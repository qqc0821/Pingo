import { AgentOrchestrator } from "./orchestrator.js"
import type { ModelClient } from "../ai/client.js"
import type { AgentRuntime, AgentRuntimeRequest, AgentRuntimeResult } from "./runtime.js"

export class LegacyAgentRuntime implements AgentRuntime {
  readonly name = "legacy" as const

  constructor(private readonly client: Pick<ModelClient, "completeWithTools">) {}

  async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const answerParts: string[] = []
    const toolCalls: AgentRuntimeResult["toolCalls"] = []
    const toolResults = new Map<string, AgentRuntimeResult["toolResults"][number]>()
    let steps = 0
    let finishReason = "stop"
    let error: string | undefined

    const orchestrator = new AgentOrchestrator({
      taskId: "ai-lab-legacy",
      client: this.client,
      toolDefinitions: request.toolDefinitions,
      executeTool: async (name, args) => {
        const id = `legacy-${toolCalls.length}`
        toolCalls.push({ id, name, args })
        const execution = await request.executeTool(name, args)
        toolResults.set(id, { id, content: execution.content, detail: execution.detail })
        return execution
      },
      isReadOnlyTool: request.isReadOnlyTool,
      emit: (event) => {
        if (event.type === "chunk") answerParts.push(event.content)
        if (
          event.type === "agent-step" &&
          event.phase === "model" &&
          event.status === "completed"
        ) {
          steps = Math.max(steps, event.loopIndex + 1)
        }
        if (event.type === "error") finishReason = "error"
        request.emit(event)
      },
      isCancelled: () => request.abortSignal?.aborted ?? false,
      maxToolLoops: request.maxSteps,
      projectAuthorized: request.projectAuthorized,
      projectName: request.projectName,
    })

    try {
      await orchestrator.run(request.messages)
      if (request.abortSignal?.aborted) finishReason = "cancelled"
    } catch (caught) {
      finishReason = "error"
      error = caught instanceof Error ? caught.message : "Legacy runtime failed"
      request.emit({ type: "error", message: error })
    }

    return {
      runtime: this.name,
      finalAnswer: answerParts.join("").trim(),
      steps,
      toolCalls,
      toolResults: [...toolResults.values()],
      finishReason,
      fallbackUsed: false,
      ...(error ? { error } : {}),
    }
  }
}
