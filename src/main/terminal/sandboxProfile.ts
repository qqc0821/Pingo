import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import type {
  ExecutableIdentity,
  TerminalSandboxSpec,
  TerminalEffects,
} from "../../shared/types.js"
import { executableRuntimeRoots } from "./executableIdentity.js"

export const SANDBOX_PROFILE_VERSION = 1

export function createSandboxSpec(
  projectRoot: string,
  operationId: string,
  executable: ExecutableIdentity,
  effects: TerminalEffects,
): TerminalSandboxSpec {
  const tempRoot = join(tmpdir(), "pingo-terminal", operationId)
  const readRoots = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/private/etc",
    "/dev",
    tempRoot,
    projectRoot,
    executable.realPath,
    ...executableRuntimeRoots(executable),
  ]
  const writeRoots = effects.workspace === "write" ? [projectRoot, tempRoot] : [tempRoot]
  const protectedPaths = getProtectedPaths(projectRoot)
  const digestInput = {
    profileVersion: SANDBOX_PROFILE_VERSION,
    readRoots: uniqueSorted(readRoots),
    writeRoots: uniqueSorted(writeRoots),
    protectedPaths: uniqueSorted(protectedPaths),
    tempRoot,
    network: "deny" as const,
  }
  return {
    ...digestInput,
    specDigest: createHash("sha256").update(stableJson(digestInput)).digest("hex"),
  }
}

export function renderSeatbeltProfile(plan: {
  executable: ExecutableIdentity
  cwd: { rootId: string }
  sandbox: TerminalSandboxSpec
  effects: TerminalEffects
}): string {
  const readRoots = uniqueSorted([...plan.sandbox.readRoots, plan.executable.realPath])
  const writeRoots = uniqueSorted(plan.sandbox.writeRoots)
  const protectedPaths = uniqueSorted(plan.sandbox.protectedPaths)
  const sensitiveWorkspacePattern = seatbeltRegex(
    `${plan.cwd.rootId}/(?:\\.env(?:\\..*)?|id_rsa|id_ed25519|authorized_keys)(?:/|$)`,
  )
  const processRoots = plan.effects.projectCodeExecution
    ? uniqueSorted([...writeRoots, ...executableRuntimeRoots(plan.executable)])
    : uniqueSorted([
        dirname(plan.executable.realPath),
        ...(plan.executable.displayName === "git"
          ? [
              "/Library/Developer/CommandLineTools/usr/bin",
              "/Library/Developer/CommandLineTools/usr/libexec/git-core",
            ]
          : []),
      ])
  const lines = [
    `(version ${SANDBOX_PROFILE_VERSION})`,
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec",
    `  (literal ${seatbeltLiteral(plan.executable.realPath)})`,
    '  (literal "/usr/bin/true")',
    ...processRoots.map((root) => `  (subpath ${seatbeltLiteral(root)})`),
    '  (literal "/bin/sh")',
    '  (literal "/bin/bash")',
    '  (literal "/usr/bin/env")',
    ")",
    "(allow sysctl-read)",
    // dyld and macOS metadata resolution need a readable root. Explicit
    // denials below close user-controlled/external locations again, and the
    // workspace/runtime/temp allow rules are applied after those denials.
    '(allow file-read* (subpath "/"))',
    '(deny file-read* (subpath "/Users"))',
    '(allow file-read-metadata (subpath "/Users"))',
    '(deny file-read* (subpath "/Volumes"))',
    '(deny file-read* (subpath "/Applications"))',
    '(deny file-read* (subpath "/tmp"))',
    '(deny file-read* (subpath "/private/tmp"))',
    '(deny file-read* (subpath "/private/var/folders"))',
    '(allow file-read-metadata (subpath "/private/var/folders"))',
    ...readRoots
      .filter((root) => root !== plan.executable.realPath)
      .map((root) => `(allow file-read* (subpath ${seatbeltLiteral(root)}))`),
    `(allow file-read* (literal ${seatbeltLiteral(plan.executable.realPath)}))`,
    ...writeRoots.map((root) => `(allow file-write* (subpath ${seatbeltLiteral(root)}))`),
    '(allow file-write* (literal "/dev/null"))',
    ...protectedPaths
      .filter((path) => !path.endsWith("/.git"))
      .map((path) => `(deny file-read* (subpath ${seatbeltLiteral(path)}))`),
    ...protectedPaths.map((path) => `(deny file-write* (subpath ${seatbeltLiteral(path)}))`),
    `(deny file-read* (regex ${sensitiveWorkspacePattern}))`,
    `(deny file-write* (regex ${sensitiveWorkspacePattern}))`,
    "(deny network-outbound)",
    "(deny network-inbound)",
    "(deny network-bind)",
    "(deny system-socket)",
    "",
  ]
  return lines.join("\n")
}

export function getProtectedPaths(projectRoot: string): string[] {
  return [
    join(projectRoot, ".git"),
    join(projectRoot, ".ssh"),
    join(projectRoot, ".gnupg"),
    join(projectRoot, "credentials"),
    join(projectRoot, "secrets"),
    join(projectRoot, ".env"),
    join(projectRoot, ".env.local"),
    join(projectRoot, ".env.development"),
    join(projectRoot, ".env.production"),
    join(projectRoot, "id_rsa"),
    join(projectRoot, "id_ed25519"),
    join(projectRoot, "authorized_keys"),
  ]
}

function seatbeltLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function seatbeltRegex(value: string): string {
  return `#"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`
}
