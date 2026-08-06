import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import {
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
  walk(startPath, root, parsed.query.toLowerCase(), results)
  if (results.length === 0) return `没有找到与“${parsed.query}”匹配的文件或文本。`
  const suffix =
    results.length >= MAX_SEARCH_RESULTS ? `\n（结果已限制为 ${MAX_SEARCH_RESULTS} 项）` : ""
  return `${results.join("\n")}${suffix}`
}

function walk(directory: string, root: string, query: string, results: string[]): void {
  if (results.length >= MAX_SEARCH_RESULTS) return

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (results.length >= MAX_SEARCH_RESULTS) return
    const absolutePath = join(directory, entry.name)
    const relativePath = relative(root, absolutePath)
    if (isSensitiveRelativePath(relativePath) || entry.isSymbolicLink()) continue

    if (entry.isDirectory()) {
      walk(absolutePath, root, query, results)
      continue
    }
    if (!entry.isFile()) continue
    if (relativePath.toLowerCase().includes(query)) {
      results.push(`${relativePath}（文件名匹配）`)
      continue
    }

    const stats = statSync(absolutePath)
    if (stats.size > MAX_FILE_BYTES) continue
    const buffer = readFileSync(absolutePath)
    if (!isBinaryBuffer(buffer) && buffer.toString("utf8").toLowerCase().includes(query)) {
      results.push(`${relativePath}（内容匹配）`)
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
