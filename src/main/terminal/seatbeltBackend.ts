import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import type {
  OperationProgressEvent,
  ResolvedCommandPlan,
  TerminalPolicyFailure,
} from "../../shared/types.js"
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
  TerminalReadResult,
  TerminalRunOperation,
  TerminalRunResult,
  TerminalSessionStatus,
  TerminalSignal,
} from "./backend.js"
import { buildIsolatedEnvironment, prepareIsolatedDirectories } from "./isolatedEnvironment.js"
import { renderSeatbeltProfile } from "./sandboxProfile.js"
import { probeSeatbelt, SEATBELT_EXECUTABLE, type SandboxProbe } from "./sandboxProbe.js"
import { foldOutput, getSoftOutputLimit, redactOutput, StreamRedactor } from "./streamRedactor.js"

const KILL_GRACE_MS = 750

export interface SeatbeltBackendDependencies {
  probeSeatbelt?: (profilePath: string) => SandboxProbe
}

export class TerminalRunnerError extends Error {
  constructor(
    public readonly failure: TerminalPolicyFailure,
    cause?: unknown,
  ) {
    super(failure.message, cause instanceof Error ? { cause } : undefined)
    this.name = "TerminalRunnerError"
  }
}

type TerminationReason = "timeout" | "cancelled" | "output"

interface PendingClose {
  error?: Error
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * One sandboxed one-shot command session over the Seatbelt process primitive.
 * Owns profile materialization, the detached process group, bounded output
 * collection with redaction, timeout/cancellation escalation, and tree cleanup.
 */
export class LocalSeatbeltSession implements TerminalBackendSession {
  readonly pid?: number
  readonly motd = ""
  readonly operation: TerminalRunOperation

  private readonly plan: ResolvedCommandPlan
  private readonly child: ChildProcess
  private readonly onProgress?: (event: OperationProgressEvent) => void
  private readonly donePromise: Promise<TerminalRunResult>
  private readonly resolveDone: (result: TerminalRunResult) => void
  private readonly rejectDone: (error: Error) => void
  private readonly startedAt = Date.now()
  private readonly redactors = { stdout: new StreamRedactor(), stderr: new StreamRedactor() }

  private statusValue: TerminalSessionStatus = { kind: "running" }
  private stdout = ""
  private stderr = ""
  private retained = ""
  private pendingDelta = ""
  private outputBytes = 0
  private truncated = false
  private hardLimitExceeded = false
  private timedOut = false
  private cancelled = false
  private settled = false
  private seq = 0
  private terminationReason?: TerminationReason
  private terminatePromise?: Promise<void>
  private terminationComplete = false
  private pendingClose?: PendingClose
  private timeout?: ReturnType<typeof setTimeout>
  private abortSignal?: AbortSignal
  private abortListener?: () => void

  constructor(
    spec: TerminalBackendSpawnSpec,
    probe: (profilePath: string) => SandboxProbe = probeSeatbelt,
  ) {
    this.plan = spec.plan
    this.onProgress = spec.onProgress

    let resolveDone!: (result: TerminalRunResult) => void
    let rejectDone!: (error: Error) => void
    this.donePromise = new Promise<TerminalRunResult>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.resolveDone = resolveDone
    this.rejectDone = rejectDone

    const plan = spec.plan
    const profileDirectory = plan.sandbox.tempRoot
    const profilePath = `${profileDirectory}/profile.sb`
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 })
    prepareIsolatedDirectories(plan)
    writeFileSync(profilePath, renderSeatbeltProfile(plan), { encoding: "utf8", mode: 0o600 })
    chmodSync(profilePath, 0o600)
    const probed = probe(profilePath)
    if (!probed.available) {
      cleanupTempRoot(plan)
      throw new TerminalRunnerError(
        failure("sandbox_unavailable", probed.reason ?? "Seatbelt 不可用", false, "stop"),
      )
    }

    const child = spawn(
      SEATBELT_EXECUTABLE,
      ["-f", profilePath, plan.executable.realPath, ...plan.argv],
      {
        cwd: plan.cwd.realPath,
        env: buildIsolatedEnvironment(plan),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    this.child = child
    this.pid = child.pid

    this.operation = {
      done: this.donePromise,
      readOutput: () => this.consumeDelta(),
      cancel: () => {
        if (this.settled) return false
        void this.terminate("cancelled")
        return true
      },
    }

    this.wire(child, spec.signal)
  }

  read(request: { offset?: number; count?: number } = {}): TerminalReadResult {
    const lines = this.retained.split("\n")
    const totalLines = this.retained.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("terminal read offset must be a non-negative safe integer")
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("terminal read count must be a positive safe integer")
    }
    if (offset >= totalLines) {
      return { text: "", totalLines, lineBegin: offset, lineEnd: offset, truncated: this.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const text = lines.slice(start, end).join("\n")
    return {
      text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + (text.length === 0 ? 0 : text.split("\n").length),
      truncated: this.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<void> {
    if (this.settled) return
    sendSignal(this.child, signal)
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    void reason
    if (this.settled) return Promise.resolve()
    return this.terminate("cancelled")
  }

  private consumeDelta(): { delta: string; truncated: boolean } {
    const delta = this.pendingDelta
    const truncated = this.truncated
    this.pendingDelta = ""
    return { delta, truncated }
  }

  private wire(child: ChildProcess, signal?: AbortSignal): void {
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (this.hardLimitExceeded) return
      const remaining = this.plan.limits.outputBytes - this.outputBytes
      if (chunk.byteLength > remaining) {
        const partial = chunk.subarray(0, Math.max(0, remaining)).toString("utf8")
        if (target === "stdout") this.stdout += partial
        else this.stderr += partial
        this.outputBytes = this.plan.limits.outputBytes
        this.truncated = true
        this.hardLimitExceeded = true
        this.emitProgress(target, this.redactors[target].push(partial))
        this.terminateFor("output")
        return
      }
      this.outputBytes += chunk.byteLength
      const value = chunk.toString("utf8")
      if (target === "stdout") this.stdout += value
      else this.stderr += value
      this.emitProgress(target, this.redactors[target].push(value))
      if (this.outputBytes > getSoftOutputLimit(this.plan)) this.truncated = true
    }

    this.timeout = setTimeout(() => this.terminateFor("timeout"), this.plan.limits.timeoutMs)
    this.abortSignal = signal
    this.abortListener = () => this.terminateFor("cancelled")
    if (signal) {
      if (signal.aborted) this.abortListener()
      else signal.addEventListener("abort", this.abortListener, { once: true })
    }
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk))
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk))
    child.once("error", (error) =>
      this.settle(error instanceof Error ? error : new Error("进程启动失败")),
    )
    child.once("close", (code, signal) => this.settle(undefined, code, signal))
  }

  private emitProgress(stream: "stdout" | "stderr", content: string): void {
    if (content) {
      this.pendingDelta += content
      this.retained += content
    }
    if (!content || !this.onProgress) return
    this.onProgress({
      type: "operation-progress",
      operationId: this.plan.operationId,
      taskId: this.plan.taskId,
      stream,
      seq: this.seq,
      content,
      truncatedSoFar: this.truncated,
    })
    this.seq += 1
  }

  private terminateFor(reason: TerminationReason): void {
    if (reason === "timeout") this.timedOut = true
    if (reason === "cancelled") this.cancelled = true
    if (reason === "output") this.truncated = true
    void this.terminate(reason)
  }

  private terminate(reason: TerminationReason): Promise<void> {
    if (this.terminatePromise) return this.terminatePromise
    this.terminationReason = reason
    this.terminatePromise = new Promise<void>((resolve) => {
      const child = this.child
      sendSignal(child, "SIGTERM")
      setTimeout(async () => {
        // The sandbox-exec wrapper can exit on SIGTERM while descendants
        // remain alive. Always send SIGKILL to the original process group,
        // even when the wrapper already reported a close event.
        sendSignal(child, "SIGKILL")
        await waitForProcessGroupExit(child.pid)
        this.terminationComplete = true
        const close = this.pendingClose
        this.settle(close?.error, close?.code ?? null, "SIGKILL")
        resolve()
      }, KILL_GRACE_MS)
    })
    return this.terminatePromise
  }

  private settle(
    error?: Error,
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
  ): void {
    if (this.terminatePromise && !this.terminationComplete) {
      this.pendingClose = { error, code, signal }
      return
    }
    if (this.settled) return
    this.settled = true
    if (this.timeout) clearTimeout(this.timeout)
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener)
    }
    cleanupTempRoot(this.plan)
    if (error) {
      this.rejectDone(error)
      return
    }
    this.emitProgress("stdout", this.redactors.stdout.flush())
    this.emitProgress("stderr", this.redactors.stderr.flush())
    this.timedOut = this.timedOut || this.terminationReason === "timeout"
    this.cancelled = this.cancelled || this.terminationReason === "cancelled"
    this.truncated = this.truncated || this.terminationReason === "output"
    const content = foldOutput(
      redactOutput([this.stdout, this.stderr].filter(Boolean).join("\n")),
      getSoftOutputLimit(this.plan),
    )
    this.statusValue = { kind: "exited", exitCode: code, signal }
    this.resolveDone({
      content,
      exitCode: code,
      signal,
      timedOut: this.timedOut,
      cancelled: this.cancelled,
      truncated: this.truncated,
      hardLimitExceeded: this.hardLimitExceeded,
      outputBytes: this.outputBytes,
      durationMs: Date.now() - this.startedAt,
    })
  }
}

/** Local Seatbelt command backend registered under the configured type. */
export class SeatbeltTerminalBackend implements TerminalBackend {
  readonly type = "seatbelt"

  constructor(private readonly dependencies: SeatbeltBackendDependencies = {}) {}

  spawn(spec: TerminalBackendSpawnSpec): TerminalBackendSession {
    return new LocalSeatbeltSession(spec, this.dependencies.probeSeatbelt)
  }
}

async function waitForProcessGroupExit(pid: number | undefined): Promise<void> {
  if (pid === undefined || process.platform === "win32") return
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (isNoSuchProcess(error)) return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process may have exited between the group and child signal.
    }
  }
}

function cleanupTempRoot(plan: ResolvedCommandPlan): void {
  try {
    rmSync(plan.sandbox.tempRoot, { recursive: true, force: true })
  } catch {
    // Cleanup is best effort; the profile/temp root is operation-scoped.
  }
}

function failure(
  code: TerminalPolicyFailure["code"],
  message: string,
  retryable: boolean,
  requiredAction?: TerminalPolicyFailure["requiredAction"],
): TerminalPolicyFailure {
  return { code, policy_code: code, message, retryable, requiredAction }
}
