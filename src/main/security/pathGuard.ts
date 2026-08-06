import { realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

export const MAX_FILE_BYTES = 200_000
export const MAX_READ_CHARS = 24_000
export const MAX_SEARCH_RESULTS = 50
export const MAX_LIST_RESULTS = 200

const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".ssh", ".gnupg", "credentials", "secrets"])
const SENSITIVE_FILE_NAMES = new Set(["id_rsa", "id_ed25519", "authorized_keys"])
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"])

export function getRealProjectRoot(projectPath: string): string {
  const root = realpathSync.native(projectPath)
  if (!statSync(root).isDirectory()) throw new Error("授权项目路径不是目录")
  return root
}

export function resolveProjectPath(projectPath: string, requestedPath: string): string {
  if (!requestedPath || isAbsolute(requestedPath) || requestedPath.includes("\\")) {
    throw new Error("工具路径必须是授权目录内的相对路径")
  }
  if (requestedPath.split("/").some((segment) => segment === "..")) {
    throw new Error("工具路径不允许使用 ..")
  }
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

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".")
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ""
}
