import { randomUUID } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import type { Capability, CapabilityGrant, GrantDuration } from "../../shared/types.js"

const SESSION_GRANT_TTL_MS = 24 * 60 * 60 * 1_000
const ONCE_GRANT_TTL_MS = 5 * 60 * 1_000
const PERSISTENT_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const ALLOWED_CAPABILITIES = new Set<Capability>([
  "workspace.read",
  "workspace.write",
  "terminal.execute",
])

export interface GrantRequest {
  capabilities: Capability[]
  scopeRoots: string[]
  duration: GrantDuration
  sourceWindowId: string
  sessionId?: string
}

export class CapabilityManager {
  private readonly sessionId: string
  private readonly grants = new Map<string, CapabilityGrant>()
  private readonly useCounts = new Map<string, number>()

  constructor(sessionId = randomUUID()) {
    this.sessionId = sessionId
  }

  getSessionId(): string {
    return this.sessionId
  }

  grant(request: GrantRequest, now = Date.now()): CapabilityGrant {
    validateGrantRequest(request)
    const scopeRoots = request.scopeRoots.map((root) => canonicalDirectory(root))
    const grant: CapabilityGrant = {
      grantId: randomUUID(),
      capabilities: [...new Set(request.capabilities)],
      scopeRoots,
      duration: request.duration,
      createdAt: now,
      expiresAt: now + getGrantTtl(request.duration),
      sourceWindowId: request.sourceWindowId,
      sessionId: request.sessionId ?? this.sessionId,
    }
    if (grant.sessionId !== this.sessionId) throw new Error("授权会话无效")
    this.grants.set(grant.grantId, grant)
    this.useCounts.set(grant.grantId, 0)
    return cloneGrant(grant)
  }

  list(now = Date.now()): CapabilityGrant[] {
    this.expire(now)
    return [...this.grants.values()]
      .filter((grant) => grant.revokedAt === undefined && grant.expiresAt > now)
      .map(cloneGrant)
  }

  revoke(grantId: string, now = Date.now()): boolean {
    const grant = this.grants.get(grantId)
    if (!grant || grant.revokedAt !== undefined) return false
    grant.revokedAt = now
    return true
  }

  revokeAllForWindow(sourceWindowId: string, now = Date.now()): number {
    let count = 0
    for (const grant of this.grants.values()) {
      if (grant.sourceWindowId === sourceWindowId && grant.revokedAt === undefined) {
        grant.revokedAt = now
        count += 1
      }
    }
    return count
  }

  revokeAll(now = Date.now()): void {
    for (const grant of this.grants.values()) {
      if (grant.revokedAt === undefined) grant.revokedAt = now
    }
  }

  assertAllowed(
    capability: Capability,
    targetPaths: string[],
    sourceWindowId: string,
    now = Date.now(),
  ): CapabilityGrant {
    this.expire(now)
    if (!ALLOWED_CAPABILITIES.has(capability)) throw new Error("该能力在当前版本被禁止")
    for (const grant of this.grants.values()) {
      if (!isGrantUsable(grant, capability, sourceWindowId, now)) continue
      if (targetPaths.every((target) => isWithinAnyRoot(target, grant.scopeRoots))) {
        return cloneGrant(grant)
      }
    }
    throw new Error(`缺少有效能力授权：${capability}`)
  }

  consume(grantId: string, now = Date.now()): void {
    const grant = this.grants.get(grantId)
    if (!grant || !isGrantUsable(grant, undefined, grant.sourceWindowId, now)) {
      throw new Error("授权已失效")
    }
    if (grant.duration !== "once") return
    const count = this.useCounts.get(grantId) ?? 0
    if (count >= 1) throw new Error("一次性授权已使用")
    this.useCounts.set(grantId, count + 1)
  }

  private expire(now: number): void {
    for (const grant of this.grants.values()) {
      if (grant.revokedAt === undefined && grant.expiresAt <= now) grant.revokedAt = now
    }
  }
}

function validateGrantRequest(request: GrantRequest): void {
  if (!request.sourceWindowId || request.sourceWindowId.length > 200) {
    throw new Error("授权来源窗口无效")
  }
  if (!Array.isArray(request.capabilities) || request.capabilities.length === 0) {
    throw new Error("至少需要申请一种能力")
  }
  if (!request.capabilities.every((capability) => ALLOWED_CAPABILITIES.has(capability))) {
    throw new Error("申请了不允许的能力")
  }
  if (
    !Array.isArray(request.scopeRoots) ||
    request.scopeRoots.length === 0 ||
    request.scopeRoots.length > 8
  ) {
    throw new Error("授权目录范围无效")
  }
  if (!(["once", "session", "persistent"] as GrantDuration[]).includes(request.duration)) {
    throw new Error("授权持续时间无效")
  }
}

function canonicalDirectory(value: string): string {
  if (!value || value.length > 4_096 || !isAbsolute(value))
    throw new Error("授权目录必须是绝对路径")
  const realPath = realpathSync.native(value)
  if (!statSync(realPath).isDirectory()) throw new Error("授权范围必须是目录")
  return realPath
}

function isGrantUsable(
  grant: CapabilityGrant,
  capability: Capability | undefined,
  sourceWindowId: string,
  now: number,
): boolean {
  return (
    grant.revokedAt === undefined &&
    grant.expiresAt > now &&
    grant.sessionId.length > 0 &&
    grant.sourceWindowId === sourceWindowId &&
    (capability === undefined || grant.capabilities.includes(capability))
  )
}

function isWithinAnyRoot(targetPath: string, roots: string[]): boolean {
  if (!isAbsolute(targetPath)) return false
  let canonicalTarget = targetPath
  try {
    canonicalTarget = realpathSync.native(targetPath)
  } catch {
    // A caller may be checking a not-yet-created target; its parent is checked by pathGuard.
  }
  return roots.some((root) => {
    const rel = relative(root, canonicalTarget)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

function getGrantTtl(duration: GrantDuration): number {
  if (duration === "once") return ONCE_GRANT_TTL_MS
  if (duration === "persistent") return PERSISTENT_GRANT_TTL_MS
  return SESSION_GRANT_TTL_MS
}

function cloneGrant(grant: CapabilityGrant): CapabilityGrant {
  return { ...grant, capabilities: [...grant.capabilities], scopeRoots: [...grant.scopeRoots] }
}
