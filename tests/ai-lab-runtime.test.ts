import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { LanguageModel } from "ai"
import { READ_ONLY_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from "../src/main/tools/registry.js"
import { VercelAgentRuntime } from "../src/main/agent/vercelRuntime.js"
import { createRealToolExecutor } from "../src/main/ai-lab/realTools.js"
import {
  createPingoModel,
  getModelBaseUrlHost,
  normalizeLegacyModelEndpoint,
  normalizeModelBaseUrl,
} from "../src/main/ai/provider.js"
import {
  parseAiLabArgs,
  resolveAiLabScenarios,
  validateProjectPath,
} from "../src/main/ai-lab/cli.js"
import { runAiLabScenario } from "../src/main/ai-lab/runner.js"
import type { AiLabScenario } from "../src/main/ai-lab/types.js"
import { ModelDiagnostics } from "../src/main/ai/modelDiagnostics.js"
import type { ChatStreamEvent } from "../src/shared/types.js"

test("Vercel runtime 将真实工具结果回填到下一轮并形成最终回答", async () => {
  const prompts: unknown[] = []
  const fakeModel = createFakeModel(async (options) => {
    prompts.push(options.prompt)
    if (prompts.length === 1) {
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "read-1",
            toolName: "read_file",
            input: JSON.stringify({ path: "facts.txt" }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      }
    }
    return {
      content: [{ type: "text" as const, text: "答案来自工具：stable-fact-42" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
    }
  })
  const events: ChatStreamEvent[] = []
  const runtime = new VercelAgentRuntime({ model: fakeModel })

  const result = await runtime.run({
    messages: [{ role: "user", content: "读取 facts.txt" }],
    toolDefinitions: READ_ONLY_TOOL_DEFINITIONS,
    executeTool: async () => ({ content: "stable-fact-42", detail: "read facts" }),
    isReadOnlyTool: (name) => name === "read_file",
    projectAuthorized: true,
    projectName: "fixture",
    maxSteps: 6,
    emit: (event) => events.push(event),
  })

  assert.equal(result.runtime, "vercel")
  assert.equal(result.fallbackUsed, false)
  assert.equal(result.finalAnswer, "答案来自工具：stable-fact-42")
  assert.equal(result.toolCalls[0]?.name, "read_file")
  assert.equal(prompts.length, 2)
  assert.match(JSON.stringify(prompts[1]), /stable-fact-42/)
  assert.ok(events.some((event) => event.type === "tool" && event.name === "read_file"))
})

test("Vercel runtime 的六步停止、取消和 provider 错误都有明确结果", async () => {
  const loopingModel = createFakeModel(async () => ({
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `loop-${Date.now()}`,
        toolName: "read_file",
        input: "{}",
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  }))
  const request = {
    messages: [{ role: "user" as const, content: "loop" }],
    toolDefinitions: READ_ONLY_TOOL_DEFINITIONS,
    executeTool: async () => ({ content: "ok", detail: "ok" }),
    isReadOnlyTool: () => true,
    emit: () => {},
  }
  const limited = await new VercelAgentRuntime({ model: loopingModel }).run({
    ...request,
    maxSteps: 6,
  })
  assert.equal(limited.steps, 6)
  assert.equal(limited.finishReason, "tool-calls")
  assert.equal(limited.fallbackUsed, false)

  const controller = new AbortController()
  controller.abort()
  const cancelled = await new VercelAgentRuntime({ model: loopingModel }).run({
    ...request,
    abortSignal: controller.signal,
  })
  assert.equal(cancelled.finishReason, "cancelled")

  const failingModel = createFakeModel(async () => {
    throw new Error("fake provider incompatibility")
  })
  const failed = await new VercelAgentRuntime({ model: failingModel }).run(request)
  assert.equal(failed.finishReason, "error")
  assert.match(failed.error ?? "", /fake provider incompatibility/)

  const slowModel = createFakeModel(async ({ signal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        },
        { once: true },
      )
    })
    return {
      content: [{ type: "text" as const, text: "late" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
    }
  })
  const timedOut = await new VercelAgentRuntime({ model: slowModel }).run({
    ...request,
    timeoutMs: 5,
  })
  assert.equal(timedOut.finishReason, "timeout")
})

test("真实 executor 只读真实目录并拒绝变更类调用", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-real-tools-"))
  try {
    writeFileSync(join(root, "facts.txt"), "stable fact\n")
    const traces: Array<{ name: string; mutating: boolean; content: string }> = []
    const executor = createRealToolExecutor(root, traces)
    const read = await executor.execute("read_file", { path: "facts.txt" })
    const blocked = await executor.execute("write_file", { path: "facts.txt", content: "changed" })
    assert.match(read.content, /stable fact/)
    assert.match(blocked.content, /只读 runtime/)
    assert.equal(traces.map((trace) => trace.name).join(","), "read_file,write_file")
    assert.equal(traces[1]?.mutating, true)
    assert.match(readFileSync(join(root, "facts.txt"), "utf8"), /stable fact/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("只读工具集合恰好三项且生产工具集合保持完整", () => {
  assert.deepEqual(
    READ_ONLY_TOOL_DEFINITIONS.map((definition) => definition.function.name),
    ["list_files", "search_files", "read_file"],
  )
  assert.ok(TOOL_DEFINITIONS.some((definition) => definition.function.name === "write_file"))
  assert.ok(TOOL_DEFINITIONS.some((definition) => definition.function.name === "terminal_intent"))
})

test("CLI 解析真实/虚拟 gating、prompt 冲突和 runtime 默认值", () => {
  const virtual = parseAiLabArgs([])
  assert.equal(virtual.runtime, "legacy")
  assert.ok(virtual.scenarioIds.includes("blocked-write"))

  const real = parseAiLabArgs(["--project", "."])
  assert.equal(real.runtime, "vercel")
  assert.deepEqual(real.scenarioIds, ["real-list", "real-search", "real-no-tool"])
  assert.equal(resolveAiLabScenarios(real).length, 3)

  assert.throws(() => parseAiLabArgs(["--prompt", "read it"]), /--prompt.*--project/)
  assert.throws(
    () => parseAiLabArgs(["--project", ".", "--prompt", "read it", "--scenario", "real-list"]),
    /互斥/,
  )
  assert.throws(
    () => parseAiLabArgs(["--project", ".", "--scenario", "project-read"]),
    /只能运行真实/,
  )
  assert.throws(() => parseAiLabArgs(["--scenario", "real-list"]), /必须提供 --project/)
  assert.throws(() => validateProjectPath(join(tmpdir(), "pingo-missing-project")), /ENOENT/)
})

test("provider base URL 兼容旧 endpoint", () => {
  assert.equal(
    normalizeModelBaseUrl("https://example.test/v1/chat/completions"),
    "https://example.test/v1",
  )
  assert.equal(normalizeModelBaseUrl("https://example.test/v1/"), "https://example.test/v1")
  assert.equal(
    createPingoModel({ apiKey: "sentinel", baseUrl: "https://example.test/v1" }).baseUrl,
    "https://example.test/v1",
  )
  assert.equal(
    normalizeLegacyModelEndpoint("https://example.test/v1/chat/completions"),
    "https://example.test/v1/chat/completions",
  )
  assert.equal(
    getModelBaseUrlHost("https://example.test/v1/chat/completions?secret=hidden"),
    "example.test",
  )
})

test("真实 runner 拒绝越权读取且循环继续，报告元数据和模式保持准确", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-real-runner-"))
  try {
    const scenario: AiLabScenario = {
      id: "prompt",
      title: "越权读取",
      prompt: "读取目录外文件，然后说明结果。",
      environment: "real-readonly",
      projectAuthorized: true,
    }
    let calls = 0
    const report = await runAiLabScenario({
      scenario,
      projectPath: root,
      model: "fake-model",
      baseUrlHost: "example.test",
      client: {
        async completeWithTools() {
          calls += 1
          return calls === 1
            ? {
                content: "",
                toolCalls: [
                  { id: "escape", name: "read_file", arguments: '{"path":"../../etc/passwd"}' },
                ],
              }
            : { content: "已拒绝，未读取目录外文件。", toolCalls: [] }
        },
      },
    })
    assert.equal(report.passed, true)
    assert.equal(report.environment, "real-readonly")
    assert.equal(report.safeMode, false)
    assert.equal(report.model, "fake-model")
    assert.equal(report.baseUrlHost, "example.test")
    assert.match(report.toolTraces[0]?.content ?? "", /工具路径不允许使用 \.\./)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("模型诊断 disabled/safe/raw 均脱敏且 fail-open", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-diagnostics-"))
  try {
    const disabled = new ModelDiagnostics({
      level: "off",
      apiKey: "sentinel-key",
      logDirectory: join(root, "disabled"),
    })
    disabled.recordSafe("ignored", { apiKey: "sentinel-key" })
    assert.equal(existsSync(join(root, "disabled")), false)

    const safeRoot = join(root, "safe")
    const safe = new ModelDiagnostics({
      level: "1",
      apiKey: "sentinel-key",
      logDirectory: safeRoot,
      now: () => new Date("2026-08-09T01:02:03.000Z"),
    })
    safe.recordSafe("step", {
      apiKey: "sentinel-key",
      nested: { authorization: "sentinel-key" },
      text: "sentinel-key appears here",
    })
    const safeFile = join(safeRoot, "model-20260809.jsonl")
    assert.equal(statSync(safeRoot).mode & 0o777, 0o700)
    assert.equal(statSync(safeFile).mode & 0o777, 0o600)
    assert.doesNotMatch(readFileSync(safeFile, "utf8"), /sentinel-key/)

    const rawRoot = join(root, "raw")
    const raw = new ModelDiagnostics({
      level: "raw",
      apiKey: "sentinel-key",
      logDirectory: rawRoot,
      now: () => new Date("2026-08-09T01:02:03.000Z"),
    })
    const wrapped = raw.wrapFetch(async (_input, init) => {
      assert.match(String(init?.body), /sentinel-key/)
      return new Response(JSON.stringify({ token: "sentinel-key", value: "response" }), {
        status: 200,
      })
    })
    const response = await wrapped("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sentinel-key" },
      body: JSON.stringify({ apiKey: "sentinel-key", prompt: "hello" }),
    })
    assert.equal(response.status, 200)
    const rawFile = join(rawRoot, "model-20260809.jsonl")
    const rawContents = readFileSync(rawFile, "utf8")
    assert.doesNotMatch(rawContents, /sentinel-key|Authorization/)
    assert.match(rawContents, /request|response/)
    raw.recordRaw("large", { value: "x".repeat(100_000) })
    const rawLines = readFileSync(rawFile, "utf8").trim().split("\n")
    const lastRawRecord = JSON.parse(rawLines.at(-1) ?? "{}") as { truncated?: boolean }
    assert.equal(lastRawRecord.truncated, true)

    const warnings: string[] = []
    const failOpen = new ModelDiagnostics({
      level: "1",
      logDirectory: join(root, "not-a-directory"),
      warn: (warning) => warnings.push(warning),
    })
    writeFileSync(join(root, "not-a-directory"), "file")
    failOpen.recordSafe("still-works", { value: "ok" })
    assert.ok(warnings.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Vercel safe 诊断记录消息摘要、工具形状和截断预览", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-safe-runtime-"))
  try {
    const diagnostics = new ModelDiagnostics({
      level: "1",
      apiKey: "sentinel-key",
      logDirectory: root,
      now: () => new Date("2026-08-09T01:02:03.000Z"),
    })
    const model = createFakeModel(async () => ({
      content: [{ type: "text" as const, text: "safe-preview" }],
      finishReason: { unified: "stop" as const, raw: "stop" },
    }))
    await new VercelAgentRuntime({ model }).run({
      messages: [{ role: "user", content: "hello" }],
      toolDefinitions: READ_ONLY_TOOL_DEFINITIONS,
      executeTool: async () => ({ content: "unused", detail: "unused" }),
      isReadOnlyTool: () => true,
      diagnostics,
      emit: () => {},
    })
    const contents = readFileSync(join(root, "model-20260809.jsonl"), "utf8")
    assert.match(contents, /messageSummary/)
    assert.match(contents, /answerPreview/)
    assert.match(contents, /safe-preview/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function createFakeModel(
  doGenerate: (options: { prompt: unknown; signal?: AbortSignal }) => Promise<{
    content: Array<Record<string, unknown>>
    finishReason: { unified: "stop" | "tool-calls"; raw: string }
  }>,
): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    doGenerate: async (options) => {
      const result = await doGenerate({ prompt: options.prompt, signal: options.abortSignal })
      return {
        ...result,
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
    doStream: async () => {
      throw new Error("fake model stream is not used")
    },
  } as unknown as LanguageModel
}
