import assert from "node:assert/strict"
import test from "node:test"
import { formatScenarioTrace, replayToolCall, runAgentScenario } from "./harness/agentHarness.js"
import type { ToolDefinition } from "../src/main/tools/types.js"

const readFileDefinition: ToolDefinition = {
  type: "function",
  function: { name: "read_file", description: "read", parameters: { type: "object" } },
}

test("harness: replays a read-only inline call and records a stable trace", async () => {
  const result = await runAgentScenario({
    name: "read-only-inline-recovery",
    messages: [{ role: "user", content: "读 note.txt" }],
    toolDefinitions: [readFileDefinition],
    modelSteps: [
      {
        label: "model writes a recoverable inline read call",
        result: {
          content: '{"name":"read_file","parameters":{"path":"note.txt"}}<|eot_id|>',
          toolCalls: [],
        },
      },
      {
        label: "model summarizes observation",
        result: { content: "文件内容是 hello", toolCalls: [] },
      },
    ],
    executeTool: async () => ({ content: "hello", detail: "read note.txt" }),
  })

  assert.deepEqual(result.toolCalls, [{ name: "read_file", args: { path: "note.txt" } }])
  assert.equal(result.finalAnswer, "文件内容是 hello")
  assert.match(formatScenarioTrace(result), /step 0: model\/completed/)
  assert.match(formatScenarioTrace(result), /tool: read_file/)
})

test("harness: mutation denial remains visible in the trace and leaves state unchanged", async () => {
  const note = "before\n"
  const result = await runAgentScenario({
    name: "write-denied",
    messages: [{ role: "user", content: "把 note.txt 改成 after" }],
    modelSteps: [
      {
        label: "model requests write",
        result: {
          content: "",
          toolCalls: [
            replayToolCall("write-1", "write_file", { path: "note.txt", content: "after\n" }),
          ],
        },
      },
      {
        label: "model reports denial",
        result: { content: "修改未执行，因为你拒绝了操作。", toolCalls: [] },
      },
    ],
    executeTool: async () => ({ content: "用户拒绝了写入操作。", detail: "写入被拒绝" }),
  })

  assert.equal(note, "before\n")
  assert.deepEqual(result.toolCalls, [
    { name: "write_file", args: { path: "note.txt", content: "after\n" } },
  ])
  assert.equal(result.finalAnswer, "修改未执行，因为你拒绝了操作。")
  assert.ok(
    result.events.some(
      (event) =>
        event.type === "agent-step" &&
        event.phase === "awaiting_approval" &&
        event.status === "started",
    ),
    formatScenarioTrace(result),
  )
})

test("harness: cancellation prevents a second model call", async () => {
  let cancelled = false
  const result = await runAgentScenario({
    name: "cancel-after-read",
    messages: [{ role: "user", content: "读 note.txt" }],
    modelSteps: [
      {
        label: "model requests read before cancellation",
        result: {
          content: "",
          toolCalls: [replayToolCall("read-1", "read_file", { path: "note.txt" })],
        },
      },
    ],
    executeTool: async () => {
      cancelled = true
      return { content: "hello", detail: "read note.txt" }
    },
    isCancelled: () => cancelled,
  })

  assert.equal(result.modelCalls, 1)
  assert.equal(result.finalAnswer, "")
  assert.deepEqual(result.toolCalls, [{ name: "read_file", args: { path: "note.txt" } }])
})

test("harness: loop budget produces a deterministic safety failure", async () => {
  const result = await runAgentScenario({
    name: "loop-budget",
    messages: [{ role: "user", content: "继续读取" }],
    maxToolLoops: 2,
    modelSteps: [
      {
        label: "first read",
        result: {
          content: "",
          toolCalls: [replayToolCall("read-1", "read_file", { path: "a.txt" })],
        },
      },
      {
        label: "second read",
        result: {
          content: "",
          toolCalls: [replayToolCall("read-2", "read_file", { path: "b.txt" })],
        },
      },
    ],
  })

  assert.equal(result.modelCalls, 2)
  assert.ok(
    result.events.some(
      (event) =>
        event.type === "error" && event.message === "模型连续请求工具次数过多，已停止本次对话。",
    ),
    formatScenarioTrace(result),
  )
})
