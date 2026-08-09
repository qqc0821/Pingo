import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import {
  consumeScanEntry,
  createScanBudget,
  DEFAULT_SCAN_EXCLUDED_DIRECTORIES,
  getRealProjectRoot,
  isBinaryBuffer,
  isSensitiveRelativePath,
  MAX_FILE_BYTES,
  MAX_SEARCH_RESULTS,
  resolveProjectPath,
} from "../security/pathGuard.js"

interface SearchFilesArgs {
  query: string
  directory?: string
}

export function searchFiles(projectPath: string, args: unknown): string {
  const parsed = parseArgs(args)
  const root = getRealProjectRoot(projectPath)
  const startPath = resolveProjectPath(projectPath, parsed.directory ?? ".")
  if (!statSync(startPath).isDirectory()) throw new Error("search_files.directory 必须是目录")

  const results: string[] = []
  const budget = createScanBudget()
  walk(startPath, root, parsed.query.toLowerCase(), results, budget)
  if (results.length === 0) {
    return budget.truncated
      ? `没有找到与“${parsed.query}”匹配的文件或文本；扫描已达到安全条目预算，结果可能不完整。`
      : `没有找到与“${parsed.query}”匹配的文件或文本。`
  }
  const suffix =
    results.length >= MAX_SEARCH_RESULTS
      ? `\n（结果已限制为 ${MAX_SEARCH_RESULTS} 项）`
      : budget.truncated
        ? "\n（扫描已达到安全条目预算，结果可能不完整）"
        : ""
  return `${results.join("\n")}${suffix}`
}

function walk(
  directory: string,
  root: string,
  query: string,
  results: string[],
  budget: ReturnType<typeof createScanBudget>,
): void {
  if (results.length >= MAX_SEARCH_RESULTS) return

  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) return
    if (!consumeScanEntry(budget)) return
    const absolutePath = join(directory, entry.name)
    const relativePath = relative(root, absolutePath)
    if (isSensitiveRelativePath(relativePath) || entry.isSymbolicLink()) continue

    if (entry.isDirectory()) {
      if (DEFAULT_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) continue
      walk(absolutePath, root, query, results, budget)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name === ".DS_Store") continue
    if (relativePath.toLowerCase().includes(query)) {
      results.push(`${relativePath}（文件名匹配）`)
      continue
    }

    try {
      const stats = statSync(absolutePath)
      if (stats.size > MAX_FILE_BYTES) continue
      const buffer = readFileSync(absolutePath)
      if (!isBinaryBuffer(buffer) && buffer.toString("utf8").toLowerCase().includes(query)) {
        results.push(`${relativePath}（内容匹配）`)
      }
    } catch {
      // 文件可能无读取权限或在扫描期间被移动；忽略后继续扫描。
    }
  }
}

function parseArgs(value: unknown): SearchFilesArgs {
  if (typeof value !== "object" || value === null) throw new Error("search_files 参数必须是对象")
  const candidate = value as { query?: unknown; directory?: unknown }
  if (typeof candidate.query !== "string" || !candidate.query.trim()) {
    throw new Error("search_files.query 必须是非空字符串")
  }
  if (candidate.directory !== undefined && typeof candidate.directory !== "string") {
    throw new Error("search_files.directory 必须是字符串")
  }
  return { query: candidate.query.trim(), directory: candidate.directory }
}
