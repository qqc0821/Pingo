import assert from "node:assert/strict"
import test from "node:test"
import { ConversationStore } from "../src/main/tasks/conversationStore.js"

const turn = (question: string, answer: string) => [
  { role: "user" as const, content: question },
  { role: "assistant" as const, content: answer },
]

test("completed turns provide context, while failed turns are not remembered as success", () => {
  const store = new ConversationStore()
  const first = store.current("window", "/project")
  store.complete("window", first.id, turn("文件在哪", "在 src/main"))
  store.complete("window", first.id, turn("失败的请求", ""))
  assert.deepEqual(store.messagesFor("window", "/project", "继续分析它"), [
    ...turn("文件在哪", "在 src/main"),
    { role: "user", content: "继续分析它" },
  ])
})

test("changing the project starts a separate conversation", () => {
  const store = new ConversationStore()
  const first = store.current("window", "/first")
  store.complete("window", first.id, turn("A 的问题", "A 的答案"))
  const second = store.current("window", "/second")
  assert.notEqual(second.id, first.id)
  assert.deepEqual(store.messagesFor("window", "/second", "B 的问题"), [
    { role: "user", content: "B 的问题" },
  ])
  store.complete("window", first.id, turn("迟到的请求", "迟到的回答"))
  assert.equal(store.messagesFor("window", "/second", "继续").length, 1)
})

test("history is bounded by complete user-assistant turns", () => {
  const store = new ConversationStore()
  const session = store.current("window", "/project")
  for (let i = 0; i < 25; i += 1) store.complete("window", session.id, turn(`q${i}`, `a${i}`))
  const messages = store.messagesFor("window", "/project", "next")
  assert.equal(messages.length, 49)
  assert.deepEqual(messages.slice(0, 2), turn("q1", "a1"))
})

test("tool calls and observations remain paired when old turns are removed", () => {
  const store = new ConversationStore()
  const session = store.current("window", "/project")
  store.complete("window", session.id, [
    { role: "user", content: "读文件" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "file facts" },
    { role: "assistant", content: "文件内容是 file facts" },
  ])
  assert.deepEqual(
    store.messagesFor("window", "/project", "再说一次").map((message) => message.role),
    ["user", "assistant", "tool", "assistant", "user"],
  )
  for (let i = 0; i < 25; i += 1) store.complete("window", session.id, turn(`q${i}`, `a${i}`))
  const messages = store.messagesFor("window", "/project", "继续")
  assert.equal(
    messages.some((message) => message.role === "tool"),
    false,
  )
})
