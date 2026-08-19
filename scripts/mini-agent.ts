/**
 * 最小 Agent：一个文件、三个工具、原生 fetch，不依赖项目里的任何其它模块。
 * 无任何权限门槛：工具一律直接执行，命令不需要确认，路径不受目录限制。
 *
 *   npx tsx scripts/mini-agent.ts "package.json 里的 dev 命令是什么"
 *   npx tsx scripts/mini-agent.ts --debug "这个项目是做什么的"
 */
import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const ROOT = process.cwd()
const MAX_STEPS = 6
const MAX_READ_BYTES = 20_000
const MAX_LIST_ENTRIES = 200
/** 只是为了避免刷屏和撑爆上下文，不是权限限制。 */
const NOISY_DIRECTORIES = new Set(["node_modules", ".git", "dist", "out", "build"])

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前项目内的文件相对路径。不确定文件名时先调用它。",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "项目内相对目录，默认为根目录" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取当前项目内某个文本文件的内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "项目内相对文件路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在项目根目录执行一条 shell 命令并返回输出，例如 git status、npm test、ls。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的完整命令" },
          reason: { type: "string", description: "为什么需要执行这条命令" },
        },
        required: ["command"],
      },
    },
  },
]

const SYSTEM_PROMPT = [
  "你是一个本地项目助手，只能通过工具了解项目内容，不要凭空猜测。",
  "需要查看项目时，必须在本轮直接发起 tool_calls，不要只描述计划。",
  "调用工具时只输出 tool_calls，不要把函数名或 JSON 参数写进 content。",
  "拿到工具结果后，用中文给出简洁、基于事实的最终回答。",
].join("")

interface ToolResult {
  content: string
  detail: string
}

interface ModelResponse {
  content?: unknown
  tool_calls?: Array<{
    id?: unknown
    function?: { name?: unknown; arguments?: unknown }
  }>
}

function main(): Promise<void> {
  loadEnv()
  const debug = process.argv.includes("--debug")
  const question = process.argv
    .slice(2)
    .filter((arg) => arg !== "--debug")
    .join(" ")
    .trim()

  if (!question) {
    console.error('用法: npx tsx scripts/mini-agent.ts [--debug] "你的问题"')
    process.exitCode = 1
    return Promise.resolve()
  }

  const apiKey = process.env.MODEL_API_KEY?.trim()
  if (!apiKey) {
    console.error("缺少 MODEL_API_KEY，请先在项目根目录的 .env 中配置。")
    process.exitCode = 1
    return Promise.resolve()
  }

  console.log(`[项目] ${ROOT}`)
  console.log(`[模型] ${modelName()}`)
  console.log(`[提问] ${question}\n`)
  return runAgent(question, apiKey, debug)
}

async function runAgent(question: string, apiKey: string, debug: boolean): Promise<void> {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ]

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const message = await callModel(messages, apiKey, debug)
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const content = typeof message.content === "string" ? message.content : ""

    if (toolCalls.length === 0) {
      warnIfToolCallLeakedIntoText(content)
      console.log(`\n[model] 最终回答: ${content.trim() || "(空回复)"}`)
      return
    }

    messages.push({ role: "assistant", content, tool_calls: toolCalls })

    for (const call of toolCalls) {
      const name = String(call?.function?.name ?? "")
      const args = parseArguments(call?.function?.arguments)
      console.log(`[model] 请求工具: ${name} ${JSON.stringify(args)}`)

      let result: ToolResult
      try {
        result = executeTool(name, args)
      } catch (error) {
        const reason = error instanceof Error ? error.message : "未知错误"
        result = { content: `工具执行失败：${reason}`, detail: `失败 — ${reason}` }
      }

      console.log(`[tool]  ${result.detail}`)
      messages.push({ role: "tool", tool_call_id: String(call?.id ?? ""), content: result.content })
    }
  }

  console.log(`\n[model] 已达到最大步数 ${MAX_STEPS}，模型仍在请求工具。`)
  process.exitCode = 1
}

async function callModel(
  messages: Record<string, unknown>[],
  apiKey: string,
  debug: boolean,
): Promise<ModelResponse> {
  const body = {
    model: modelName(),
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    stream: false,
    temperature: 0.2,
  }
  if (debug) console.log(`\n[debug] 请求 →\n${JSON.stringify(body, null, 2)}\n`)

  const response = await fetch(baseUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  const raw = await response.text()
  if (debug) console.log(`[debug] 响应 ←\n${raw}\n`)
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}：${raw.slice(0, 300)}`)

  const parsed = JSON.parse(raw)
  const message = parsed?.choices?.[0]?.message
  if (!message) throw new Error(`模型返回缺少 message 字段：${raw.slice(0, 300)}`)
  return message
}

function runCommand(args: Record<string, unknown>): ToolResult {
  const command = typeof args.command === "string" ? args.command.trim() : ""
  if (!command) throw new Error("run_command 缺少 command 参数")

  try {
    const output = execSync(command, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const clipped =
      output.length > MAX_READ_BYTES ? `${output.slice(0, MAX_READ_BYTES)}\n…(已截断)` : output
    return {
      content: `退出码 0\n\n${clipped || "(无输出)"}`,
      detail: `已执行（退出码 0，${output.length} 字符输出）`,
    }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    const status = failure.status ?? -1
    const combined =
      `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || ""
    return {
      content: `退出码 ${status}\n\n${combined.slice(0, MAX_READ_BYTES)}`,
      detail: `已执行（退出码 ${status}）`,
    }
  }
}

function executeTool(name: string, args: Record<string, unknown>): ToolResult {
  if (name === "run_command") return runCommand(args)

  if (name === "list_files") {
    const directory = typeof args.directory === "string" ? args.directory : "."
    const files = listFiles(directory)
    return {
      content: files.join("\n") || "该目录下没有可列出的文件。",
      detail: `已列出 ${files.length} 个文件（${directory}）`,
    }
  }

  if (name === "read_file") {
    const relativePath = typeof args.path === "string" ? args.path : ""
    if (!relativePath) throw new Error("read_file 缺少 path 参数")
    const absolutePath = resolve(ROOT, relativePath)
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error(`文件不存在：${relativePath}`)
    }
    const text = readFileSync(absolutePath, "utf8")
    const clipped =
      text.length > MAX_READ_BYTES ? `${text.slice(0, MAX_READ_BYTES)}\n…(已截断)` : text
    return { content: clipped, detail: `已读取 ${relativePath}（${text.length} 字符）` }
  }

  throw new Error(`未知工具：${name}`)
}

function listFiles(directory: string): string[] {
  const start = resolve(ROOT, directory)
  const results: string[] = []

  const walk = (current: string): void => {
    if (results.length >= MAX_LIST_ENTRIES) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (results.length >= MAX_LIST_ENTRIES) return
      if (NOISY_DIRECTORIES.has(entry.name)) continue
      const absolutePath = join(current, entry.name)
      if (entry.isDirectory()) walk(absolutePath)
      else if (entry.isFile()) results.push(relative(ROOT, absolutePath) || absolutePath)
    }
  }

  walk(start)
  return results
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** DeepSeek 等模型有时会把工具调用当成普通文本输出，这里给出明确提示便于排查。 */
function warnIfToolCallLeakedIntoText(content: string): void {
  const looksLikeCall = TOOLS.some((tool) => content.includes(`"${tool.function.name}"`))
  if (looksLikeCall && content.includes('"name"')) {
    console.log("[警告] 模型把工具调用写进了 content，没有使用 tool_calls 字段。这是模型侧问题。")
  }
}

function modelName(): string {
  return process.env.MODEL_NAME?.trim() || "deepseek-v4-pro"
}

function baseUrl(): string {
  return process.env.MODEL_BASE_URL?.trim() || "https://api.deepseek.com/v1/chat/completions"
}

function loadEnv(): void {
  const envPath = join(ROOT, ".env")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    if (process.env[key]?.trim()) continue
    process.env[key] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
  }
}

void main().catch((error: unknown) => {
  console.error(`\n[错误] ${error instanceof Error ? error.message : "运行失败"}`)
  process.exitCode = 1
})
