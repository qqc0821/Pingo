import assert from "node:assert/strict"
import test from "node:test"
import { TerminalRunStore } from "../src/main/terminal/runStore.js"
import type { TerminalRunLedgerInput } from "../src/main/terminal/runStore.js"

test("terminal run store keeps redacted, bounded in-memory tool history", () => {
  const store = new TerminalRunStore()
  try {
    const base: TerminalRunLedgerInput = {
      runId: "run-base",
      operationId: "operation-base",
      taskId: "task-base",
      intentKind: "git.read",
      intentAction: "status",
      argv: ["--no-pager", "status"],
      cwdRelative: ".",
      planDigest: "a".repeat(64),
      fingerprint: "安静 绿色 松鼠",
      status: "completed",
      exitCode: 0,
      durationMs: 4,
      outputBytes: 24,
      outputRedacted: "first output",
      truncated: false,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    }
    for (let index = 0; index < 205; index += 1) {
      store.recordTerminalRun({
        ...base,
        runId: `run-${index}`,
        operationId: `operation-${index}`,
        outputRedacted:
          index === 204 ? `api_key=secret-${index}\n${"x".repeat(300_000)}` : `output-${index}`,
        truncated: index === 204,
        finishedAt: base.finishedAt + index,
      })
    }
    assert.equal(store.getTerminalRun("run-0"), null)
    const latest = store.getTerminalRun("run-204")
    assert.ok(latest)
    assert.equal(latest.truncated, true)
    assert.ok(latest.outputRedacted.length <= 256_000)
    assert.doesNotMatch(latest.outputRedacted, /secret-204/)

    store.recordTerminalRun({
      ...base,
      runId: "run-diff",
      operationId: "operation-diff",
      outputRedacted: "different output",
      finishedAt: base.finishedAt + 206,
    })
    const diff = store.diffTerminalRuns("run-204", "run-diff")
    assert.equal(diff?.different, true)
    assert.equal(diff?.right, "different output")
  } finally {
    store.close()
  }
})
