import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProjectScriptBinding, TerminalIntent } from "../../shared/types.js"
import { resolveProjectPath } from "../security/pathGuard.js"

export const QUALITY_SCRIPT_NAMES = ["lint", "typecheck", "format:check", "test", "build"] as const
export type QualityScriptName = (typeof QUALITY_SCRIPT_NAMES)[number]

export interface ResolvedProjectScript {
  binding: ProjectScriptBinding
  cwd: string
  packageJsonPath: string
}

export function resolveProjectScript(
  projectRoot: string,
  intent: Extract<TerminalIntent, { kind: "project.script" }>,
): ResolvedProjectScript {
  if (intent.packageManager !== "npm") throw new Error("只支持 npm 项目脚本")
  if (!QUALITY_SCRIPT_NAMES.includes(intent.script as QualityScriptName)) {
    throw new Error("只开放已知质量脚本")
  }
  if (intent.forwardedArgs.length > 0) throw new Error("项目脚本暂不接受转发参数")
  const cwd = resolveProjectPath(projectRoot, intent.cwd)
  const packageJsonPath = join(projectRoot, "package.json")
  const source = readFileSync(packageJsonPath, "utf8")
  const packageJsonSha256 = createHash("sha256").update(source, "utf8").digest("hex")
  let packageJson: unknown
  try {
    packageJson = JSON.parse(source)
  } catch {
    throw new Error("package.json 不是有效 JSON")
  }
  if (typeof packageJson !== "object" || packageJson === null) {
    throw new Error("package.json 格式无效")
  }
  const scripts = (packageJson as { scripts?: unknown }).scripts
  const body =
    typeof scripts === "object" && scripts !== null
      ? (scripts as Record<string, unknown>)[intent.script]
      : undefined
  if (typeof body !== "string" || !body.trim()) {
    throw new Error(`package.json 未声明质量脚本 ${intent.script}`)
  }
  validateQualityScriptBody(body)
  return {
    binding: {
      packageJsonRelativePath: "package.json",
      name: intent.script as QualityScriptName,
      body,
      packageJsonSha256,
    },
    cwd,
    packageJsonPath,
  }
}

export function verifyProjectScriptBinding(
  projectRoot: string,
  binding: ProjectScriptBinding,
): void {
  const packageJsonPath = join(projectRoot, binding.packageJsonRelativePath)
  const source = readFileSync(packageJsonPath, "utf8")
  const packageJsonSha256 = createHash("sha256").update(source, "utf8").digest("hex")
  if (packageJsonSha256 !== binding.packageJsonSha256) throw new Error("script changed")
  let packageJson: unknown
  try {
    packageJson = JSON.parse(source)
  } catch {
    throw new Error("package.json 不是有效 JSON")
  }
  const scripts =
    typeof packageJson === "object" && packageJson !== null
      ? (packageJson as { scripts?: unknown }).scripts
      : undefined
  const body =
    typeof scripts === "object" && scripts !== null
      ? (scripts as Record<string, unknown>)[binding.name]
      : undefined
  if (body !== binding.body) throw new Error("script changed")
  validateQualityScriptBody(binding.body)
}

function validateQualityScriptBody(body: string): void {
  if (body.length > 2_000 || /[;|<>$`()\n\r]/.test(body)) {
    throw new Error("质量脚本包含禁止的 Shell 控制语法")
  }
  if (/(^|\s)(sudo|osascript|launchctl|installer|rm|curl|wget|npx)(\s|$)/.test(body)) {
    throw new Error("质量脚本包含永久禁止的命令")
  }
  if (
    /\b(git\s+(push|reset|clean)|npm\s+(install|exec)|python(?:3)?\s+-c|node\s+-e)\b/.test(body)
  ) {
    throw new Error("质量脚本包含不允许的副作用命令")
  }
}
