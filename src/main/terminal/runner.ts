import type { ResolvedCommandPlan } from "../../shared/types.js"
import type { TerminalBackendSession, TerminalRunOptions, TerminalRunResult } from "./backend.js"
import {
  SeatbeltTerminalBackend,
  TerminalRunnerError,
  type SeatbeltBackendDependencies,
} from "./seatbeltBackend.js"
import type { SandboxProbe } from "./sandboxProbe.js"

export { TerminalRunnerError }
export type { TerminalRunResult, TerminalRunOptions }

/**
 * Thin compatibility facade over {@link SeatbeltTerminalBackend}. Kept so direct
 * one-shot callers (integration tests) can run a single command without going
 * through {@link TerminalSessionService}; production orchestration uses the
 * session registry instead.
 */
export interface TerminalRunnerDependencies {
  probeSeatbelt?: (profilePath: string) => SandboxProbe
}

interface ActiveEntry {
  taskId: string
  session: TerminalBackendSession
}

export class TerminalRunner {
  private readonly backend: SeatbeltTerminalBackend
  private readonly active = new Map<string, ActiveEntry>()

  constructor(dependencies: TerminalRunnerDependencies = {}) {
    const backendDeps: SeatbeltBackendDependencies = {}
    if (dependencies.probeSeatbelt) backendDeps.probeSeatbelt = dependencies.probeSeatbelt
    this.backend = new SeatbeltTerminalBackend(backendDeps)
  }

  async run(
    plan: ResolvedCommandPlan,
    options: TerminalRunOptions = {},
  ): Promise<TerminalRunResult> {
    const session = this.backend.spawn({
      sessionId: plan.operationId,
      owner: plan.taskId,
      type: "seatbelt",
      plan,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    })
    this.active.set(plan.operationId, { taskId: plan.taskId, session })
    const done = session.operation.done
    void done.then(
      () => this.active.delete(plan.operationId),
      () => this.active.delete(plan.operationId),
    )
    return done
  }

  async cancel(taskId: string, operationId: string): Promise<boolean> {
    const active = this.active.get(operationId)
    if (!active || active.taskId !== taskId) return false
    await active.session.close("cancelled")
    return true
  }

  async cancelAll(): Promise<void> {
    const entries = [...this.active.values()]
    await Promise.all(entries.map((entry) => entry.session.close("cancelled")))
    this.active.clear()
  }

  hasActive(operationId: string): boolean {
    return this.active.has(operationId)
  }
}
