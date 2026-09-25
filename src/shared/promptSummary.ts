export const PROMPT_SUMMARY_MAX_CHARS = 120

const COUNT_INTENT_PATTERN =
  /(?:多少|几\s*(?:个|张|份|项|条|处|种|台|套|位|枚|行|列|段)?|数量|总数|数目|统计)/u
const COUNT_DETAIL_INTENT_PATTERN = /(?:分别|各有|分类|明细|分布|每(?:个|种|类))/u
const COUNT_ANSWER_PATTERN =
  /(?:一共|共有|共计|总计|合计|共|找到|发现)\s*(?:约\s*)?([\d.零一二三四五六七八九十百千万两]+)\s*(个|张|份|项|条|处|种|台|套|位|枚|行|列|段)?\s*([^，,。；;!！?？\n]{0,16})/u

/** 把模型常见的内联编号列表拆成真正的行，避免在窄卡片中黏成一段。 */
export function normalizePromptContent(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/([：:])\s+(?=\d+\.\s)/g, "$1\n")
    .replace(/\s+(\d+)\.\s+(?=[`*_~\p{L}\p{N}])/gu, "\n$1. ")
    .trim()
}

function extractCountSummary(content: string, request: string): string | null {
  if (!COUNT_INTENT_PATTERN.test(request) || COUNT_DETAIL_INTENT_PATTERN.test(request)) return null
  const match = content.match(COUNT_ANSWER_PATTERN)
  if (!match?.[1]) return null

  const number = match[1]
  const unit = match[2] ?? ""
  const subject = (match[3] ?? "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const measure = `${unit}${subject}`.trim()

  return `共有 ${number}${measure ? ` ${measure}` : ""}。`
}

/** 摘要优先回答用户意图；数量问题只保留总数，其他问题回退到首个结论句。 */
export function summarizePromptContent(content: string, request = ""): string {
  const normalized = normalizePromptContent(content)
  if (!normalized) return ""

  const countSummary = extractCountSummary(normalized, request)
  if (countSummary) return countSummary

  const lines = normalized.split("\n")
  const firstListLine = lines.findIndex((line) => /^\s*(?:\d+\.|[-*])\s+/.test(line))
  const firstBlock =
    firstListLine > 0
      ? lines.slice(0, firstListLine).join(" ").trim()
      : normalized.split(/\n\s*\n/, 1)[0]?.trim() || normalized
  const firstSentence = firstBlock.match(/^(.+?[。！？!?](?:\s|$))/)?.[1]?.trim()
  const summary = firstSentence || firstBlock
  if (summary.length <= PROMPT_SUMMARY_MAX_CHARS) return summary
  return `${summary.slice(0, PROMPT_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
}
