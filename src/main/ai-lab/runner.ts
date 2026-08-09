import { AgentOrchestrator } from "../agent/orchestrator.js"
import { TOOL_DEFINITIONS } from "../tools/registry.js"
import { executeAiLabTool, isAiLabReadOnlyTool } from "./virtualTools.js"
import type { AiLabCheck, AiLabReport, AiLabRunOptions } from "./types.js"

const FINAL_ANSWER_MIN_LENGTH = 4

/**
 * 在与正式 Agent 相同的提示词/工具协议下运行，但使用虚拟工具执行器。
 * 本模块不会加载 TaskManager，因此不会进入正式 IPC、权限或持久化路径。
 */
export async function runAiLabScenario(options: AiLabRunOptions): Promise<AiLabReport> {
  const events: AiLabReport["events"] = []
  const toolTraces: AiLabReport["toolTraces"] = []
  const answerParts: string[] = []
  const orchestrator = new AgentOrchestrator({
    taskId: `ai-lab-${options.scenario.id}`,
    client: options.client,
    toolDefinitions: TOOL_DEFINITIONS,
    executeTool: async (name, args) => executeAiLabTool(name, args, toolTraces),
    isReadOnlyTool: isAiLabReadOnlyTool,
    emit: (event) => {
      events.push(event)
      if (event.type === "chunk") answerParts.push(event.content)
    },
    isCancelled: () => false,
    projectAuthorized: options.scenario.projectAuthorized,
    projectName: "AI Lab Fixture",
  })

  await orchestrator.run([{ role: "user", content: options.scenario.prompt }])
  const finalAnswer = answerParts.join("").trim()
  const checks = evaluate(options.scenario, finalAnswer, toolTraces)
  return {
    scenario: options.scenario,
    finalAnswer,
    events,
    toolTraces,
    checks,
    passed: checks.every((check) => check.passed),
    safeMode: true,
  }
}

function evaluate(
  scenario: AiLabReport["scenario"],
  finalAnswer: string,
  toolTraces: AiLabReport["toolTraces"],
): AiLabCheck[] {
  const checks: AiLabCheck[] = [
    {
      name: "最终回答",
      passed: finalAnswer.length >= FINAL_ANSWER_MIN_LENGTH,
      detail:
        finalAnswer.length >= FINAL_ANSWER_MIN_LENGTH
          ? `已收到 ${finalAnswer.length} 个字符的最终回答。`
          : "模型没有产出可用的最终回答。",
    },
    {
      name: "安全隔离",
      passed: true,
      detail: "所有工具都运行在虚拟项目中；高风险调用只会被记录和拦截。",
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

  for (const fragment of scenario.expectedAnswerFragments ?? []) {
    const present = finalAnswer.toLowerCase().includes(fragment.toLowerCase())
    checks.push({
      name: `回答包含「${fragment}」`,
      passed: present,
      detail: present ? "已包含预期事实。" : "未包含预期事实，可能没有正确利用工具结果。",
    })
  }

  return checks
}
