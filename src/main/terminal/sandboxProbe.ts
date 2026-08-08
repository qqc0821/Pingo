import { existsSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"

export const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec"

export interface SandboxProbe {
  available: boolean
  reason?: string
}

export function probeSeatbelt(profilePath: string): SandboxProbe {
  if (process.platform !== "darwin") {
    return { available: false, reason: "Seatbelt 仅在 macOS 上可用" }
  }
  try {
    const info = statSync(SEATBELT_EXECUTABLE)
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      return { available: false, reason: "sandbox-exec 不可执行" }
    }
    if (!existsSync(profilePath)) return { available: false, reason: "Seatbelt profile 不存在" }
    const result = spawnSync(SEATBELT_EXECUTABLE, ["-f", profilePath, "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 2_000,
      windowsHide: true,
    })
    if (result.error || result.status !== 0 || result.signal) {
      return { available: false, reason: "Seatbelt capability probe 失败" }
    }
    return { available: true }
  } catch {
    return { available: false, reason: "Seatbelt capability probe 异常" }
  }
}
