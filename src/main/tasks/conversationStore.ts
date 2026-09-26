import { randomUUID } from "node:crypto"
import type { ModelRequestMessage } from "../ai/client.js"

const MAX_MESSAGES = 48
const MAX_HISTORY_CHARS = 32_000
const MAX_TOOL_OBSERVATION_CHARS = 2_000

interface Conversation {
  id: string
  projectPath: string | undefined
  turns: ModelRequestMessage[][]
}

/** Runtime-only conversation history, grouped by completed runs to preserve tool-call pairing. */
export class ConversationStore {
  private readonly byWindow = new Map<string, Conversation>()

  current(windowId: string, projectPath: string | undefined): Conversation {
    const existing = this.byWindow.get(windowId)
    if (existing && existing.projectPath === projectPath) return existing
    const conversation = { id: randomUUID(), projectPath, turns: [] }
    this.byWindow.set(windowId, conversation)
    return conversation
  }

  messagesFor(
    windowId: string,
    projectPath: string | undefined,
    input: string,
  ): ModelRequestMessage[] {
    const conversation = this.current(windowId, projectPath)
    return [...conversation.turns.flat(), { role: "user", content: input }]
  }

  complete(
    windowId: string,
    sessionId: string,
    transcript: ModelRequestMessage[],
    failureReason?: string,
  ): void {
    const conversation = this.byWindow.get(windowId)
    if (!conversation || conversation.id !== sessionId || transcript.length < 2) return
    const final = transcript.at(-1)
    if (final?.role !== "assistant" || (!final.content?.trim() && !failureReason)) return
    const bounded = transcript.map((message) =>
      message.role === "tool"
        ? { ...message, content: message.content.slice(0, MAX_TOOL_OBSERVATION_CHARS) }
        : message,
    )
    if (failureReason) {
      bounded[bounded.length - 1] = {
        role: "assistant",
        content: `上轮任务未完成：${failureReason.slice(0, 500)}\n${final.content ?? ""}`,
      }
    }
    conversation.turns.push(bounded)
    while (conversation.turns.length > 1 && exceedsBudget(conversation.turns)) {
      conversation.turns.shift()
    }
    if (exceedsBudget(conversation.turns)) {
      const first = bounded[0]
      const last = bounded.at(-1)
      conversation.turns =
        first?.role === "user"
          ? [[first, { role: "assistant", content: last?.content?.slice(0, 8_000) ?? "" }]]
          : []
    }
  }

  clear(windowId?: string): void {
    if (windowId) this.byWindow.delete(windowId)
    else this.byWindow.clear()
  }
}

function exceedsBudget(turns: ModelRequestMessage[][]): boolean {
  const messages = turns.flat()
  return (
    messages.length > MAX_MESSAGES ||
    messages.reduce(
      (sum, message) =>
        sum +
        (message.content?.length ?? 0) +
        (message.role === "assistant" && "tool_calls" in message
          ? message.tool_calls.reduce((total, call) => total + call.function.arguments.length, 0)
          : 0),
      0,
    ) > MAX_HISTORY_CHARS
  )
}
