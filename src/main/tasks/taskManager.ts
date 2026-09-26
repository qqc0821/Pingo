import { randomUUID } from "node:crypto"
import type {
  Capability,
  ChatStreamEvent,
  CapabilityGrant,
  GrantDuration,
  OperationDecision,
  OperationPlan,
  OperationResult,
  TaskState,
} from "../../shared/types.js"
import { ModelClient } from "../ai/client.js"
import type { ModelGateway } from "../ai/client.js"
import type { ModelRequestMessage } from "../ai/client.js"
import { AgentOrchestrator } from "../agent/orchestrator.js"
import { AuditLogger } from "../security/auditLogger.js"
import { ApprovalBroker } from "../security/approvalBroker.js"
import { CapabilityManager } from "../security/capabilityManager.js"
import { TerminalTrustManager } from "../security/terminalTrust.js"
import { classifyOperation } from "../security/riskClassifier.js"
import { SeatbeltTerminalBackend } from "../terminal/seatbeltBackend.js"
import { TerminalSessionService } from "../terminal/sessionRegistry.js"
import { getTerminalFeatureFlags, type TerminalFeatureFlags } from "../terminal/featureFlags.js"
import { READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS } from "../tools/registry.js"
import type { SettingsStore } from "../store.js"
import { UndoManager } from "./undoManager.js"
import { ConversationStore } from "./conversationStore.js"
import type { ConversationPersistence } from "./sessionPersistence.js"
import { INTERACTIVE_EXECUTION_POLICY, type ExecutionPolicy } from "./executionPolicy.js"
import { ToolExecutor } from "./toolExecutor.js"

export type TaskEventSink = (event: ChatStreamEvent) => void

interface PermissionWaiter {
  capabilities: Capability[]
  resolve: (granted: boolean) => void
}

export interface TaskRecord {
  taskId: string
  sourceWindowId: string
  projectPath?: string
  sessionId?: string
  input?: string
  conversationRecorded?: boolean
  emit: TaskEventSink
  controller: AbortController
  client: ModelGateway
  state: TaskState
  cancelled: boolean
  answer: string
  unresolvedOperationFailure?: string
  unresolvedToolKind?: "read" | "change"
  unresolvedToolName?: string
  failureMessage?: string
  permission?: PermissionWaiter
  activeTerminalSessionId?: string
  cancellationPromise?: Promise<void>
  finishedAt?: number
}

export interface TaskManagerDependencies {
  settingsStore: SettingsStore
  executionPolicy?: ExecutionPolicy
  modelClientFactory?: () => ModelGateway
  conversationPersistence?: ConversationPersistence
  conversationOwnerKey?: string
  capabilityManager?: CapabilityManager
  approvalBroker?: ApprovalBroker
  auditLogger: AuditLogger
  terminalFeatureFlags?: TerminalFeatureFlags
  terminalTrustManager?: TerminalTrustManager
  terminalSessionService?: TerminalSessionService
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly conversations: ConversationStore
  private readonly capabilityManager: CapabilityManager
  private readonly approvalBroker: ApprovalBroker
  private readonly terminalSessionService: TerminalSessionService
  private readonly terminalFeatureFlags: TerminalFeatureFlags
  private readonly terminalTrustManager: TerminalTrustManager
  private readonly undoManager = new UndoManager()
  private readonly executionPolicy: ExecutionPolicy
  private readonly completedTaskTtlMs = 30 * 60 * 1_000
  private readonly toolExecutor: ToolExecutor

  constructor(private readonly dependencies: TaskManagerDependencies) {
    this.conversations = new ConversationStore(dependencies.conversationPersistence)
    this.executionPolicy = dependencies.executionPolicy ?? INTERACTIVE_EXECUTION_POLICY
    this.capabilityManager = dependencies.capabilityManager ?? new CapabilityManager()
    this.approvalBroker = dependencies.approvalBroker ?? new ApprovalBroker()
    this.terminalSessionService =
      dependencies.terminalSessionService ?? createDefaultTerminalService()
    this.terminalFeatureFlags = dependencies.terminalFeatureFlags ?? getTerminalFeatureFlags()
    this.terminalTrustManager = dependencies.terminalTrustManager ?? new TerminalTrustManager()
    this.toolExecutor = new ToolExecutor({
      settingsStore: dependencies.settingsStore,
      auditLogger: dependencies.auditLogger,
      executionPolicy: this.executionPolicy,
      capabilityManager: this.capabilityManager,
      approvalBroker: this.approvalBroker,
      terminalSessionService: this.terminalSessionService,
      terminalFeatureFlags: this.terminalFeatureFlags,
      terminalTrustManager: this.terminalTrustManager,
      undoManager: this.undoManager,
      emitState: (task, state) => this.emitState(task, state),
      emitOperationResult: (task, result) => this.emitOperationResult(task, result),
    })
  }

  submit(
    sourceWindowId: string,
    messages: ModelRequestMessage[],
    emit: TaskEventSink,
    options?: { taskId?: string; projectPath?: string; sessionId?: string; input?: string },
  ): string {
    this.pruneTasks()
    const taskId = options?.taskId ?? randomUUID()
    const task: TaskRecord = {
      taskId,
      sourceWindowId,
      projectPath: options?.projectPath ?? this.toolExecutor.getActiveProjectPath(),
      sessionId: options?.sessionId,
      input: options?.input,
      emit,
      controller: new AbortController(),
      client: this.dependencies.modelClientFactory?.() ?? new ModelClient(),
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
    const projectPath = this.toolExecutor.getActiveProjectPath()
    const owner = this.conversationOwner(sourceWindowId)
    const session = this.conversations.current(owner, projectPath)
    const messages = this.conversations.messagesFor(owner, projectPath, content)
    this.conversations.begin(owner, session.id, content)
    this.submit(sourceWindowId, messages, emit, {
      taskId,
      projectPath,
      sessionId: session.id,
      input: content,
    })
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
    const owner = this.conversationOwner(sourceWindowId)
    this.conversations.clear(owner)
    return this.conversations.current(owner, this.toolExecutor.getActiveProjectPath()).id
  }

  getInterruptedConversation(sourceWindowId: string): string | undefined {
    return this.conversations.interrupted(
      this.conversationOwner(sourceWindowId),
      this.toolExecutor.getActiveProjectPath(),
    )
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
    const grant = await this.toolExecutor.waitForCapability(task, classification.capability)
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
        this.toolExecutor.assertTrustedWorkspaceTargets(task, action.targets)
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
      ? this.toolExecutor.executeTrustedOperation(task, plan, execute)
      : this.toolExecutor.confirmAndExecute(task, plan, execute)
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
    this.conversations.clearMemory()
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
        executeTool: (name, args) => this.toolExecutor.executeTool(task, name, args),
        onUnhandledToolError: (name, message) => {
          task.unresolvedOperationFailure = message
          task.unresolvedToolKind = READ_ONLY_TOOL_NAMES.has(name) ? "read" : "change"
          task.unresolvedToolName = name
        },
        isReadOnlyTool: (name) => READ_ONLY_TOOL_NAMES.has(name),
        emit: (event) => this.handleModelEvent(task, event),
        isCancelled: () => task.cancelled,
        projectAuthorized: Boolean(projectPath),
        projectName,
        projectPath,
      })
      const runResult = await orchestrator.run(messages)
      if (runResult.stopReason === "failed") {
        this.handleModelEvent(task, { type: "error", message: runResult.error })
      }
      const transcript = runResult.transcript
      if (transcript && task.sessionId && !task.cancelled) {
        const final = transcript.at(-1)
        const emptyAnswer = final?.role !== "assistant" || !final.content?.trim()
        const reason =
          task.unresolvedOperationFailure ?? (emptyAnswer ? "模型未返回有效答复" : undefined)
        this.conversations.complete(
          this.conversationOwner(task.sourceWindowId),
          task.sessionId,
          transcript,
          reason,
        )
        task.conversationRecorded = true
        if (emptyAnswer && !task.unresolvedOperationFailure) {
          this.handleModelEvent(task, { type: "error", message: "模型未返回有效答复" })
        }
      }
      if (!isTerminal(task.state) && !task.cancelled) {
        this.handleModelEvent(task, { type: "done" })
      }
    } catch (error) {
      if (task.cancelled) return
      this.rememberInterruptedRun(task, safeError(error))
      this.emitState(task, "failed")
      task.emit({ type: "error", message: safeError(error) })
    } finally {
      if (task.cancelled) await this.finishCancellation(task)
      else if (task.state === "failed") {
        this.rememberInterruptedRun(task, task.failureMessage ?? "任务未完成")
      }
    }
  }

  private handleModelEvent(task: TaskRecord, event: ChatStreamEvent): void {
    if (event.type === "chunk") task.answer += event.content
    if (event.type === "done" && task.unresolvedOperationFailure) {
      this.emitState(task, "failed")
      task.emit({ type: "error", message: task.answer.trim() || task.unresolvedOperationFailure })
      return
    }
    if (event.type === "error") {
      task.failureMessage = event.message
      this.emitState(task, "failed")
    }
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
          this.rememberInterruptedRun(task, "任务已取消")
          this.emitState(task, "cancelled")
          task.emit({ type: "cancelled" })
        }
      })()
    }
    await task.cancellationPromise
  }

  private rememberInterruptedRun(task: TaskRecord, reason: string): void {
    if (!task.sessionId || !task.input || task.conversationRecorded) return
    this.conversations.complete(
      this.conversationOwner(task.sourceWindowId),
      task.sessionId,
      [
        { role: "user", content: task.input },
        { role: "assistant", content: reason },
      ],
      reason,
    )
    task.conversationRecorded = true
  }

  private emitState(task: TaskRecord, state: TaskState): void {
    if (
      task.state === state &&
      state !== "awaiting_confirmation" &&
      state !== "awaiting_permission"
    )
      return
    task.state = state
    if (isTerminal(state)) task.finishedAt = Date.now()
    task.emit({ type: "task-state", taskId: task.taskId, state })
  }

  private emitOperationResult(task: TaskRecord, result: OperationResult): void {
    if (result.status === "completed") result.verification ??= "not_checked"
    if (result.status !== "completed") {
      task.unresolvedOperationFailure = result.content || result.detail
      task.unresolvedToolKind = "change"
    }
    task.emit({ type: "operation-result", result })
  }

  private getOwnedTask(taskId: string, sourceWindowId: string): TaskRecord | undefined {
    this.pruneTasks()
    const task = this.tasks.get(taskId)
    return task?.sourceWindowId === sourceWindowId ? task : undefined
  }

  private pruneTasks(): void {
    const now = Date.now()
    const completed = [...this.tasks.values()]
      .filter((task) => task.finishedAt !== undefined)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    for (const [index, task] of completed.entries()) {
      if (now - (task.finishedAt ?? 0) > this.completedTaskTtlMs || index < completed.length - 64) {
        this.tasks.delete(task.taskId)
      }
    }
  }

  private conversationOwner(sourceWindowId: string): string {
    return this.dependencies.conversationOwnerKey ?? sourceWindowId
  }

  private cancelAll(): void {
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.state)) this.cancel(task.taskId, task.sourceWindowId)
    }
  }
}

function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled"
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 240) : "操作失败"
}

function createDefaultTerminalService(): TerminalSessionService {
  const service = new TerminalSessionService()
  service.registerBackend(new SeatbeltTerminalBackend())
  return service
}

export { readableFingerprint } from "./toolExecutor.js"
