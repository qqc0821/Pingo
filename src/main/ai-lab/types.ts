import type { ChatStreamEvent } from "../../shared/types.js"
import type { ToolDefinition } from "../tools/types.js"

export type AiLabScenarioId =
  | "conversation"
  | "project-read"
  | "blocked-write"
  | "real-list"
  | "real-search"
  | "real-no-tool"
  | "prompt"

export type AiLabEnvironment = "virtual" | "real-readonly"

export interface AiLabScenario {
  id: AiLabScenarioId
  title: string
  prompt: string
  environment: AiLabEnvironment
  projectAuthorized: boolean
  expectedToolNames?: string[]
  requiredToolSequence?: string[]
  expectedAnswerFragments?: string[]
  expectedAnswerExact?: string
  maxToolCalls?: number
}

export interface AiLabToolTrace {
  name: string
  args: unknown
  detail: string
  content: string
  mutating: boolean
}

export interface AiLabCheck {
  name: string
  passed: boolean
  detail: string
}

export interface AiLabReport {
  scenario: AiLabScenario
  finalAnswer: string
  events: ChatStreamEvent[]
  toolTraces: AiLabToolTrace[]
  checks: AiLabCheck[]
  passed: boolean
  environment: AiLabEnvironment
  runtime: "legacy" | "vercel"
  fallbackUsed: boolean
  steps: number
  finishReason: string
  startedAt: string
  model: string
  baseUrlHost: string
  attempt: number
  retried: boolean
  retryReason?: string
  /** 兼容旧报告字段；真实只读模式为 false。 */
  safeMode: boolean
}

export interface AiLabRunOptions {
  scenario: AiLabScenario
  client?: {
    completeWithTools: (
      messages: Parameters<import("../ai/client.js").ModelClient["completeWithTools"]>[0],
      toolDefinitions: ToolDefinition[],
    ) => ReturnType<import("../ai/client.js").ModelClient["completeWithTools"]>
  }
  runtime?: import("../agent/runtime.js").AgentRuntime
  projectPath?: string
  diagnostics?: import("../ai/modelDiagnostics.js").ModelDiagnostics
  startedAt?: string
  model?: string
  baseUrlHost?: string
  attempt?: number
  retried?: boolean
  retryReason?: string
}
