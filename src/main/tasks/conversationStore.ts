import { randomUUID } from "node:crypto"
import type { ModelRequestMessage } from "../ai/client.js"
import type { ConversationPersistence, StoredConversation } from "./sessionPersistence.js"

const MAX_MESSAGES = 48
const MAX_HISTORY_CHARS = 32_000
const MAX_TOOL_OBSERVATION_CHARS = 2_000

type Conversation = StoredConversation

/** Conversation history grouped by turns, optionally backed by bounded local storage. */
export class ConversationStore {
  private readonly byWindow = new Map<string, Conversation>()

  constructor(private readonly persistence?: ConversationPersistence) {}

  current(windowId: string, projectPath: string | undefined): Conversation {
    const existing = this.byWindow.get(windowId) ?? this.persistence?.load(windowId)
    if (existing && !this.byWindow.has(windowId)) {
      this.byWindow.set(windowId, existing)
      if (existing.pending) {
        const input = existing.pending
        existing.pending = undefined
        existing.interrupted = input
        existing.turns.push([
          { role: "user", content: input },
          { role: "assistant", content: "上轮任务在应用退出时中断，未自动重试或重新执行工具。" },
        ])
        this.bound(existing)
        this.persist(windowId, existing)
      }
    }
    if (existing && existing.projectPath === projectPath) return existing
    const conversation: Conversation = {
      id: randomUUID(),
      projectPath,
      turns: [],
      updatedAt: Date.now(),
    }
    this.byWindow.set(windowId, conversation)
    this.persist(windowId, conversation)
    return conversation
  }

  begin(windowId: string, sessionId: string, input: string): void {
    const conversation = this.byWindow.get(windowId)
    if (!conversation || conversation.id !== sessionId) return
    conversation.pending = input.slice(0, 8_000)
    conversation.interrupted = undefined
    this.persist(windowId, conversation)
  }

  interrupted(windowId: string, projectPath: string | undefined): string | undefined {
    return this.current(windowId, projectPath).interrupted
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
    conversation.pending = undefined
    conversation.interrupted = undefined
    this.bound(conversation)
    this.persist(windowId, conversation)
  }

  clear(windowId?: string): void {
    if (windowId) {
      const session = this.byWindow.get(windowId) ?? this.persistence?.load(windowId)
      this.byWindow.delete(windowId)
      this.persistence?.remove(windowId, session?.id)
    } else {
      for (const [owner, session] of this.byWindow) this.persistence?.remove(owner, session.id)
      this.byWindow.clear()
    }
  }

  clearMemory(): void {
    this.byWindow.clear()
  }

  private bound(conversation: Conversation): void {
    while (conversation.turns.length > 1 && exceedsBudget(conversation.turns)) {
      conversation.turns.shift()
    }
    if (exceedsBudget(conversation.turns)) {
      const first = conversation.turns.at(-1)?.[0]
      const last = conversation.turns.at(-1)?.at(-1)
      conversation.turns =
        first?.role === "user"
          ? [[first, { role: "assistant", content: last?.content?.slice(0, 8_000) ?? "" }]]
          : []
    }
  }

  private persist(windowId: string, conversation: Conversation): void {
    conversation.updatedAt = Date.now()
    this.persistence?.save(windowId, conversation)
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
