import type { TerminalRunRecord } from "../../shared/types.js"
import { redactOutput } from "./streamRedactor.js"

const MAX_RUNS = 200
const MAX_OUTPUT_BYTES = 256_000
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export type TerminalRunLedgerInput = TerminalRunRecord
export type TerminalRunLedgerRecord = TerminalRunRecord

/** In-memory terminal-run history used by the task controls during the current app session. */
export class TerminalRunStore {
  private readonly runs = new Map<string, TerminalRunRecord>()

  close(): void {
    this.runs.clear()
  }

  recordTerminalRun(input: TerminalRunLedgerInput): void {
    const redacted = redactOutput(input.outputRedacted)
    const redactedBytes = Buffer.byteLength(redacted, "utf8")
    const outputRedacted = Buffer.from(redacted, "utf8")
      .subarray(0, MAX_OUTPUT_BYTES)
      .toString("utf8")
    this.runs.set(input.runId, {
      ...input,
      argv: [...input.argv],
      outputRedacted,
      truncated: input.truncated || redactedBytes > MAX_OUTPUT_BYTES,
    })
    this.prune()
  }

  getTerminalRun(runId: string): TerminalRunRecord | null {
    const run = this.runs.get(runId)
    return run ? { ...run, argv: [...run.argv] } : null
  }

  /** Explicitly remove one run record; idempotent, returns whether it existed. */
  deleteTerminalRun(runId: string): boolean {
    return this.runs.delete(runId)
  }

  /** List every retained run, newest first (publication order reversed). */
  listTerminalRuns(): TerminalRunRecord[] {
    return [...this.runs.values()]
      .sort((left, right) => right.finishedAt - left.finishedAt)
      .map((run) => ({ ...run, argv: [...run.argv] }))
  }

  searchTerminalRuns(query = "", limit = 50): TerminalRunRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const needle = query.trim().toLocaleLowerCase()
    return [...this.runs.values()]
      .filter((run) => {
        if (!needle) return true
        return [
          run.intentKind,
          run.intentAction ?? "",
          run.status,
          run.outputRedacted,
          String(run.finishedAt),
        ].some((value) => value.toLocaleLowerCase().includes(needle))
      })
      .sort((left, right) => right.finishedAt - left.finishedAt)
      .slice(0, safeLimit)
      .map((run) => ({ ...run, argv: [...run.argv] }))
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

  private prune(): void {
    const cutoff = Date.now() - RUN_RETENTION_MS
    for (const [runId, run] of this.runs) {
      if (run.finishedAt < cutoff) this.runs.delete(runId)
    }
    const overflow = [...this.runs.values()]
      .sort((left, right) => right.finishedAt - left.finishedAt)
      .slice(MAX_RUNS)
    for (const run of overflow) this.runs.delete(run.runId)
  }
}
