import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { AuditLogger } from "../src/main/security/auditLogger.js"
import { SettingsStore } from "../src/main/store.js"
import { TaskManager } from "../src/main/tasks/taskManager.js"
import type { ChatStreamEvent } from "../src/shared/types.js"

test("trusted workspace persists independently from remembered project path", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-trusted-store-"))
  const settingsPath = join(root, "settings")
  const store = new SettingsStore(settingsPath)

  store.setAuthorizedProjectPath(root)
  store.setTrustedWorkspace(root, 123)
  assert.equal(statSync(join(settingsPath, "settings.json")).mode & 0o777, 0o600)
  const restored = new SettingsStore(settingsPath)
  assert.deepEqual(restored.getTrustedWorkspace(), {
    path: root,
    name: root.split("/").at(-1),
    authorizedAt: 123,
  })

  restored.clearTrustedWorkspace()
  assert.equal(restored.getTrustedWorkspace(), undefined)
  assert.equal(restored.getAuthorizedProjectPath(), root)
})

test("trusted workspace executes structured file operations without permission or approval cards", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-trusted-task-"))
  const filePath = join(root, "note.txt")
  writeFileSync(filePath, "before\n")
  const store = new SettingsStore(join(root, "data"))
  store.setTrustedWorkspace(root)
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
                      id: "trusted-write-1",
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "已完成。" } }] }), {
        status: 200,
      })
    }

    manager.submit("window-a", [{ role: "user", content: "修改 note.txt" }], (event) =>
      events.push(event),
    )
    await waitFor(() =>
      events.some((event) => event.type === "task-state" && event.state === "completed"),
    )

    assert.equal(readFileSync(filePath, "utf8"), "after\n")
    assert.equal(
      events.some((event) => event.type === "capability-request"),
      false,
    )
    assert.equal(
      events.some((event) => event.type === "approval-request"),
      false,
    )
    assert.equal(
      events.some((event) => event.type === "task-state" && event.state === "executing"),
      true,
    )
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("trusted workspace does not implicitly authorize Terminal", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  const root = mkdtempSync(join(tmpdir(), "pingo-trusted-terminal-"))
  const store = new SettingsStore(join(root, "data"))
  store.setTrustedWorkspace(root)
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
                      id: "trusted-terminal-1",
                      type: "function",
                      function: {
                        name: "terminal_execute",
                        arguments: JSON.stringify({
                          executable: "/bin/pwd",
                          args: [],
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "已拒绝。" } }] }), {
        status: 200,
      })
    }

    const taskId = manager.submit("window-a", [{ role: "user", content: "运行 pwd" }], (event) =>
      events.push(event),
    )
    await waitFor(() => events.some((event) => event.type === "capability-request"))
    const request = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "capability-request" }> =>
        event.type === "capability-request",
    )
    assert.ok(request)
    assert.deepEqual(request.capabilities, ["terminal.execute"])
    manager.denyCapability("window-a", taskId)
    await waitFor(() =>
      events.some((event) => event.type === "task-state" && event.state === "completed"),
    )
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
