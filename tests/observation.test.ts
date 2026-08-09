import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_OBSERVATION_BUDGET,
  createObservationTracker,
} from "../src/main/agent/observation.js"

test("截断单次过长观察并保留前缀", () => {
  const tracker = createObservationTracker({
    maxCharsPerTool: 20,
    maxTotalToolCharsPerLoop: 1_000,
  })

  const result = tracker.format("abcdefghijklmnopqrstuvwxyz")

  assert.equal(result.truncated, true)
  assert.equal(result.omitted, false)
  assert.match(result.content, /^abcdefghijklmnopqrst/)
  assert.match(result.content, /truncated/)
})

test("单轮总预算耗尽后省略后续内容", () => {
  const tracker = createObservationTracker({
    maxCharsPerTool: 100,
    maxTotalToolCharsPerLoop: 30,
  })

  const first = tracker.format("a".repeat(30))
  const second = tracker.format("bbbb")

  assert.equal(first.omitted, false)
  assert.equal(second.omitted, true)
  assert.equal(tracker.budgetExceeded, true)
  assert.match(second.content, /observation budget exceeded/i)
})

test("导出规格要求的默认观察预算", () => {
  assert.deepEqual(DEFAULT_OBSERVATION_BUDGET, {
    maxCharsPerTool: 8_000,
    maxTotalToolCharsPerLoop: 24_000,
  })
})
