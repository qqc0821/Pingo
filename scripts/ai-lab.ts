import { loadDotEnv } from "../src/main/env.js"
import { ModelClient } from "../src/main/ai/client.js"
import {
  createPingoModel,
  getModelBaseUrlHost,
  normalizeLegacyModelEndpoint,
} from "../src/main/ai/provider.js"
import { ModelDiagnostics } from "../src/main/ai/modelDiagnostics.js"
import { LegacyAgentRuntime } from "../src/main/agent/legacyRuntime.js"
import { VercelAgentRuntime } from "../src/main/agent/vercelRuntime.js"
import { runAiLabScenario } from "../src/main/ai-lab/runner.js"
import {
  helpText,
  parseAiLabArgs,
  resolveAiLabScenarios,
  validateProjectPath,
} from "../src/main/ai-lab/cli.js"

async function main(): Promise<void> {
  const options = parseAiLabArgs(process.argv.slice(2))
  if (options.help) {
    console.log(helpText())
    return
  }

  loadDotEnv([process.cwd()])
  const projectPath = validateProjectPath(options.projectPath)
  if (options.model) process.env.MODEL_NAME = options.model
  if (options.baseUrl) {
    process.env.MODEL_BASE_URL =
      options.runtime === "legacy" ? normalizeLegacyModelEndpoint(options.baseUrl) : options.baseUrl
  }

  if (!process.env.MODEL_API_KEY?.trim()) {
    throw new Error("未找到 MODEL_API_KEY。请先在 .env 中配置密钥后再运行 AI Lab。")
  }

  const scenarios = resolveAiLabScenarios(options)
  const diagnostics = new ModelDiagnostics({
    level: process.env.PINGO_DEBUG_MODEL,
    apiKey: process.env.MODEL_API_KEY,
  })
  const provider =
    options.runtime === "vercel"
      ? new VercelAgentRuntime(
          createPingoModel({
            apiKey: process.env.MODEL_API_KEY,
            modelName: process.env.MODEL_NAME,
            baseUrl: process.env.MODEL_BASE_URL,
            diagnostics,
          }),
        )
      : new LegacyAgentRuntime(new ModelClient())
  const modelName = process.env.MODEL_NAME?.trim() || "deepseek-chat"
  const baseUrlHost = getModelBaseUrlHost(process.env.MODEL_BASE_URL)
  const reports = []
  for (const scenario of scenarios) {
    const report = await runAiLabScenario({
      scenario,
      runtime: provider,
      projectPath,
      diagnostics,
      model: modelName,
      baseUrlHost,
      attempt: 1,
      retried: false,
    })
    reports.push(report)
    if (!options.json) printReport(report)
  }

  if (options.json) console.log(JSON.stringify(reports, null, 2))
  if (reports.some((report) => !report.passed)) process.exitCode = 1
}

function printReport(report: Awaited<ReturnType<typeof runAiLabScenario>>): void {
  console.log(
    `\n[${report.passed ? "PASS" : "FAIL"}] ${report.scenario.id} — ${report.scenario.title}`,
  )
  console.log(
    `  runtime: ${report.runtime} | environment: ${report.environment} | fallbackUsed: ${report.fallbackUsed} | finishReason: ${report.finishReason}`,
  )
  for (const trace of report.toolTraces) {
    console.log(`  tool: ${trace.name} ${JSON.stringify(trace.args)} (${trace.detail})`)
  }
  console.log(`  answer: ${report.finalAnswer || "(empty)"}`)
  for (const check of report.checks) {
    console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`)
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "AI Lab 运行失败"
  console.error(`AI Lab: ${message}`)
  process.exitCode = 1
})
