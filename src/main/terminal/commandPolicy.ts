import { basename } from "node:path"
import type { CommandPlan } from "../../shared/types.js"
import { resolveProjectPath } from "../security/pathGuard.js"

const MAX_ARGS = 32
const MAX_ARG_LENGTH = 1_000
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 128_000
const SHELL_SYNTAX = /[;&|<>$`(){}\n\r]/
const ALLOWED_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"])

const COMMAND_PATHS: Record<string, Set<string>> = {
  pwd: new Set(["/bin/pwd", "/usr/bin/pwd"]),
  ls: new Set(["/bin/ls", "/usr/bin/ls"]),
  git: new Set(["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]),
  npm: new Set(["/usr/local/bin/npm", "/opt/homebrew/bin/npm", "/usr/bin/npm"]),
}

export interface CommandRequest {
  executable: unknown
  args?: unknown
  cwd: unknown
  timeoutMs?: unknown
  outputLimitBytes?: unknown
  envKeys?: unknown
}

export interface CommandPolicyResult {
  plan: CommandPlan
  riskReason: string
}

export function validateCommand(projectPath: string, value: unknown): CommandPolicyResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Terminal 参数必须是结构化对象")
  }
  const candidate = value as CommandRequest
  const executable = parseExecutable(candidate.executable)
  const args = parseArgs(candidate.args)
  const commandName = basename(executable)
  const allowedPaths = COMMAND_PATHS[commandName]
  if (!allowedPaths?.has(executable)) throw new Error("未知或未允许的可执行文件")
  if (args.some((arg) => SHELL_SYNTAX.test(arg))) {
    throw new Error("参数包含 Shell 语法，Terminal 只接受安全的参数数组")
  }
  validateSubcommand(commandName, args)

  const cwdValue = candidate.cwd
  if (typeof cwdValue !== "string" || !cwdValue.trim()) throw new Error("cwd 必须是字符串")
  const cwd = resolveProjectPath(projectPath, cwdValue)
  const timeoutMs = parseLimit(candidate.timeoutMs, 1_000, DEFAULT_TIMEOUT_MS)
  const outputLimitBytes = parseLimit(candidate.outputLimitBytes, 1_024, DEFAULT_OUTPUT_LIMIT_BYTES)
  const envKeys = parseEnvKeys(candidate.envKeys)
  return {
    plan: {
      executable,
      args: commandName === "git" ? ["--no-pager", ...args] : args,
      cwd,
      timeoutMs,
      outputLimitBytes,
      envKeys,
    },
    riskReason:
      commandName === "npm"
        ? "npm run 会执行仓库脚本，属于 R3 高风险命令"
        : "所有 Terminal 命令都需要逐次确认",
  }
}

export function isForbiddenCommand(value: unknown): boolean {
  try {
    if (typeof value !== "object" || value === null) return true
    const candidate = value as CommandRequest
    const executable =
      typeof candidate.executable === "string" ? basename(candidate.executable) : ""
    return [
      "sh",
      "bash",
      "zsh",
      "fish",
      "sudo",
      "osascript",
      "python",
      "python3",
      "node",
      "rm",
      "mv",
      "cp",
      "curl",
      "wget",
      "installer",
      "launchctl",
    ].includes(executable)
  } catch {
    return true
  }
}

function parseExecutable(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 512) {
    throw new Error("executable 必须是允许的绝对路径")
  }
  return value
}

function parseArgs(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error("args 数组无效")
  if (!value.every((arg) => typeof arg === "string" && arg.length <= MAX_ARG_LENGTH)) {
    throw new Error("每个 Terminal 参数必须是有限长度字符串")
  }
  return value as string[]
}

function parseEnvKeys(value: unknown): string[] {
  if (value === undefined) return ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
  if (!Array.isArray(value) || value.length > ALLOWED_ENV_KEYS.size) {
    throw new Error("envKeys 参数无效")
  }
  if (!value.every((key) => typeof key === "string" && ALLOWED_ENV_KEYS.has(key))) {
    throw new Error("Terminal 环境变量不在最小白名单中")
  }
  return [...new Set(value)] as string[]
}

function validateSubcommand(commandName: string, args: string[]): void {
  if (commandName === "pwd") {
    if (args.length > 0) throw new Error("pwd 不接受额外参数")
    return
  }
  if (commandName === "ls") {
    if (args.some((arg) => arg.startsWith("-") && !/^-[alhRt]+$/.test(arg))) {
      throw new Error("ls 参数不在安全白名单中")
    }
    if (args.some((arg) => arg.startsWith("/"))) throw new Error("ls 不允许绝对路径参数")
    return
  }
  if (commandName === "git") {
    const [subcommand] = args
    if (!subcommand || !["status", "diff", "log"].includes(subcommand)) {
      throw new Error("git 只开放 status、diff、log 只读子命令")
    }
    if (
      args.some((arg) =>
        ["--ext-diff", "--no-ext-diff", "--paginate", "--exec-path", "-c", "--config-env"].includes(
          arg,
        ),
      )
    ) {
      throw new Error("git 外部 diff、pager 和全局配置不可用")
    }
    return
  }
  if (commandName === "npm") {
    if (args.length < 2 || args[0] !== "run" || (args[1] ?? "").startsWith("-")) {
      throw new Error("npm 只开放 npm run <script>，不开放安装或配置命令")
    }
    if (args.slice(2).some((arg) => arg === "--shell" || arg === "--ignore-scripts")) {
      throw new Error("npm 脚本参数无效")
    }
  }
}

function parseLimit(value: unknown, minimum: number, maximum: number): number {
  if (value === undefined) return maximum
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("Terminal 限制参数超出范围")
  }
  return value
}
