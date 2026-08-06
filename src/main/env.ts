import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export function loadDotEnv(directories: string[] = [process.cwd()]): void {
  for (const directory of directories) {
    const envPath = join(directory, ".env")
    if (!existsSync(envPath)) continue

    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue

      const separatorIndex = trimmed.indexOf("=")
      if (separatorIndex <= 0) continue

      const key = trimmed.slice(0, separatorIndex).trim()
      const rawValue = trimmed.slice(separatorIndex + 1).trim()
      if (process.env[key]?.trim()) continue

      process.env[key] = stripQuotes(rawValue)
    }
  }
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value
}
