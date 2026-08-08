import { createHash } from "node:crypto"
import { existsSync, openSync, readSync, realpathSync, statSync, closeSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ExecutableIdentity, TerminalExecutableName } from "../../shared/types.js"

const FIXED_EXECUTABLES: Record<TerminalExecutableName, string[]> = {
  git: ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"],
  npm: [],
  node: [],
  pnpm: [],
  yarn: [],
  bun: [],
}

export function resolveExecutableIdentity(displayName: TerminalExecutableName): ExecutableIdentity {
  const candidates = [...FIXED_EXECUTABLES[displayName]]
  if (displayName === "node") candidates.unshift(process.execPath)
  if (displayName !== "git") {
    const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean)
    candidates.push(...pathEntries.map((entry) => join(entry, displayName)))
  }
  for (const candidate of candidates) {
    const identity = readExecutableIdentity(candidate, displayName)
    if (identity) return identity
  }
  throw new Error(`找不到受支持的 ${displayName} 可执行文件`)
}

export function readBoundExecutableIdentity(plan: ExecutableIdentity): ExecutableIdentity {
  const current = readExecutableIdentity(plan.realPath, plan.displayName)
  if (!current || !sameExecutableIdentity(plan, current)) {
    throw new Error("executable identity changed")
  }
  return current
}

export function sameExecutableIdentity(a: ExecutableIdentity, b: ExecutableIdentity): boolean {
  return (
    a.displayName === b.displayName &&
    a.realPath === b.realPath &&
    a.sha256 === b.sha256 &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.mtimeMs === b.mtimeMs &&
    a.ownerUid === b.ownerUid
  )
}

export function executableRuntimeRoots(identity: ExecutableIdentity): string[] {
  const roots = new Set<string>([dirname(identity.realPath)])
  if (identity.displayName !== "git") {
    // npm-cli.js imports npm's package-local runtime. Keep this exact package
    // root available while the real HOME remains default-denied by Seatbelt.
    roots.add(dirname(dirname(dirname(identity.realPath))))
    roots.add(dirname(dirname(dirname(dirname(dirname(identity.realPath))))))
  }
  return [...roots].filter((root) => root && root !== "/")
}

function readExecutableIdentity(
  candidate: string,
  displayName: TerminalExecutableName,
): ExecutableIdentity | null {
  try {
    if (!existsSync(candidate)) return null
    const realPath = realpathSync.native(candidate)
    const info = statSync(realPath)
    if (!info.isFile() || (info.mode & 0o111) === 0) return null
    return {
      displayName,
      realPath,
      sha256: sha256File(realPath),
      device: Number(info.dev),
      inode: Number(info.ino),
      mtimeMs: info.mtimeMs,
      ownerUid: Number(info.uid),
    }
  } catch {
    return null
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256")
  const fd = openSync(path, "r")
  const buffer = Buffer.allocUnsafe(128 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return hash.digest("hex")
  } finally {
    closeSync(fd)
  }
}
