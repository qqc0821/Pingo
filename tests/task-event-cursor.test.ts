import assert from "node:assert/strict"
import test from "node:test"
import { advanceTaskEventCursor } from "../src/shared/taskEventCursor.js"
import type { TaskEventEnvelope } from "../src/shared/types.js"

const event = (requestId: string, taskId: string, sequence: number): TaskEventEnvelope => ({
  requestId,
  taskId,
  sequence,
  event: { type: "start" },
})

test("accepts only increasing events for the active request and run", () => {
  const first = advanceTaskEventCursor(
    { requestId: "current", taskId: null, sequence: 0 },
    event("current", "run-1", 1),
  )
  assert.deepEqual(first, { requestId: "current", taskId: "run-1", sequence: 1 })
  assert.ok(first)
  assert.equal(advanceTaskEventCursor(first, event("old", "run-0", 2)), null)
  assert.equal(advanceTaskEventCursor(first, event("current", "run-2", 2)), null)
  assert.equal(advanceTaskEventCursor(first, event("current", "run-1", 1)), null)
  assert.deepEqual(advanceTaskEventCursor(first, event("current", "run-1", 3)), {
    requestId: "current",
    taskId: "run-1",
    sequence: 3,
  })
})
