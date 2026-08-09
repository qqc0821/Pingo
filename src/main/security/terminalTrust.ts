import { randomUUID } from "node:crypto"
import type { ResolvedCommandPlan, TerminalTrustGrant } from "../../shared/types.js"

export const TERMINAL_TRUST_MAX_USES = 20
export const TERMINAL_TRUST_TTL_MS = 30 * 60 * 1_000
export const TERMINAL_TRUST_DECAY_MS = 10 * 60 * 1_000

interface TrustKey {
  kind: string
  action: string
  rootId: string
}

export class TerminalTrustManager {
  private readonly grants = new Map<string, TerminalTrustGrant>()

  constructor(private readonly sessionId = randomUUID()) {}

  getSessionId(): string {
    return this.sessionId
  }

  grant(plan: ResolvedCommandPlan, sourceWindowId: string, now = Date.now()): TerminalTrustGrant {
    assertTrustable(plan)
    const key = getTrustKey(plan)
    const existing = [...this.grants.values()].find(
      (grant) =>
        !grant.revokedAt && sameTrustKey(grant, key) && grant.sourceWindowId === sourceWindowId,
    )
    if (existing) {
      existing.expiresAt = now + TERMINAL_TRUST_TTL_MS
      existing.lastUsedAt = now
      return cloneGrant(existing)
    }
    const grant: TerminalTrustGrant = {
      trustId: randomUUID(),
      ...key,
      sourceWindowId,
      sessionId: this.sessionId,
      createdAt: now,
      expiresAt: now + TERMINAL_TRUST_TTL_MS,
      lastUsedAt: now,
      useCount: 0,
      maxUses: TERMINAL_TRUST_MAX_USES,
    }
    this.grants.set(grant.trustId, grant)
    return cloneGrant(grant)
  }

  consumeIfAllowed(plan: ResolvedCommandPlan, sourceWindowId: string, now = Date.now()): boolean {
    if (!isTrustable(plan)) return false
    const key = getTrustKey(plan)
    const grant = [...this.grants.values()].find(
      (candidate) =>
        !candidate.revokedAt &&
        candidate.sourceWindowId === sourceWindowId &&
        candidate.sessionId === this.sessionId &&
        sameTrustKey(candidate, key),
    )
    if (!grant) return false
    if (
      grant.expiresAt <= now ||
      grant.useCount >= grant.maxUses ||
      now - grant.lastUsedAt > TERMINAL_TRUST_DECAY_MS
    ) {
      grant.revokedAt = now
      return false
    }
    grant.useCount += 1
    grant.lastUsedAt = now
    return true
  }

  list(now = Date.now()): TerminalTrustGrant[] {
    for (const grant of this.grants.values()) {
      if (
        !grant.revokedAt &&
        (grant.expiresAt <= now ||
          now - grant.lastUsedAt > TERMINAL_TRUST_DECAY_MS ||
          grant.useCount >= grant.maxUses)
      ) {
        grant.revokedAt = now
      }
    }
    return [...this.grants.values()].filter((grant) => !grant.revokedAt).map(cloneGrant)
  }

  revokeAll(now = Date.now()): void {
    for (const grant of this.grants.values()) {
      if (!grant.revokedAt) grant.revokedAt = now
    }
  }
}

export function isTrustable(plan: ResolvedCommandPlan): boolean {
  return plan.sandbox.tier === "read-only" && plan.risk === "R1"
}

function assertTrustable(plan: ResolvedCommandPlan): void {
  if (!isTrustable(plan)) throw new Error("只有 read-only + R1 Terminal 意图可以积累会话信任")
}

function getTrustKey(plan: ResolvedCommandPlan): TrustKey {
  const intent = plan.intent as { kind: string; action?: string }
  return { kind: intent.kind, action: intent.action ?? "", rootId: plan.cwd.rootId }
}

function sameTrustKey(left: TrustKey, right: TrustKey): boolean {
  return left.kind === right.kind && left.action === right.action && left.rootId === right.rootId
}

function cloneGrant(grant: TerminalTrustGrant): TerminalTrustGrant {
  return { ...grant }
}
