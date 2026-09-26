import assert from "node:assert/strict"
import test from "node:test"
import { projectTaskEvent } from "../src/renderer/src/taskEventProjection.js"

test("task event projection keeps the answer and marks the final card consistently", () => {
  let state = { response: "", operationResult: "", request: "文件在哪" }
  for (const event of [
    { type: "start" as const },
    { type: "chunk" as const, content: "在 src/main" },
  ]) {
    state = projectTaskEvent(state, event).state
  }
  const final = projectTaskEvent(state, { type: "done" })
  assert.equal(final.terminal, true)
  assert.equal(final.patch?.tone, "success")
  assert.equal(final.patch?.content, "在 src/main")
})

test("interrupted or failed operations are never projected as success", () => {
  const state = { response: "", operationResult: "", request: "写文件" }
  const failed = projectTaskEvent(state, { type: "error", message: "操作未完成" })
  assert.equal(failed.terminal, true)
  assert.equal(failed.patch?.tone, "error")
  const cancelled = projectTaskEvent(state, { type: "cancelled" })
  assert.equal(cancelled.patch?.label, "已取消")
})
