import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import type {
  ChatMessageInput,
  ChatStreamEvent,
  ClearContextRequest,
  ContextPreview,
  ConversationDetail,
  ConversationItem,
  ConversationItemKind,
  ConversationItemStatus,
  ConversationSubmitRequest,
  ConversationSubmitResult,
  ConversationSummary,
  TaskState,
} from "../../shared/types.js"
import type { OperationResult, TerminalPolicyCode } from "../../shared/types.js"
import { redactOutput } from "../terminal/streamRedactor.js"

const DATABASE_FILE = "chat-history.sqlite"
const MAX_CONTEXT_MESSAGES = 24
const MAX_CONTEXT_CHARACTERS = 100_000
type Row = Record<string, unknown>

export interface TerminalRunLedgerInput {
  runId: string
  operationId: string
  taskId: string
  conversationId?: string
  intentKind: string
  intentAction?: string
  argv: string[]
  cwdRelative: string
  planDigest: string
  fingerprint: string
  status: OperationResult["status"]
  exitCode?: number | null
  policyCode?: TerminalPolicyCode
  durationMs: number
  outputBytes: number
  outputRedacted: string
  truncated: boolean
  startedAt: number
  finishedAt: number
}

export interface TerminalRunLedgerRecord extends TerminalRunLedgerInput {
  conversationId?: string
}

interface ConversationRow extends Row {
  conversation_id: string
  title: string
  active_context_epoch_id: string
  revision: number
  created_at: number
  updated_at: number
  archived_at: number | null
}

interface ItemRow extends Row {
  item_id: string
  conversation_id: string
  turn_id: string | null
  run_id: string | null
  context_epoch_id: string
  kind: ConversationItemKind
  role: "user" | "assistant" | "system" | null
  status: ConversationItemStatus
  content: string
  detail: string | null
  created_at: number
  updated_at: number
}

interface TerminalRunRow extends Row {
  run_id: string
  operation_id: string
  task_id: string
  conversation_id: string | null
  intent_kind: string
  intent_action: string | null
  argv_json: string
  cwd_relative: string
  plan_digest: string
  fingerprint: string
  status: string
  exit_code: number | null
  policy_code: string | null
  duration_ms: number
  output_bytes: number
  output_redacted: string
  truncated: number
  started_at: number
  finished_at: number
}

/** Main-process source of truth for user-visible conversation state. */
export class ConversationStore {
  private readonly db: DatabaseSync

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      chmodSync(directory, 0o700)
    } catch {
      // The directory may be on a filesystem that does not support POSIX modes.
    }
    const databasePath = join(directory, DATABASE_FILE)
    this.db = new DatabaseSync(databasePath)
    try {
      chmodSync(databasePath, 0o600)
    } catch {
      // Best effort; the user-data directory remains app-owned on supported platforms.
    }
    this.initialize()
    this.recoverInterruptedRuns()
  }

  close(): void {
    this.db.close()
  }

  create(): ConversationDetail {
    return this.transaction(() => {
      const now = Date.now()
      const conversationId = randomUUID()
      const epochId = randomUUID()
      this.db
        .prepare(
          `INSERT INTO conversations
            (conversation_id, title, active_context_epoch_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(conversationId, "新对话", epochId, now, now)
      this.db
        .prepare(
          `INSERT INTO context_epochs (context_epoch_id, conversation_id, sequence, created_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run(epochId, conversationId, now)
      return this.require(conversationId)
    })
  }

  list(): ConversationSummary[] {
    return this.db
      .prepare(
        `SELECT conversation_id, title, active_context_epoch_id, revision, created_at, updated_at, archived_at
         FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC`,
      )
      .all()
      .map((row) => this.toSummary(row as ConversationRow))
  }

  get(conversationId: string): ConversationDetail | null {
    const row = this.db
      .prepare(
        `SELECT conversation_id, title, active_context_epoch_id, revision, created_at, updated_at, archived_at
         FROM conversations WHERE conversation_id = ?`,
      )
      .get(conversationId) as ConversationRow | undefined
    if (!row) return null
    const items = this.db
      .prepare(
        `SELECT item_id, conversation_id, turn_id, run_id, context_epoch_id, kind, role, status,
                content, detail, created_at, updated_at
         FROM conversation_items WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(conversationId)
      .map((item) => this.toItem(item as ItemRow))
    return { ...this.toSummary(row), items }
  }

  submit(request: ConversationSubmitRequest): ConversationSubmitResult {
    this.assertSubmitRequest(request)
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT run_id, conversation_id FROM conversation_turns WHERE client_request_id = ?`,
        )
        .get(request.clientRequestId) as { run_id: string; conversation_id: string } | undefined
      if (existing) {
        if (existing.conversation_id !== request.conversationId)
          throw new ConversationConflictError("请求标识已属于另一条对话。")
        const conversation = this.require(request.conversationId)
        return { taskId: existing.run_id, started: false, conversation }
      }

      const conversation = this.requireRow(request.conversationId)
      if (conversation.revision !== request.expectedRevision)
        throw new ConversationConflictError("会话已在其他操作中更新，请刷新后重试。")
      if (conversation.active_context_epoch_id !== request.expectedContextEpochId)
        throw new ConversationConflictError("上下文已切换，请基于当前上下文重新提交。")
      if (this.hasActiveRun(request.conversationId))
        throw new ConversationConflictError("当前任务尚未结束，不能开始新的任务。")

      const now = Date.now()
      const turnId = randomUUID()
      const runId = randomUUID()
      const assistantItemId = randomUUID()
      const title =
        conversation.title === "新对话" ? makeTitle(request.content) : conversation.title
      this.db
        .prepare(
          `INSERT INTO conversation_turns
            (turn_id, conversation_id, context_epoch_id, client_request_id, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turnId,
          request.conversationId,
          conversation.active_context_epoch_id,
          request.clientRequestId,
          runId,
          now,
        )
      this.db
        .prepare(
          `INSERT INTO conversation_runs
            (run_id, turn_id, conversation_id, context_epoch_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'proposed', ?, ?)`,
        )
        .run(runId, turnId, request.conversationId, conversation.active_context_epoch_id, now, now)
      this.insertItem({
        itemId: randomUUID(),
        conversationId: request.conversationId,
        turnId,
        runId,
        contextEpochId: conversation.active_context_epoch_id,
        kind: "message",
        role: "user",
        status: "complete",
        content: request.content,
        now,
      })
      this.insertItem({
        itemId: assistantItemId,
        conversationId: request.conversationId,
        turnId,
        runId,
        contextEpochId: conversation.active_context_epoch_id,
        kind: "message",
        role: "assistant",
        status: "streaming",
        content: "",
        now,
      })
      this.db
        .prepare(`UPDATE conversation_runs SET assistant_item_id = ? WHERE run_id = ?`)
        .run(assistantItemId, runId)
      this.touchConversation(request.conversationId, title, now)
      return { taskId: runId, started: true, conversation: this.require(request.conversationId) }
    })
  }

  getContextForRun(runId: string): ChatMessageInput[] {
    const run = this.db
      .prepare(`SELECT conversation_id, context_epoch_id FROM conversation_turns WHERE run_id = ?`)
      .get(runId) as { conversation_id: string; context_epoch_id: string } | undefined
    if (!run) throw new Error("会话运行不存在")
    const rows = this.db
      .prepare(
        `SELECT role, content FROM conversation_items
         WHERE conversation_id = ? AND context_epoch_id = ? AND kind = 'message'
           AND role IN ('user', 'assistant') AND status != 'error' AND length(content) > 0
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(run.conversation_id, run.context_epoch_id) as Array<{
      role: "user" | "assistant"
      content: string
    }>
    const selected: ChatMessageInput[] = []
    let characters = 0
    for (const row of rows) {
      if (
        selected.length >= MAX_CONTEXT_MESSAGES ||
        characters + row.content.length > MAX_CONTEXT_CHARACTERS
      )
        break
      selected.push({ role: row.role, content: row.content })
      characters += row.content.length
    }
    return selected.reverse()
  }

  recordTaskEvent(runId: string, event: ChatStreamEvent): void {
    if (event.type === "operation-progress") return
    this.transaction(() => {
      const run = this.db
        .prepare(
          `SELECT conversation_id, turn_id, assistant_item_id, context_epoch_id
           FROM conversation_runs WHERE run_id = ?`,
        )
        .get(runId) as
        | {
            conversation_id: string
            turn_id: string
            assistant_item_id: string
            context_epoch_id: string
          }
        | undefined
      if (!run) return
      const now = Date.now()
      if (event.type === "chunk") {
        this.db
          .prepare(
            `UPDATE conversation_items SET content = content || ?, status = 'streaming', updated_at = ?
             WHERE item_id = ?`,
          )
          .run(event.content, now, run.assistant_item_id)
      } else if (event.type === "task-state") {
        this.setRunState(runId, event.state, now)
      } else if (event.type === "tool") {
        this.insertEventItem(run, "tool", event.name, event.detail, now)
      } else if (event.type === "capability-request") {
        this.insertEventItem(run, "capability-request", "请求授权", JSON.stringify(event), now)
      } else if (event.type === "approval-request") {
        this.insertEventItem(
          run,
          "approval-request",
          "等待操作确认",
          JSON.stringify(event.request),
          now,
        )
      } else if (event.type === "operation-result") {
        this.insertEventItem(
          run,
          "operation-result",
          event.result.content,
          event.result.detail,
          now,
        )
      } else if (event.type === "done") {
        this.completeAssistant(run.assistant_item_id, "complete", now)
        this.setRunState(runId, "completed", now)
      } else if (event.type === "cancelled") {
        this.completeAssistant(run.assistant_item_id, "interrupted", now)
        this.setRunState(runId, "cancelled", now)
      } else if (event.type === "error") {
        this.db
          .prepare(
            `UPDATE conversation_items
             SET status = 'error', content = CASE WHEN length(content) = 0 THEN ? ELSE content END,
                 detail = ?, updated_at = ? WHERE item_id = ?`,
          )
          .run(event.message, event.message, now, run.assistant_item_id)
        this.setRunState(runId, "failed", now)
      }
      this.touchConversation(run.conversation_id, undefined, now)
    })
  }

  clearContext(request: ClearContextRequest): ConversationDetail {
    if (!isIdentifier(request.conversationId)) throw new TypeError("conversationId 无效")
    return this.transaction(() => {
      const conversation = this.requireRow(request.conversationId)
      if (conversation.revision !== request.expectedRevision)
        throw new ConversationConflictError("会话已更新，请刷新后重试。")
      if (this.hasActiveRun(request.conversationId))
        throw new ConversationConflictError("请先取消并等待当前任务结束，再清空上下文。")
      const now = Date.now()
      const nextEpochId = randomUUID()
      const sequence =
        ((
          this.db
            .prepare(
              `SELECT MAX(sequence) as sequence FROM context_epochs WHERE conversation_id = ?`,
            )
            .get(request.conversationId) as { sequence: number | null }
        ).sequence ?? 0) + 1
      this.db
        .prepare(
          `INSERT INTO context_epochs (context_epoch_id, conversation_id, sequence, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(nextEpochId, request.conversationId, sequence, now)
      this.db
        .prepare(`UPDATE conversations SET active_context_epoch_id = ? WHERE conversation_id = ?`)
        .run(nextEpochId, request.conversationId)
      this.insertItem({
        itemId: randomUUID(),
        conversationId: request.conversationId,
        contextEpochId: nextEpochId,
        kind: "context-cleared",
        status: "complete",
        content: "已清空后续模型上下文；上方历史仍会保留。",
        now,
      })
      this.touchConversation(request.conversationId, undefined, now)
      return this.require(request.conversationId)
    })
  }

  undoClearContext(conversationId: string): ConversationDetail | null {
    if (!isIdentifier(conversationId)) throw new TypeError("conversationId 无效")
    return this.transaction(() => {
      const current = this.requireRow(conversationId)
      const epoch = this.db
        .prepare(`SELECT context_epoch_id, sequence FROM context_epochs WHERE context_epoch_id = ?`)
        .get(current.active_context_epoch_id) as
        { context_epoch_id: string; sequence: number } | undefined
      if (!epoch || epoch.sequence <= 1) return null
      const itemCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM conversation_items
             WHERE context_epoch_id = ? AND kind != 'context-cleared'`,
          )
          .get(epoch.context_epoch_id) as { count: number }
      ).count
      if (itemCount > 0) return null
      const previous = this.db
        .prepare(
          `SELECT context_epoch_id FROM context_epochs WHERE conversation_id = ? AND sequence = ?`,
        )
        .get(conversationId, epoch.sequence - 1) as { context_epoch_id: string } | undefined
      if (!previous) return null
      this.db
        .prepare(`DELETE FROM conversation_items WHERE context_epoch_id = ?`)
        .run(epoch.context_epoch_id)
      this.db
        .prepare(`DELETE FROM context_epochs WHERE context_epoch_id = ?`)
        .run(epoch.context_epoch_id)
      const now = Date.now()
      this.db
        .prepare(`UPDATE conversations SET active_context_epoch_id = ? WHERE conversation_id = ?`)
        .run(previous.context_epoch_id, conversationId)
      this.touchConversation(conversationId, undefined, now)
      return this.require(conversationId)
    })
  }

  contextPreview(conversationId: string): ContextPreview | null {
    const conversation = this.requireRowOrNull(conversationId)
    if (!conversation) return null
    const rows = this.getContextRows(conversationId, conversation.active_context_epoch_id)
    return {
      conversationId,
      contextEpochId: conversation.active_context_epoch_id,
      messageCount: rows.length,
      characterCount: rows.reduce((total, row) => total + row.content.length, 0),
    }
  }

  recordTerminalRun(input: TerminalRunLedgerInput): void {
    const redacted = redactOutput(input.outputRedacted)
    const redactedBytes = Buffer.byteLength(redacted, "utf8")
    const outputRedacted = Buffer.from(redacted, "utf8").subarray(0, 256_000).toString("utf8")
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO terminal_runs
            (run_id, operation_id, task_id, conversation_id, intent_kind, intent_action,
             argv_json, cwd_relative, plan_digest, fingerprint, status, exit_code, policy_code,
             duration_ms, output_bytes, output_redacted, truncated, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.operationId,
          input.taskId,
          input.conversationId ?? null,
          input.intentKind,
          input.intentAction ?? null,
          JSON.stringify(input.argv),
          input.cwdRelative,
          input.planDigest,
          input.fingerprint,
          input.status,
          input.exitCode ?? null,
          input.policyCode ?? null,
          input.durationMs,
          input.outputBytes,
          outputRedacted,
          input.truncated || redactedBytes > 256_000 ? 1 : 0,
          input.startedAt,
          input.finishedAt,
        )
      this.db
        .prepare(`DELETE FROM terminal_runs WHERE finished_at < ?`)
        .run(Date.now() - 30 * 24 * 60 * 60 * 1_000)
      this.db
        .prepare(
          `DELETE FROM terminal_runs WHERE run_id IN
             (SELECT run_id FROM terminal_runs ORDER BY finished_at DESC LIMIT -1 OFFSET 200)`,
        )
        .run()
    })
  }

  getTerminalRun(runId: string): TerminalRunLedgerRecord | null {
    const row = this.db.prepare(`SELECT * FROM terminal_runs WHERE run_id = ?`).get(runId) as
      TerminalRunRow | undefined
    return row ? this.toTerminalRun(row) : null
  }

  searchTerminalRuns(query = "", limit = 50): TerminalRunLedgerRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const pattern = `%${query.trim()}%`
    return (
      this.db
        .prepare(
          `SELECT * FROM terminal_runs
         WHERE intent_kind LIKE ? OR intent_action LIKE ? OR status LIKE ? OR output_redacted LIKE ?
            OR CAST(finished_at AS TEXT) LIKE ?
         ORDER BY finished_at DESC LIMIT ?`,
        )
        .all(pattern, pattern, pattern, pattern, pattern, safeLimit) as TerminalRunRow[]
    ).map((row) => this.toTerminalRun(row))
  }

  diffTerminalRuns(
    leftRunId: string,
    rightRunId: string,
  ): { left: string; right: string; different: boolean } | null {
    const left = this.getTerminalRun(leftRunId)
    const right = this.getTerminalRun(rightRunId)
    if (!left || !right) return null
    return {
      left: left.outputRedacted,
      right: right.outputRedacted,
      different: left.outputRedacted !== right.outputRedacted,
    }
  }

  importLegacy(
    messages: Array<{ id: string; role: "user" | "assistant" | "error"; content: string }>,
  ): ConversationDetail | null {
    if (!Array.isArray(messages) || messages.length === 0) return null
    return this.transaction(() => {
      const imported = this.db
        .prepare(
          `SELECT conversation_id FROM legacy_imports WHERE migration_key = 'renderer-localstorage-v1'`,
        )
        .get() as { conversation_id: string } | undefined
      if (imported) return this.get(imported.conversation_id)
      const now = Date.now()
      const conversationId = randomUUID()
      const epochId = randomUUID()
      this.db
        .prepare(
          `INSERT INTO conversations
            (conversation_id, title, active_context_epoch_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(conversationId, "已迁入的对话", epochId, now, now)
      this.db
        .prepare(
          `INSERT INTO context_epochs (context_epoch_id, conversation_id, sequence, created_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run(epochId, conversationId, now)
      for (const message of messages.slice(-200)) {
        if (!isIdentifier(message.id) || !["user", "assistant", "error"].includes(message.role))
          continue
        if (typeof message.content !== "string" || message.content.length > 20_000) continue
        this.insertItem({
          itemId: randomUUID(),
          conversationId,
          contextEpochId: epochId,
          kind: "message",
          role: message.role === "user" ? "user" : "assistant",
          status: message.role === "error" ? "error" : "complete",
          content: message.content,
          now,
        })
      }
      this.db
        .prepare(
          `INSERT INTO legacy_imports (migration_key, conversation_id, imported_at) VALUES (?, ?, ?)`,
        )
        .run("renderer-localstorage-v1", conversationId, now)
      this.touchConversation(conversationId, undefined, now)
      return this.require(conversationId)
    })
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        active_context_epoch_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS context_epochs (
        context_epoch_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(conversation_id, sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        context_epoch_id TEXT NOT NULL REFERENCES context_epochs(context_epoch_id),
        client_request_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_runs (
        run_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        context_epoch_id TEXT,
        assistant_item_id TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_items (
        item_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        turn_id TEXT,
        run_id TEXT,
        context_epoch_id TEXT NOT NULL REFERENCES context_epochs(context_epoch_id),
        kind TEXT NOT NULL,
        role TEXT,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversation_items_timeline_idx
        ON conversation_items(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS conversation_items_context_idx
        ON conversation_items(conversation_id, context_epoch_id, created_at);
      CREATE TABLE IF NOT EXISTS terminal_runs (
        run_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        conversation_id TEXT,
        intent_kind TEXT NOT NULL,
        intent_action TEXT,
        argv_json TEXT NOT NULL,
        cwd_relative TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        policy_code TEXT,
        duration_ms INTEGER NOT NULL,
        output_bytes INTEGER NOT NULL,
        output_redacted TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS terminal_runs_finished_idx
        ON terminal_runs(finished_at DESC);
      CREATE INDEX IF NOT EXISTS terminal_runs_intent_idx
        ON terminal_runs(intent_kind, intent_action, finished_at DESC);
      CREATE TABLE IF NOT EXISTS legacy_imports (
        migration_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        imported_at INTEGER NOT NULL
      ) STRICT;
    `)
  }

  private recoverInterruptedRuns(): void {
    const now = Date.now()
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE conversation_items SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'`,
        )
        .run(now)
      this.db
        .prepare(
          `UPDATE conversation_runs SET state = 'interrupted', updated_at = ?
           WHERE state NOT IN ('completed', 'failed', 'cancelled')`,
        )
        .run(now)
    })
  }

  private getContextRows(conversationId: string, epochId: string): Array<{ content: string }> {
    return this.db
      .prepare(
        `SELECT content FROM conversation_items
         WHERE conversation_id = ? AND context_epoch_id = ? AND kind = 'message'
           AND role IN ('user', 'assistant') AND status != 'error' AND length(content) > 0
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(conversationId, epochId, MAX_CONTEXT_MESSAGES) as Array<{ content: string }>
  }

  private hasActiveRun(conversationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM conversation_runs WHERE conversation_id = ?
         AND state NOT IN ('completed', 'failed', 'cancelled', 'interrupted') LIMIT 1`,
      )
      .get(conversationId)
    return Boolean(row)
  }

  private completeAssistant(itemId: string, status: ConversationItemStatus, now: number): void {
    this.db
      .prepare(`UPDATE conversation_items SET status = ?, updated_at = ? WHERE item_id = ?`)
      .run(status, now, itemId)
  }

  private setRunState(runId: string, state: TaskState, now: number): void {
    this.db
      .prepare(`UPDATE conversation_runs SET state = ?, updated_at = ? WHERE run_id = ?`)
      .run(state, now, runId)
  }

  private insertEventItem(
    run: { conversation_id: string; turn_id: string; context_epoch_id: string },
    kind: ConversationItemKind,
    content: string,
    detail: string,
    now: number,
  ): void {
    this.insertItem({
      itemId: randomUUID(),
      conversationId: run.conversation_id,
      turnId: run.turn_id,
      contextEpochId: run.context_epoch_id,
      kind,
      status: "complete",
      content,
      detail,
      now,
    })
  }

  private insertItem(input: {
    itemId: string
    conversationId: string
    turnId?: string
    runId?: string
    contextEpochId: string
    kind: ConversationItemKind
    role?: "user" | "assistant" | "system"
    status: ConversationItemStatus
    content: string
    detail?: string
    now: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_items
          (item_id, conversation_id, turn_id, run_id, context_epoch_id, kind, role, status,
           content, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.itemId,
        input.conversationId,
        input.turnId ?? null,
        input.runId ?? null,
        input.contextEpochId,
        input.kind,
        input.role ?? null,
        input.status,
        input.content,
        input.detail ?? null,
        input.now,
        input.now,
      )
  }

  private toTerminalRun(row: TerminalRunRow): TerminalRunLedgerRecord {
    let argv: string[] = []
    try {
      const parsed: unknown = JSON.parse(row.argv_json)
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
        argv = parsed
      }
    } catch {
      argv = []
    }
    return {
      runId: row.run_id,
      operationId: row.operation_id,
      taskId: row.task_id,
      ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
      intentKind: row.intent_kind,
      ...(row.intent_action === null ? {} : { intentAction: row.intent_action }),
      argv,
      cwdRelative: row.cwd_relative,
      planDigest: row.plan_digest,
      fingerprint: row.fingerprint,
      status: row.status as OperationResult["status"],
      ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
      ...(row.policy_code === null ? {} : { policyCode: row.policy_code as TerminalPolicyCode }),
      durationMs: row.duration_ms,
      outputBytes: row.output_bytes,
      outputRedacted: row.output_redacted,
      truncated: row.truncated === 1,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }
  }

  private touchConversation(conversationId: string, title: string | undefined, now: number): void {
    this.db
      .prepare(
        `UPDATE conversations SET revision = revision + 1, title = COALESCE(?, title), updated_at = ?
         WHERE conversation_id = ?`,
      )
      .run(title ?? null, now, conversationId)
  }

  private require(conversationId: string): ConversationDetail {
    const conversation = this.get(conversationId)
    if (!conversation) throw new Error("会话不存在")
    return conversation
  }

  private requireRow(conversationId: string): ConversationRow {
    const row = this.requireRowOrNull(conversationId)
    if (!row) throw new Error("会话不存在")
    return row
  }

  private requireRowOrNull(conversationId: string): ConversationRow | null {
    if (!isIdentifier(conversationId)) return null
    return (
      (this.db
        .prepare(
          `SELECT conversation_id, title, active_context_epoch_id, revision, created_at, updated_at, archived_at
           FROM conversations WHERE conversation_id = ?`,
        )
        .get(conversationId) as ConversationRow | undefined) ?? null
    )
  }

  private toSummary(row: ConversationRow): ConversationSummary {
    return {
      conversationId: row.conversation_id,
      title: row.title,
      activeContextEpochId: row.active_context_epoch_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    }
  }

  private toItem(row: ItemRow): ConversationItem {
    return {
      itemId: row.item_id,
      conversationId: row.conversation_id,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      contextEpochId: row.context_epoch_id,
      kind: row.kind,
      ...(row.role ? { role: row.role } : {}),
      status: row.status,
      content: row.content,
      ...(row.detail ? { detail: row.detail } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private assertSubmitRequest(request: ConversationSubmitRequest): void {
    if (
      !request ||
      !isIdentifier(request.conversationId) ||
      !isIdentifier(request.clientRequestId) ||
      !isIdentifier(request.expectedContextEpochId) ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      typeof request.content !== "string" ||
      request.content.trim().length === 0 ||
      request.content.length > 20_000
    ) {
      throw new TypeError("会话提交参数无效")
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}

export class ConversationConflictError extends Error {}

function makeTitle(content: string): string {
  const firstLine = content.trim().replace(/\s+/g, " ").slice(0, 40)
  return firstLine || "新对话"
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120
}
