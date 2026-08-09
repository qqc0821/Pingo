import {
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai"
import { buildToolConversation } from "./contextBuilder.js"
import type { AgentRuntime, AgentRuntimeRequest, AgentRuntimeResult } from "./runtime.js"

export const DEFAULT_RUNTIME_TIMEOUT_MS = 60_000

export interface VercelAgentRuntimeOptions {
  model: LanguageModel
}

export class VercelAgentRuntime implements AgentRuntime {
  readonly name = "vercel" as const

  constructor(private readonly options: VercelAgentRuntimeOptions) {}

  private get modelId(): string {
    return typeof this.options.model === "string" ? this.options.model : this.options.model.modelId
  }

  async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const toolCalls: AgentRuntimeResult["toolCalls"] = []
    const toolResults: AgentRuntimeResult["toolResults"] = []
    let stepCount = 0
    let finishReason = "stop"
    let error: string | undefined
    let timedOut = false
    const abortController = new AbortController()
    const abortFromCaller = () => abortController.abort()
    if (request.abortSignal) {
      if (request.abortSignal.aborted) abortController.abort()
      else request.abortSignal.addEventListener("abort", abortFromCaller, { once: true })
    }
    const timeout = setTimeout(() => {
      timedOut = true
      abortController.abort()
    }, request.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS)
    const conversation = buildToolConversation(request.messages, {
      projectAuthorized: request.projectAuthorized,
      projectName: request.projectName,
    })
    const system = conversation.find((message) => message.role === "system")?.content ?? undefined
    const messages = conversation.filter((message) => message.role !== "system") as ModelMessage[]
    const tools = createTools(request)

    try {
      const result = await generateText({
        model: this.options.model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(request.maxSteps ?? 6),
        abortSignal: abortController.signal,
        maxRetries: 0,
        onStepStart: ({ stepNumber, messages: stepMessages }) => {
          stepCount = Math.max(stepCount, stepNumber + 1)
          request.emit({
            type: "agent-step",
            taskId: "ai-lab-vercel",
            stepId: `vercel-model-${stepNumber}`,
            loopIndex: stepNumber,
            phase: "model",
            status: "started",
            title: "正在分析任务",
          })
          request.diagnostics?.recordSafe("step-start", {
            runtime: "vercel",
            model: this.modelId,
            stepNumber,
            toolNames: request.toolDefinitions.map((definition) => definition.function.name),
            messageSummary: stepMessages.map((message) => ({
              role: message.role,
              length: messageLength(message.content),
            })),
          })
        },
        onStepFinish: ({
          stepNumber,
          text,
          toolCalls: stepToolCalls,
          finishReason: stepFinishReason,
        }) => {
          stepCount = Math.max(stepCount, stepNumber + 1)
          for (const call of stepToolCalls) {
            toolCalls.push({ id: call.toolCallId, name: call.toolName, args: call.input })
          }
          finishReason = String(stepFinishReason)
          request.diagnostics?.recordSafe("step-finish", {
            runtime: "vercel",
            model: this.modelId,
            stepNumber,
            toolCallCount: stepToolCalls.length,
            toolNames: stepToolCalls.map((call) => call.toolName),
            finishReason: String(stepFinishReason),
            answerLength: text.length,
            answerPreview: text.trim().slice(0, 160) || undefined,
          })
          request.emit({
            type: "agent-step",
            taskId: "ai-lab-vercel",
            stepId: `vercel-model-${stepNumber}`,
            loopIndex: stepNumber,
            phase: "model",
            status: "completed",
            title: stepToolCalls.length > 0 ? "已决定调用工具" : "已完成分析",
            detail: text.trim().slice(0, 160) || undefined,
            toolNames: stepToolCalls.map((call) => call.toolName),
          })
        },
      })

      for (const resultItem of result.toolResults) {
        const id = resultItem.toolCallId
        const output = stringifyToolOutput(resultItem.output)
        toolResults.push({ id, content: output, detail: "Vercel AI SDK：工具结果已回填" })
      }
      if (result.text.trim()) {
        request.emit({ type: "chunk", content: result.text })
      }
      request.emit({
        type: "agent-step",
        taskId: "ai-lab-vercel",
        stepId: "vercel-summary",
        loopIndex: Math.max(0, stepCount - 1),
        phase: "summarizing",
        status: "completed",
        title: "已整理回答",
      })
      return {
        runtime: this.name,
        finalAnswer: result.text.trim(),
        steps: stepCount,
        toolCalls,
        toolResults,
        finishReason,
        fallbackUsed: false,
      }
    } catch (caught) {
      finishReason = timedOut ? "timeout" : request.abortSignal?.aborted ? "cancelled" : "error"
      error = caught instanceof Error ? caught.message : "Vercel runtime failed"
      request.emit({ type: "error", message: error })
      return {
        runtime: this.name,
        finalAnswer: "",
        steps: stepCount,
        toolCalls,
        toolResults,
        finishReason,
        fallbackUsed: false,
        error,
      }
    } finally {
      clearTimeout(timeout)
      request.abortSignal?.removeEventListener("abort", abortFromCaller)
    }
  }
}

function createTools(request: AgentRuntimeRequest): ToolSet {
  const tools: ToolSet = {}
  for (const definition of request.toolDefinitions) {
    const name = definition.function.name
    tools[name] = tool({
      description: definition.function.description,
      inputSchema: jsonSchema(definition.function.parameters),
      execute: async (input: unknown) => {
        const result = await request.executeTool(name, input)
        request.emit({ type: "tool", name, detail: result.detail })
        request.diagnostics?.recordSafe("tool-result", {
          runtime: "vercel",
          toolName: name,
          resultShape: { contentType: typeof result.content, contentLength: result.content.length },
        })
        return result.content
      },
    })
  }
  return tools
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function messageLength(content: unknown): number {
  if (typeof content === "string") return content.length
  try {
    return JSON.stringify(content).length
  } catch {
    return 0
  }
}
