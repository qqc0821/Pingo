import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import type {
  ApprovalRequest,
  Capability,
  CapabilityGrant,
  OperationKind,
  OperationPlan,
  OperationResult,
  ResolvedCommandPlan,
  TerminalPolicyFailure,
  TaskState,
} from "../../shared/types.js"
import { AuditLogger } from "../security/auditLogger.js"
import { ApprovalBroker } from "../security/approvalBroker.js"
import { CapabilityManager } from "../security/capabilityManager.js"
import { TerminalTrustManager } from "../security/terminalTrust.js"
import {
  compileTerminalIntent,
  formatResolvedCommand,
  revalidateTerminalPlan,
  TerminalPolicyError,
  terminalFailure,
} from "../terminal/intentPolicy.js"
import { TerminalError } from "../terminal/backend.js"
import { TerminalRunnerError } from "../terminal/seatbeltBackend.js"
import { TerminalSessionService } from "../terminal/sessionRegistry.js"
import type { TerminalFeatureFlags } from "../terminal/featureFlags.js"
import { executeTool, READ_ONLY_TOOL_NAMES } from "../tools/registry.js"
import type { ToolExecution } from "../tools/types.js"
import { planFileOperation, type PlannedFileOperation } from "../tools/fileOperations.js"
import { getRealProjectRoot } from "../security/pathGuard.js"
import { detectSandboxDenial } from "../terminal/policyCatalog.js"
import type { SettingsStore } from "../store.js"
import { UndoManager } from "./undoManager.js"
import { actionClass, type ExecutionPolicy } from "./executionPolicy.js"
import type { TaskRecord } from "./taskManager.js"

export interface CapabilityAccess {
  grant?: CapabilityGrant
  trustedWorkspace: boolean
}

interface ToolExecutorDeps {
  settingsStore: SettingsStore
  auditLogger: AuditLogger
  executionPolicy: ExecutionPolicy
  capabilityManager: CapabilityManager
  approvalBroker: ApprovalBroker
  terminalSessionService: TerminalSessionService
  terminalFeatureFlags: TerminalFeatureFlags
  terminalTrustManager: TerminalTrustManager
  undoManager: UndoManager
  emitState: (task: TaskRecord, state: TaskState) => void
  emitOperationResult: (task: TaskRecord, result: OperationResult) => void
}

/** Owns tool authorization, preview, approval, execution, and terminal containment. */
export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  async executeTool(task: TaskRecord, name: string, args: unknown): Promise<ToolExecution> {
    if (task.cancelled)
      return { content: "任务已取消。", detail: "任务已取消", status: "cancelled" }
    if (READ_ONLY_TOOL_NAMES.has(name)) {
      const grant = await this.waitForCapability(task, "workspace.read")
      if (!grant) return this.trackToolExecution(task, name, deniedExecution("workspace.read"))
      const projectPath = this.requireProjectPath(task)
      if (grant.grant) this.deps.capabilityManager.consume(grant.grant.grantId)
      const execution = await executeTool(projectPath, name, args)
      return this.trackToolExecution(task, name, execution)
    }
    if (isFileOperation(name))
      return this.trackToolExecution(task, name, await this.executeFileOperation(task, name, args))
    if (name === "terminal_intent")
      return this.trackToolExecution(task, name, await this.executeTerminalOperation(task, args))
    if (name === "terminal_execute") {
      return this.trackToolExecution(task, name, {
        content:
          "[policy_code=command_forbidden] 命令未执行：旧版通用 Terminal 接口已关闭。请改用 terminal_intent。",
        detail: "policy_code=command_forbidden",
        status: "denied",
        policyFailure: terminalFailure(
          "command_forbidden",
          "旧版通用 Terminal 接口已关闭",
          false,
          "change_approach",
        ),
      })
    }
    return this.trackToolExecution(task, name, {
      content: `工具 ${name} 不被允许。`,
      detail: `已拒绝未知工具 ${name}`,
      status: "denied",
    })
  }

  private trackToolExecution(
    task: TaskRecord,
    name: string,
    execution: ToolExecution,
  ): ToolExecution {
    const kind = READ_ONLY_TOOL_NAMES.has(name) ? "read" : "change"
    if (execution.status === "completed" && task.unresolvedToolName === name) {
      task.unresolvedOperationFailure = undefined
      task.unresolvedToolKind = undefined
      task.unresolvedToolName = undefined
    } else if (execution.status) {
      if (execution.status !== "completed") {
        task.unresolvedOperationFailure = execution.content || execution.detail
        task.unresolvedToolKind = kind
        task.unresolvedToolName = name
      }
    }
    return execution
  }

  private async executeFileOperation(
    task: TaskRecord,
    name: string,
    args: unknown,
  ): Promise<ToolExecution> {
    const kind = name as Exclude<OperationKind, "terminal.execute">
    const grant = await this.waitForCapability(task, "workspace.write")
    if (!grant) return deniedExecution("workspace.write")
    const projectPath = this.requireProjectPath(task)
    let operation: PlannedFileOperation
    try {
      operation = planFileOperation(
        projectPath,
        task.taskId,
        task.sourceWindowId,
        kind,
        args,
        (value) => this.deps.approvalBroker.createPlanDigest(value),
      )
    } catch (error) {
      return {
        content: `操作未创建：${safeError(error)}`,
        detail: "文件操作预览失败",
        status: "failed",
      }
    }
    const execute = async () => {
      if (grant.trustedWorkspace) {
        this.assertTrustedWorkspaceTargets(task, operation.plan.targets)
      } else {
        this.deps.capabilityManager.assertAllowed(
          "workspace.write",
          operation.plan.targets,
          task.sourceWindowId,
        )
        if (grant.grant) this.deps.capabilityManager.consume(grant.grant.grantId)
      }
      return operation.execute({ isCancelled: () => task.cancelled })
    }
    const result = grant.trustedWorkspace
      ? await this.executeTrustedOperation(task, operation.plan, execute)
      : await this.confirmAndExecute(task, operation.plan, execute)
    if (result.status === "completed" && result.undoId && operation.undo) {
      this.deps.undoManager.register({
        undoId: result.undoId,
        taskId: task.taskId,
        sourceWindowId: task.sourceWindowId,
        kind,
        targets: operation.plan.targets,
        preview: `撤销：${operation.plan.preview}`,
        run: operation.undo,
      })
    }
    return {
      content: result.content,
      detail: result.detail,
      status: result.status,
      ...(result.policyFailure ? { errorCode: result.policyFailure.code } : {}),
      truncated: result.truncated,
    }
  }

  private async executeTerminalOperation(
    task: TaskRecord,
    args: unknown,
    options: { forceApproval?: boolean } = {},
  ): Promise<ToolExecution> {
    const grant = await this.waitForCapability(task, "terminal.execute")
    if (!grant || (!grant.grant && !grant.trustedWorkspace))
      return deniedExecution("terminal.execute")
    if (!this.deps.terminalFeatureFlags.terminalV2Enabled) {
      const policyFailure = terminalFailure(
        "command_forbidden",
        "Terminal V2 当前处于灰度关闭状态，没有启动进程",
        true,
        "change_approach",
      )
      return {
        content: `[policy_code=${policyFailure.policy_code}] ${policyFailure.message}`,
        detail: `policy_code=${policyFailure.policy_code}`,
        status: "denied",
        policyFailure,
      }
    }
    const sessionGrant = grant.grant
    const projectPath = this.requireProjectPath(task)
    const operationId = randomUUID()
    let terminalPlan: ResolvedCommandPlan
    try {
      if (
        typeof args === "object" &&
        args !== null &&
        (args as { kind?: unknown }).kind === "project.script" &&
        !this.deps.terminalFeatureFlags.projectScriptsEnabled
      ) {
        throw new TerminalPolicyError(
          terminalFailure(
            "command_forbidden",
            "项目质量脚本当前处于灰度关闭状态",
            true,
            "change_approach",
          ),
        )
      }
      terminalPlan = compileTerminalIntent(args, {
        taskId: task.taskId,
        operationId,
        sourceWindowId: task.sourceWindowId,
        projectRoot: projectPath,
      })
    } catch (error) {
      const policyFailure = getTerminalFailure(error)
      return {
        content: `[policy_code=${policyFailure.policy_code}] 命令未执行：${policyFailure.message}`,
        detail: `policy_code=${policyFailure.code}`,
        status: "failed",
        policyFailure,
      }
    }
    const now = terminalPlan.createdAt
    const plan: OperationPlan = {
      operationId,
      taskId: task.taskId,
      sourceWindowId: task.sourceWindowId,
      kind: "terminal.execute",
      capability: "terminal.execute",
      risk: terminalPlan.risk,
      riskReason: terminalPlan.reason,
      targets: [terminalPlan.cwd.realPath],
      preview: formatTerminalPlanPreview(terminalPlan),
      terminalPlan,
      preconditions: [],
      digest: terminalPlan.planDigest,
      createdAt: now,
      expiresAt: terminalPlan.expiresAt,
      reversible: false,
    }
    const result = await this.confirmAndExecute(
      task,
      plan,
      async () => {
        if (!plan.terminalPlan) throw new Error("Terminal 计划缺失")
        revalidateTerminalPlan(projectPath, plan.terminalPlan)
        if (grant.trustedWorkspace) {
          this.assertTrustedWorkspaceTargets(task, plan.targets, "terminal")
        } else if (sessionGrant) {
          this.deps.capabilityManager.assertAllowed(
            "terminal.execute",
            plan.targets,
            task.sourceWindowId,
          )
          this.deps.capabilityManager.consume(sessionGrant.grantId)
        }
        const spawned = await this.deps.terminalSessionService.spawn(
          task.taskId,
          {
            type: "seatbelt",
            plan: plan.terminalPlan,
            onProgress: (event) => task.emit(event),
          },
          task.controller.signal,
        )
        const sessionId = spawned.snapshot.sessionId
        task.activeTerminalSessionId = sessionId
        try {
          const run = await spawned.operation.done
          const policyFailure = run.cancelled
            ? terminalFailure(
                "cancelled",
                "Terminal operation 已取消并确认进程已结束",
                true,
                "ask_user",
              )
            : run.timedOut
              ? terminalFailure(
                  "timed_out",
                  "Terminal operation 超时并已终止进程树",
                  true,
                  "ask_user",
                )
              : run.hardLimitExceeded
                ? terminalFailure(
                    "output_limit_exceeded",
                    "Terminal 输出超过限制并已终止进程树",
                    true,
                    "change_approach",
                  )
                : detectSandboxDenial(run.content)
          const status = run.cancelled
            ? "cancelled"
            : run.exitCode === 0 && !run.timedOut && !run.hardLimitExceeded
              ? "completed"
              : "failed"
          return {
            operationId: plan.operationId,
            status,
            content:
              run.content || (status === "completed" ? "命令完成，无输出。" : "命令未成功完成。"),
            detail: `exitCode=${String(run.exitCode)} signal=${String(run.signal)}${run.timedOut ? " timeout" : ""}`,
            reversible: false,
            exitCode: run.exitCode,
            signal: run.signal,
            truncated: run.truncated,
            policyFailure,
          }
        } finally {
          task.activeTerminalSessionId = undefined
          await this.deps.terminalSessionService
            .kill(task.taskId, sessionId, "command completed")
            .catch(() => {})
        }
      },
      options,
    )
    return {
      content: result.policyFailure
        ? `[policy_code=${result.policyFailure.policy_code}] ${result.content}`
        : result.content,
      detail: result.detail,
      status: result.status,
      ...(result.policyFailure ? { policyFailure: result.policyFailure } : {}),
    }
  }

  async confirmAndExecute(
    task: TaskRecord,
    plan: OperationPlan,
    execute: () => Promise<OperationResult>,
    options: { forceApproval?: boolean } = {},
  ): Promise<OperationResult> {
    if (this.deps.executionPolicy.actions[actionClass(plan.kind)] === "automatic") {
      return this.executeTrustedOperation(task, plan, execute)
    }
    const trustUsed = Boolean(
      !options.forceApproval &&
      plan.terminalPlan &&
      this.deps.terminalTrustManager.consumeIfAllowed(plan.terminalPlan, task.sourceWindowId),
    )
    this.deps.emitState(task, trustUsed ? "executing" : "awaiting_confirmation")
    const decision = trustUsed
      ? { decision: "approve" as const, remember: false }
      : await this.deps.approvalBroker.waitForDecision(plan, (request) => {
          task.emit({ type: "approval-request", request: sanitizeApprovalRequest(request) })
        })
    if (decision.decision !== "approve") {
      const status =
        decision.decision === "expired"
          ? "expired"
          : decision.decision === "cancelled"
            ? "cancelled"
            : "denied"
      const result: OperationResult = {
        operationId: plan.operationId,
        status,
        content:
          status === "denied"
            ? `用户拒绝了这项操作。${decision.reason ? `理由：${decision.reason}` : ""}`
            : "这项操作未获确认，因此没有执行。",
        detail:
          status === "expired" ? "确认已超时" : status === "cancelled" ? "任务已取消" : "用户拒绝",
        reversible: plan.reversible,
        policyFailure:
          status === "denied"
            ? terminalFailure(
                "user_denied",
                "用户拒绝了这项 Terminal operation",
                false,
                "change_approach",
              )
            : status === "expired"
              ? terminalFailure(
                  "approval_expired",
                  "确认已过期，没有创建终端进程",
                  true,
                  "ask_user",
                )
              : terminalFailure("cancelled", "操作已取消，没有创建终端进程", true, "ask_user"),
      }
      this.deps.emitOperationResult(task, result)
      this.deps.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: result.detail,
        ...(plan.terminalPlan ? { planDigest: plan.terminalPlan.planDigest } : {}),
        ...(result.policyFailure ? { policyCode: result.policyFailure.policy_code } : {}),
      })
      return result
    }
    try {
      if (!trustUsed) {
        this.deps.approvalBroker.consumeApproval(plan, decision.token, {
          sourceWindowId: task.sourceWindowId,
          taskId: task.taskId,
          operationId: plan.operationId,
        })
      }
      if (decision.remember) {
        if (!plan.terminalPlan) throw new Error("只有 Terminal read-only 意图可以积累信任")
        this.deps.terminalTrustManager.grant(plan.terminalPlan, task.sourceWindowId)
      }
      if (!trustUsed) this.deps.emitState(task, "executing")
      const result = await execute()
      this.deps.emitOperationResult(task, result)
      this.deps.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: result.detail,
        ...(plan.terminalPlan ? { planDigest: plan.terminalPlan.planDigest } : {}),
        ...(result.policyFailure ? { policyCode: result.policyFailure.policy_code } : {}),
      })
      return result
    } catch (error) {
      const policyFailure = getTerminalFailure(error)
      const result: OperationResult = {
        operationId: plan.operationId,
        status: task.cancelled ? "cancelled" : "failed",
        content: `操作未执行：${policyFailure.message}`,
        detail: `policy_code=${policyFailure.code}`,
        reversible: plan.reversible,
        policyFailure,
      }
      this.deps.emitOperationResult(task, result)
      this.deps.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: result.detail,
        ...(plan.terminalPlan ? { planDigest: plan.terminalPlan.planDigest } : {}),
        ...(result.policyFailure ? { policyCode: result.policyFailure.policy_code } : {}),
      })
      return result
    }
  }

  async executeTrustedOperation(
    task: TaskRecord,
    plan: OperationPlan,
    execute: () => Promise<OperationResult>,
  ): Promise<OperationResult> {
    this.deps.emitState(task, "executing")
    try {
      const result = await execute()
      this.deps.emitOperationResult(task, result)
      this.deps.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: `trusted_workspace: ${result.detail}`,
      })
      return result
    } catch (error) {
      const result: OperationResult = {
        operationId: plan.operationId,
        status: task.cancelled ? "cancelled" : "failed",
        content: `操作未执行：${safeError(error)}`,
        detail: safeError(error),
        reversible: plan.reversible,
      }
      this.deps.emitOperationResult(task, result)
      this.deps.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: `trusted_workspace: ${result.detail}`,
      })
      return result
    }
  }

  async waitForCapability(
    task: TaskRecord,
    capability: Capability,
  ): Promise<CapabilityAccess | null> {
    if (
      this.deps.executionPolicy.actions[
        capability === "workspace.read"
          ? "read"
          : capability === "workspace.write"
            ? "file-change"
            : "terminal"
      ] === "automatic"
    )
      return { trustedWorkspace: true }
    const projectPath = this.deps.settingsStore.getAuthorizedProjectPath()
    if (projectPath && capability !== "terminal.execute" && this.isTrustedWorkspace(projectPath)) {
      return { trustedWorkspace: true }
    }
    if (projectPath) {
      try {
        return {
          grant: this.deps.capabilityManager.assertAllowed(
            capability,
            [projectPath],
            task.sourceWindowId,
          ),
          trustedWorkspace: false,
        }
      } catch {
        // Fall through to the explicit permission request.
      }
    }
    this.deps.emitState(task, "awaiting_permission")
    const granted = await new Promise<boolean>((resolve) => {
      task.permission = { capabilities: [capability], resolve }
      task.emit({
        type: "capability-request",
        taskId: task.taskId,
        capabilities: [capability],
        scopeRoots: projectPath ? [projectPath] : [],
      })
    })
    if (!granted || task.cancelled) return null
    const nextProjectPath = this.deps.settingsStore.getAuthorizedProjectPath()
    if (!nextProjectPath) return null
    try {
      return {
        grant: this.deps.capabilityManager.assertAllowed(
          capability,
          [nextProjectPath],
          task.sourceWindowId,
        ),
        trustedWorkspace: false,
      }
    } catch {
      return null
    }
  }

  private requireProjectPath(task: TaskRecord): string {
    const projectPath = task.projectPath
    if (!projectPath) throw new Error("当前项目目录不可访问")
    return getRealProjectRoot(projectPath)
  }

  getActiveProjectPath(): string | undefined {
    const preferencesPath = this.deps.settingsStore.getPreferences().defaultLocation.trim()
    const rememberedPath = this.deps.settingsStore.getAuthorizedProjectPath()
    const usableRememberedPath = rememberedPath === homedir() ? undefined : rememberedPath
    const candidates = this.deps.executionPolicy.allowProcessCwdFallback
      ? [preferencesPath, usableRememberedPath, process.cwd()]
      : [rememberedPath, preferencesPath]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        return getRealProjectRoot(candidate)
      } catch {
        // Try the next configured location.
      }
    }
    return undefined
  }

  private isTrustedWorkspace(projectPath: string): boolean {
    const trusted = this.deps.settingsStore.getTrustedWorkspace()
    if (!trusted) return false
    try {
      return getRealProjectRoot(trusted.path) === getRealProjectRoot(projectPath)
    } catch {
      return false
    }
  }

  assertTrustedWorkspaceTargets(
    task: TaskRecord,
    targets: string[],
    action: "file-change" | "terminal" = "file-change",
  ): void {
    if (this.deps.executionPolicy.actions[action] === "automatic") {
      const root = this.requireProjectPath(task)
      if (!targets.every((target) => isWithinRoot(root, target))) {
        throw new Error("操作目标越过当前项目目录")
      }
      return
    }
    const trusted = this.deps.settingsStore.getTrustedWorkspace()
    if (!trusted) throw new Error("持续目录授权已关闭")
    const root = getRealProjectRoot(trusted.path)
    if (!targets.every((target) => isWithinRoot(root, target))) {
      throw new Error("操作目标越过持续授权目录")
    }
  }
}

function isFileOperation(name: string): name is Exclude<OperationKind, "terminal.execute"> {
  return ["create_directory", "write_file", "apply_patch", "move_path", "trash_path"].includes(name)
}

function isWithinRoot(root: string, target: string): boolean {
  if (!isAbsolute(target)) return false
  const relativeTarget = relative(root, target)
  return (
    relativeTarget === "" ||
    (!relativeTarget.startsWith(`..${sep}`) &&
      relativeTarget !== ".." &&
      !isAbsolute(relativeTarget))
  )
}

function formatTerminalPlanPreview(plan: ResolvedCommandPlan): string {
  const lines = [
    `command: ${formatResolvedCommand(plan)}`,
    `cwd: ${plan.cwd.relativePath || "."}`,
    `executable: ${plan.executable.realPath}`,
    `effects: workspace=${plan.effects.workspace}; projectCodeExecution=${String(plan.effects.projectCodeExecution)}`,
    "network: disabled",
    "externalPaths: none",
    `sandbox: profile=${plan.sandbox.profileVersion}; HOME=isolated; TMP=operation-private; protected=${plan.sandbox.protectedPaths.length}`,
    `limits: timeoutMs=${plan.limits.timeoutMs}; outputBytes=${plan.limits.outputBytes}; cancel=SIGTERM→750ms→SIGKILL`,
    `planDigest: ${plan.planDigest}`,
  ]
  if (plan.projectScript) {
    lines.push(
      `script: ${plan.projectScript.name}`,
      `scriptBody: ${plan.projectScript.body}`,
      `scriptSource: ${plan.projectScript.packageJsonRelativePath}`,
      `packageJsonSha256: ${plan.projectScript.packageJsonSha256}`,
    )
  }
  return lines.join("\n")
}

function sanitizeApprovalRequest(request: ApprovalRequest): ApprovalRequest {
  const plan = { ...request.plan, preview: request.plan.preview.slice(0, 24_000) }
  const terminalPlan = plan.terminalPlan
  if (!terminalPlan) return { ...request, plan }
  return {
    ...request,
    plan,
    display: {
      riskBadge: {
        level: terminalPlan.risk,
        tier: terminalPlan.sandbox.tier,
        label: formatTerminalRiskBadge(terminalPlan),
      },
      pathPreview: {
        readRoots: terminalPlan.sandbox.readRoots,
        writeRoots: terminalPlan.sandbox.writeRoots,
        protectedPaths: terminalPlan.sandbox.protectedPaths,
      },
      fingerprint: { words: readableFingerprint(terminalPlan.planDigest) },
    },
  }
}

function formatTerminalRiskBadge(plan: ResolvedCommandPlan): string {
  if (plan.sandbox.tier === "read-only" && plan.effects.workspace === "read") {
    return `${plan.risk} · 只读、无项目代码执行`
  }
  if (plan.sandbox.tier === "workspace-write" && plan.effects.projectCodeExecution) {
    return `${plan.risk} · workspace 可写、执行项目代码`
  }
  return `${plan.risk} · ${plan.sandbox.tier}`
}

const FINGERPRINT_WORDS = [
  "安静",
  "绿色",
  "松鼠",
  "晴朗",
  "蓝色",
  "灯塔",
  "温柔",
  "金色",
  "云朵",
  "清醒",
  "紫色",
  "风铃",
  "可靠",
  "银色",
  "海湾",
  "明亮",
]

export function readableFingerprint(digest: string): [string, string, string] {
  const indexes = [0, 8, 16].map(
    (offset) => Number.parseInt(digest.slice(offset, offset + 8), 16) % FINGERPRINT_WORDS.length,
  )
  return [
    FINGERPRINT_WORDS[indexes[0] ?? 0] ?? "安静",
    FINGERPRINT_WORDS[indexes[1] ?? 0] ?? "绿色",
    FINGERPRINT_WORDS[indexes[2] ?? 0] ?? "松鼠",
  ]
}

function getTerminalFailure(error: unknown): TerminalPolicyFailure {
  if (error instanceof TerminalPolicyError || error instanceof TerminalRunnerError) {
    return error.failure
  }
  if (error instanceof TerminalError && error.code === "LIMIT_REACHED") {
    return terminalFailure("command_forbidden", "Terminal 并发数已达上限", true, "ask_user")
  }
  return terminalFailure("command_forbidden", safeError(error), false, "change_approach")
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 240) : "操作失败"
}

function deniedExecution(capability: Capability): ToolExecution {
  return {
    content: `denied: 用户没有授予 ${capability}，没有执行任何电脑操作。`,
    detail: `权限拒绝：${capability}`,
    status: "denied",
  }
}
