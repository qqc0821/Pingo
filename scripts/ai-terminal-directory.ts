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

  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      '用法：npm run test:ai-terminal -- --prompt "你的问题" [--allow-no-terminal]\n' +
        "默认将当前工作目录作为已授权目录；AI 根据你的原始问题决定是否以及如何调用 Terminal。",
    )
    return
  }

  const requestedDirectory = process.env.PINGO_INSPECT_DIRECTORY?.trim() || process.cwd()
  const projectRoot = getRealProjectRoot(requestedDirectory)
  assert.ok(
    !isSensitiveRelativePath(basename(projectRoot)),
    "不能把 .git、.ssh、.gnupg、credentials 或 secrets 目录作为授权目录",
  )

  const runtimeData = mkdtempSync(join(tmpdir(), "pingo-ai-terminal-directory-"))
  const settingsStore = new SettingsStore(join(runtimeData, "settings"))
  settingsStore.setAuthorizedProjectPath(projectRoot)
  const auditLogger = new AuditLogger(join(runtimeData, "operation-history.jsonl"))
  const manager = new TaskManager({ settingsStore, auditLogger })
  const events: ChatStreamEvent[] = []
  let taskId = ""
  let settled = false
  let finalAnswer = ""
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
      assert.deepEqual(
        event.capabilities,
        ["terminal.execute"],
        "该测试只自动处理 Terminal capability，不自动授权文件写入等其它能力",
      )
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
      const terminalPlan = event.request.plan.terminalPlan
      assert.ok(terminalPlan, "审批请求不是 Terminal 计划")
      if (
        terminalPlan.risk !== "R1" ||
        terminalPlan.effects.workspace !== "read" ||
        terminalPlan.effects.projectCodeExecution ||
        terminalPlan.sandbox.network !== "deny"
      ) {
        await manager.decide(SOURCE_WINDOW_ID, {
          taskId,
          operationId: event.request.operationId,
          decision: "deny",
        })
        throw new Error("测试只自动批准 R1 只读 Terminal 命令")
      }
      await manager.decide(SOURCE_WINDOW_ID, {
        taskId,
        operationId: event.request.operationId,
        decision: "approve",
      })
      return
    }
    if (event.type === "chunk") finalAnswer += event.content
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
      [{ role: "user", content: options.prompt }],
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
    if (options.requireTerminal) assert.ok(terminalCalls.length > 0, "AI 没有调用 terminal_intent")
    const operation = events.find(
      (event): event is Extract<ChatStreamEvent, { type: "operation-result" }> =>
        event.type === "operation-result",
    )
    if (options.requireTerminal) assert.ok(operation, "没有收到 operation-result")
    if (operation) assert.equal(operation.result.status, "completed", operation.result.content)

    console.log(
      `[PASS] AI → ${terminalCalls.length ? "terminal_intent → capability → approval → Seatbelt → result" : "final answer"}`,
    )
    console.log(`directory: ${projectRoot}`)
    console.log(`terminal calls: ${terminalCalls.length}`)
    if (operation) console.log(`command result:\n${operation.result.content}`)
    console.log(`AI answer:\n${finalAnswer.trim() || "(empty)"}`)
  } finally {
    if (!settled && taskId) manager.cancel(taskId, SOURCE_WINDOW_ID)
    rmSync(runtimeData, { recursive: true, force: true })
  }
}

interface CliOptions {
  prompt: string
  requireTerminal: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  let prompt = ""
  let requireTerminal = true
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }
    if (argument === "--allow-no-terminal") {
      requireTerminal = false
      continue
    }
    if (argument === "--prompt") {
      const value = argv[index + 1]?.trim()
      if (!value) throw new Error("--prompt 后必须提供用户问题")
      prompt = value
      index += 1
      continue
    }
    throw new Error(`未知参数：${argument}`)
  }
  if (!help && !prompt) throw new Error('请提供原始用户问题：--prompt "你的问题"')
  return { prompt, requireTerminal, help }
}

void main().catch((error: unknown) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
