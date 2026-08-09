import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import {
  consumeScanEntry,
  createScanBudget,
  DEFAULT_SCAN_EXCLUDED_DIRECTORIES,
  getRealProjectRoot,
  isSensitiveRelativePath,
  MAX_LIST_RESULTS,
  resolveProjectPath,
} from "../security/pathGuard.js"

interface ListFilesArgs {
  directory?: string
}

export function listFiles(projectPath: string, args: unknown): string {
  const parsed = parseArgs(args)
  const root = getRealProjectRoot(projectPath)
  const startPath = resolveProjectPath(projectPath, parsed.directory ?? ".")
  if (!statSync(startPath).isDirectory()) throw new Error("list_files 的 directory 必须是目录")

  const results: string[] = []
  const budget = createScanBudget()
  walk(startPath, root, results, budget)
  if (results.length === 0) {
    return budget.truncated
      ? "授权目录中没有找到可列出的文件；扫描已达到安全条目预算，结果可能不完整。"
      : "授权目录中没有找到可列出的文件。"
  }
  const suffix =
    results.length >= MAX_LIST_RESULTS
      ? `\n（结果已限制为 ${MAX_LIST_RESULTS} 项）`
      : budget.truncated
        ? "\n（扫描已达到安全条目预算，结果可能不完整）"
        : ""
  return `${results.join("\n")}${suffix}`
}

function walk(
  directory: string,
  root: string,
  results: string[],
  budget: ReturnType<typeof createScanBudget>,
): void {
  if (results.length >= MAX_LIST_RESULTS) return

  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= MAX_LIST_RESULTS) return
    if (!consumeScanEntry(budget)) return
    const absolutePath = join(directory, entry.name)
    const relativePath = relative(root, absolutePath)
    if (isSensitiveRelativePath(relativePath) || entry.isSymbolicLink()) continue
    if (entry.isFile() && entry.name === ".DS_Store") continue

    if (entry.isDirectory()) {
      if (DEFAULT_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) continue
      walk(absolutePath, root, results, budget)
    } else if (entry.isFile()) results.push(relativePath)
  }
}

function parseArgs(value: unknown): ListFilesArgs {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null) throw new Error("list_files 参数必须是对象")
  const directory = (value as { directory?: unknown }).directory
  if (directory !== undefined && typeof directory !== "string") {
    throw new Error("list_files.directory 必须是字符串")
  }
  return { directory }
}
