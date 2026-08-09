import { loadDotEnv } from "../src/main/env.js"
import { ModelClient } from "../src/main/ai/client.js"
import { AI_LAB_SCENARIOS, getAiLabScenario } from "../src/main/ai-lab/scenarios.js"
import { runAiLabScenario } from "../src/main/ai-lab/runner.js"

interface CliOptions {
  scenarioIds: string[]
  json: boolean
  model?: string
  baseUrl?: string
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  loadDotEnv([process.cwd()])
  if (options.model) process.env.MODEL_NAME = options.model
  if (options.baseUrl) process.env.MODEL_BASE_URL = options.baseUrl

  if (!process.env.MODEL_API_KEY?.trim()) {
    throw new Error("未找到 MODEL_API_KEY。请先在 .env 中配置密钥后再运行 AI Lab。")
  }

  const scenarios = options.scenarioIds.map((id) => {
    const scenario = getAiLabScenario(id)
    if (!scenario)
      throw new Error(
        `未知用例：${id}。可用用例：${AI_LAB_SCENARIOS.map((item) => item.id).join("、")}`,
      )
    return scenario
  })
  const reports = []
  for (const scenario of scenarios) {
    const report = await runAiLabScenario({ scenario, client: new ModelClient() })
    reports.push(report)
    if (!options.json) printReport(report)
  }

  if (options.json) console.log(JSON.stringify(reports, null, 2))
  if (reports.some((report) => !report.passed)) process.exitCode = 1
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    scenarioIds: AI_LAB_SCENARIOS.map((scenario) => scenario.id),
    json: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    }
    if (arg === "--json") {
      options.json = true
      continue
    }
    if (arg === "--scenario") {
      const value = args[index + 1]
      if (!value) throw new Error("--scenario 需要一个用例 ID")
      options.scenarioIds = value.split(",").filter(Boolean)
      index += 1
      continue
    }
    if (arg === "--model") {
      options.model = requiredValue(arg, args[++index])
      continue
    }
    if (arg === "--base-url") {
      options.baseUrl = requiredValue(arg, args[++index])
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  return options
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} 需要一个值`)
  return value
}

function printReport(report: Awaited<ReturnType<typeof runAiLabScenario>>): void {
  console.log(
    `\n[${report.passed ? "PASS" : "FAIL"}] ${report.scenario.id} — ${report.scenario.title}`,
  )
  for (const trace of report.toolTraces) {
    console.log(`  tool: ${trace.name} ${JSON.stringify(trace.args)} (${trace.detail})`)
  }
  console.log(`  answer: ${report.finalAnswer || "(empty)"}`)
  for (const check of report.checks) {
    console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`)
  }
}

function printHelp(): void {
  console.log(`AI Lab — 隔离测试模型回答与工具调用

Usage:
  npm run ai:lab
  npm run ai:lab -- --scenario project-read
  npm run ai:lab -- --scenario project-read,blocked-write --model deepseek-chat
  npm run ai:lab -- --json

Options:
  --scenario <ids>  运行一个或多个逗号分隔的用例
  --model <name>    仅覆盖本次运行的 MODEL_NAME
  --base-url <url>  仅覆盖本次运行的 MODEL_BASE_URL
  --json            输出完整的机器可读报告
`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "AI Lab 运行失败"
  console.error(`AI Lab: ${message}`)
  process.exitCode = 1
})
