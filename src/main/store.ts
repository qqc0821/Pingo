import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { UserPreferences, WindowPosition } from "../shared/types.js"

export const DEFAULT_PREFERENCES: UserPreferences = {
  modelBaseUrl: "https://api.deepseek.com/v1/chat/completions",
  modelName: "deepseek-chat",
  petScale: 1,
  transparency: 1,
  launchAtLogin: false,
}

interface PersistedSettings {
  windowPosition?: WindowPosition
  authorizedProjectPath?: string
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

  getPreferences(): UserPreferences {
    return { ...DEFAULT_PREFERENCES, ...this.data.preferences }
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
    renameSync(temporaryPath, this.filePath)
  }
}

function isPersistedSettings(value: unknown): value is PersistedSettings {
  if (typeof value !== "object" || value === null) return false

  const candidate = value as {
    windowPosition?: unknown
    authorizedProjectPath?: unknown
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
  return (
    candidate.preferences === undefined ||
    (typeof candidate.preferences === "object" && candidate.preferences !== null)
  )
}
