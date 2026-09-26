import { randomUUID } from "node:crypto"
import type { ChatStreamEvent } from "../../shared/types.js"
import type { ModelGateway, ModelRequestMessage, ToolCall } from "../ai/client.js"
import { parseToolArguments } from "../ai/client.js"
import {
  type ObservationBudget,
  DEFAULT_OBSERVATION_BUDGET,
  createObservationTracker,
} from "./observation.js"
import {
  TOOL_NUDGE_MESSAGE,
  buildToolConversation,
  looksLikePlanWithoutTools,
} from "./contextBuilder.js"
import { extractInlineToolCalls } from "./toolCallFallback.js"
import type { ToolDefinition, ToolExecution } from "../tools/types.js"

const DEFAULT_MAX_TOOL_LOOPS = 6
const TOO_MANY_TOOL_LOOPS_MESSAGE = "模型连续请求工具次数过多，已停止本次对话。"

export interface AgentOrchestratorDeps {
  taskId: string
  client: Pick<ModelGateway, "completeWithTools">
  toolDefinitions: ToolDefinition[]
  executeTool: (name: string, args: unknown) => Promise<ToolExecution>
  onUnhandledToolError?: (name: string, message: string) => void
  isReadOnlyTool: (name: string) => boolean
  emit: (event: ChatStreamEvent) => void
  isCancelled: () => boolean
  maxToolLoops?: number
  observationBudget?: ObservationBudget
  /** 已授权项目时传入，写入 system 上下文 */
  projectAuthorized?: boolean
  projectName?: string
  projectPath?: string
}

export type RunStopReason = "answered" | "cancelled" | "budget_exhausted" | "failed"
export type RunResult =
  | { stopReason: "answered"; transcript: ModelRequestMessage[] }
  | { stopReason: "cancelled" | "budget_exhausted"; transcript: null }
  | { stopReason: "failed"; transcript: null; error: string }

export class AgentOrchestrator {
  private readonly maxToolLoops: number
  private readonly observationBudget: ObservationBudget

  constructor(private readonly deps: AgentOrchestratorDeps) {
    this.maxToolLoops = deps.maxToolLoops ?? DEFAULT_MAX_TOOL_LOOPS
    this.observationBudget = deps.observationBudget ?? DEFAULT_OBSERVATION_BUDGET
  }

  async run(messages: ModelRequestMessage[]): Promise<RunResult> {
    const conversation = buildToolConversation(messages, {
      projectAuthorized: this.deps.projectAuthorized,
      projectName: this.deps.projectName,
      projectPath: this.deps.projectPath,
    })
    const turnStart = conversation.length - 1
    let nudgesUsed = 0

    for (let loopIndex = 0; loopIndex < this.maxToolLoops; loopIndex += 1) {
      if (this.deps.isCancelled()) return { stopReason: "cancelled", transcript: null }

      const modelStepId = randomUUID()
      this.emitStep({
        stepId: modelStepId,
        loopIndex,
        phase: "model",
        status: "started",
        title: "正在分析任务",
      })

      let result: Awaited<ReturnType<ModelGateway["completeWithTools"]>>
      try {
        result = await this.deps.client.completeWithTools(conversation, this.deps.toolDefinitions)
      } catch (error) {
        this.emitStep({
          stepId: modelStepId,
          loopIndex,
          phase: "model",
          status: "failed",
          title: "分析失败",
        })
        return {
          stopReason: "failed",
          transcript: null,
          error: error instanceof Error ? error.message : "模型请求失败",
        }
      }
      if (this.deps.isCancelled()) return { stopReason: "cancelled", transcript: null }

      this.emitStep({
        stepId: modelStepId,
        loopIndex,
        phase: "model",
        status: "completed",
        title: result.toolCalls.length > 0 ? "已决定调用工具" : "已完成分析",
        detail: result.content.trim() ? result.content.trim().slice(0, 160) : undefined,
      })

      let toolCalls = result.toolCalls
      let recoveredFromText = false

      if (toolCalls.length === 0) {
        const inlineCalls = extractInlineToolCalls(result.content, (name) => this.isKnownTool(name))
        const recoverable = inlineCalls.filter((call) => this.deps.isReadOnlyTool(call.name))

        if (inlineCalls.length > 0 && recoverable.length === inlineCalls.length) {
          // 模型把调用写成了纯文本；只读工具可以安全地结构化恢复
          toolCalls = inlineCalls.map((call, index) => ({
            id: `inline-${loopIndex}-${index}-${randomUUID()}`,
            name: call.name,
            arguments: call.arguments,
          }))
          recoveredFromText = true
          this.emitStep({
            stepId: randomUUID(),
            loopIndex,
            phase: "model",
            status: "completed",
            title: "已从文本中恢复工具调用",
            toolNames: toolCalls.map((call) => call.name),
          })
        } else {
          // 变更类工具不做文本恢复，改为要求模型重新以 tool_calls 发起
          const shouldNudge =
            nudgesUsed === 0 &&
            (inlineCalls.length > 0 ||
              (Boolean(this.deps.projectAuthorized) && looksLikePlanWithoutTools(result.content)))

          if (shouldNudge) {
            nudgesUsed += 1
            this.emitStep({
              stepId: randomUUID(),
              loopIndex,
              phase: "model",
              status: "started",
              title: "未调用工具，正在强制重试",
              detail: result.content.trim().slice(0, 160) || undefined,
            })
            conversation.push({ role: "assistant", content: result.content || "" })
            conversation.push(TOOL_NUDGE_MESSAGE)
            continue
          }

          if (result.content) this.deps.emit({ type: "chunk", content: result.content })
          const summaryStepId = randomUUID()
          this.emitStep({
            stepId: summaryStepId,
            loopIndex,
            phase: "summarizing",
            status: "started",
            title: "正在整理回答",
          })
          this.emitStep({
            stepId: summaryStepId,
            loopIndex,
            phase: "summarizing",
            status: "completed",
            title: "已整理回答",
          })
          conversation.push({ role: "assistant", content: result.content || "" })
          return { stopReason: "answered", transcript: conversation.slice(turnStart) }
        }
      }

      // 有工具调用时，中间 content 不进聊天气泡，避免“说了计划却像最终答案”
      conversation.push({
        role: "assistant",
        content: recoveredFromText ? "" : result.content || "",
        tool_calls: toolCalls.map(toModelToolCall),
      })
      await this.runToolBatch(conversation, toolCalls, loopIndex)
      if (this.deps.isCancelled()) return { stopReason: "cancelled", transcript: null }
    }

    if (!this.deps.isCancelled()) {
      this.deps.emit({ type: "error", message: TOO_MANY_TOOL_LOOPS_MESSAGE })
    }
    return {
      stopReason: this.deps.isCancelled() ? "cancelled" : "budget_exhausted",
      transcript: null,
    }
  }

  private async runToolBatch(
    conversation: ModelRequestMessage[],
    toolCalls: ToolCall[],
    loopIndex: number,
  ): Promise<void> {
    const stepId = randomUUID()
    const tracker = createObservationTracker(this.observationBudget)
    const executions = new Map<string, ToolExecution>()

    this.emitStep({
      stepId,
      loopIndex,
      phase: "tool_batch",
      status: "started",
      title: "正在执行工具",
      toolNames: toolCalls.map((call) => call.name),
    })

    // Calls in one model response may depend on earlier calls (for example write then read).
    for (const [index, call] of toolCalls.entries()) {
      if (this.deps.isCancelled()) {
        this.emitStep({
          stepId,
          loopIndex,
          phase: "tool_batch",
          status: "skipped",
          title: "已停止执行工具",
        })
        return
      }
      let execution: ToolExecution
      try {
        execution = await this.deps.executeTool(call.name, parseToolArguments(call.arguments))
      } catch {
        execution = {
          content: `工具 ${call.name} 执行失败，后续操作已跳过。请检查当前状态后调整方法。`,
          detail: `工具 ${call.name} 执行失败`,
          status: "failed",
        }
        this.deps.onUnhandledToolError?.(call.name, execution.content)
      }
      executions.set(call.id, execution)
      if (execution.status && execution.status !== "completed") {
        for (const remaining of toolCalls.slice(index + 1)) {
          executions.set(remaining.id, {
            content: "前一项工具未成功，未执行此操作。",
            detail: `已跳过 ${remaining.name}`,
            status: "cancelled",
          })
        }
        break
      }
    }

    let emittedBudgetExceeded = false
    for (const call of toolCalls) {
      const execution = executions.get(call.id)
      if (!execution) continue
      this.deps.emit({ type: "tool", name: call.name, detail: execution.detail })
      const formatted = tracker.format(execution.content)
      this.deps.emit({
        type: "tool-result",
        callId: call.id,
        name: call.name,
        status: execution.status ?? "completed",
        ...(execution.errorCode ||
        execution.policyFailure ||
        (execution.status && execution.status !== "completed")
          ? {
              errorCode:
                execution.errorCode ?? execution.policyFailure?.code ?? `tool_${execution.status}`,
            }
          : {}),
        truncated: Boolean(execution.truncated || formatted.truncated || formatted.omitted),
      })
      if (formatted.omitted && !emittedBudgetExceeded) {
        emittedBudgetExceeded = true
        this.emitStep({
          stepId: randomUUID(),
          loopIndex,
          phase: "budget_exceeded",
          status: "completed",
          title: "观察预算已用尽",
        })
      }
      conversation.push({ role: "tool", tool_call_id: call.id, content: formatted.content })
    }

    this.emitStep({
      stepId,
      loopIndex,
      phase: "tool_batch",
      status: "completed",
      title: "工具执行完成",
      toolNames: toolCalls.map((call) => call.name),
    })
  }

  private isKnownTool(name: string): boolean {
    return this.deps.toolDefinitions.some((definition) => definition.function.name === name)
  }

  private emitStep(
    event: Omit<Extract<ChatStreamEvent, { type: "agent-step" }>, "type" | "taskId">,
  ): void {
    this.deps.emit({ type: "agent-step", taskId: this.deps.taskId, ...event })
  }
}

function toModelToolCall(
  toolCall: ToolCall,
): Extract<ModelRequestMessage, { role: "assistant" }>["tool_calls"][number] {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }
}
