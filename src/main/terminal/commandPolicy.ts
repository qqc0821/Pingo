import { basename } from "node:path"
import type { CommandPlan, TerminalIntent } from "../../shared/types.js"
import { resolveProjectPath } from "../security/pathGuard.js"
import { getIntentPackDefinition } from "./intentPacks.js"

const MAX_ARGS = 32
const MAX_ARG_LENGTH = 1_000
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 128_000
const SHELL_SYNTAX = /[;&|<>$`(){}\n\r]/
const QUALITY_SCRIPTS = new Set(["lint", "typecheck", "format:check", "test", "build"])

const COMMAND_PATHS: Record<string, Set<string>> = {
  pwd: new Set(["/bin/pwd", "/usr/bin/pwd"]),
  ls: new Set(["/bin/ls", "/usr/bin/ls"]),
  git: new Set(["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]),
  npm: new Set(["/usr/bin/npm", "/usr/local/bin/npm", "/opt/homebrew/bin/npm"]),
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

/**
 * Legacy direct-command validator retained only for compatibility with old
 * callers/tests. Production model tools must use compileTerminalIntent below.
 */
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
  if (candidate.envKeys !== undefined) {
    throw new Error("模型不能指定 Terminal 环境变量")
  }
  validateLegacySubcommand(commandName, args)

  if (commandName === "npm") throw new Error("npm run 当前已暂停，等待脚本绑定安全链完成")
  const cwdValue = candidate.cwd
  if (typeof cwdValue !== "string" || !cwdValue.trim()) throw new Error("cwd 必须是字符串")
  const cwd = resolveProjectPath(projectPath, cwdValue)
  const timeoutMs = parseLimit(candidate.timeoutMs, 1_000, DEFAULT_TIMEOUT_MS)
  const outputLimitBytes = parseLimit(candidate.outputLimitBytes, 1_024, DEFAULT_OUTPUT_LIMIT_BYTES)
  return {
    plan: {
      executable,
      args: commandName === "git" ? ["--no-pager", ...args] : args,
      cwd,
      timeoutMs,
      outputLimitBytes,
      envKeys: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    },
    riskReason: "旧版直接命令接口仅用于兼容；生产 Terminal 必须使用结构化意图",
  }
}

export function parseTerminalIntent(value: unknown): TerminalIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TerminalIntent 必须是结构化对象")
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.kind !== "string") throw new Error("TerminalIntent kind 无效")
  if (!getIntentPackDefinition(candidate.kind)) {
    throw new Error("TerminalIntent 未声明或当前灰度开关已关闭")
  }
  if (candidate.kind === "git.read") {
    assertExactKeys(candidate, ["kind", "action", "args", "cwd"])
    if (
      candidate.action !== "status" &&
      candidate.action !== "diff" &&
      candidate.action !== "log"
    ) {
      throw new Error("git.read 只开放 status、diff、log")
    }
    return {
      kind: "git.read",
      action: candidate.action,
      args: parseArgs(candidate.args),
      cwd: parseRelativeCwd(candidate.cwd),
    }
  }
  if (candidate.kind === "project.script") {
    assertExactKeys(candidate, ["kind", "packageManager", "script", "forwardedArgs", "cwd"])
    if (candidate.packageManager !== "npm" && candidate.packageManager !== "auto") {
      throw new Error("只开放 npm 或 auto 项目质量脚本")
    }
    if (typeof candidate.script !== "string" || !QUALITY_SCRIPTS.has(candidate.script)) {
      throw new Error("只开放 lint、typecheck、format:check、test、build 质量脚本")
    }
    const forwardedArgs = parseArgs(candidate.forwardedArgs)
    if (forwardedArgs.length > 0) {
      throw new Error("项目脚本暂不接受转发参数")
    }
    return {
      kind: "project.script",
      packageManager: candidate.packageManager,
      script: candidate.script as "lint" | "typecheck" | "format:check" | "test" | "build",
      forwardedArgs,
      cwd: parseRelativeCwd(candidate.cwd),
    }
  }
  if (candidate.kind === "git.inspect") {
    assertExactKeys(candidate, ["kind", "action", "args", "cwd"])
    if (
      candidate.action !== "show" &&
      candidate.action !== "blame" &&
      candidate.action !== "stash list"
    ) {
      throw new Error("git.inspect 只开放 show、blame、stash list")
    }
    const args = parseArgs(candidate.args)
    validateGitInspectArgs(candidate.action, args)
    return {
      kind: "git.inspect",
      action: candidate.action,
      args,
      cwd: parseRelativeCwd(candidate.cwd),
    }
  }
  if (candidate.kind === "runtime.info") {
    assertExactKeys(candidate, ["kind", "action", "cwd"])
    if (candidate.action !== "node" && candidate.action !== "npm") {
      throw new Error("runtime.info 只开放 node 或 npm 版本查询")
    }
    return { kind: "runtime.info", action: candidate.action, cwd: parseRelativeCwd(candidate.cwd) }
  }
  if (candidate.kind === "pkg.audit") {
    assertExactKeys(candidate, ["kind", "action", "packageManager", "cwd"])
    if (candidate.packageManager !== "auto") throw new Error("pkg.audit 必须使用 auto 包管理器探测")
    if (candidate.action !== "ls" && candidate.action !== "outdated") {
      throw new Error("pkg.audit 只开放 ls 或 outdated")
    }
    return {
      kind: "pkg.audit",
      action: candidate.action,
      packageManager: "auto",
      cwd: parseRelativeCwd(candidate.cwd),
    }
  }
  if (candidate.kind === "directory.list") {
    assertExactKeys(candidate, ["kind", "action", "cwd"])
    if (candidate.action !== "list") {
      throw new Error("directory.list 只开放 list")
    }
    return { kind: "directory.list", action: "list", cwd: parseRelativeCwd(candidate.cwd) }
  }
  throw new Error("不支持的 TerminalIntent")
}

export function isForbiddenCommand(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return true
  const candidate = value as Record<string, unknown>
  if (typeof candidate.kind === "string") {
    try {
      parseTerminalIntent(value)
      return false
    } catch {
      return true
    }
  }
  const executable = typeof candidate.executable === "string" ? basename(candidate.executable) : ""
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
    "npx",
  ].includes(executable)
}

export function validateGitReadArgs(action: "status" | "diff" | "log", args: string[]): void {
  if (action !== "status" && action !== "diff" && action !== "log") {
    throw new Error("git 只开放 status、diff、log 只读子命令")
  }
  const allowedFlags = getAllowedGitFlags(action)
  let afterPathSeparator = false
  let expectsValue: "count" | null = null
  for (const arg of args) {
    if (SHELL_SYNTAX.test(arg) || arg.includes("\u0000")) {
      throw new Error("Git 参数包含不安全语法")
    }
    if (expectsValue) {
      if (!/^\d{1,6}$/.test(arg)) throw new Error("Git 数量参数无效")
      expectsValue = null
      continue
    }
    if (arg === "--") {
      afterPathSeparator = true
      continue
    }
    if (arg.startsWith("-")) {
      if (arg === "-n" || arg === "--max-count") {
        if (action !== "log") throw new Error("Git 参数不属于该子命令")
        expectsValue = "count"
        continue
      }
      if (!allowedFlags.has(arg) && !isAllowedInlineGitFlag(action, arg)) {
        throw new Error("Git 参数不在该只读子命令的安全 grammar 中")
      }
      continue
    }
    if (!afterPathSeparator && isGitPathLike(arg)) {
      // Status/diff/log pathspecs are allowed only after --, which removes
      // ambiguity with flags and keeps all path handling in this parser.
      throw new Error("Git 路径参数必须位于 -- 之后")
    }
    validateGitRelativePath(arg)
  }
  if (expectsValue) throw new Error("Git 数量参数缺少值")
}

function validateGitInspectArgs(action: "show" | "blame" | "stash list", args: string[]): void {
  const definition = getIntentPackDefinition("git.inspect")
  const grammar = definition?.actions[action]
  if (!grammar) throw new Error("git.inspect action 未声明")
  let afterPathSeparator = false
  for (const arg of args) {
    if (SHELL_SYNTAX.test(arg) || arg.includes("\u0000")) throw new Error("Git 参数包含不安全语法")
    if (arg === "--") {
      afterPathSeparator = true
      continue
    }
    if (arg.startsWith("-")) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      if (!grammar.allowedFlags.includes(arg) && !grammar.allowedFlags.includes(flag)) {
        throw new Error("git.inspect 参数不在安全 grammar 中")
      }
      continue
    }
    if (action === "stash list") throw new Error("stash list 不接受位置参数")
    if (!afterPathSeparator && action === "blame") {
      if (!/^(?:HEAD|[0-9a-f]{7,64})$/.test(arg)) throw new Error("Git 路径参数必须位于 -- 之后")
    } else if (afterPathSeparator) {
      validateGitRelativePath(arg)
    } else if (action === "show" && !/^(?:HEAD|[0-9a-f]{7,64}|HEAD~\d{1,4})$/.test(arg)) {
      throw new Error("git show 只接受安全的 revision")
    }
  }
}

function validateLegacySubcommand(commandName: string, args: string[]): void {
  if (commandName === "pwd") {
    if (args.length > 0) throw new Error("pwd 不接受额外参数")
    return
  }
  if (commandName === "ls") {
    if (args.some((arg) => arg.startsWith("-") && !/^-[alhRt]+$/.test(arg))) {
      throw new Error("ls 参数不在安全白名单中")
    }
    if (args.some((arg) => arg.startsWith("/"))) throw new Error("ls 不允许绝对路径参数")
    if (args.some((arg) => arg.split("/").includes(".."))) throw new Error("ls 不允许 ..")
    return
  }
  if (commandName === "git") {
    const normalized = args[0] === "--no-pager" ? args.slice(1) : args
    const [subcommand, ...rest] = normalized
    validateGitReadArgs(subcommand as "status" | "diff" | "log", rest)
    return
  }
  if (commandName === "npm") {
    throw new Error("npm run 当前已暂停，等待脚本绑定安全链完成")
  }
  throw new Error("未知 Terminal 命令")
}

function getAllowedGitFlags(action: "status" | "diff" | "log"): Set<string> {
  if (action === "status")
    return new Set(["--short", "--porcelain", "--branch", "--untracked-files=no"])
  if (action === "diff") {
    return new Set([
      "--cached",
      "--staged",
      "--stat",
      "--name-only",
      "--name-status",
      "--no-color",
      "--minimal",
    ])
  }
  return new Set(["--oneline", "--decorate", "--stat", "--no-color", "--first-parent"])
}

function isAllowedInlineGitFlag(action: "status" | "diff" | "log", arg: string): boolean {
  if (action === "status") return /^--untracked-files=(no|normal|all)$/.test(arg)
  if (action === "log")
    return /^--max-count=\d{1,6}$/.test(arg) || /^--pretty=(oneline|short|medium)$/.test(arg)
  return false
}

function isGitPathLike(arg: string): boolean {
  return !arg.startsWith("-")
}

function validateGitRelativePath(value: string): void {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) {
    throw new Error("Git 路径必须是 workspace 内相对路径")
  }
  if (value.split("/").some((part) => part === "..")) {
    throw new Error("Git 路径不允许使用 ..")
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
  return [...(value as string[])]
}

function parseRelativeCwd(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
    throw new Error("cwd 必须是 workspace 内相对路径")
  }
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.split("/").includes("..")
  ) {
    throw new Error("cwd 必须是 workspace 内相对路径")
  }
  return value
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("TerminalIntent 包含 Main 才能决定的字段")
  }
}

function parseLimit(value: unknown, minimum: number, maximum: number): number {
  if (value === undefined) return maximum
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("Terminal 限制参数超出范围")
  }
  return value
}
