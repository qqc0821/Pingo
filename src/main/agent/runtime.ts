import type { ChatMessageInput, ChatStreamEvent } from "../../shared/types.js"
import type { ToolDefinition, ToolExecution } from "../tools/types.js"
import type { ModelDiagnostics } from "../ai/modelDiagnostics.js"

export type AgentRuntimeName = "legacy" | "vercel"

export interface AgentRuntimeRequest {
  messages: ChatMessageInput[]
  toolDefinitions: ToolDefinition[]
  executeTool: (name: string, args: unknown) => Promise<ToolExecution>
  isReadOnlyTool: (name: string) => boolean
  projectAuthorized?: boolean
  projectName?: string
  maxSteps?: number
  timeoutMs?: number
  abortSignal?: AbortSignal
  emit: (event: ChatStreamEvent) => void
  diagnostics?: ModelDiagnostics
}

export interface AgentRuntimeResult {
  runtime: AgentRuntimeName
  finalAnswer: string
  steps: number
  toolCalls: Array<{ id: string; name: string; args: unknown }>
  toolResults: Array<{ id: string; content: string; detail: string }>
  finishReason: string
  fallbackUsed: boolean
  error?: string
}

export interface AgentRuntime {
  readonly name: AgentRuntimeName
  run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>
}
