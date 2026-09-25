import type { ResolvedCommandPlan } from "../../shared/types.js"
import {
  TerminalError,
  type TerminalBackend,
  type TerminalBackendSession,
  type TerminalReadResult,
  type TerminalRunOperation,
  type TerminalSessionSnapshot,
  type TerminalSignal,
  type TerminalSpawnRequest,
} from "./backend.js"

export interface TerminalSpawnResult {
  snapshot: TerminalSessionSnapshot
  operation: TerminalRunOperation
}

interface SessionRecord {
  id: string
  owner: string
  name?: string
  type: string
  plan: ResolvedCommandPlan
  session: TerminalBackendSession
  closing?: Promise<void>
}

export interface TerminalSessionServiceDependencies {
  /** Maximum concurrently running command sessions; default 2. */
  maxConcurrent?: number
}

/**
 * In-process registry for replaceable command-session backends and owner-scoped
 * sessions. Mirrors DeepSeek Harness's {@code TerminalSessionService}: it owns
 * identity, publication, authorization, concurrency, and awaited cleanup, while
 * backends own the actual process mechanics. Owner is a Pingo {@code taskId}.
 */
export class TerminalSessionService {
  private readonly backends = new Map<string, TerminalBackend>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly reservedNames = new Map<string, Set<string>>()
  private readonly maxConcurrent: number
  private nextId = 0
  private disposing = false

  constructor(dependencies: TerminalSessionServiceDependencies = {}) {
    this.maxConcurrent = dependencies.maxConcurrent ?? 2
  }

  /** Register one backend type; returns a disposer that removes exactly this contribution. */
  registerBackend(backend: TerminalBackend): () => void {
    if (backend.type.length === 0) throw new Error("terminal backend type must be non-empty")
    if (this.backends.has(backend.type)) {
      throw new TerminalError(
        `a terminal backend named "${backend.type}" is already registered`,
        "DUPLICATE_BACKEND",
      )
    }
    this.backends.set(backend.type, backend)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.backends.get(backend.type) === backend) this.backends.delete(backend.type)
    }
  }

  /** List registered backend types in registration order. */
  listBackends(): string[] {
    return [...this.backends.keys()]
  }

  /**
   * Create and publish one owner-scoped command session. Fails with a stable
   * code on unknown backend, duplicate name, or concurrency exhaustion; rolls
   * back the backend session when publication or a later check fails.
   */
  async spawn(
    owner: string,
    request: TerminalSpawnRequest,
    signal?: AbortSignal,
  ): Promise<TerminalSpawnResult> {
    if (this.disposing) {
      throw new TerminalError("terminal service is disposing", "SERVICE_DISPOSING")
    }
    signal?.throwIfAborted?.()
    const backend = this.backends.get(request.type)
    if (backend === undefined) {
      throw new TerminalError(`no terminal backend registered for "${request.type}"`, "NO_BACKEND")
    }
    if (request.name !== undefined && request.name.length === 0) {
      throw new Error("terminal session name must be non-empty")
    }
    const releaseName = this.reserveName(owner, request.name)
    const sessionId = `term-${++this.nextId}`
    let session: TerminalBackendSession | undefined
    try {
      this.assertConcurrency()
      session = backend.spawn({
        sessionId,
        owner,
        type: request.type,
        ...(request.name !== undefined ? { name: request.name } : {}),
        plan: request.plan,
        ...(signal !== undefined ? { signal } : {}),
        ...(request.onProgress !== undefined ? { onProgress: request.onProgress } : {}),
      })
      if (this.disposing) {
        throw new TerminalError("terminal service is disposing", "SERVICE_DISPOSING")
      }
      const record: SessionRecord = {
        id: sessionId,
        owner,
        name: request.name,
        type: request.type,
        plan: request.plan,
        session,
      }
      this.sessions.set(sessionId, record)
      return { snapshot: this.snapshot(record), operation: session.operation }
    } catch (error) {
      if (session !== undefined && !this.sessions.has(sessionId)) {
        await session.close("spawn rolled back").catch(() => {})
      }
      throw error
    } finally {
      releaseName()
    }
  }

  /** List fresh snapshots for exactly one owner in publication order. */
  list(owner: string): TerminalSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((record) => record.owner === owner)
      .map((record) => this.snapshot(record))
  }

  /** Read one bounded retained-output page from an owned session. */
  read(
    owner: string,
    id: string,
    request: { offset?: number; count?: number } = {},
  ): TerminalReadResult {
    return this.expectOwned(owner, id).session.read(request)
  }

  /** Deliver an allowed signal through an owned backend session. */
  async signal(owner: string, id: string, signal: TerminalSignal): Promise<void> {
    await this.expectOwned(owner, id).session.signal(signal)
  }

  /**
   * Close one owned session and remove it only after quiescent backend cleanup.
   * Returns true for a newly closed session, false when the session is unknown
   * (already removed) or the same close is already in flight.
   */
  async kill(owner: string, id: string, reason = "model request"): Promise<boolean> {
    const record = this.sessions.get(id)
    if (record === undefined) return false
    if (record.owner !== owner) {
      throw new TerminalError(`terminal session ${id} belongs to another task`, "FOREIGN_SESSION")
    }
    if (record.closing !== undefined) {
      await record.closing
      return false
    }
    const closing = record.session.close(reason)
    record.closing = closing
    try {
      await closing
      this.sessions.delete(id)
      return true
    } catch (error) {
      record.closing = undefined
      throw error
    }
  }

  /** Test whether an exact owner has a published session. */
  hasOwnerActivity(owner: string): boolean {
    return [...this.sessions.values()].some((record) => record.owner === owner)
  }

  /** Terminate and remove every session owned by {@code owner}. */
  async disposeOwned(owner: string): Promise<void> {
    const records = [...this.sessions.values()].filter((record) => record.owner === owner)
    await this.closeRecords(records, "owner disposed")
    this.reservedNames.delete(owner)
  }

  /** Terminate every session and clear registrations; irreversible teardown. */
  async disposeAll(): Promise<void> {
    this.disposing = true
    try {
      await this.closeRecords([...this.sessions.values()], "service disposed")
    } finally {
      this.backends.clear()
      this.reservedNames.clear()
      this.sessions.clear()
    }
  }

  private assertConcurrency(): void {
    const running = [...this.sessions.values()].filter(
      (record) => record.session.status().kind === "running",
    ).length
    if (running >= this.maxConcurrent) {
      throw new TerminalError("terminal concurrency limit reached", "LIMIT_REACHED")
    }
  }

  private reserveName(owner: string, name: string | undefined): () => void {
    if (name === undefined) return () => {}
    if (
      [...this.sessions.values()].some((record) => record.owner === owner && record.name === name)
    ) {
      throw new TerminalError(
        `terminal session name "${name}" already exists for this owner`,
        "DUPLICATE_NAME",
      )
    }
    const reserved = this.reservedNames.get(owner) ?? new Set<string>()
    if (reserved.has(name)) {
      throw new TerminalError(
        `terminal session name "${name}" is already being created`,
        "DUPLICATE_NAME",
      )
    }
    reserved.add(name)
    this.reservedNames.set(owner, reserved)
    return () => {
      reserved.delete(name)
      if (reserved.size === 0) this.reservedNames.delete(owner)
    }
  }

  private expectOwned(owner: string, id: string): SessionRecord {
    const record = this.sessions.get(id)
    if (record === undefined) {
      throw new TerminalError(`unknown terminal session ${id}`, "NO_SESSION")
    }
    if (record.owner !== owner) {
      throw new TerminalError(`terminal session ${id} belongs to another task`, "FOREIGN_SESSION")
    }
    return record
  }

  private snapshot(record: SessionRecord): TerminalSessionSnapshot {
    return {
      sessionId: record.id,
      ...(record.name !== undefined ? { name: record.name } : {}),
      type: record.type,
      ...(record.session.pid !== undefined ? { pid: record.session.pid } : {}),
      status: record.session.status(),
      planDigest: record.plan.planDigest,
      intentKind: record.plan.intent.kind,
    }
  }

  private async closeRecords(records: SessionRecord[], reason: string): Promise<void> {
    const results = await Promise.allSettled(
      records.map(async (record) => {
        const closing = record.closing ?? record.session.close(reason)
        record.closing = closing
        try {
          await closing
          this.sessions.delete(record.id)
        } catch (error) {
          if (record.closing === closing) record.closing = undefined
          throw error
        }
      }),
    )
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => (result as PromiseRejectedResult).reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to close ${failures.length} terminal session(s)`)
    }
  }
}
