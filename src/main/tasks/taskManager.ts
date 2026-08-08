import { randomUUID } from "node:crypto"
import type {
  ApprovalRequest,
  Capability,
  ChatMessageInput,
  ChatStreamEvent,
  CapabilityGrant,
  GrantDuration,
  OperationDecision,
  OperationKind,
  OperationPlan,
  OperationResult,
  TaskState,
} from "../../shared/types.js"
import { ModelClient } from "../ai/client.js"
import { AuditLogger } from "../security/auditLogger.js"
import { ApprovalBroker } from "../security/approvalBroker.js"
import { CapabilityManager } from "../security/capabilityManager.js"
import { classifyOperation } from "../security/riskClassifier.js"
import { validateCommand } from "../terminal/commandPolicy.js"
import { TerminalRunner } from "../terminal/runner.js"
import { executeTool, READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS } from "../tools/registry.js"
import { planFileOperation, type PlannedFileOperation } from "../tools/fileOperations.js"
import type { SettingsStore } from "../store.js"
import { UndoManager } from "./undoManager.js"

export type TaskEventSink = (event: ChatStreamEvent) => void

interface PermissionWaiter {
  capabilities: Capability[]
  resolve: (granted: boolean) => void
}

interface TaskRecord {
  taskId: string
  sourceWindowId: string
  emit: TaskEventSink
  controller: AbortController
  client: ModelClient
  state: TaskState
  cancelled: boolean
  permission?: PermissionWaiter
}

export interface TaskManagerDependencies {
  settingsStore: SettingsStore
  capabilityManager?: CapabilityManager
  approvalBroker?: ApprovalBroker
  auditLogger: AuditLogger
  terminalRunner?: TerminalRunner
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly capabilityManager: CapabilityManager
  private readonly approvalBroker: ApprovalBroker
  private readonly terminalRunner: TerminalRunner
  private readonly undoManager = new UndoManager()

  constructor(private readonly dependencies: TaskManagerDependencies) {
    this.capabilityManager = dependencies.capabilityManager ?? new CapabilityManager()
    this.approvalBroker = dependencies.approvalBroker ?? new ApprovalBroker()
    this.terminalRunner = dependencies.terminalRunner ?? new TerminalRunner()
  }

  submit(sourceWindowId: string, messages: ChatMessageInput[], emit: TaskEventSink): string {
    const taskId = randomUUID()
    const task: TaskRecord = {
      taskId,
      sourceWindowId,
      emit,
      controller: new AbortController(),
      client: new ModelClient(),
      state: "proposed",
      cancelled: false,
    }
    this.tasks.set(taskId, task)
    this.emitState(task, "proposed")
    void this.run(task, messages)
    return taskId
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
    this.terminalRunner.cancelAll()
    this.dependencies.auditLogger.record({
      taskId,
      kind: "task.cancel",
      targets: [],
      status: "cancelled",
    })
    this.emitState(task, "cancelled")
    task.emit({ type: "cancelled" })
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
    return this.confirmAndExecute(task, plan, async () => {
      this.capabilityManager.assertAllowed(
        classification.capability,
        action.targets,
        sourceWindowId,
      )
      this.capabilityManager.consume(grant.grantId)
      await action.run()
      this.undoManager.remove(undoId)
      return {
        operationId: plan.operationId,
        status: "completed",
        content: "已撤销上一项文件操作。",
        detail: "撤销完成",
        reversible: false,
      }
    })
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
      capabilities.some((capability) => capability === "system.automation")
    ) {
      throw new Error("申请了当前版本不允许的能力")
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
    this.approvalBroker.cancelAll()
    this.cancelAll()
  }

  getAuditHistory(): ReturnType<AuditLogger["list"]> {
    return this.dependencies.auditLogger.list()
  }

  private async run(task: TaskRecord, messages: ChatMessageInput[]): Promise<void> {
    this.emitState(task, "planning")
    try {
      await task.client.stream(
        messages,
        (event) => this.handleModelEvent(task, event),
        (name, args) => this.executeTool(task, name, args),
        TOOL_DEFINITIONS,
      )
      if (!isTerminal(task.state) && !task.cancelled) {
        this.emitState(task, "completed")
      }
    } catch (error) {
      if (task.cancelled) return
      this.emitState(task, "failed")
      task.emit({ type: "error", message: safeError(error) })
    }
  }

  private handleModelEvent(task: TaskRecord, event: ChatStreamEvent): void {
    if (event.type === "error") this.emitState(task, "failed")
    if (event.type === "cancelled") this.emitState(task, "cancelled")
    if (event.type === "done" && !isTerminal(task.state)) this.emitState(task, "completed")
    task.emit(event)
  }

  private async executeTool(task: TaskRecord, name: string, args: unknown) {
    if (task.cancelled) return { content: "任务已取消。", detail: "任务已取消" }
    if (READ_ONLY_TOOL_NAMES.has(name)) {
      const grant = await this.waitForCapability(task, "workspace.read")
      if (!grant) return deniedExecution("workspace.read")
      const projectPath = this.requireProjectPath()
      this.capabilityManager.consume(grant.grantId)
      const execution = await executeTool(projectPath, name, args)
      return execution
    }
    if (isFileOperation(name)) return this.executeFileOperation(task, name, args)
    if (name === "terminal_execute") return this.executeTerminalOperation(task, args)
    return { content: `工具 ${name} 不被允许。`, detail: `已拒绝未知工具 ${name}` }
  }

  private async executeFileOperation(
    task: TaskRecord,
    name: string,
    args: unknown,
  ): Promise<{ content: string; detail: string }> {
    const kind = name as Exclude<OperationKind, "terminal.execute">
    const grant = await this.waitForCapability(task, "workspace.write")
    if (!grant) return deniedExecution("workspace.write")
    const projectPath = this.requireProjectPath()
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
      return { content: `操作未创建：${safeError(error)}`, detail: "文件操作预览失败" }
    }
    const result = await this.confirmAndExecute(task, operation.plan, async () => {
      this.capabilityManager.assertAllowed("workspace.write", [projectPath], task.sourceWindowId)
      this.capabilityManager.consume(grant.grantId)
      return operation.execute({ isCancelled: () => task.cancelled })
    })
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
    return { content: result.content, detail: result.detail }
  }

  private async executeTerminalOperation(
    task: TaskRecord,
    args: unknown,
  ): Promise<{ content: string; detail: string }> {
    const grant = await this.waitForCapability(task, "terminal.execute")
    if (!grant) return deniedExecution("terminal.execute")
    const projectPath = this.requireProjectPath()
    let parsed
    try {
      parsed = validateCommand(projectPath, args)
    } catch (error) {
      return { content: `命令未执行：${safeError(error)}`, detail: "Terminal 策略拒绝" }
    }
    const classification = classifyOperation("terminal.execute")
    const now = Date.now()
    const operationId = randomUUID()
    const planInput = {
      taskId: task.taskId,
      kind: "terminal.execute" as const,
      capability: classification.capability,
      risk: classification.risk,
      targets: [parsed.plan.cwd],
      command: parsed.plan,
    }
    const plan: OperationPlan = {
      operationId,
      taskId: task.taskId,
      sourceWindowId: task.sourceWindowId,
      kind: "terminal.execute",
      capability: "terminal.execute",
      risk: "R3",
      riskReason: parsed.riskReason,
      targets: [parsed.plan.cwd],
      preview: formatCommandPreview(parsed.plan),
      command: parsed.plan,
      preconditions: [],
      digest: this.approvalBroker.createPlanDigest(planInput),
      createdAt: now,
      expiresAt: now + 30_000,
      reversible: false,
    }
    const result = await this.confirmAndExecute(task, plan, async () => {
      this.capabilityManager.assertAllowed("terminal.execute", [projectPath], task.sourceWindowId)
      const current = validateCommand(projectPath, args).plan
      if (JSON.stringify(current) !== JSON.stringify(plan.command)) {
        throw new Error("确认后命令或 cwd 已变化")
      }
      this.capabilityManager.consume(grant.grantId)
      const run = await this.terminalRunner.run(current, { signal: task.controller.signal })
      const status = run.exitCode === 0 && !run.timedOut && !run.truncated ? "completed" : "failed"
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
      }
    })
    return { content: result.content, detail: result.detail }
  }

  private async confirmAndExecute(
    task: TaskRecord,
    plan: OperationPlan,
    execute: () => Promise<OperationResult>,
  ): Promise<OperationResult> {
    this.emitState(task, "awaiting_confirmation")
    const decision = await this.approvalBroker.waitForDecision(plan, (request) => {
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
        content: status === "denied" ? "用户拒绝了这项操作。" : "这项操作未获确认，因此没有执行。",
        detail:
          status === "expired" ? "确认已超时" : status === "cancelled" ? "任务已取消" : "用户拒绝",
        reversible: plan.reversible,
      }
      task.emit({ type: "operation-result", result })
      this.dependencies.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: result.detail,
      })
      return result
    }
    try {
      this.approvalBroker.consumeApproval(plan, decision.token, {
        sourceWindowId: task.sourceWindowId,
        taskId: task.taskId,
        operationId: plan.operationId,
      })
      this.emitState(task, "executing")
      const result = await execute()
      task.emit({ type: "operation-result", result })
      this.dependencies.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: result.detail,
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
      task.emit({ type: "operation-result", result })
      this.dependencies.auditLogger.record({
        taskId: task.taskId,
        operationId: plan.operationId,
        kind: plan.kind,
        risk: plan.risk,
        targets: plan.targets,
        status: result.status,
        detail: result.detail,
      })
      return result
    }
  }

  private async waitForCapability(
    task: TaskRecord,
    capability: Capability,
  ): Promise<CapabilityGrant | null> {
    const projectPath = this.dependencies.settingsStore.getAuthorizedProjectPath()
    if (projectPath) {
      try {
        return this.capabilityManager.assertAllowed(capability, [projectPath], task.sourceWindowId)
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
      return this.capabilityManager.assertAllowed(
        capability,
        [nextProjectPath],
        task.sourceWindowId,
      )
    } catch {
      return null
    }
  }

  private requireProjectPath(): string {
    const projectPath = this.dependencies.settingsStore.getAuthorizedProjectPath()
    if (!projectPath) throw new Error("尚未选择授权目录")
    return projectPath
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

function formatCommandPreview(command: NonNullable<OperationPlan["command"]>): string {
  return [
    `executable: ${command.executable}`,
    `args: ${JSON.stringify(command.args)}`,
    `cwd: ${command.cwd}`,
    `timeoutMs: ${command.timeoutMs}`,
    `outputLimitBytes: ${command.outputLimitBytes}`,
    `envKeys: ${command.envKeys.join(", ")}`,
  ].join("\n")
}

function sanitizeApprovalRequest(request: ApprovalRequest): ApprovalRequest {
  const plan = { ...request.plan, preview: request.plan.preview.slice(0, 24_000) }
  return { ...request, plan }
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 240) : "操作失败"
}

function deniedExecution(capability: Capability): { content: string; detail: string } {
  return {
    content: `denied: 用户没有授予 ${capability}，没有执行任何电脑操作。`,
    detail: `权限拒绝：${capability}`,
  }
}
