import type { ChatStreamEvent } from "../../shared/types.js"
import type { ToolDefinition } from "../tools/types.js"

export type AiLabScenarioId = "conversation" | "project-read" | "blocked-write"

export interface AiLabScenario {
  id: AiLabScenarioId
  title: string
  prompt: string
  projectAuthorized: boolean
  expectedToolNames?: string[]
  expectedAnswerFragments?: string[]
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
  /** 只用于说明测试台没有对真实项目做任何修改。 */
  safeMode: true
}

export interface AiLabRunOptions {
  scenario: AiLabScenario
  client: {
    completeWithTools: (
      messages: Parameters<import("../ai/client.js").ModelClient["completeWithTools"]>[0],
      toolDefinitions: ToolDefinition[],
    ) => ReturnType<import("../ai/client.js").ModelClient["completeWithTools"]>
  }
}
