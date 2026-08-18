import { lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export const MAX_FILE_BYTES = 200_000
export const MAX_READ_CHARS = 24_000
export const MAX_SEARCH_RESULTS = 50
export const MAX_LIST_RESULTS = 200
export const MAX_SCAN_ENTRIES = 10_000
export const MAX_WRITE_BYTES = 200_000
export const MAX_BATCH_ITEMS = 32
export const DEFAULT_SCAN_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "out",
  "dist",
  "coverage",
  ".vite",
])

const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".ssh", ".gnupg", "credentials", "secrets"])
const SENSITIVE_FILE_NAMES = new Set(["id_rsa", "id_ed25519", "authorized_keys"])
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"])

export interface ScanBudget {
  visitedEntries: number
  truncated: boolean
}

export function createScanBudget(): ScanBudget {
  return { visitedEntries: 0, truncated: false }
}

export function consumeScanEntry(budget: ScanBudget): boolean {
  if (budget.visitedEntries >= MAX_SCAN_ENTRIES) {
    budget.truncated = true
    return false
  }
  budget.visitedEntries += 1
  return true
}

export function getRealProjectRoot(projectPath: string): string {
  const root = realpathSync.native(projectPath)
  if (!statSync(root).isDirectory()) throw new Error("授权项目路径不是目录")
  return root
}

export function resolveProjectPath(projectPath: string, requestedPath: string): string {
  validateRelativePath(requestedPath)
  if (isSensitiveRelativePath(requestedPath)) throw new Error("出于安全原因，这个路径默认不可读取")

  const root = getRealProjectRoot(projectPath)
  const target = realpathSync.native(resolve(root, requestedPath))
  const relativeTarget = relative(root, target)
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error("工具路径越过了已授权目录")
  }
  if (isSensitiveRelativePath(relativeTarget)) throw new Error("出于安全原因，这个路径默认不可读取")
  return target
}

/**
 * Resolve a path for a new or existing write target. Unlike resolveProjectPath,
 * the final entry may not exist, but every existing ancestor must be real and
 * inside the authorised root. This is deliberately re-runnable immediately
 * before use to narrow the check/use race window.
 */
export function resolveProjectTarget(projectPath: string, requestedPath: string): string {
  validateRelativePath(requestedPath)
  if (isSensitiveRelativePath(requestedPath)) throw new Error("出于安全原因，这个路径默认不可写")

  const root = getRealProjectRoot(projectPath)
  const lexicalTarget = resolve(root, requestedPath)
  assertWithinRoot(root, lexicalTarget)

  let current = lexicalTarget
  while (true) {
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink()) throw new Error("符号链接目标默认不可访问")
      const realCurrent = realpathSync.native(current)
      assertWithinRoot(root, realCurrent)
      if (current === lexicalTarget) return realCurrent
      return lexicalTarget
    } catch (error) {
      if (!isMissingPathError(error) || current === root) throw error
      const parent = dirname(current)
      if (parent === current) throw new Error("目标父目录不存在")
      current = parent
    }
  }
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/")
  const segments = normalized.split("/").filter(Boolean)
  const basename = segments.at(-1) ?? ""
  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true
  if (SENSITIVE_FILE_NAMES.has(basename) || basename.startsWith(".env")) return true
  return SENSITIVE_EXTENSIONS.has(getExtension(basename))
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0)
}

function validateRelativePath(requestedPath: string): void {
  if (
    !requestedPath ||
    requestedPath.length > 4_096 ||
    requestedPath.includes("\\") ||
    requestedPath.includes("\u0000") ||
    isAbsolute(requestedPath)
  ) {
    throw new Error("工具路径必须是授权目录内的相对路径")
  }
  if (requestedPath.split("/").some((segment) => segment === "..")) {
    throw new Error("工具路径不允许使用 ..")
  }
}

function assertWithinRoot(root: string, target: string): void {
  const relativeTarget = relative(root, target)
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error("工具路径越过了已授权目录")
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".")
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ""
}
