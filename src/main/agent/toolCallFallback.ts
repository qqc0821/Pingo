/**
 * 部分模型（已知 deepseek-chat / V4 系列）会把工具调用当成普通文本写进 content，
 * tool_calls 字段为空且 finish_reason 仍是 stop。这里做一次结构化恢复。
 */

export interface InlineToolCall {
  name: string
  arguments: string
}

const SENTINEL_PATTERN = /<\|[a-z0-9_]+\|>/gi

export function stripSentinels(content: string): string {
  return content.replace(SENTINEL_PATTERN, "")
}

/** 扫描出文本中所有括号平衡的 JSON 对象，跳过字符串内的括号 */
function findJsonObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]

    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character === "{") {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (character === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  return objects
}

function readToolName(record: Record<string, unknown>): string | undefined {
  if (typeof record.name === "string") return record.name
  if (typeof record.tool === "string") return record.tool
  if (typeof record.tool_name === "string") return record.tool_name
  if (typeof record.function === "string") return record.function
  if (typeof record.function === "object" && record.function !== null) {
    const nested = (record.function as Record<string, unknown>).name
    if (typeof nested === "string") return nested
  }
  return undefined
}

function readToolArguments(record: Record<string, unknown>): unknown {
  if (typeof record.function === "object" && record.function !== null) {
    const nested = record.function as Record<string, unknown>
    if (nested.arguments !== undefined) return nested.arguments
    if (nested.parameters !== undefined) return nested.parameters
  }
  if (record.parameters !== undefined) return record.parameters
  if (record.arguments !== undefined) return record.arguments
  if (record.input !== undefined) return record.input
  if (record.args !== undefined) return record.args
  return {}
}

/**
 * 只恢复注册表中真实存在的工具；未知名称一律忽略，避免把模型编造的文本当成调用。
 */
export function extractInlineToolCalls(
  content: string,
  isKnownTool: (name: string) => boolean,
): InlineToolCall[] {
  if (!content.trim()) return []

  const calls: InlineToolCall[] = []
  for (const raw of findJsonObjects(stripSentinels(content))) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue

    const record = parsed as Record<string, unknown>
    const name = readToolName(record)
    if (!name || !isKnownTool(name)) continue

    const argumentsValue = readToolArguments(record)
    calls.push({
      name,
      arguments:
        typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue ?? {}),
    })
  }

  return calls
}
