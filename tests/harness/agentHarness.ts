import type {
  CompletionResult,
  ModelClient,
  ModelRequestMessage,
  ToolCall,
} from "../../src/main/ai/client.js"
import { AgentOrchestrator, type AgentOrchestratorDeps } from "../../src/main/agent/orchestrator.js"
import { READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS } from "../../src/main/tools/registry.js"
import type { ToolDefinition, ToolExecution } from "../../src/main/tools/types.js"
import type { ChatMessageInput, ChatStreamEvent } from "../../src/shared/types.js"

export interface ReplayModelStep {
  label: string
  result: CompletionResult
}

export interface RecordedToolCall {
  name: string
  args: unknown
}

export interface AgentScenario {
  name: string
  messages: ChatMessageInput[]
  modelSteps: ReplayModelStep[]
  toolDefinitions?: ToolDefinition[]
  executeTool?: (name: string, args: unknown) => Promise<ToolExecution>
  isReadOnlyTool?: (name: string) => boolean
  isCancelled?: () => boolean
  maxToolLoops?: number
  observationBudget?: AgentOrchestratorDeps["observationBudget"]
  projectAuthorized?: boolean
  projectName?: string
  projectPath?: string
}

export interface AgentScenarioResult {
  events: ChatStreamEvent[]
  modelConversations: ModelRequestMessage[][]
  modelToolDefinitions: ToolDefinition[][]
  toolCalls: RecordedToolCall[]
  finalAnswer: string
  modelCalls: number
}

/**
 * Deterministic replacement for the network model client. It intentionally fails
 * if a code change causes the orchestrator to request one more completion than a
 * scenario recorded, which makes control-flow regressions immediately visible.
 */
export class ReplayModelClient {
  private readonly steps: ReplayModelStep[]
  private index = 0
  readonly conversations: ModelRequestMessage[][] = []
  readonly toolDefinitions: ToolDefinition[][] = []

  constructor(steps: ReplayModelStep[]) {
    this.steps = steps.map((step) => structuredClone(step))
  }

  async completeWithTools(
    messages: ModelRequestMessage[],
    toolDefinitions: ToolDefinition[],
  ): Promise<CompletionResult> {
    this.conversations.push(structuredClone(messages))
    this.toolDefinitions.push(structuredClone(toolDefinitions))
    const step = this.steps.at(this.index)
    if (!step) {
      throw new Error(`回放模型步骤已耗尽：第 ${this.index + 1} 次调用没有预设响应。`)
    }
    this.index += 1
    return structuredClone(step.result)
  }

  assertConsumed(): void {
    if (this.index !== this.steps.length) {
      const next = this.steps[this.index]
      throw new Error(`回放模型步骤未消费：${next?.label ?? `第 ${this.index + 1} 步`}`)
    }
  }

  get calls(): number {
    return this.index
  }
}

export function replayToolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: JSON.stringify(args) }
}

export async function runAgentScenario(scenario: AgentScenario): Promise<AgentScenarioResult> {
  const client = new ReplayModelClient(scenario.modelSteps)
  const events: ChatStreamEvent[] = []
  const toolCalls: RecordedToolCall[] = []
  const orchestrator = new AgentOrchestrator({
    taskId: `harness:${scenario.name}`,
    client: client as Pick<ModelClient, "completeWithTools">,
    toolDefinitions: scenario.toolDefinitions ?? TOOL_DEFINITIONS,
    executeTool: async (name, args) => {
      toolCalls.push({ name, args: structuredClone(args) })
      return scenario.executeTool?.(name, args) ?? { content: "ok", detail: `${name} completed` }
    },
    isReadOnlyTool: scenario.isReadOnlyTool ?? ((name) => READ_ONLY_TOOL_NAMES.has(name)),
    emit: (event) => events.push(structuredClone(event)),
    isCancelled: scenario.isCancelled ?? (() => false),
    maxToolLoops: scenario.maxToolLoops,
    observationBudget: scenario.observationBudget,
    projectAuthorized: scenario.projectAuthorized,
    projectName: scenario.projectName,
    projectPath: scenario.projectPath,
  })

  await orchestrator.run(scenario.messages)
  client.assertConsumed()

  return {
    events,
    modelConversations: client.conversations,
    modelToolDefinitions: client.toolDefinitions,
    toolCalls,
    finalAnswer: events
      .filter(
        (event): event is Extract<ChatStreamEvent, { type: "chunk" }> => event.type === "chunk",
      )
      .map((event) => event.content)
      .join(""),
    modelCalls: client.calls,
  }
}

/** A stable, human-readable trace intended for a failed test's diagnostic output. */
export function formatScenarioTrace(result: AgentScenarioResult): string {
  const lines = [
    `model calls: ${result.modelCalls}`,
    `tool calls: ${result.toolCalls.map((call) => call.name).join(", ") || "none"}`,
  ]
  for (const event of result.events) {
    if (event.type === "agent-step") {
      lines.push(
        `step ${event.loopIndex}: ${event.phase}/${event.status}${event.toolNames ? ` (${event.toolNames.join(", ")})` : ""}`,
      )
    } else if (event.type === "tool") {
      lines.push(`tool: ${event.name}`)
    } else if (event.type === "chunk") {
      lines.push(`answer: ${event.content}`)
    } else if (event.type === "error") {
      lines.push(`error: ${event.message}`)
    } else {
      lines.push(`event: ${event.type}`)
    }
  }
  return lines.join("\n")
}
