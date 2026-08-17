import type { OperationProgressEvent, ResolvedCommandPlan } from "../../shared/types.js"

/**
 * Signals the one-shot command session accepts. Kept a plain union because Pingo's
 * seatbelt process is a detached process group; the backend maps these to the
 * same process-group signalling used for timeout/cancellation.
 */
export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP"

/** Stable machine-routable failure codes, aligned with DeepSeek Harness's terminal seam. */
export type TerminalErrorCode =
  | "NO_BACKEND"
  | "DUPLICATE_BACKEND"
  | "DUPLICATE_NAME"
  | "NO_SESSION"
  | "FOREIGN_SESSION"
  | "SEND_ACTIVE"
  | "SERVICE_DISPOSING"
  | "OWNER_NOT_LIVE"
  | "LIMIT_REACHED"

/** Error carrying a stable {@link TerminalErrorCode}, mirroring DSH's TerminalError. */
export class TerminalError extends Error {
  constructor(
    message: string,
    readonly code: TerminalErrorCode,
  ) {
    super(message)
    this.name = "TerminalError"
  }
}

/** Settled result for one command session, reused unchanged from the original runner. */
export interface TerminalRunResult {
  content: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  hardLimitExceeded: boolean
  outputBytes: number
  durationMs: number
}

/** Options controlling one command execution. */
export interface TerminalRunOptions {
  signal?: AbortSignal
  onProgress?: (event: OperationProgressEvent) => void
}

/** Request to create one owner-scoped command session. */
export interface TerminalSpawnRequest {
  /** Registered backend type. */
  type: string
  /** Optional owner-local display name, unique per owner. */
  name?: string
  /** Fully resolved, frozen command plan the backend executes. */
  plan: ResolvedCommandPlan
  /** Streamed progress sink (push-based; Pingo renders progress cards). */
  onProgress?: (event: OperationProgressEvent) => void
}

/** Fully identified request handed from the registry to a backend. */
export interface TerminalBackendSpawnSpec {
  /** Registry-minted session identity. */
  sessionId: string
  /** Exact owner (Pingo taskId) for authority-aware cleanup. */
  owner: string
  type: string
  name?: string
  plan: ResolvedCommandPlan
  signal?: AbortSignal
  onProgress?: (event: OperationProgressEvent) => void
}

/** Live backend-owned run; exactly one per session. */
export interface TerminalRunOperation {
  /** Resolves when the command settles (exit, timeout, cancellation, or output limit). */
  done: Promise<TerminalRunResult>
  /** Consume redacted output produced since the prior call. */
  readOutput(): { delta: string; truncated: boolean }
  /** Request cancellation; returns false after the operation settled. */
  cancel(): boolean
}

/** Top-level command status. */
export type TerminalSessionStatus =
  { kind: "running" } | { kind: "exited"; exitCode: number | null; signal: NodeJS.Signals | null }

/** Bounded retained-output page. */
export interface TerminalReadResult {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}

/** Owner-visible summary of one published command session. */
export interface TerminalSessionSnapshot {
  sessionId: string
  name?: string
  type: string
  pid?: number
  status: TerminalSessionStatus
  planDigest: string
  intentKind: string
}

/** Backend-owned live session retained by {@link TerminalSessionService}. */
export interface TerminalBackendSession {
  /** Initial bounded output captured at spawn; empty for one-shot sessions. */
  readonly motd: string
  /** Top-level process id when one exists. */
  readonly pid?: number
  /** The live run, started when the backend spawned the session. */
  readonly operation: TerminalRunOperation
  /** Read one bounded page from retained output. */
  read(request: { offset?: number; count?: number }): TerminalReadResult
  /** Deliver a signal to the captured process group. */
  signal(signal: TerminalSignal): Promise<void>
  /** Observe top-level process status. */
  status(): TerminalSessionStatus
  /** Idempotently terminate the captured process tree and await quiescence. */
  close(reason: string): Promise<void>
}

/** Replaceable provider for one command-session type. */
export interface TerminalBackend {
  /** Stable type selected by {@link TerminalSpawnRequest.type}. */
  readonly type: string
  /** Allocate and start a command session; throws after cleaning partial resources. */
  spawn(spec: TerminalBackendSpawnSpec): TerminalBackendSession
}
