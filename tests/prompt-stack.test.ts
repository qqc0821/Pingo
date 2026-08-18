import assert from "node:assert/strict"
import test from "node:test"
import {
  MAX_VISIBLE_PROMPTS,
  collapseStack,
  createPromptId,
  dedupeKeyFor,
  pushNotification,
  removePromptItem,
  taskDedupKey,
  upsertPromptItem,
} from "../src/shared/promptStack.js"
import type { PetNotification, PetPromptItem } from "../src/shared/types.js"

function taskCard(taskId: string, label: string, content: string): PetPromptItem {
  return {
    id: createPromptId("task"),
    kind: "task",
    tone: "progress",
    label,
    content,
    taskId,
    dedupKey: taskDedupKey(taskId),
    sticky: true,
    createdAt: 1000,
    updatedAt: 1000,
  }
}

function notification(text: string, overrides: Partial<PetNotification> = {}): PetNotification {
  return { text, ...overrides }
}

test("任务卡按 taskId 原地更新:更新内容、保留位置与 id", () => {
  const first = taskCard("t1", "分析中", "正在理解目标。")
  let stack = [taskCard("t0", "旧任务", "旧内容"), first]

  stack = upsertPromptItem(
    stack,
    taskCard("t1", "执行中", "正在执行。"),
    { tone: "progress", label: "执行中", content: "正在执行。" },
    2000,
  )

  assert.equal(stack.length, 2)
  assert.equal(stack[1].id, first.id, "原地更新应保留 id")
  assert.equal(stack[1].content, "正在执行。")
  assert.equal(stack[1].label, "执行中")
  assert.equal(stack[1].updatedAt, 2000)
  assert.equal(stack[0].content, "旧内容", "无关卡不受影响")
})

test("任务卡完成时保留 id,变更 tone/label 与 expandable", () => {
  let stack = [taskCard("t1", "分析中", "正在理解目标。")]
  stack = upsertPromptItem(
    stack,
    taskCard("t1", "已完成", "结果内容"),
    { tone: "success", label: "已完成", content: "结果内容", expandable: true, sticky: false },
    3000,
  )

  assert.equal(stack.length, 1)
  assert.equal(stack[0].tone, "success")
  assert.equal(stack[0].expandable, true)
  assert.equal(stack[0].sticky, false)
})

test("新增任务卡追加到末尾(最新位)", () => {
  let stack = [taskCard("t1", "分析中", "内容A")]
  stack = upsertPromptItem(stack, taskCard("t2", "分析中", "内容B"), {}, 2000)
  assert.equal(stack.length, 2)
  assert.equal(stack[1].taskId, "t2")
})

test("通知去重键:id 优先于 source,其次文本", () => {
  assert.equal(dedupeKeyFor(notification("hi", { id: "n1" })), "id:n1")
  assert.equal(dedupeKeyFor(notification("hi", { source: "dsh:turn/end" })), "src:dsh:turn/end")
  assert.equal(dedupeKeyFor(notification("hi")), "text:hi")
  assert.equal(dedupeKeyFor(notification("")), null)
})

test("同来源通知在冷却窗内合并:内容更新、计数 +1、不新增卡", () => {
  const first = notification("第一条", { source: "dsh:subagent/end" })
  const second = notification("第二条", { source: "dsh:subagent/end" })

  let stack = pushNotification([], first, { now: 1000 })
  stack = pushNotification(stack, second, { now: 2000 }) // 冷却窗(4s)内

  assert.equal(stack.length, 1)
  assert.equal(stack[0].content, "第二条")
  assert.equal(stack[0].count, 2)
  assert.equal(stack[0].updatedAt, 2000)
})

test("超过冷却窗后同源通知成为新卡", () => {
  const first = notification("第一条", { source: "dsh:goal/complete" })
  const second = notification("第二条", { source: "dsh:goal/complete" })

  let stack = pushNotification([], first, { now: 1000 })
  stack = pushNotification(stack, second, { now: 10_000 }) // 超过 4s

  assert.equal(stack.length, 2)
  assert.equal(stack[1].count, 1)
})

test("mcp 分类通知渲染为 mcp 卡", () => {
  const stack = pushNotification([], notification("工具结果", { kind: "mcp", source: "pet:mcp" }), {
    now: 1000,
    labelFor: () => "MCP",
  })
  assert.equal(stack[0].kind, "mcp")
  assert.equal(stack[0].label, "MCP")
})

test("removePromptItem 只移除目标卡", () => {
  const a = taskCard("a", "分析中", "A")
  const b = taskCard("b", "分析中", "B")
  const c = taskCard("c", "分析中", "C")
  const stack = [a, b, c]

  const next = removePromptItem(stack, b.id)
  assert.deepEqual(
    next.map((item) => item.taskId),
    ["a", "c"],
  )
  assert.equal(next.length, 2)
})

test("collapseStack 保留最近 maxVisible 张卡,其余折叠", () => {
  const stack = [
    taskCard("a", "分析中", "A"),
    taskCard("b", "分析中", "B"),
    taskCard("c", "分析中", "C"),
    taskCard("d", "分析中", "D"),
    taskCard("e", "分析中", "E"),
  ]

  const { visible, hidden } = collapseStack(stack, { now: 1000, ttlMs: 60_000 })

  assert.equal(visible.length, MAX_VISIBLE_PROMPTS)
  assert.deepEqual(
    visible.map((item) => item.taskId),
    ["c", "d", "e"].slice(-MAX_VISIBLE_PROMPTS),
    "应保留最近 maxVisible 张(数组末尾最新)",
  )
  assert.deepEqual(
    hidden.map((item) => item.taskId),
    ["a", "b", "c"].slice(0, 5 - MAX_VISIBLE_PROMPTS),
  )
})

test("collapseStack:非 sticky 卡超过 TTL 折叠进 hidden,sticky 卡豁免", () => {
  const staleNotification: PetPromptItem = {
    ...taskCard("n", "通知", "旧通知"),
    kind: "notification",
    sticky: false,
    updatedAt: 0,
    dedupKey: "src:x",
  }
  const freshTask = taskCard("t", "分析中", "进行中")

  const { visible, hidden } = collapseStack([staleNotification, freshTask], {
    now: 100_000,
    ttlMs: 60_000,
  })

  assert.deepEqual(
    visible.map((item) => item.taskId),
    ["t"],
  )
  assert.deepEqual(
    hidden.map((item) => item.kind),
    ["notification"],
  )
})

test("collapseStack:折叠只影响展示,不删除卡", () => {
  const stack = Array.from({ length: 6 }, (_, index) =>
    taskCard(`t${index}`, "分析中", `内容${index}`),
  )
  const { visible, hidden } = collapseStack(stack, { now: 1000, ttlMs: 60_000 })
  assert.equal(visible.length + hidden.length, 6)
})
