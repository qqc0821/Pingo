export type PetState =
  | "idle"
  | "happy"
  | "thinking"
  | "nod"
  | "worried"
  | "encourage"
  | "sleepy"
  | "reminder"
  | "focus"
  | "celebrate"

export interface PetStateEvent {
  state: PetState
  durationMs?: number
}
export type ChatMessageRole = "user" | "assistant" | "system"

export interface ChatMessageInput {
  role: ChatMessageRole
  content: string
}

export type ChatStreamEvent =
  | { type: "start" }
  | { type: "chunk"; content: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string }

export interface WindowPosition {
  x: number
  y: number
}

export interface WindowState {
  expanded: boolean
  position: WindowPosition
  size: {
    width: number
    height: number
  }
}

export interface ProjectInfo {
  path: string
  name: string
}

export interface UserPreferences {
  modelBaseUrl: string
  modelName: string
  defaultLocation: string
  petScale: number
  transparency: number
  launchAtLogin: boolean
}

export interface AppSettings extends UserPreferences {
  apiKeyConfigured: boolean
}

export interface WindowAppearance {
  scale: number
}

export interface PingoAPI {
  platform: NodeJS.Platform
  version: string
  pet: {
    setExpanded: (expanded: boolean) => Promise<void>
    showContextMenu: () => void
    dragStart: (screenX: number, screenY: number) => void
    dragMove: (screenX: number, screenY: number) => void
    dragEnd: () => void
    onWindowState: (listener: (state: WindowState) => void) => () => void
    onSettingsRequest: (listener: () => void) => () => void
    onAppearance: (listener: (appearance: WindowAppearance) => void) => () => void
    onStateChange: (listener: (event: PetStateEvent) => void) => () => void
  }
  project: {
    get: () => Promise<ProjectInfo | null>
    choose: () => Promise<ProjectInfo | null>
    revoke: () => Promise<void>
  }
  settings: {
    get: () => Promise<AppSettings>
    update: (settings: UserPreferences) => Promise<AppSettings>
  }
}
