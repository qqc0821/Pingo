import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { TrustedWorkspace, UserPreferences, WindowPosition } from "../shared/types.js"

export const DEFAULT_PREFERENCES: UserPreferences = {
  modelBaseUrl: "https://api.deepseek.com/v1/chat/completions",
  modelName: "deepseek-v4-pro",
  defaultLocation: "",
  petScale: 1,
  transparency: 1,
  launchAtLogin: false,
}

const LEGACY_DEEPSEEK_MODELS = new Set(["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"])

interface PersistedSettings {
  windowPosition?: WindowPosition
  authorizedProjectPath?: string
  trustedWorkspace?: {
    path: string
    authorizedAt: number
  }
  preferences?: Partial<UserPreferences>
}

export class SettingsStore {
  private readonly filePath: string
  private data: PersistedSettings

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "settings.json")
    this.data = this.read()
  }

  getWindowPosition(): WindowPosition | undefined {
    return this.data.windowPosition
  }

  setWindowPosition(position: WindowPosition): void {
    this.data.windowPosition = position
    this.persist()
  }

  getAuthorizedProjectPath(): string | undefined {
    return this.data.authorizedProjectPath
  }

  setAuthorizedProjectPath(path: string): void {
    this.data.authorizedProjectPath = path
    this.persist()
  }

  clearAuthorizedProjectPath(): void {
    delete this.data.authorizedProjectPath
    this.persist()
  }

  getTrustedWorkspace(): TrustedWorkspace | undefined {
    const trusted = this.data.trustedWorkspace
    if (!trusted) return undefined
    return {
      path: trusted.path,
      name: basenameForPath(trusted.path),
      authorizedAt: trusted.authorizedAt,
    }
  }

  setTrustedWorkspace(path: string, authorizedAt = Date.now()): void {
    this.data.trustedWorkspace = { path, authorizedAt }
    this.data.authorizedProjectPath = path
    this.persist()
  }

  clearTrustedWorkspace(): void {
    delete this.data.trustedWorkspace
    this.persist()
  }

  getPreferences(): UserPreferences {
    const preferences = { ...DEFAULT_PREFERENCES, ...this.data.preferences }
    if (LEGACY_DEEPSEEK_MODELS.has(preferences.modelName)) {
      preferences.modelName = DEFAULT_PREFERENCES.modelName
    }
    return preferences
  }

  setPreferences(preferences: UserPreferences): void {
    this.data.preferences = preferences
    this.persist()
  }

  private read(): PersistedSettings {
    try {
      const raw = readFileSync(this.filePath, "utf8")
      const parsed: unknown = JSON.parse(raw)

      if (!isPersistedSettings(parsed)) return {}
      return parsed
    } catch {
      return {}
    }
  }

  private persist(): void {
    const directory = dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp`
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), "utf8")
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, this.filePath)
  }
}

function isPersistedSettings(value: unknown): value is PersistedSettings {
  if (typeof value !== "object" || value === null) return false

  const candidate = value as {
    windowPosition?: unknown
    authorizedProjectPath?: unknown
    trustedWorkspace?: unknown
    preferences?: unknown
  }
  if (candidate.windowPosition !== undefined) {
    if (typeof candidate.windowPosition !== "object" || candidate.windowPosition === null)
      return false

    const position = candidate.windowPosition as { x?: unknown; y?: unknown }
    if (typeof position.x !== "number" || typeof position.y !== "number") return false
  }
  if (
    candidate.authorizedProjectPath !== undefined &&
    typeof candidate.authorizedProjectPath !== "string"
  ) {
    return false
  }
  if (candidate.trustedWorkspace !== undefined) {
    if (typeof candidate.trustedWorkspace !== "object" || candidate.trustedWorkspace === null)
      return false
    const trusted = candidate.trustedWorkspace as { path?: unknown; authorizedAt?: unknown }
    if (typeof trusted.path !== "string" || typeof trusted.authorizedAt !== "number") return false
  }
  return (
    candidate.preferences === undefined ||
    (typeof candidate.preferences === "object" && candidate.preferences !== null)
  )
}

function basenameForPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.split("/").at(-1) || path
}
