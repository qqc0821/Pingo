import { randomUUID } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { AuditRecord, OperationKind, RiskLevel } from "../../shared/types.js"

export interface AuditInput {
  taskId: string
  operationId?: string
  kind: OperationKind | "capability.grant" | "capability.revoke" | "task.cancel"
  risk?: RiskLevel
  targets?: string[]
  status: string
  detail?: string
}

export class AuditLogger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // The file may not exist yet; appendFileSync below creates it with mode 0600.
    }
  }

  record(input: AuditInput, now = Date.now()): AuditRecord {
    const record: AuditRecord = {
      auditId: randomUUID(),
      taskId: safeId(input.taskId),
      ...(input.operationId ? { operationId: safeId(input.operationId) } : {}),
      kind: input.kind,
      ...(input.risk ? { risk: input.risk } : {}),
      targets: (input.targets ?? []).slice(0, 32).map(redactTarget),
      status: safeText(input.status, 80),
      createdAt: now,
      ...(input.detail ? { detail: safeText(input.detail, 240) } : {}),
    }
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
    chmodSync(this.filePath, 0o600)
    return record
  }

  list(limit = 100): AuditRecord[] {
    try {
      return readFileSync(this.filePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(limit, 500)))
        .flatMap((line) => parseRecord(line))
    } catch {
      return []
    }
  }
}

function parseRecord(line: string): AuditRecord[] {
  try {
    const value: unknown = JSON.parse(line)
    return isAuditRecord(value) ? [value] : []
  } catch {
    return []
  }
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<AuditRecord>
  return (
    typeof record.auditId === "string" &&
    typeof record.taskId === "string" &&
    typeof record.kind === "string" &&
    Array.isArray(record.targets) &&
    typeof record.status === "string" &&
    typeof record.createdAt === "number"
  )
}

function redactTarget(value: string): string {
  const normalized = safeText(value, 1_000)
  return normalized
    .replace(/MODEL_API_KEY\s*=\s*[^\s]+/gi, "MODEL_API_KEY=[redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
}

function safeId(value: string): string {
  return safeText(value, 120).replace(/[^a-zA-Z0-9._:-]/g, "_")
}

function safeText(value: string, maxLength: number): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 || code === 0x09
    })
    .join("")
    .slice(0, maxLength)
}
