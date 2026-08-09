import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import type {
  OperationProgressEvent,
  ResolvedCommandPlan,
  TerminalPolicyFailure,
} from "../../shared/types.js"
import { buildIsolatedEnvironment, prepareIsolatedDirectories } from "./isolatedEnvironment.js"
import { renderSeatbeltProfile } from "./sandboxProfile.js"
import { probeSeatbelt, SEATBELT_EXECUTABLE, type SandboxProbe } from "./sandboxProbe.js"
import { foldOutput, getSoftOutputLimit, redactOutput, StreamRedactor } from "./streamRedactor.js"

const MAX_CONCURRENT_PROCESSES = 2
const KILL_GRACE_MS = 750

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

export interface TerminalRunOptions {
  signal?: AbortSignal
  onProgress?: (event: OperationProgressEvent) => void
}

export interface TerminalRunnerDependencies {
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

interface ActiveOperation {
  taskId: string
  operationId: string
  child: ChildProcess
  terminatePromise?: Promise<void>
  terminationComplete?: boolean
  pendingClose?: { error?: Error; code: number | null; signal: NodeJS.Signals | null }
  onTerminationComplete?: () => void
  terminationReason?: "timeout" | "cancelled" | "output"
}

export class TerminalRunner {
  private readonly active = new Map<string, ActiveOperation>()

  constructor(private readonly dependencies: TerminalRunnerDependencies = {}) {}

  async run(
    plan: ResolvedCommandPlan,
    options: TerminalRunOptions = {},
  ): Promise<TerminalRunResult> {
    if (this.active.size >= MAX_CONCURRENT_PROCESSES) {
      throw new TerminalRunnerError(
        failure("command_forbidden", "Terminal 并发数已达上限", true, "ask_user"),
      )
    }
    return this.runProcess(plan, options)
  }

  async cancel(taskId: string, operationId: string): Promise<boolean> {
    const active = this.active.get(operationId)
    if (!active || active.taskId !== taskId) return false
    await this.terminate(active, "cancelled")
    return true
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.active.values()].map((active) => this.terminate(active, "cancelled")),
    )
  }

  hasActive(operationId: string): boolean {
    return this.active.has(operationId)
  }

  private runProcess(
    plan: ResolvedCommandPlan,
    options: TerminalRunOptions,
  ): Promise<TerminalRunResult> {
    const startedAt = Date.now()
    const profileDirectory = plan.sandbox.tempRoot
    const profilePath = `${profileDirectory}/profile.sb`
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 })
    prepareIsolatedDirectories(plan)
    writeFileSync(profilePath, renderSeatbeltProfile(plan), { encoding: "utf8", mode: 0o600 })
    chmodSync(profilePath, 0o600)
    const probe = (this.dependencies.probeSeatbelt ?? probeSeatbelt)(profilePath)
    if (!probe.available) {
      cleanupTempRoot(plan)
      throw new TerminalRunnerError(
        failure("sandbox_unavailable", probe.reason ?? "Seatbelt 不可用", false, "stop"),
      )
    }

    return new Promise<TerminalRunResult>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let outputBytes = 0
      let truncated = false
      let hardLimitExceeded = false
      let seq = 0
      let timedOut = false
      let cancelled = false
      let settled = false
      const redactors = {
        stdout: new StreamRedactor(),
        stderr: new StreamRedactor(),
      }

      const emitProgress = (stream: "stdout" | "stderr", content: string): void => {
        if (!content || !options.onProgress) return
        options.onProgress({
          type: "operation-progress",
          operationId: plan.operationId,
          taskId: plan.taskId,
          stream,
          seq,
          content,
          truncatedSoFar: truncated,
        })
        seq += 1
      }

      const finish = (
        error?: Error,
        code: number | null = null,
        signal: NodeJS.Signals | null = null,
      ) => {
        if (active?.terminatePromise && !active.terminationComplete) {
          active.pendingClose = { error, code, signal }
          return
        }
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (options.signal && abortListener)
          options.signal.removeEventListener("abort", abortListener)
        if (active) this.active.delete(plan.operationId)
        cleanupTempRoot(plan)
        if (error) reject(error)
        else {
          emitProgress("stdout", redactors.stdout.flush())
          emitProgress("stderr", redactors.stderr.flush())
          timedOut = timedOut || active?.terminationReason === "timeout"
          cancelled = cancelled || active?.terminationReason === "cancelled"
          truncated = truncated || active?.terminationReason === "output"
          const content = foldOutput(
            redactOutput([stdout, stderr].filter(Boolean).join("\n")),
            getSoftOutputLimit(plan),
          )
          resolve({
            content,
            exitCode: code,
            signal,
            timedOut,
            cancelled,
            truncated,
            hardLimitExceeded,
            outputBytes,
            durationMs: Date.now() - startedAt,
          })
        }
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
      const active: ActiveOperation = { taskId: plan.taskId, operationId: plan.operationId, child }
      this.active.set(plan.operationId, active)
      active.onTerminationComplete = () => {
        const close = active?.pendingClose
        finish(close?.error, close?.code ?? null, "SIGKILL")
      }

      const terminateFor = (reason: "timeout" | "cancelled" | "output") => {
        if (reason === "timeout") timedOut = true
        if (reason === "cancelled") cancelled = true
        if (reason === "output") truncated = true
        if (active) void this.terminate(active, reason)
      }

      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        if (hardLimitExceeded) return
        const remaining = plan.limits.outputBytes - outputBytes
        if (chunk.byteLength > remaining) {
          const partial = chunk.subarray(0, Math.max(0, remaining)).toString("utf8")
          if (target === "stdout") stdout += partial
          else stderr += partial
          outputBytes = plan.limits.outputBytes
          truncated = true
          hardLimitExceeded = true
          emitProgress(target, redactors[target].push(partial))
          terminateFor("output")
          return
        }
        outputBytes += chunk.byteLength
        const value = chunk.toString("utf8")
        if (target === "stdout") stdout += value
        else stderr += value
        emitProgress(target, redactors[target].push(value))
        if (outputBytes > getSoftOutputLimit(plan)) truncated = true
      }

      const timeout = setTimeout(() => terminateFor("timeout"), plan.limits.timeoutMs)
      const abortListener = () => terminateFor("cancelled")
      if (options.signal) {
        if (options.signal.aborted) abortListener()
        else options.signal.addEventListener("abort", abortListener, { once: true })
      }
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk))
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk))
      child.once("error", (error) =>
        finish(error instanceof Error ? error : new Error("进程启动失败")),
      )
      child.once("close", (code, signal) => finish(undefined, code, signal))
    })
  }

  private async terminate(
    active: ActiveOperation,
    _reason: "timeout" | "cancelled" | "output",
  ): Promise<void> {
    if (active.terminatePromise) return active.terminatePromise
    active.terminationReason = _reason
    active.terminatePromise = new Promise<void>((resolve) => {
      const child = active.child
      sendSignal(child, "SIGTERM")
      setTimeout(async () => {
        // The sandbox-exec wrapper can exit on SIGTERM while descendants
        // remain alive. Always send SIGKILL to the original process group,
        // even when the wrapper already reported a close event.
        sendSignal(child, "SIGKILL")
        await waitForProcessGroupExit(child.pid)
        active.terminationComplete = true
        active.onTerminationComplete?.()
        resolve()
      }, KILL_GRACE_MS)
    })
    return active.terminatePromise
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
