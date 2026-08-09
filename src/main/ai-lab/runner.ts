import { basename } from "node:path"
import { LegacyAgentRuntime } from "../agent/legacyRuntime.js"
import type { AgentRuntime } from "../agent/runtime.js"
import { getRealProjectRoot } from "../security/pathGuard.js"
import {
  READ_ONLY_TOOL_DEFINITIONS,
  READ_ONLY_TOOL_NAMES,
  TOOL_DEFINITIONS,
} from "../tools/registry.js"
import { ModelClient } from "../ai/client.js"
import { createRealToolExecutor } from "./realTools.js"
import { executeAiLabTool, isAiLabReadOnlyTool } from "./virtualTools.js"
import type { AiLabCheck, AiLabReport, AiLabRunOptions } from "./types.js"

export async function runAiLabScenario(options: AiLabRunOptions): Promise<AiLabReport> {
  const events: AiLabReport["events"] = []
  const toolTraces: AiLabReport["toolTraces"] = []
  const isReal = options.scenario.environment === "real-readonly"
  const projectPath = isReal ? getRealProjectRoot(options.projectPath ?? "") : undefined
  const runtime = options.runtime ?? new LegacyAgentRuntime(options.client ?? new ModelClient())
  const toolDefinitions = isReal ? READ_ONLY_TOOL_DEFINITIONS : TOOL_DEFINITIONS
  const executor = isReal
    ? createRealToolExecutor(projectPath ?? "", toolTraces).execute
    : (name: string, args: unknown) => executeAiLabTool(name, args, toolTraces)
  const isReadOnlyTool = isReal
    ? (name: string) => READ_ONLY_TOOL_NAMES.has(name)
    : isAiLabReadOnlyTool
  const projectName = isReal ? basename(projectPath ?? "") : "AI Lab Fixture"
  const runtimeResult = await runtime.run({
    messages: [{ role: "user", content: options.scenario.prompt }],
    toolDefinitions,
    executeTool: executor,
    isReadOnlyTool,
    projectAuthorized: options.scenario.projectAuthorized,
    projectName,
    maxSteps: 6,
    diagnostics: options.diagnostics,
    emit: (event) => events.push(event),
  })
  const checks = evaluate(options.scenario, runtimeResult, toolTraces)
  return {
    scenario: options.scenario,
    finalAnswer: runtimeResult.finalAnswer,
    events,
    toolTraces,
    checks,
    passed: checks.every((check) => check.passed),
    environment: options.scenario.environment,
    runtime: runtimeResult.runtime,
    fallbackUsed: runtimeResult.fallbackUsed,
    steps: runtimeResult.steps,
    finishReason: runtimeResult.finishReason,
    startedAt: options.startedAt ?? new Date().toISOString(),
    model: options.model ?? "unknown",
    baseUrlHost: options.baseUrlHost ?? "unknown",
    attempt: options.attempt ?? 1,
    retried: options.retried ?? false,
    ...(options.retryReason ? { retryReason: options.retryReason } : {}),
    safeMode: !isReal,
  }
}

function evaluate(
  scenario: AiLabReport["scenario"],
  result: Awaited<ReturnType<AgentRuntime["run"]>>,
  toolTraces: AiLabReport["toolTraces"],
): AiLabCheck[] {
  const checks: AiLabCheck[] = [
    {
      name: "最终回答",
      passed: result.finalAnswer.trim().length > 0,
      detail: result.finalAnswer.trim()
        ? `已收到 ${result.finalAnswer.trim().length} 个字符的最终回答。`
        : "模型没有产出可用的最终回答。",
    },
    {
      name: "运行环境",
      passed: scenario.environment === "real-readonly" || scenario.environment === "virtual",
      detail:
        scenario.environment === "real-readonly"
          ? "工具只通过真实项目的只读 gateway 执行。"
          : "工具运行在虚拟项目中；高风险调用只会被记录和拦截。",
    },
    {
      name: "runtime 结果",
      passed:
        !result.error && result.finishReason !== "error" && result.finishReason !== "cancelled",
      detail: result.error ?? `runtime=${result.runtime}，finishReason=${result.finishReason}`,
    },
    {
      name: "runtime fallback",
      passed: result.fallbackUsed === false,
      detail: result.fallbackUsed
        ? "本次结果使用了 runtime fallback。"
        : "未发生 runtime fallback。",
    },
  ]

  if (scenario.maxToolCalls !== undefined) {
    checks.push({
      name: "工具调用范围",
      passed: toolTraces.length <= scenario.maxToolCalls,
      detail: `调用 ${toolTraces.length} 次，允许最多 ${scenario.maxToolCalls} 次。`,
    })
  }

  for (const name of scenario.expectedToolNames ?? []) {
    const called = toolTraces.some((trace) => trace.name === name)
    checks.push({
      name: `调用 ${name}`,
      passed: called,
      detail: called ? "已按预期调用。" : "模型未按预期调用此工具。",
    })
  }

  if (scenario.requiredToolSequence) {
    const actual = toolTraces.map((trace) => trace.name)
    let cursor = -1
    const position = scenario.requiredToolSequence.every((name) => {
      const next = actual.indexOf(name, cursor + 1)
      if (next < 0) return false
      cursor = next
      return true
    })
    checks.push({
      name: "工具调用顺序",
      passed: position,
      detail: position
        ? `调用顺序满足 ${scenario.requiredToolSequence.join(" → ")}。`
        : `实际调用顺序为 ${actual.join(" → ") || "（无）"}。`,
    })
  }

  for (const fragment of scenario.expectedAnswerFragments ?? []) {
    const present = result.finalAnswer.toLowerCase().includes(fragment.toLowerCase())
    checks.push({
      name: `回答包含「${fragment}」`,
      passed: present,
      detail: present ? "已包含预期事实。" : "未包含预期事实，可能没有正确利用工具结果。",
    })
  }

  if (scenario.expectedAnswerExact !== undefined) {
    const actual = result.finalAnswer.trim()
    checks.push({
      name: `回答精确等于「${scenario.expectedAnswerExact}」`,
      passed: actual === scenario.expectedAnswerExact,
      detail:
        actual === scenario.expectedAnswerExact
          ? "已通过规范化后的精确答案检查。"
          : `规范化后的回答为「${actual || "（空）"}」。`,
    })
  }

  return checks
}
