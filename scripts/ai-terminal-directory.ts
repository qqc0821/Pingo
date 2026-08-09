import assert from "node:assert/strict"
import { basename, join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import type { ChatStreamEvent } from "../src/shared/types.js"
import { loadDotEnv } from "../src/main/env.js"
import { AuditLogger } from "../src/main/security/auditLogger.js"
import { getRealProjectRoot, isSensitiveRelativePath } from "../src/main/security/pathGuard.js"
import { SettingsStore } from "../src/main/store.js"
import { TaskManager } from "../src/main/tasks/taskManager.js"

const SOURCE_WINDOW_ID = "ai-terminal-directory-test"
const TEST_TIMEOUT_MS = 120_000

async function main(): Promise<void> {
  loadDotEnv([process.cwd()])
  assert.ok(process.env.MODEL_API_KEY?.trim(), "未找到 MODEL_API_KEY，请先配置 .env")

  const requestedDirectory = process.env.PINGO_INSPECT_DIRECTORY?.trim()
  assert.ok(
    requestedDirectory,
    "请设置 PINGO_INSPECT_DIRECTORY，例如：PINGO_INSPECT_DIRECTORY=\"$HOME/Documents\"",
  )
  const projectRoot = getRealProjectRoot(requestedDirectory)
  assert.ok(
    !isSensitiveRelativePath(basename(projectRoot)),
    "不能把 .git、.ssh、.gnupg、credentials 或 secrets 目录作为授权目录",
  )

  const expectedEntry = process.env.PINGO_INSPECT_EXPECT?.trim()
  const prompt = [
    "这是一次 Pingo Terminal 端到端测试。",
    "你必须调用 terminal_intent 工具，不能调用 list_files、search_files 或 read_file。",
    'TerminalIntent 必须严格使用：{"kind":"directory.list","action":"list","cwd":"."}。',
    "执行成功后，用简短中文总结命令输出；不要执行其它命令，不要写入或修改任何文件。",
    expectedEntry ? `总结中请确认是否看到了目录条目：${expectedEntry}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const runtimeData = mkdtempSync(join(tmpdir(), "pingo-ai-terminal-directory-"))
  const settingsStore = new SettingsStore(join(runtimeData, "settings"))
  settingsStore.setAuthorizedProjectPath(projectRoot)
  const auditLogger = new AuditLogger(join(runtimeData, "operation-history.jsonl"))
  const manager = new TaskManager({ settingsStore, auditLogger })
  const events: ChatStreamEvent[] = []
  let taskId = ""
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const emit = (event: ChatStreamEvent): void => {
    events.push(event)
    void handleEvent(event).catch((error: unknown) => {
      if (settled) return
      settled = true
      rejectDone(error instanceof Error ? error : new Error(String(error)))
    })
  }

  async function handleEvent(event: ChatStreamEvent): Promise<void> {
    if (event.type === "capability-request") {
      assert.deepEqual(event.capabilities, ["terminal.execute"])
      manager.grantCapability(
        SOURCE_WINDOW_ID,
        taskId,
        ["terminal.execute"],
        "once",
        [projectRoot],
      )
      return
    }
    if (event.type === "approval-request") {
      assert.equal(event.request.taskId, taskId)
      assert.equal(event.request.plan.terminalPlan?.intent.kind, "directory.list")
      await manager.decide(SOURCE_WINDOW_ID, {
        taskId,
        operationId: event.request.operationId,
        decision: "approve",
      })
      return
    }
    if (event.type === "task-state" && event.state === "failed") {
      throw new Error("Pingo 任务失败，请查看上方事件和模型配置")
    }
    if (event.type === "task-state" && event.state === "completed" && !settled) {
      settled = true
      resolveDone()
    }
  }

  try {
    taskId = manager.submit(
      SOURCE_WINDOW_ID,
      [{ role: "user", content: prompt }],
      emit,
    )
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`AI Terminal 测试超过 ${TEST_TIMEOUT_MS}ms`)),
        TEST_TIMEOUT_MS,
      )
    })
    try {
      await Promise.race([done, timeout])
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }

    const terminalCalls = events.filter(
      (event): event is Extract<ChatStreamEvent, { type: "tool" }> =>
        event.type === "tool" && event.name === "terminal_intent",
    )
    assert.ok(terminalCalls.length > 0, "AI 没有调用 terminal_intent")
    const operation = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "operation-result" }> =>
        event.type === "operation-result",
    )
    assert.ok(operation, "没有收到 operation-result")
    assert.equal(operation.result.status, "completed", operation.result.content)
    if (expectedEntry) assert.match(operation.result.content, new RegExp(escapeRegExp(expectedEntry)))

    console.log("[PASS] AI → terminal_intent → capability → approval → Seatbelt → result")
    console.log(`directory: ${projectRoot}`)
    console.log(`terminal calls: ${terminalCalls.length}`)
    console.log(operation.result.content)
  } finally {
    if (!settled && taskId) manager.cancel(taskId, SOURCE_WINDOW_ID)
    rmSync(runtimeData, { recursive: true, force: true })
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

void main().catch((error: unknown) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
