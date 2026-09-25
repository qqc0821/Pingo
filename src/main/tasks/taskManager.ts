import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import type {
  ApprovalRequest,
  Capability,
  ChatStreamEvent,
  CapabilityGrant,
  GrantDuration,
  OperationDecision,
  OperationKind,
  OperationPlan,
  OperationResult,
  ResolvedCommandPlan,
  TerminalPolicyFailure,
  TaskState,
} from "../../shared/types.js"
import { ModelClient } from "../ai/client.js"
import type { ModelRequestMessage } from "../ai/client.js"
import { AgentOrchestrator } from "../agent/orchestrator.js"
import { AuditLogger } from "../security/auditLogger.js"
import { ApprovalBroker } from "../security/approvalBroker.js"
import { CapabilityManager } from "../security/capabilityManager.js"
import { TerminalTrustManager } from "../security/terminalTrust.js"
import { classifyOperation } from "../security/riskClassifier.js"
import {
  compileTerminalIntent,
  formatResolvedCommand,
  revalidateTerminalPlan,
  TerminalPolicyError,
  terminalFailure,
} from "../terminal/intentPolicy.js"
import { TerminalError } from "../terminal/backend.js"
import { SeatbeltTerminalBackend, TerminalRunnerError } from "../terminal/seatbeltBackend.js"
import { TerminalSessionService } from "../terminal/sessionRegistry.js"
import { getTerminalFeatureFlags, type TerminalFeatureFlags } from "../terminal/featureFlags.js"
import { executeTool, READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS } from "../tools/registry.js"
import type { ToolExecution } from "../tools/types.js"
import { planFileOperation, type PlannedFileOperation } from "../tools/fileOperations.js"
import { getRealProjectRoot } from "../security/pathGuard.js"
import { detectSandboxDenial } from "../terminal/policyCatalog.js"
import type { SettingsStore } from "../store.js"
import { UndoManager } from "./undoManager.js"
import { ConversationStore } from "./conversationStore.js"

export type TaskEventSink = (event: ChatStreamEvent) => void

interface PermissionWaiter {
  capabilities: Capability[]
  resolve: (granted: boolean) => void
}

interface TaskRecord {
  taskId: string
  sourceWindowId: string
  projectPath?: string
  sessionId?: string
  emit: TaskEventSink
  controller: AbortController
  client: ModelClient
  state: TaskState
  cancelled: boolean
  answer: string
  unresolvedOperationFailure?: string
  permission?: PermissionWaiter
  activeTerminalSessionId?: string
  cancellationPromise?: Promise<void>
}

interface CapabilityAccess {
  grant?: CapabilityGrant
  trustedWorkspace: boolean
}

export interface TaskManagerDependencies {
  settingsStore: SettingsStore
  /** Desktop app mode: execute supported operations without user permission/approval cards. */
  skipUserConfirmation?: boolean
  capabilityManager?: CapabilityManager
  approvalBroker?: ApprovalBroker
  auditLogger: AuditLogger
  terminalFeatureFlags?: TerminalFeatureFlags
  terminalTrustManager?: TerminalTrustManager
  terminalSessionService?: TerminalSessionService
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly conversations = new ConversationStore()
  private readonly capabilityManager: CapabilityManager
  private readonly approvalBroker: ApprovalBroker
  private readonly terminalSessionService: TerminalSessionService
  private readonly terminalFeatureFlags: TerminalFeatureFlags
  private readonly terminalTrustManager: TerminalTrustManager
  private readonly undoManager = new UndoManager()

  constructor(private readonly dependencies: TaskManagerDependencies) {
    this.capabilityManager = dependencies.capabilityManager ?? new CapabilityManager()
    this.approvalBroker = dependencies.approvalBroker ?? new ApprovalBroker()
    this.terminalSessionService =
      dependencies.terminalSessionService ?? createDefaultTerminalService()
    this.terminalFeatureFlags = dependencies.terminalFeatureFlags ?? getTerminalFeatureFlags()
    this.terminalTrustManager = dependencies.terminalTrustManager ?? new TerminalTrustManager()
  }

  submit(
    sourceWindowId: string,
    messages: ModelRequestMessage[],
    emit: TaskEventSink,
    options?: { taskId?: string; projectPath?: string; sessionId?: string },
  ): string {
    const taskId = options?.taskId ?? randomUUID()
    const task: TaskRecord = {
      taskId,
      sourceWindowId,
      projectPath: options?.projectPath ?? this.getActiveProjectPath(),
      sessionId: options?.sessionId,
      emit,
      controller: new AbortController(),
      client: new ModelClient(),
      state: "proposed",
      cancelled: false,
      answer: "",
    }
    this.tasks.set(taskId, task)
    this.emitState(task, "proposed")
    void this.run(task, messages)
    return taskId
  }

  submitUserInput(
    sourceWindowId: string,
    content: string,
    emit: TaskEventSink,
    taskId = randomUUID(),
  ): { taskId: string; sessionId: string } {
    if (
      [...this.tasks.values()].some(
        (task) => task.sourceWindowId === sourceWindowId && !isTerminal(task.state),
      )
    ) {
      throw new Error("当前已有任务在执行")
    }
    const projectPath = this.getActiveProjectPath()
    const session = this.conversations.current(sourceWindowId, projectPath)
    const messages = this.conversations.messagesFor(sourceWindowId, projectPath, content)
    this.submit(sourceWindowId, messages, emit, { taskId, projectPath, sessionId: session.id })
    return { taskId, sessionId: session.id }
  }

  startNewConversation(sourceWindowId: string): string {
    if (
      [...this.tasks.values()].some(
        (task) => task.sourceWindowId === sourceWindowId && !isTerminal(task.state),
      )
    ) {
      throw new Error("请等待当前任务结束后再开始新对话")
    }
    this.conversations.clear(sourceWindowId)
    return this.conversations.current(sourceWindowId, this.getActiveProjectPath()).id
  }

  cancel(taskId: string, sourceWindowId: string): boolean {
    const task = this.getOwnedTask(taskId, sourceWindowId)
    if (!task || isTerminal(task.state)) return false
    task.cancelled = true
    task.controller.abort()
    task.permission?.resolve(false)
    task.permission = undefined
    this.approvalBroker.cancelTask(taskId)
    task.client.cancel()
    void this.finishCancellation(task)
    this.dependencies.auditLogger.record({
      taskId,
      kind: "task.cancel",
      targets: [],
      status: "cancelled",
    })
    return true
  }

  async decide(
    sourceWindowId: string,
    decision: OperationDecision,
  ): Promise<OperationResult | null> {
    const task = this.getOwnedTask(decision.taskId, sourceWindowId)
    if (!task || task.cancelled) return null
    this.approvalBroker.decide(sourceWindowId, decision)
    return null
  }

  async undo(
    sourceWindowId: string,
    taskId: string,
    undoId: string,
  ): Promise<OperationResult | null> {
    const task = this.getOwnedTask(taskId, sourceWindowId)
    const action = task ? this.undoManager.get(undoId, taskId, sourceWindowId) : undefined
    if (!task || !action) return null
    const classification = classifyOperation(action.kind)
    const grant = await this.waitForCapability(task, classification.capability)
    if (!grant) {
      return {
        operationId: "undo-denied",
        status: "denied",
        content: "用户未授予撤销所需权限。",
        detail: "撤销被拒绝",
        reversible: false,
      }
    }
    const now = Date.now()
    const plan: OperationPlan = {
      operationId: randomUUID(),
      taskId,
      sourceWindowId,
      kind: action.kind,
      capability: classification.capability,
      risk: classification.risk,
      riskReason: `撤销操作：${classification.reason}`,
      targets: action.targets,
      preview: action.preview,
      preconditions: [],
      digest: this.approvalBroker.createPlanDigest({
        taskId,
        kind: action.kind,
        targets: action.targets,
        preview: action.preview,
      }),
      createdAt: now,
      expiresAt: now + 30_000,
      reversible: false,
    }
    const execute = async (): Promise<OperationResult> => {
      if (grant.trustedWorkspace) {
        this.assertTrustedWorkspaceTargets(task, action.targets)
      } else {
        if (!grant.grant) throw new Error("撤销授权已失效")
        this.capabilityManager.assertAllowed(
          classification.capability,
          action.targets,
          sourceWindowId,
        )
        this.capabilityManager.consume(grant.grant.grantId)
      }
      await action.run()
      this.undoManager.remove(undoId)
      return {
        operationId: plan.operationId,
        status: "completed",
        content: "已撤销上一项文件操作。",
        detail: "撤销完成",
        reversible: false,
      }
    }
    return grant.trustedWorkspace
      ? this.executeTrustedOperation(task, plan, execute)
      : this.confirmAndExecute(task, plan, execute)
  }

  grantCapability(
    sourceWindowId: string,
    taskId: string,
    capabilities: Capability[],
    duration: GrantDuration,
    scopeRoots: string[],
  ): CapabilityGrant {
    const task = this.getOwnedTask(taskId, sourceWindowId)
    if (!task) throw new Error("任务不存在或窗口无权操作")
    if (task.state !== "awaiting_permission" || !task.permission) {
      throw new Error("当前任务没有待处理的权限申请")
    }
    if (
      capabilities.length === 0 ||
      capabilities.some((capability) => capability === "system.automation") ||
      duration === "persistent"
    ) {
      throw new Error(
        duration === "persistent"
          ? "持续目录授权必须通过首次启动或设置页创建"
          : "申请了当前版本不允许的能力",
      )
    }
    if (!capabilities.every((capability) => task.permission?.capabilities.includes(capability))) {
      throw new Error("授权能力与当前任务申请不一致")
    }
    const grant = this.capabilityManager.grant({
      capabilities,
      duration,
      scopeRoots,
      sourceWindowId,
    })
    this.dependencies.auditLogger.record({
      taskId,
      kind: "capability.grant",
      targets: grant.scopeRoots,
      status: "granted",
      detail: grant.capabilities.join(","),
    })
    if (
      task.permission &&
      capabilities.some((capability) => task.permission?.capabilities.includes(capability))
    ) {
      task.permission.resolve(true)
      task.permission = undefined
      this.emitState(task, "planning")
    }
    return grant
  }

  denyCapability(sourceWindowId: string, taskId: string): boolean {
    const task = this.getOwnedTask(taskId, sourceWindowId)
    if (!task?.permission) return false
    task.permission.resolve(false)
    task.permission = undefined
    return true
  }

  listCapabilities(): CapabilityGrant[] {
    return this.capabilityManager.list()
  }

  revokeCapability(grantId: string): boolean {
    const revoked = this.capabilityManager.revoke(grantId)
    if (!revoked) return false
    this.dependencies.auditLogger.record({
      taskId: "system",
      kind: "capability.revoke",
      targets: [],
      status: "revoked",
      detail: grantId,
    })
    this.cancelAll()
    return true
  }

  revokeAllCapabilities(): void {
    this.capabilityManager.revokeAll()
    this.terminalTrustManager.revokeAll()
    this.approvalBroker.cancelAll()
    this.cancelAll()
    this.conversations.clear()
  }

  getAuditHistory(): ReturnType<AuditLogger["list"]> {
    return this.dependencies.auditLogger.list()
  }

  listTerminalTrust(): ReturnType<TerminalTrustManager["list"]> {
    return this.terminalTrustManager.list()
  }

  revokeAllTerminalTrust(): void {
    this.terminalTrustManager.revokeAll()
    this.approvalBroker.cancelAll()
    this.cancelAll()
  }

  private async run(task: TaskRecord, messages: ModelRequestMessage[]): Promise<void> {
    this.emitState(task, "planning")
    try {
      this.handleModelEvent(task, { type: "start" })
      const projectPath = task.projectPath
      const projectName = projectPath
        ? projectPath.split(/[/\\]/).filter(Boolean).at(-1)
        : undefined
      const orchestrator = new AgentOrchestrator({
        taskId: task.taskId,
        client: task.client,
        toolDefinitions: TOOL_DEFINITIONS,
        executeTool: (name, args) => this.executeTool(task, name, args),
        isReadOnlyTool: (name) => READ_ONLY_TOOL_NAMES.has(name),
        emit: (event) => this.handleModelEvent(task, event),
        isCancelled: () => task.cancelled,
        projectAuthorized: Boolean(projectPath),
        projectName,
        projectPath,
      })
      const transcript = await orchestrator.run(messages)
      if (!isTerminal(task.state) && !task.cancelled) {
        if (transcript && task.sessionId && !task.unresolvedOperationFailure) {
          this.conversations.complete(task.sourceWindowId, task.sessionId, transcript)
        }
        this.handleModelEvent(task, { type: "done" })
      }
    } catch (error) {
      if (task.cancelled) return
      this.emitState(task, "failed")
      task.emit({ type: "error", message: safeError(error) })
    } finally {
      if (task.cancelled) await this.finishCancellation(task)
    }
  }

  private handleModelEvent(task: TaskRecord, event: ChatStreamEvent): void {
    if (event.type === "chunk") task.answer += event.content
    if (event.type === "done" && task.unresolvedOperationFailure) {
      this.emitState(task, "failed")
      task.emit({ type: "error", message: task.answer.trim() || task.unresolvedOperationFailure })
      return
    }
    if (event.type === "error") this.emitState(task, "failed")
    if (event.type === "cancelled") {
      if (!task.cancelled) this.emitState(task, "cancelled")
      return
    }
    if (event.type === "done" && !isTerminal(task.state)) this.emitState(task, "completed")
    task.emit(event)
  }

  private async finishCancellation(task: TaskRecord): Promise<void> {
    if (!task.cancellationPromise) {
      task.cancellationPromise = (async () => {
        if (task.activeTerminalSessionId) {
          await this.terminalSessionService.kill(
            task.taskId,
            task.activeTerminalSessionId,
            "task cancelled",
          )
        }
        if (!isTerminal(task.state)) {
          this.emitState(task, "cancelled")
          task.emit({ type: "cancelled" })
        }
      })()
    }
    await task.cancellationPromise
  }

  private async executeTool(task: TaskRecord, name: string, args: unknown): Promise<ToolExecution> {
    if (task.cancelled)
      return { content: "任务已取消。", detail: "任务已取消", status: "cancelled" }
    if (READ_ONLY_TOOL_NAMES.has(name)) {
      const grant = await this.waitForCapability(task, "workspace.read")
      if (!grant) return this.trackToolExecution(task, deniedExecution("workspace.read"))
      const projectPath = this.requireProjectPath(task)
      if (grant.grant) this.capabilityManager.consume(grant.grant.grantId)
      const execution = await executeTool(projectPath, name, args)
      return this.trackToolExecution(task, execution)
    }
    if (isFileOperation(name))
      return this.trackToolExecution(task, await this.executeFileOperation(task, name, args))
    if (name === "terminal_intent")
      return this.trackToolExecution(task, await this.executeTerminalOperation(task, args))
    if (name === "terminal_execute") {
      return this.trackToolExecution(task, {
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
    return this.trackToolExecution(task, {
      content: `工具 ${name} 不被允许。`,
      detail: `已拒绝未知工具 ${name}`,
      status: "denied",
    })
  }

  private trackToolExecution(task: TaskRecord, execution: ToolExecution): ToolExecution {
    if (execution.status === "completed") task.unresolvedOperationFailure = undefined
    else if (execution.status) {
      task.unresolvedOperationFailure = execution.content || execution.detail
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
        (value) => this.approvalBroker.createPlanDigest(value),
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
        this.capabilityManager.assertAllowed(
          "workspace.write",
          operation.plan.targets,
          task.sourceWindowId,
        )
        if (grant.grant) this.capabilityManager.consume(grant.grant.grantId)
      }
      return operation.execute({ isCancelled: () => task.cancelled })
    }
    const result = grant.trustedWorkspace
      ? await this.executeTrustedOperation(task, operation.plan, execute)
      : await this.confirmAndExecute(task, operation.plan, execute)
    if (result.status === "completed" && result.undoId && operation.undo) {
      this.undoManager.register({
        undoId: result.undoId,
        taskId: task.taskId,
        sourceWindowId: task.sourceWindowId,
        kind,
        targets: operation.plan.targets,
        preview: `撤销：${operation.plan.preview}`,
        run: operation.undo,
      })
    }
    return { content: result.content, detail: result.detail, status: result.status }
  }

  private async executeTerminalOperation(
    task: TaskRecord,
    args: unknown,
    options: { forceApproval?: boolean } = {},
  ): Promise<ToolExecution> {
    const grant = await this.waitForCapability(task, "terminal.execute")
    if (!grant || (!grant.grant && !grant.trustedWorkspace))
      return deniedExecution("terminal.execute")
    if (!this.terminalFeatureFlags.terminalV2Enabled) {
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
        !this.terminalFeatureFlags.projectScriptsEnabled
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
          this.assertTrustedWorkspaceTargets(task, plan.targets)
        } else if (sessionGrant) {
          this.capabilityManager.assertAllowed(
            "terminal.execute",
            plan.targets,
            task.sourceWindowId,
          )
          this.capabilityManager.consume(sessionGrant.grantId)
        }
        const spawned = await this.terminalSessionService.spawn(
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
          await this.terminalSessionService
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

  private async confirmAndExecute(
    task: TaskRecord,
    plan: OperationPlan,
    execute: () => Promise<OperationResult>,
    options: { forceApproval?: boolean } = {},
  ): Promise<OperationResult> {
    if (this.dependencies.skipUserConfirmation) {
      return this.executeTrustedOperation(task, plan, execute)
    }
    const trustUsed = Boolean(
      !options.forceApproval &&
      plan.terminalPlan &&
      this.terminalTrustManager.consumeIfAllowed(plan.terminalPlan, task.sourceWindowId),
    )
    this.emitState(task, trustUsed ? "executing" : "awaiting_confirmation")
    const decision = trustUsed
      ? { decision: "approve" as const, remember: false }
      : await this.approvalBroker.waitForDecision(plan, (request) => {
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
      this.emitOperationResult(task, result)
      this.dependencies.auditLogger.record({
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
        this.approvalBroker.consumeApproval(plan, decision.token, {
          sourceWindowId: task.sourceWindowId,
          taskId: task.taskId,
          operationId: plan.operationId,
        })
      }
      if (decision.remember) {
        if (!plan.terminalPlan) throw new Error("只有 Terminal read-only 意图可以积累信任")
        this.terminalTrustManager.grant(plan.terminalPlan, task.sourceWindowId)
      }
      if (!trustUsed) this.emitState(task, "executing")
      const result = await execute()
      this.emitOperationResult(task, result)
      this.dependencies.auditLogger.record({
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
      this.emitOperationResult(task, result)
      this.dependencies.auditLogger.record({
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

  private async executeTrustedOperation(
    task: TaskRecord,
    plan: OperationPlan,
    execute: () => Promise<OperationResult>,
  ): Promise<OperationResult> {
    this.emitState(task, "executing")
    try {
      const result = await execute()
      this.emitOperationResult(task, result)
      this.dependencies.auditLogger.record({
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
      this.emitOperationResult(task, result)
      this.dependencies.auditLogger.record({
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

  private async waitForCapability(
    task: TaskRecord,
    capability: Capability,
  ): Promise<CapabilityAccess | null> {
    if (this.dependencies.skipUserConfirmation) return { trustedWorkspace: true }
    const projectPath = this.dependencies.settingsStore.getAuthorizedProjectPath()
    if (projectPath && capability !== "terminal.execute" && this.isTrustedWorkspace(projectPath)) {
      return { trustedWorkspace: true }
    }
    if (projectPath) {
      try {
        return {
          grant: this.capabilityManager.assertAllowed(
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
    this.emitState(task, "awaiting_permission")
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
    const nextProjectPath = this.dependencies.settingsStore.getAuthorizedProjectPath()
    if (!nextProjectPath) return null
    try {
      return {
        grant: this.capabilityManager.assertAllowed(
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

  private getActiveProjectPath(): string | undefined {
    const preferencesPath = this.dependencies.settingsStore.getPreferences().defaultLocation.trim()
    const rememberedPath = this.dependencies.settingsStore.getAuthorizedProjectPath()
    const usableRememberedPath = rememberedPath === homedir() ? undefined : rememberedPath
    const candidates = this.dependencies.skipUserConfirmation
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
    const trusted = this.dependencies.settingsStore.getTrustedWorkspace()
    if (!trusted) return false
    try {
      return getRealProjectRoot(trusted.path) === getRealProjectRoot(projectPath)
    } catch {
      return false
    }
  }

  private assertTrustedWorkspaceTargets(task: TaskRecord, targets: string[]): void {
    if (this.dependencies.skipUserConfirmation) {
      const root = this.requireProjectPath(task)
      if (!targets.every((target) => isWithinRoot(root, target))) {
        throw new Error("操作目标越过当前项目目录")
      }
      return
    }
    const trusted = this.dependencies.settingsStore.getTrustedWorkspace()
    if (!trusted) throw new Error("持续目录授权已关闭")
    const root = getRealProjectRoot(trusted.path)
    if (!targets.every((target) => isWithinRoot(root, target))) {
      throw new Error("操作目标越过持续授权目录")
    }
  }

  private emitState(task: TaskRecord, state: TaskState): void {
    if (
      task.state === state &&
      state !== "awaiting_confirmation" &&
      state !== "awaiting_permission"
    )
      return
    task.state = state
    task.emit({ type: "task-state", taskId: task.taskId, state })
  }

  private emitOperationResult(task: TaskRecord, result: OperationResult): void {
    if (result.status === "completed") task.unresolvedOperationFailure = undefined
    else task.unresolvedOperationFailure = result.content || result.detail
    task.emit({ type: "operation-result", result })
  }

  private getOwnedTask(taskId: string, sourceWindowId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId)
    return task?.sourceWindowId === sourceWindowId ? task : undefined
  }

  private cancelAll(): void {
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.state)) this.cancel(task.taskId, task.sourceWindowId)
    }
  }
}

function isFileOperation(name: string): name is Exclude<OperationKind, "terminal.execute"> {
  return ["create_directory", "write_file", "apply_patch", "move_path", "trash_path"].includes(name)
}

function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled"
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

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 240) : "操作失败"
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

function createDefaultTerminalService(): TerminalSessionService {
  const service = new TerminalSessionService()
  service.registerBackend(new SeatbeltTerminalBackend())
  return service
}

function deniedExecution(capability: Capability): ToolExecution {
  return {
    content: `denied: 用户没有授予 ${capability}，没有执行任何电脑操作。`,
    detail: `权限拒绝：${capability}`,
    status: "denied",
  }
}
