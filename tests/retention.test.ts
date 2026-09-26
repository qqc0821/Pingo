import assert from "node:assert/strict"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AuditLogger } from "../src/main/security/auditLogger.js"
import { UndoManager } from "../src/main/tasks/undoManager.js"

test("undo entries expire with their retained task window", () => {
  const manager = new UndoManager()
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    manager.register({
      undoId: "undo-1",
      taskId: "task-1",
      sourceWindowId: "window",
      kind: "write_file",
      targets: ["/project/file"],
      preview: "undo",
      run: async () => {},
    })
    assert.ok(manager.get("undo-1", "task-1", "window"))
    now += 30 * 60 * 1_000 + 1
    assert.equal(manager.get("undo-1", "task-1", "window"), undefined)
  } finally {
    Date.now = originalNow
  }
})

test("audit data stays bounded after many records", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-audit-"))
  const path = join(root, "audit.jsonl")
  const audit = new AuditLogger(path)
  const targets = Array.from({ length: 32 }, (_, index) => `/project/${index}-${"x".repeat(950)}`)
  for (let index = 0; index < 90; index += 1) {
    audit.record({ taskId: `task-${index}`, kind: "write_file", targets, status: "completed" })
  }
  assert.ok(statSync(path).size <= 2_000_000)
  assert.ok(audit.list().length > 0)
})
