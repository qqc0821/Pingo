import { getRealProjectRoot } from "../security/pathGuard.js"
import { AI_LAB_SCENARIOS, getAiLabScenario } from "./scenarios.js"
import type { AiLabScenario } from "./types.js"

export interface CliOptions {
  scenarioIds: string[]
  projectPath?: string
  prompt?: string
  runtime: "legacy" | "vercel"
  json: boolean
  model?: string
  baseUrl?: string
  help?: boolean
}

export function parseAiLabArgs(args: string[]): CliOptions {
  let explicitScenario = false
  let projectPath: string | undefined
  let prompt: string | undefined
  let runtime: "legacy" | "vercel" | undefined
  let json = false
  let model: string | undefined
  let baseUrl: string | undefined
  let scenarioIds: string[] | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help" || arg === "-h") {
      return { scenarioIds: [], runtime: "legacy", json: false, help: true }
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--project") {
      projectPath = requiredValue(arg, args[++index])
      continue
    }
    if (arg === "--prompt") {
      prompt = requiredValue(arg, args[++index]).trim()
      if (!prompt) throw new Error("--prompt 不能为空")
      continue
    }
    if (arg === "--scenario") {
      explicitScenario = true
      const value = requiredValue(arg, args[++index])
      scenarioIds = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      if (scenarioIds.length === 0) throw new Error("--scenario 至少需要一个用例 ID")
      continue
    }
    if (arg === "--runtime") {
      const value = requiredValue(arg, args[++index])
      if (value !== "legacy" && value !== "vercel")
        throw new Error("--runtime 必须是 legacy 或 vercel")
      runtime = value
      continue
    }
    if (arg === "--model") {
      model = requiredValue(arg, args[++index])
      continue
    }
    if (arg === "--base-url") {
      baseUrl = requiredValue(arg, args[++index])
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }

  if (prompt && explicitScenario) throw new Error("--prompt 与 --scenario 互斥")
  if (prompt && !projectPath) throw new Error("--prompt 必须同时提供 --project")

  if (prompt) {
    scenarioIds = ["prompt"]
  } else if (!scenarioIds) {
    scenarioIds = projectPath
      ? AI_LAB_SCENARIOS.filter((scenario) => scenario.environment === "real-readonly").map(
          (scenario) => scenario.id,
        )
      : AI_LAB_SCENARIOS.filter((scenario) => scenario.environment === "virtual").map(
          (scenario) => scenario.id,
        )
  }

  const selected = prompt ? [] : resolveScenarios(scenarioIds, Boolean(projectPath))
  const resolvedRuntime = runtime ?? (projectPath ? "vercel" : "legacy")
  if (
    !projectPath &&
    resolvedRuntime === "vercel" &&
    selected.some((scenario) => scenario.id === "blocked-write")
  ) {
    throw new Error("虚拟 blocked-write 场景必须使用 Legacy runtime")
  }
  return {
    scenarioIds: selected.map((scenario) => scenario.id),
    projectPath,
    prompt,
    runtime: resolvedRuntime,
    json,
    model,
    baseUrl,
  }
}

export function resolveAiLabScenarios(options: CliOptions): AiLabScenario[] {
  if (options.prompt) {
    return [
      {
        id: "prompt",
        title: "真实项目：自由提问",
        prompt: options.prompt,
        environment: "real-readonly",
        projectAuthorized: true,
      },
    ]
  }
  return resolveScenarios(options.scenarioIds, Boolean(options.projectPath))
}

export function validateProjectPath(projectPath: string | undefined): string | undefined {
  return projectPath === undefined ? undefined : getRealProjectRoot(projectPath)
}

export function helpText(): string {
  return `AI Lab — 隔离测试模型回答与工具调用

Usage:
  npm run ai:lab
  npm run ai:lab -- --project .
  npm run ai:lab -- --project . --runtime vercel --prompt "读取 package.json，说明项目名称"
  npm run ai:lab -- --project . --runtime vercel --scenario real-list,real-search,real-no-tool

Options:
  --project <path>  使用真实只读项目 runtime；默认 runtime 为 vercel
  --prompt <text>   对真实项目自由提问；必须同时提供 --project，不能与 --scenario 同用
  --scenario <ids>  选择逗号分隔场景；真实/虚拟场景不能混用
  --runtime <name>  legacy 或 vercel
  --model <name>    覆盖模型名称
  --base-url <url>  覆盖 API 根路径或旧的 /chat/completions endpoint
  --json            输出机器可读报告
`
}

function resolveScenarios(ids: string[], hasProject: boolean): AiLabScenario[] {
  const scenarios = ids.map((id) => {
    const scenario = getAiLabScenario(id)
    if (!scenario)
      throw new Error(
        `未知用例：${id}。可用用例：${AI_LAB_SCENARIOS.map((item) => item.id).join("、")}`,
      )
    return scenario
  })
  const environments = new Set(scenarios.map((scenario) => scenario.environment))
  if (environments.size > 1) throw new Error("虚拟与真实场景不能在同一次调用中混跑")
  if (scenarios.some((scenario) => scenario.environment === "real-readonly") !== hasProject) {
    throw new Error(hasProject ? "--project 只能运行真实只读场景" : "真实场景必须提供 --project")
  }
  return scenarios
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`)
  return value
}
