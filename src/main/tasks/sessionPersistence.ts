import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { ModelRequestMessage } from "../ai/client.js"
import { redactOutput } from "../terminal/streamRedactor.js"

const VERSION = 1
const MAX_FILE_BYTES = 256_000
const MAX_SESSIONS = 8
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

export interface StoredConversation {
  id: string
  projectPath?: string
  turns: ModelRequestMessage[][]
  pending?: string
  interrupted?: string
  updatedAt: number
}

export interface ConversationPersistence {
  load(owner: string): StoredConversation | undefined
  save(owner: string, conversation: StoredConversation): void
  remove(owner: string, sessionId?: string): void
}

/** Versioned, bounded session JSON. The owner pointer is separate from the conversation file. */
export class FileSessionPersistence implements ConversationPersistence {
  constructor(private readonly directory: string) {}

  load(owner: string): StoredConversation | undefined {
    try {
      const pointer = readFileSync(this.pointerPath(owner), "utf8").trim()
      if (!isSessionId(pointer)) return undefined
      const path = this.sessionPath(pointer)
      if (statSync(path).size > MAX_FILE_BYTES) return undefined
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (!isStoredFile(raw)) return undefined
      return raw.conversation
    } catch {
      // Corrupt or absent storage is isolated to this conversation.
      return undefined
    }
  }

  save(owner: string, conversation: StoredConversation): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const safe = sanitize(conversation)
    const payload = JSON.stringify({ version: VERSION, conversation: safe })
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error("会话超过本地存储上限")
    atomicWrite(this.sessionPath(safe.id), payload)
    atomicWrite(this.pointerPath(owner), safe.id)
    this.prune(safe.id)
  }

  remove(owner: string, sessionId?: string): void {
    const currentId = sessionId ?? this.load(owner)?.id
    rmSync(this.pointerPath(owner), { force: true })
    if (currentId && isSessionId(currentId)) rmSync(this.sessionPath(currentId), { force: true })
  }

  private pointerPath(owner: string): string {
    return join(this.directory, `owner-${createHash("sha256").update(owner).digest("hex")}.txt`)
  }

  private sessionPath(id: string): string {
    if (!isSessionId(id)) throw new Error("会话 ID 无效")
    return join(this.directory, `session-${id}.json`)
  }

  private prune(activeId: string): void {
    const files = readdirSync(this.directory)
      .filter((name) => /^session-[0-9a-f-]{36}\.json$/.test(name))
      .map((name) => ({ name, mtimeMs: statSync(join(this.directory, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const now = Date.now()
    for (const [index, file] of files.entries()) {
      if (file.name === `session-${activeId}.json`) continue
      if (index >= MAX_SESSIONS || now - file.mtimeMs > MAX_AGE_MS) {
        rmSync(join(this.directory, file.name), { force: true })
      }
    }
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function sanitize(value: StoredConversation): StoredConversation {
  return {
    ...value,
    turns: value.turns.map((turn) =>
      turn.map((message) => {
        if (message.role === "assistant" && "tool_calls" in message) {
          return {
            ...message,
            content: redactOutput(message.content ?? ""),
            tool_calls: message.tool_calls.map((call) => ({
              ...call,
              function: { ...call.function, arguments: redactOutput(call.function.arguments) },
            })),
          }
        }
        return { ...message, content: redactOutput(message.content) }
      }),
    ),
    ...(value.pending ? { pending: redactOutput(value.pending).slice(0, 8_000) } : {}),
    ...(value.interrupted ? { interrupted: redactOutput(value.interrupted).slice(0, 8_000) } : {}),
  }
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isStoredFile(value: unknown): value is { version: 1; conversation: StoredConversation } {
  if (!value || typeof value !== "object") return false
  const file = value as { version?: unknown; conversation?: unknown }
  if (file.version !== VERSION || !file.conversation || typeof file.conversation !== "object")
    return false
  const item = file.conversation as Partial<StoredConversation>
  return (
    isSessionId(item.id ?? "") &&
    (item.projectPath === undefined || typeof item.projectPath === "string") &&
    Array.isArray(item.turns) &&
    item.turns.every((turn) => Array.isArray(turn) && turn.every(isMessage)) &&
    (item.pending === undefined || typeof item.pending === "string") &&
    (item.interrupted === undefined || typeof item.interrupted === "string") &&
    typeof item.updatedAt === "number"
  )
}

function isMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const message = value as {
    role?: unknown
    content?: unknown
    tool_call_id?: unknown
    tool_calls?: unknown
  }
  if (message.role === "tool")
    return typeof message.tool_call_id === "string" && typeof message.content === "string"
  if (message.role === "assistant" && message.tool_calls !== undefined) {
    return (
      (typeof message.content === "string" || message.content === null) &&
      Array.isArray(message.tool_calls)
    )
  }
  return (
    ["user", "assistant", "system"].includes(String(message.role)) &&
    typeof message.content === "string"
  )
}
