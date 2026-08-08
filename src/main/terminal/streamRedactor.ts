const HOLD_BYTES = 512

/**
 * 流式输出只能发布已经离开敏感串可能范围的前缀；安全边界由完整终态再次校验。
 */
export class StreamRedactor {
  private hold = ""

  push(chunk: string): string {
    const value = this.hold + chunk
    if (value.length <= HOLD_BYTES) {
      this.hold = value
      return ""
    }
    const boundary = value.length - HOLD_BYTES
    const safe = value.slice(0, boundary)
    this.hold = value.slice(boundary)
    return redactOutput(safe)
  }

  flush(): string {
    const value = redactOutput(this.hold)
    this.hold = ""
    return value
  }
}

export function redactOutput(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/MODEL_API_KEY\s*=\s*[^\s]+/gi, "MODEL_API_KEY=[redacted]")
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
}

export function foldOutput(value: string, softLimit: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= softLimit) return value
  const sectionBytes = Math.min(32 * 1024, Math.max(1, Math.floor(softLimit / 2)))
  const head = bytes.subarray(0, sectionBytes).toString("utf8")
  const tail = bytes
    .subarray(Math.max(sectionBytes, bytes.byteLength - sectionBytes))
    .toString("utf8")
  const foldedBytes = Math.max(
    0,
    bytes.byteLength - Buffer.byteLength(head) - Buffer.byteLength(tail),
  )
  return `${head}\n[... 已折叠 ${foldedBytes} 字节 ...]\n${tail}`
}

export function getSoftOutputLimit(plan: {
  limits: { outputBytes: number; softOutputBytes?: number }
}): number {
  return Math.min(plan.limits.softOutputBytes ?? plan.limits.outputBytes, plan.limits.outputBytes)
}
