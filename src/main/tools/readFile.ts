import { readFileSync, statSync } from "node:fs"
import {
  isBinaryBuffer,
  MAX_FILE_BYTES,
  MAX_READ_CHARS,
  resolveProjectPath,
} from "../security/pathGuard.js"

interface ReadFileArgs {
  path: string
  startLine?: number
  endLine?: number
}

export function readFile(projectPath: string, args: unknown): string {
  const parsed = parseArgs(args)
  const absolutePath = resolveProjectPath(projectPath, parsed.path)
  const stats = statSync(absolutePath)
  if (!stats.isFile()) throw new Error("read_file 的 path 必须是文件")
  if (stats.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES} 字节限制`)

  const buffer = readFileSync(absolutePath)
  if (isBinaryBuffer(buffer)) throw new Error("二进制文件默认不可读取")

  const lines = buffer.toString("utf8").split(/\r?\n/)
  const start = parsed.startLine ?? 1
  const end = parsed.endLine ?? Math.min(lines.length, start + 299)
  if (start < 1 || end < start || end - start >= 300) {
    throw new Error("read_file 行范围无效，最多读取 300 行")
  }

  const output = lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(5, " ")} | ${line}`)
    .join("\n")
  return output.length > MAX_READ_CHARS
    ? `${output.slice(0, MAX_READ_CHARS)}\n（内容已截断）`
    : output
}

function parseArgs(value: unknown): ReadFileArgs {
  if (typeof value !== "object" || value === null) throw new Error("read_file 参数必须是对象")
  const candidate = value as { path?: unknown; startLine?: unknown; endLine?: unknown }
  if (typeof candidate.path !== "string" || !candidate.path)
    throw new Error("read_file.path 必须是非空字符串")
  if (candidate.startLine !== undefined && !isPositiveInteger(candidate.startLine)) {
    throw new Error("read_file.startLine 必须是正整数")
  }
  if (candidate.endLine !== undefined && !isPositiveInteger(candidate.endLine)) {
    throw new Error("read_file.endLine 必须是正整数")
  }
  return {
    path: candidate.path,
    startLine: candidate.startLine as number | undefined,
    endLine: candidate.endLine as number | undefined,
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}
