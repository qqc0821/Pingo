import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { TaskManager } from "../src/main/tasks/taskManager.js"
import { DESKTOP_EXECUTION_POLICY } from "../src/main/tasks/executionPolicy.js"
import { FileSessionPersistence } from "../src/main/tasks/sessionPersistence.js"
import { SettingsStore } from "../src/main/store.js"
import { AuditLogger } from "../src/main/security/auditLogger.js"
import type { ChatStreamEvent } from "../src/shared/types.js"

async function waitForTerminal(events: ChatStreamEvent[]): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!events.some((event) => event.type === "done" || event.type === "error")) {
    if (Date.now() > deadline) throw new Error("任务未结束")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("a second desktop request receives context, and a new session clears it", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-conversation-"))
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
    executionPolicy: DESKTOP_EXECUTION_POLICY,
  })
  let count = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async (_input, init) => {
      count += 1
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      if (count === 2) {
        assert.deepEqual(body.messages.slice(-3), [
          { role: "user", content: "文件在哪" },
          { role: "assistant", content: "在 src/main" },
          { role: "user", content: "继续说它" },
        ])
      }
      if (count === 3) {
        assert.deepEqual(body.messages.slice(-1), [{ role: "user", content: "新的问题" }])
        assert.equal(body.messages.length, 2)
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: count === 1 ? "在 src/main" : "继续说明" } }],
        }),
        { status: 200 },
      )
    }
    const firstEvents: ChatStreamEvent[] = []
    const first = manager.submitUserInput("window", "文件在哪", (event) => firstEvents.push(event))
    await waitForTerminal(firstEvents)
    const secondEvents: ChatStreamEvent[] = []
    const second = manager.submitUserInput("window", "继续说它", (event) =>
      secondEvents.push(event),
    )
    await waitForTerminal(secondEvents)
    assert.equal(first.sessionId, second.sessionId)
    const freshSessionId = manager.startNewConversation("window")
    assert.notEqual(freshSessionId, second.sessionId)
    const thirdEvents: ChatStreamEvent[] = []
    manager.submitUserInput("window", "新的问题", (event) => thirdEvents.push(event))
    await waitForTerminal(thirdEvents)
    assert.equal(count, 3)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("a new task manager restores the desktop conversation for a new window id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-manager-restart-"))
  const settingsStore = new SettingsStore(join(root, "data"))
  settingsStore.setAuthorizedProjectPath(root)
  const persistence = new FileSessionPersistence(join(root, "sessions"))
  const seen: Array<Array<{ role: string; content: string | null }>> = []
  const createManager = () =>
    new TaskManager({
      settingsStore,
      auditLogger: new AuditLogger(join(root, "audit.jsonl")),
      executionPolicy: DESKTOP_EXECUTION_POLICY,
      conversationPersistence: persistence,
      conversationOwnerKey: "desktop-pet",
      modelClientFactory: () => ({
      cancel() {},
      async completeWithTools(messages) {
        seen.push(structuredClone(messages) as Array<{ role: string; content: string | null }>)
          return { content: seen.length === 1 ? "第一轮答复" : "第二轮答复", toolCalls: [] }
        },
      }),
    })
  const firstEvents: ChatStreamEvent[] = []
  createManager().submitUserInput("old-window", "第一轮问题", (event) => firstEvents.push(event))
  await waitForTerminal(firstEvents)
  const secondEvents: ChatStreamEvent[] = []
  createManager().submitUserInput("new-window", "继续", (event) => secondEvents.push(event))
  await waitForTerminal(secondEvents)
  assert.deepEqual(seen[1]?.slice(-3), [
    { role: "user", content: "第一轮问题" },
    { role: "assistant", content: "第一轮答复" },
    { role: "user", content: "继续" },
  ])
})

test("a denied tool is not reported as a completed task", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-denied-conversation-"))
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
    executionPolicy: DESKTOP_EXECUTION_POLICY,
  })
  const events: ChatStreamEvent[] = []
  let count = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async (_input, init) => {
      count += 1
      if (count === 3) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content?: string }>
        }
        assert.ok(
          body.messages.some(
            (message) =>
              message.role === "assistant" && message.content?.includes("上轮任务未完成"),
          ),
        )
      }
      const message =
        count === 1
          ? {
              content: "",
              tool_calls: [
                {
                  id: "blocked",
                  type: "function",
                  function: { name: "terminal_execute", arguments: "{}" },
                },
              ],
            }
          : { content: "这个操作不能执行。" }
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 })
    }
    manager.submitUserInput("window", "执行任意 Shell", (event) => events.push(event))
    await waitForTerminal(events)
    assert.ok(events.some((event) => event.type === "error" && event.message.includes("不能执行")))
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
    )
    const followUpEvents: ChatStreamEvent[] = []
    manager.submitUserInput("window", "刚才为什么没做成", (event) => followUpEvents.push(event))
    await waitForTerminal(followUpEvents)
    assert.equal(count, 3)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("a follow-up retains the prior tool call and its observation", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-tool-context-"))
  writeFileSync(join(root, "note.txt"), "fact from file")
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
    executionPolicy: DESKTOP_EXECUTION_POLICY,
  })
  let count = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async (_input, init) => {
      count += 1
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{
          role: string
          content?: string
          tool_call_id?: string
          tool_calls?: unknown[]
        }>
      }
      if (count === 1)
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "read-previous",
                      type: "function",
                      function: { name: "read_file", arguments: '{"path":"note.txt"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        )
      if (count === 3) {
        assert.ok(
          body.messages.some(
            (message) => message.role === "assistant" && message.tool_calls?.length === 1,
          ),
        )
        assert.ok(
          body.messages.some(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === "read-previous" &&
              message.content?.includes("fact from file"),
          ),
        )
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "文件说明了事实。" } }] }),
        { status: 200 },
      )
    }
    const firstEvents: ChatStreamEvent[] = []
    manager.submitUserInput("window", "读取 note.txt", (event) => firstEvents.push(event))
    await waitForTerminal(firstEvents)
    const secondEvents: ChatStreamEvent[] = []
    manager.submitUserInput("window", "刚才文件说了什么", (event) => secondEvents.push(event))
    await waitForTerminal(secondEvents)
    assert.equal(count, 3)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("a corrected read can recover a failed read before the final answer", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-read-recovery-"))
  writeFileSync(join(root, "note.txt"), "verified fact")
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
    executionPolicy: DESKTOP_EXECUTION_POLICY,
  })
  const events: ChatStreamEvent[] = []
  let count = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async () => {
      count += 1
      const message =
        count < 3
          ? {
              content: "",
              tool_calls: [
                {
                  id: `read-${count}`,
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: count === 1 ? "missing.txt" : "note.txt" }),
                  },
                },
              ],
            }
          : { content: "文件确认了 verified fact。" }
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 })
    }
    manager.submitUserInput("window", "读文件并回答", (event) => events.push(event))
    await waitForTerminal(events)
    assert.equal(count, 3)
    assert.ok(events.some((event) => event.type === "done"))
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})
