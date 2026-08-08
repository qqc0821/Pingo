import { createHash } from "node:crypto"
import { relative } from "node:path"
import type {
  ResolvedCommandPlan,
  TerminalIntent,
  TerminalPolicyFailure,
  TerminalSandboxSpec,
} from "../../shared/types.js"
import { getRealProjectRoot, resolveProjectPath } from "../security/pathGuard.js"
import { parseTerminalIntent, validateGitReadArgs } from "./commandPolicy.js"
import { readBoundExecutableIdentity, resolveExecutableIdentity } from "./executableIdentity.js"
import { resolveProjectScript, verifyProjectScriptBinding } from "./projectScript.js"
import { createSandboxSpec } from "./sandboxProfile.js"

const TERMINAL_TTL_MS = 60_000
const TERMINAL_TIMEOUT_MS = 30_000
const TERMINAL_OUTPUT_BYTES = 128_000

export class TerminalPolicyError extends Error {
  constructor(
    public readonly failure: TerminalPolicyFailure,
    cause?: unknown,
  ) {
    super(failure.message, cause instanceof Error ? { cause } : undefined)
    this.name = "TerminalPolicyError"
  }
}

export interface CompileTerminalOptions {
  taskId: string
  operationId: string
  sourceWindowId: string
  projectRoot: string
  now?: number
  expiresAt?: number
}

export function compileTerminalIntent(
  value: unknown,
  options: CompileTerminalOptions,
): ResolvedCommandPlan {
  let intent: TerminalIntent
  try {
    intent = parseTerminalIntent(value)
  } catch (error) {
    throw policyError("command_forbidden", safeMessage(error), false, "change_approach")
  }
  const projectRoot = getRealProjectRoot(options.projectRoot)
  const now = options.now ?? Date.now()
  const expiresAt = options.expiresAt ?? now + TERMINAL_TTL_MS
  if (expiresAt <= now)
    throw policyError("approval_expired", "Terminal 计划已过期", false, "ask_user")

  try {
    const cwd = resolveProjectPath(projectRoot, intent.cwd)
    const rootId = projectRoot
    const base = {
      operationId: options.operationId,
      taskId: options.taskId,
      sourceWindowId: options.sourceWindowId,
      intent,
      cwd: {
        rootId,
        relativePath: relative(projectRoot, cwd) || ".",
        realPath: cwd,
      },
      limits: {
        timeoutMs: TERMINAL_TIMEOUT_MS,
        outputBytes: TERMINAL_OUTPUT_BYTES,
      },
      createdAt: now,
      expiresAt,
    } as const

    const resolved =
      intent.kind === "git.read"
        ? compileGitRead(projectRoot, intent, base)
        : compileProjectScript(projectRoot, intent, base)
    const planDigest = createPlanDigest({ ...resolved, planDigest: undefined })
    return freezePlan({ ...resolved, planDigest })
  } catch (error) {
    if (error instanceof TerminalPolicyError) throw error
    throw policyError("command_forbidden", safeMessage(error), false, "change_approach", error)
  }
}

export function revalidateTerminalPlan(
  projectRoot: string,
  plan: ResolvedCommandPlan,
  now = Date.now(),
): void {
  if (plan.expiresAt <= now) {
    throw policyError("approval_expired", "Terminal 计划已过期", false, "ask_user")
  }
  try {
    readBoundExecutableIdentity(plan.executable)
  } catch (error) {
    throw policyError("executable_changed", "可执行文件身份已变化", false, "ask_user", error)
  }
  let current: ResolvedCommandPlan
  try {
    current = compileTerminalIntent(plan.intent, {
      taskId: plan.taskId,
      operationId: plan.operationId,
      sourceWindowId: plan.sourceWindowId,
      projectRoot,
      now: plan.createdAt,
      expiresAt: plan.expiresAt,
    })
  } catch (error) {
    if (error instanceof TerminalPolicyError && plan.projectScript) {
      throw policyError("script_changed", error.message, false, "ask_user", error)
    }
    throw error
  }
  if (current.planDigest !== plan.planDigest) {
    throw policyError("plan_changed", "批准后的 Terminal 计划已变化", false, "ask_user")
  }
  if (plan.projectScript) {
    try {
      verifyProjectScriptBinding(getRealProjectRoot(projectRoot), plan.projectScript)
    } catch (error) {
      throw policyError(
        "script_changed",
        "package.json 或 script 正文已变化",
        false,
        "ask_user",
        error,
      )
    }
  }
  if (!sameSandboxSpec(current.sandbox, plan.sandbox)) {
    throw policyError("plan_changed", "Seatbelt sandbox spec 已变化", false, "ask_user")
  }
}

export function createPlanDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

export function formatResolvedCommand(plan: ResolvedCommandPlan): string {
  const command = [plan.executable.displayName, ...plan.argv]
    .map((argument) => quoteArg(argument))
    .join(" ")
  return command
}

export function terminalFailure(
  code: TerminalPolicyFailure["code"],
  message: string,
  retryable: boolean,
  requiredAction?: TerminalPolicyFailure["requiredAction"],
): TerminalPolicyFailure {
  return { code, policy_code: code, message: message.slice(0, 240), retryable, requiredAction }
}

function compileGitRead(
  projectRoot: string,
  intent: Extract<TerminalIntent, { kind: "git.read" }>,
  base: Omit<
    ResolvedCommandPlan,
    | "executable"
    | "argv"
    | "projectScript"
    | "effects"
    | "sandbox"
    | "risk"
    | "reason"
    | "planDigest"
  >,
): Omit<ResolvedCommandPlan, "planDigest"> {
  try {
    validateGitReadArgs(intent.action, intent.args)
  } catch (error) {
    throw policyError("command_forbidden", safeMessage(error), false, "change_approach", error)
  }
  const executable = resolveExecutableIdentity("git")
  const effects = {
    workspace: "read" as const,
    projectCodeExecution: false,
    network: "none" as const,
    externalPaths: [],
  }
  const sandbox = createSandboxSpec(projectRoot, base.operationId, executable, effects)
  return {
    ...base,
    executable,
    argv: ["--no-pager", intent.action, ...intent.args],
    effects,
    sandbox,
    risk: "R1",
    reason: "只读 Git 查询；workspace 只读、网络关闭、目录外访问禁止",
  }
}

function compileProjectScript(
  projectRoot: string,
  intent: Extract<TerminalIntent, { kind: "project.script" }>,
  base: Omit<
    ResolvedCommandPlan,
    | "executable"
    | "argv"
    | "projectScript"
    | "effects"
    | "sandbox"
    | "risk"
    | "reason"
    | "planDigest"
  >,
): Omit<ResolvedCommandPlan, "planDigest"> {
  let resolvedScript
  try {
    resolvedScript = resolveProjectScript(projectRoot, intent)
  } catch (error) {
    throw policyError("command_forbidden", safeMessage(error), false, "change_approach", error)
  }
  const executable = resolveExecutableIdentity("npm")
  const effects = {
    workspace: "write" as const,
    projectCodeExecution: true,
    network: "none" as const,
    externalPaths: [],
  }
  const sandbox = createSandboxSpec(projectRoot, base.operationId, executable, effects)
  return {
    ...base,
    cwd: { ...base.cwd, realPath: resolvedScript.cwd },
    executable,
    argv: ["run", intent.script],
    projectScript: resolvedScript.binding,
    effects,
    sandbox,
    risk: "R3",
    reason: `将执行 package.json 中的 ${intent.script} 质量脚本；可写 workspace 和 operation 临时目录，网络关闭`,
  }
}

function sameSandboxSpec(a: TerminalSandboxSpec, b: TerminalSandboxSpec): boolean {
  return (
    createPlanDigest({ ...a, specDigest: undefined }) ===
    createPlanDigest({ ...b, specDigest: undefined })
  )
}

function freezePlan(plan: ResolvedCommandPlan): ResolvedCommandPlan {
  Object.freeze(plan.intent)
  Object.freeze(plan.argv)
  Object.freeze(plan.cwd)
  if (plan.projectScript) Object.freeze(plan.projectScript)
  Object.freeze(plan.effects.externalPaths)
  Object.freeze(plan.effects)
  Object.freeze(plan.sandbox.readRoots)
  Object.freeze(plan.sandbox.writeRoots)
  Object.freeze(plan.sandbox.protectedPaths)
  Object.freeze(plan.sandbox)
  Object.freeze(plan.limits)
  return Object.freeze(plan)
}

function policyError(
  code: TerminalPolicyFailure["code"],
  message: string,
  retryable: boolean,
  requiredAction: TerminalPolicyFailure["requiredAction"],
  cause?: unknown,
): TerminalPolicyError {
  return new TerminalPolicyError(terminalFailure(code, message, retryable, requiredAction), cause)
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value)
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Terminal 策略拒绝了这项请求"
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`
}
