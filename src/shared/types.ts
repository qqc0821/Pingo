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
  | { type: "task-state"; taskId: string; state: TaskState }
  | { type: "capability-request"; taskId: string; capabilities: Capability[]; scopeRoots: string[] }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "operation-result"; result: OperationResult }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string }

export type Capability =
  "workspace.read" | "workspace.write" | "terminal.execute" | "system.automation"

export type GrantDuration = "once" | "session" | "persistent"
export type RiskLevel = "R0" | "R1" | "R2" | "R3" | "R4"
export type OperationKind =
  | "create_directory"
  | "write_file"
  | "apply_patch"
  | "move_path"
  | "trash_path"
  | "terminal.execute"

export interface CapabilityGrant {
  grantId: string
  capabilities: Capability[]
  scopeRoots: string[]
  duration: GrantDuration
  createdAt: number
  expiresAt: number
  revokedAt?: number
  sourceWindowId: string
  sessionId: string
}

export interface FileStatePrecondition {
  path: string
  exists: boolean
  sha256?: string
  mtimeMs?: number
  size?: number
}

export interface CommandPlan {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  outputLimitBytes: number
  envKeys: string[]
}

export interface OperationPlan {
  operationId: string
  taskId: string
  sourceWindowId: string
  kind: OperationKind
  capability: Capability
  risk: RiskLevel
  riskReason: string
  targets: string[]
  preview: string
  command?: CommandPlan
  preconditions: FileStatePrecondition[]
  digest: string
  createdAt: number
  expiresAt: number
  reversible: boolean
}

export interface ApprovalRequest {
  operationId: string
  taskId: string
  plan: OperationPlan
  expiresAt: number
}

export type OperationDecisionValue = "approve" | "deny"

export interface OperationDecision {
  taskId: string
  operationId: string
  decision: OperationDecisionValue
}

export interface OperationResult {
  operationId: string
  status: "completed" | "denied" | "expired" | "failed" | "cancelled"
  content: string
  detail: string
  reversible: boolean
  exitCode?: number | null
  signal?: string | null
  truncated?: boolean
  undoId?: string
}

export type TaskState =
  | "proposed"
  | "awaiting_permission"
  | "planning"
  | "awaiting_confirmation"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"

export interface AuditRecord {
  auditId: string
  taskId: string
  operationId?: string
  kind: OperationKind | "capability.grant" | "capability.revoke" | "task.cancel"
  risk?: RiskLevel
  targets: string[]
  status: string
  createdAt: number
  detail?: string
}

export interface CapabilityRequest {
  taskId: string
  capabilities: Capability[]
  duration: GrantDuration
}

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
  task: {
    submit: (messages: ChatMessageInput[]) => Promise<{ taskId: string }>
    cancel: (taskId: string) => void
    decide: (decision: OperationDecision) => Promise<OperationResult | null>
    undo: (taskId: string, undoId: string) => Promise<OperationResult | null>
    grant: (request: CapabilityRequest) => Promise<CapabilityGrant | null>
    deny: (taskId: string) => Promise<boolean>
    onEvent: (listener: (event: ChatStreamEvent) => void) => () => void
  }
  audit: {
    list: () => Promise<AuditRecord[]>
  }
  capabilities: {
    list: () => Promise<CapabilityGrant[]>
    revoke: (grantId: string) => Promise<boolean>
  }
}
