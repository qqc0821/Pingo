import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ModelDiagnosticsLevel = "disabled" | "safe" | "raw"

export const MAX_RAW_DIAGNOSTIC_BYTES = 64 * 1024

export interface ModelDiagnosticsOptions {
  level?: string
  apiKey?: string
  logDirectory?: string
  now?: () => Date
  warn?: (message: string) => void
}

export function resolveModelDiagnosticsLevel(
  value = process.env.PINGO_DEBUG_MODEL,
): ModelDiagnosticsLevel {
  if (value === "1") return "safe"
  if (value === "raw") return "raw"
  return "disabled"
}

export class ModelDiagnostics {
  readonly level: ModelDiagnosticsLevel
  private readonly apiKey: string
  private readonly logDirectory: string
  private readonly now: () => Date
  private readonly warn: (message: string) => void

  constructor(options: ModelDiagnosticsOptions = {}) {
    this.level = resolveModelDiagnosticsLevel(options.level)
    this.apiKey = options.apiKey?.trim() ?? ""
    this.logDirectory = options.logDirectory ?? join(homedir(), "Library", "Logs", "Pingo")
    this.now = options.now ?? (() => new Date())
    this.warn = options.warn ?? ((message) => console.warn(`Pingo model diagnostics: ${message}`))
  }

  recordSafe(event: string, payload: Record<string, unknown>): void {
    if (this.level !== "safe") return
    this.write({ level: "safe", event, ...payload })
  }

  recordRaw(event: string, payload: unknown): void {
    if (this.level !== "raw") return
    this.write({ level: "raw", event, payload })
  }

  wrapFetch(fetchImpl: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
    if (this.level === "disabled") return fetchImpl
    return async (input, init) => {
      const url = getRequestUrl(input)
      if (this.level === "raw") {
        this.recordRaw("request", {
          url,
          body: parseBody(init?.body),
        })
      }

      try {
        const response = await fetchImpl(input, init)
        if (this.level === "raw") {
          try {
            const responseBody = await response.clone().text()
            this.recordRaw("response", {
              url,
              status: response.status,
              body: parseBody(responseBody),
            })
          } catch (error) {
            this.warn(`读取响应诊断副本失败：${safeError(error)}`)
          }
        }
        return response
      } catch (error) {
        if (this.level === "raw") {
          this.recordRaw("error", { url, error: safeError(error) })
        }
        throw error
      }
    }
  }

  private write(record: Record<string, unknown>): void {
    try {
      const timestamp = this.now().toISOString()
      const sanitized = sanitizeValue({ timestamp, ...record }, this.apiKey)
      const line = boundedJsonLine(sanitized)
      mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 })
      chmodSync(this.logDirectory, 0o700)
      const filePath = join(this.logDirectory, `model-${formatDate(this.now())}.jsonl`)
      try {
        appendFileSync(filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 })
      } catch (error) {
        if (isMissingFileError(error)) {
          writeFileSync(filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 })
        } else {
          throw error
        }
      }
      chmodSync(filePath, 0o600)
    } catch (error) {
      this.warn(`写入诊断日志失败：${safeError(error)}`)
    }
  }
}

export function sanitizeValue(value: unknown, apiKey = ""): unknown {
  if (typeof value === "string") {
    return apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, apiKey))
  if (typeof value !== "object" || value === null) return value

  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (isCredentialLikeKey(key)) output[key] = "[REDACTED]"
    else output[key] = sanitizeValue(child, apiKey)
  }
  return output
}

function boundedJsonLine(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, "utf8") <= MAX_RAW_DIAGNOSTIC_BYTES) return serialized
  let previewLength = Math.floor(MAX_RAW_DIAGNOSTIC_BYTES / 2)
  while (previewLength > 0) {
    const line = JSON.stringify({ truncated: true, preview: serialized.slice(0, previewLength) })
    if (Buffer.byteLength(line, "utf8") <= MAX_RAW_DIAGNOSTIC_BYTES) return line
    previewLength = Math.floor(previewLength * 0.8)
  }
  return JSON.stringify({ truncated: true })
}

function parseBody(value: BodyInit | null | undefined): unknown {
  if (typeof value !== "string")
    return value === undefined || value === null ? undefined : "[body omitted]"
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function getRequestUrl(input: RequestInfo | URL): string {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  try {
    const url = new URL(raw)
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? raw
  }
}

function isCredentialLikeKey(key: string): boolean {
  return /authorization|api[_-]?key|token|secret|password|credential|cookie/i.test(key)
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "")
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : "unknown error"
}
