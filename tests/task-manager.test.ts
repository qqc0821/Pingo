import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { AuditLogger } from "../src/main/security/auditLogger.js"
import { TaskManager } from "../src/main/tasks/taskManager.js"
import { SettingsStore } from "../src/main/store.js"
import type { ChatStreamEvent } from "../src/shared/types.js"

test("task manager waits for permission before read tools and resumes after grant", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-task-"))
  writeFileSync(join(root, "note.txt"), "safe content\n")
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
  })
  const events: ChatStreamEvent[] = []
  let requestCount = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async (_input, init) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body)) as { messages: unknown[] }
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "read-1",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: "note.txt" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      assert.ok(body.messages.length >= 3)
      return new Response(JSON.stringify({ choices: [{ message: { content: "已安全读取。" } }] }), {
        status: 200,
      })
    }
    const taskId = manager.submit(
      "window-a",
      [{ role: "user", content: "读取 note.txt" }],
      (event) => events.push(event),
    )
    await waitFor(() => events.some((event) => event.type === "capability-request"))
    assert.equal(requestCount, 1)
    manager.grantCapability("window-a", taskId, ["workspace.read"], "session", [root])
    await waitFor(() =>
      events.some((event) => event.type === "task-state" && event.state === "completed"),
    )
    assert.equal(requestCount, 2)
    assert.ok(events.some((event) => event.type === "tool" && event.name === "read_file"))
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("write tools stop at an immutable approval preview and execute only after approval", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-write-task-"))
  const filePath = join(root, "note.txt")
  writeFileSync(filePath, "before\n")
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
  })
  const events: ChatStreamEvent[] = []
  let requestCount = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "write-1",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: "note.txt", content: "after\n" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "写入完成。" } }] }), {
        status: 200,
      })
    }
    const taskId = manager.submit(
      "window-a",
      [{ role: "user", content: "修改 note.txt" }],
      (event) => events.push(event),
    )
    await waitFor(() => events.some((event) => event.type === "capability-request"))
    manager.grantCapability("window-a", taskId, ["workspace.write"], "session", [root])
    await waitFor(() => events.some((event) => event.type === "approval-request"))
    assert.equal(readFileSync(filePath, "utf8"), "before\n")
    const request = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "approval-request" }> =>
        event.type === "approval-request",
    )
    assert.ok(request)
    manager.decide("window-a", {
      taskId,
      operationId: request.request.operationId,
      decision: "approve",
    })
    await waitFor(() =>
      events.some((event) => event.type === "task-state" && event.state === "completed"),
    )
    assert.equal(readFileSync(filePath, "utf8"), "after\n")
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("terminal_intent uses the real approval, script binding, Seatbelt runner, and one-time decision chain", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-terminal-task-"))
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node terminal-test.js" } }),
  )
  writeFileSync(join(root, "terminal-test.js"), 'process.stdout.write("terminal-script-ok")')
  const store = new SettingsStore(join(root, "data"))
  store.setAuthorizedProjectPath(root)
  const manager = new TaskManager({
    settingsStore: store,
    auditLogger: new AuditLogger(join(root, "audit.jsonl")),
  })
  const events: ChatStreamEvent[] = []
  let requestCount = 0
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "terminal-intent-1",
                      type: "function",
                      function: {
                        name: "terminal_intent",
                        arguments: JSON.stringify({
                          kind: "project.script",
                          packageManager: "npm",
                          script: "test",
                          forwardedArgs: [],
                          cwd: ".",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "脚本完成。" } }] }), {
        status: 200,
      })
    }
    const taskId = manager.submit(
      "window-terminal",
      [{ role: "user", content: "运行测试" }],
      (event) => events.push(event),
    )
    await waitFor(() => events.some((event) => event.type === "capability-request"))
    manager.grantCapability("window-terminal", taskId, ["terminal.execute"], "session", [root])
    await waitFor(() => events.some((event) => event.type === "approval-request"))
    const approval = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "approval-request" }> =>
        event.type === "approval-request",
    )
    assert.ok(approval)
    assert.equal(approval.request.plan.terminalPlan?.projectScript?.body, "node terminal-test.js")
    assert.equal(approval.request.plan.terminalPlan?.effects.network, "none")
    assert.equal(approval.request.plan.terminalPlan?.sandbox.network, "deny")
    assert.match(approval.request.plan.preview, /scriptBody: node terminal-test\.js/)
    assert.match(approval.request.plan.preview, /packageJsonSha256/)
    manager.decide("window-terminal", {
      taskId,
      operationId: approval.request.operationId,
      decision: "approve",
    })
    await waitFor(() =>
      events.some(
        (event) => event.type === "operation-result" && event.result.status === "completed",
      ),
    )
    const result = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "operation-result" }> =>
        event.type === "operation-result",
    )
    assert.ok(result)
    assert.match(result.result.content, /terminal-script-ok/)
    assert.equal(requestCount, 2)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待任务事件超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
