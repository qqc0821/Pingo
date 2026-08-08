import { spawn } from "node:child_process"
import type { CommandPlan } from "../../shared/types.js"

const MAX_CONCURRENT_PROCESSES = 2
const KILL_GRACE_MS = 250

export interface TerminalRunResult {
  content: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  truncated: boolean
  durationMs: number
}

export interface TerminalRunOptions {
  signal?: AbortSignal
}

export class TerminalRunner {
  private activeCount = 0
  private readonly children = new Set<ReturnType<typeof spawn>>()

  async run(plan: CommandPlan, options: TerminalRunOptions = {}): Promise<TerminalRunResult> {
    if (this.activeCount >= MAX_CONCURRENT_PROCESSES) throw new Error("Terminal 并发数已达上限")
    this.activeCount += 1
    const startedAt = Date.now()
    try {
      return await this.runProcess(plan, options, startedAt)
    } finally {
      this.activeCount -= 1
    }
  }

  cancelAll(): void {
    for (const child of this.children) killProcessTree(child)
  }

  private runProcess(
    plan: CommandPlan,
    options: TerminalRunOptions,
    startedAt: number,
  ): Promise<TerminalRunResult> {
    const environment = pickEnvironment(plan.envKeys)
    environment.GIT_PAGER = "cat"
    environment.GIT_EXTERNAL_DIFF = ""
    environment.GIT_CONFIG_NOSYSTEM = "1"
    environment.GIT_CONFIG_GLOBAL = "/dev/null"
    environment.GIT_TERMINAL_PROMPT = "0"

    return new Promise((resolve, reject) => {
      let output = ""
      let truncated = false
      let timedOut = false
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const child = spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
      this.children.add(child)
      const timeout = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
        killTimer = setTimeout(() => finish(undefined, null, "SIGKILL"), KILL_GRACE_MS)
      }, plan.timeoutMs)

      const finish = (
        error?: Error,
        code: number | null = null,
        signal: NodeJS.Signals | null = null,
      ) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        this.children.delete(child)
        if (error) reject(error)
        else {
          resolve({
            content: redactOutput(output),
            exitCode: code,
            signal,
            timedOut,
            truncated,
            durationMs: Date.now() - startedAt,
          })
        }
      }

      const append = (chunk: Buffer): void => {
        if (truncated) return
        const remaining = plan.outputLimitBytes - Buffer.byteLength(output, "utf8")
        if (chunk.byteLength > remaining) {
          output += chunk.subarray(0, Math.max(0, remaining)).toString("utf8")
          output += "\n[output truncated]"
          truncated = true
          killProcessTree(child)
          return
        }
        output += chunk.toString("utf8")
      }

      child.stdout?.on("data", append)
      child.stderr?.on("data", append)
      child.once("error", (error) =>
        finish(error instanceof Error ? error : new Error("进程启动失败")),
      )
      child.once("close", (code, signal) => finish(undefined, code, signal))
      if (options.signal) {
        const cancel = () => {
          killProcessTree(child)
          finish(new Error("Terminal 任务已取消"))
        }
        if (options.signal.aborted) cancel()
        else options.signal.addEventListener("abort", cancel, { once: true })
      }
    })
  }
}

function pickEnvironment(keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && key !== "MODEL_API_KEY") env[key] = value
  }
  return env
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.killed || child.pid === undefined) return
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM")
    else child.kill("SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // The process may have exited between the check and the signal.
    }
  }
}

function redactOutput(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/MODEL_API_KEY\s*=\s*[^\s]+/gi, "MODEL_API_KEY=[redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 128_000)
}
