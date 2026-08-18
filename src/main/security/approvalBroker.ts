import { createHash, randomUUID } from "node:crypto"
import type {
  ApprovalRequest,
  ApprovalTokenBinding,
  OperationDecision,
  OperationPlan,
} from "../../shared/types.js"

interface PendingApproval {
  request: ApprovalRequest
  resolve: (decision: BrokerDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BrokerDecision {
  decision: "approve" | "deny" | "expired" | "cancelled"
  token?: string
  remember?: boolean
  reason?: string
}

export interface ApprovalValidation {
  sourceWindowId: string
  taskId: string
  operationId: string
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly deniedDigests = new Map<string, Set<string>>()
  private readonly approvalTokens = new Map<string, ApprovalTokenBinding>()

  createPlanDigest(value: unknown): string {
    return createHash("sha256").update(stableJson(value)).digest("hex")
  }

  async waitForDecision(
    plan: OperationPlan,
    notify: (request: ApprovalRequest) => void,
  ): Promise<BrokerDecision> {
    const now = Date.now()
    if (plan.expiresAt <= now) return { decision: "expired" }
    const digest = getPlanDigest(plan)
    if (this.wasDenied(plan.taskId, digest)) return { decision: "deny" }
    const request: ApprovalRequest = Object.freeze({
      operationId: plan.operationId,
      taskId: plan.taskId,
      plan: deepFreezePlan(plan),
      expiresAt: plan.expiresAt,
    })
    return new Promise<BrokerDecision>((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(plan.operationId)
          resolve({ decision: "expired" })
        },
        Math.max(1, plan.expiresAt - now),
      )
      this.pending.set(plan.operationId, { request, resolve, timer })
      notify(request)
    })
  }

  decide(sourceWindowId: string, decision: OperationDecision): boolean {
    const pending = this.pending.get(decision.operationId)
    if (!pending) return false
    const plan = pending.request.plan
    if (
      plan.sourceWindowId !== sourceWindowId ||
      plan.taskId !== decision.taskId ||
      decision.taskId !== pending.request.taskId
    ) {
      return false
    }
    this.pending.delete(decision.operationId)
    clearTimeout(pending.timer)
    if (decision.decision === "deny") {
      const digest = getPlanDigest(plan)
      let denied = this.deniedDigests.get(plan.taskId)
      if (!denied) {
        denied = new Set<string>()
        this.deniedDigests.set(plan.taskId, denied)
      }
      denied.add(digest)
      pending.resolve({ decision: "deny", reason: decision.reason })
      return true
    }
    const token = randomUUID()
    this.approvalTokens.set(token, {
      token,
      planDigest: getPlanDigest(plan),
      taskId: plan.taskId,
      operationId: plan.operationId,
      windowId: plan.sourceWindowId,
      expiresAt: plan.expiresAt,
    })
    pending.resolve({ decision: "approve", token, remember: decision.decision === "trust" })
    return true
  }

  consumeApproval(
    plan: OperationPlan,
    token: string | undefined,
    validation: ApprovalValidation,
    now = Date.now(),
  ): void {
    if (!token) throw new Error("批准 token 无效或已使用")
    const binding = this.approvalTokens.get(token)
    if (
      !binding ||
      binding.consumedAt !== undefined ||
      binding.planDigest !== getPlanDigest(plan) ||
      binding.windowId !== validation.sourceWindowId ||
      binding.taskId !== validation.taskId ||
      binding.operationId !== validation.operationId ||
      plan.sourceWindowId !== validation.sourceWindowId ||
      plan.taskId !== validation.taskId ||
      plan.operationId !== validation.operationId ||
      binding.expiresAt <= now ||
      plan.expiresAt <= now
    ) {
      throw new Error("批准范围或有效期无效")
    }
    binding.consumedAt = now
  }

  cancelTask(taskId: string): void {
    for (const [operationId, pending] of this.pending) {
      if (pending.request.taskId !== taskId) continue
      this.pending.delete(operationId)
      clearTimeout(pending.timer)
      pending.resolve({ decision: "cancelled" })
    }
  }

  cancelAll(): void {
    for (const taskId of new Set([...this.pending.values()].map(({ request }) => request.taskId))) {
      this.cancelTask(taskId)
    }
  }

  hasPending(operationId: string): boolean {
    return this.pending.has(operationId)
  }

  wasDenied(taskId: string, digest: string): boolean {
    return this.deniedDigests.get(taskId)?.has(digest) ?? false
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
}

function deepFreezePlan(plan: OperationPlan): OperationPlan {
  Object.freeze(plan.preconditions)
  Object.freeze(plan.targets)
  if (plan.command) {
    Object.freeze(plan.command.args)
    Object.freeze(plan.command)
  }
  if (plan.terminalPlan) {
    Object.freeze(plan.terminalPlan.intent)
    Object.freeze(plan.terminalPlan.argv)
    Object.freeze(plan.terminalPlan.cwd)
    if (plan.terminalPlan.projectScript) Object.freeze(plan.terminalPlan.projectScript)
    Object.freeze(plan.terminalPlan.effects.externalPaths)
    Object.freeze(plan.terminalPlan.effects)
    Object.freeze(plan.terminalPlan.sandbox.readRoots)
    Object.freeze(plan.terminalPlan.sandbox.writeRoots)
    Object.freeze(plan.terminalPlan.sandbox.protectedPaths)
    Object.freeze(plan.terminalPlan.sandbox)
    Object.freeze(plan.terminalPlan.limits)
    Object.freeze(plan.terminalPlan)
  }
  return Object.freeze(plan)
}

function getPlanDigest(plan: OperationPlan): string {
  if (!plan.terminalPlan) return plan.digest
  const terminalPlanWithoutDigest = Object.fromEntries(
    Object.entries(plan.terminalPlan).filter(([key]) => key !== "planDigest"),
  )
  return createHash("sha256").update(stableJson(terminalPlanWithoutDigest)).digest("hex")
}
