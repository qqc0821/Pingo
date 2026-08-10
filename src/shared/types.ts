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

export type AgentStepPhase =
  "planning" | "model" | "tool_batch" | "awaiting_approval" | "summarizing" | "budget_exceeded"

export type AgentStepStatus = "started" | "completed" | "failed" | "skipped"

export interface AgentStepEvent {
  type: "agent-step"
  taskId: string
  stepId: string
  loopIndex: number
  phase: AgentStepPhase
  status: AgentStepStatus
  title: string
  detail?: string
  toolNames?: string[]
}

export type ChatStreamEvent =
  | { type: "start" }
  | { type: "chunk"; content: string }
  | { type: "tool"; name: string; detail: string }
  | AgentStepEvent
  | OperationProgressEvent
  | { type: "task-state"; taskId: string; state: TaskState }
  | { type: "capability-request"; taskId: string; capabilities: Capability[]; scopeRoots: string[] }
  | { type: "approval-request"; request: ApprovalRequest }
  | { type: "operation-result"; result: OperationResult }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string }

export interface OperationProgressEvent {
  type: "operation-progress"
  operationId: string
  taskId: string
  stream: "stdout" | "stderr"
  seq: number
  content: string
  truncatedSoFar: boolean
}

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

export type TerminalIntent =
  | {
      kind: "git.read"
      action: "status" | "diff" | "log"
      args: string[]
      cwd: string
    }
  | {
      kind: "project.script"
      packageManager: "npm" | "auto"
      script: string
      forwardedArgs: string[]
      cwd: string
    }
  | {
      kind: "git.inspect"
      action: "show" | "blame" | "stash list"
      args: string[]
      cwd: string
    }
  | {
      kind: "runtime.info"
      action: "node" | "npm"
      cwd: string
    }
  | {
      kind: "pkg.audit"
      action: "ls" | "outdated"
      packageManager: "auto"
      cwd: string
    }
  | {
      kind: "directory.list"
      action: "list"
      cwd: string
    }

export type TerminalExecutableName = "git" | "ls" | "npm" | "node" | "pnpm" | "yarn" | "bun"

export type TerminalSandboxTier = "read-only" | "workspace-write" | "network-allowlist"

export interface SlotSchema {
  type: "string"
  enum?: string[]
  pattern?: string
  maxLength?: number
  path?: boolean
}

export interface ActionGrammar {
  argv: string[]
  slots: Record<string, SlotSchema>
  allowedFlags: string[]
  pathArgsAfterDoubleDash: boolean
}

export interface IntentPackDefinition {
  kind: string
  version: number
  executable: TerminalExecutableName
  packageManager?: "auto"
  actions: Record<string, ActionGrammar>
  sandboxTier: TerminalSandboxTier
  effects: TerminalEffects
  risk: "R1" | "R3"
  limits?: Partial<TerminalLimits>
  preservesColor?: boolean
  enabled: boolean
}

export interface ExecutableIdentity {
  displayName: TerminalExecutableName
  realPath: string
  sha256: string
  device: number
  inode: number
  mtimeMs: number
  ownerUid: number
}

export interface TerminalEffects {
  workspace: "read" | "write"
  projectCodeExecution: boolean
  network: "none"
  externalPaths: string[]
}

export interface TerminalSandboxSpec {
  profileVersion: number
  tier: TerminalSandboxTier
  readRoots: string[]
  writeRoots: string[]
  protectedPaths: string[]
  tempRoot: string
  network: "deny"
  specDigest: string
}

export interface TerminalLimits {
  timeoutMs: number
  /** 硬上限；保留 outputBytes 名称以兼容 V1 计划与测试调用方。 */
  outputBytes: number
  /** 软上限；超过后折叠中间输出但继续运行。 */
  softOutputBytes?: number
}

export interface ProjectScriptBinding {
  packageJsonRelativePath: string
  name: "lint" | "typecheck" | "format:check" | "test" | "build"
  body: string
  packageJsonSha256: string
}

export interface ResolvedCommandPlan {
  operationId: string
  taskId: string
  sourceWindowId: string
  intent: TerminalIntent
  executable: ExecutableIdentity
  argv: string[]
  cwd: {
    rootId: string
    relativePath: string
    realPath: string
  }
  projectScript?: ProjectScriptBinding
  effects: TerminalEffects
  sandbox: TerminalSandboxSpec
  limits: TerminalLimits
  risk: "R1" | "R3" | "R4"
  reason: string
  planDigest: string
  createdAt: number
  expiresAt: number
}

export type TerminalPolicyCode =
  | "user_denied"
  | "approval_expired"
  | "sandbox_unavailable"
  | "sandbox_denied_fs"
  | "sandbox_denied_network"
  | "plan_changed"
  | "script_changed"
  | "executable_changed"
  | "command_forbidden"
  | "timed_out"
  | "cancelled"
  | "output_limit_exceeded"

export interface TerminalPolicyFailure {
  code: TerminalPolicyCode
  policy_code: TerminalPolicyCode
  message: string
  retryable: boolean
  requiredAction?: "ask_user" | "change_approach" | "stop"
}

export interface TerminalRunRecord {
  runId: string
  operationId: string
  taskId: string
  intentKind: string
  intentAction?: string
  argv: string[]
  cwdRelative: string
  planDigest: string
  fingerprint: string
  status: OperationResult["status"]
  exitCode?: number | null
  policyCode?: TerminalPolicyCode
  durationMs: number
  outputBytes: number
  outputRedacted: string
  truncated: boolean
  startedAt: number
  finishedAt: number
}

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

export interface TrustedWorkspace {
  path: string
  name: string
  authorizedAt: number
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
  terminalPlan?: ResolvedCommandPlan
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
  display?: ApprovalDisplay
}

export interface ApprovalDisplay {
  riskBadge: {
    level: "R1" | "R3" | "R4"
    tier: TerminalSandboxTier
    label: string
  }
  pathPreview: {
    readRoots: string[]
    writeRoots: string[]
    protectedPaths: string[]
  }
  fingerprint: {
    words: [string, string, string]
  }
}

export interface ApprovalTokenBinding {
  token: string
  planDigest: string
  taskId: string
  operationId: string
  windowId: string
  expiresAt: number
  consumedAt?: number
}

export type OperationDecisionValue = "approve" | "deny" | "trust"

export interface OperationDecision {
  taskId: string
  operationId: string
  decision: OperationDecisionValue
  reason?: string
}

export interface TerminalTrustGrant {
  trustId: string
  kind: string
  action: string
  rootId: string
  sourceWindowId: string
  sessionId: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number
  useCount: number
  maxUses: number
  revokedAt?: number
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
  policyFailure?: TerminalPolicyFailure
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
  kind:
    | OperationKind
    | "capability.grant"
    | "capability.revoke"
    | "task.cancel"
    | "trusted_workspace.enable"
    | "trusted_workspace.disable"
    | "trusted_workspace.forget"
  risk?: RiskLevel
  targets: string[]
  status: string
  createdAt: number
  detail?: string
  planDigest?: string
  policyCode?: TerminalPolicyCode
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
    setDetailExpanded: (expanded: boolean) => Promise<void>
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
    openPath: (path: string, line?: number, column?: number) => Promise<boolean>
  }
  trustedWorkspace: {
    get: () => Promise<TrustedWorkspace | null>
    choose: () => Promise<TrustedWorkspace | null>
    disable: () => Promise<boolean>
    forget: () => Promise<boolean>
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
  terminalTrust: {
    list: () => Promise<TerminalTrustGrant[]>
    revokeAll: () => Promise<void>
  }
  terminalRuns: {
    list: (query?: string, limit?: number) => Promise<TerminalRunRecord[]>
    rerun: (runId: string) => Promise<{ taskId: string }>
    diff: (
      leftRunId: string,
      rightRunId: string,
    ) => Promise<{ left: string; right: string; different: boolean } | null>
  }
}
