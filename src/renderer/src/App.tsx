import { useCallback, useEffect, useRef, useState } from "react"
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
} from "react"
import petGentleImage from "../../assets/pet-gentle.png"
import petImage from "../../assets/pet.png"
import petHappyImage from "../../assets/pet-happy.png"
import petThinkingImage from "../../assets/pet-thinking.png"
import type {
  AppSettings,
  ApprovalRequest,
  AuditRecord,
  CapabilityGrant,
  Capability,
  ChatStreamEvent,
  ConversationDetail,
  ConversationSummary,
  OperationDecision,
  OperationResult,
  PetState,
  TaskState,
  TerminalRunRecord,
  TerminalTrustGrant,
  TrustedWorkspace,
  UserPreferences,
} from "../../shared/types.js"

type IconName = "arrow-left" | "check" | "close" | "info" | "send" | "settings" | "stop" | "tool"
type PetImageKey = "idle" | "happy" | "thinking" | "gentle"
type LocalMessageRole = "user" | "assistant" | "error"

interface LocalMessage {
  id: string
  role: LocalMessageRole
  content: string
}

interface PendingPermission {
  taskId: string
  capabilities: Capability[]
  scopeRoots: string[]
}

interface OperationLogEntry {
  id: string
  operationId: string
  taskId: string
  stream: "stdout" | "stderr"
  content: string
  truncatedSoFar: boolean
}

const LEGACY_STORAGE_KEY = "pingo:task-messages"
const TRUSTED_WORKSPACE_PROMPTED_KEY = "pingo:trusted-workspace-prompted"
const HAPPY_STATE_DURATION_MS = 1800
const POINTER_TAP_THRESHOLD_PX = 4

const PET_IMAGES: Record<PetImageKey, string> = {
  idle: petImage,
  happy: petHappyImage,
  thinking: petThinkingImage,
  gentle: petGentleImage,
}
const PET_IMAGE_ENTRIES = Object.entries(PET_IMAGES) as Array<[PetImageKey, string]>
const PET_STATE_CONFIG: Record<PetState, { image: PetImageKey; label: string }> = {
  idle: { image: "idle", label: "待机中" },
  happy: { image: "happy", label: "开心" },
  thinking: { image: "thinking", label: "思考中" },
  nod: { image: "gentle", label: "点头" },
  worried: { image: "thinking", label: "需要你确认" },
  encourage: { image: "happy", label: "鼓励" },
  sleepy: { image: "gentle", label: "困倦" },
  reminder: { image: "thinking", label: "等待授权" },
  focus: { image: "gentle", label: "专注陪伴" },
  celebrate: { image: "happy", label: "完成庆祝" },
}

const ICON_PATHS: Record<IconName, readonly string[]> = {
  "arrow-left": ["M19 12H5", "m12 19-7-7 7-7"],
  check: ["m5 12 4 4L19 6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  info: ["M12 16v-4", "M12 8h.01", "M21 12a9 9 0 1 1-18 0Z"],
  send: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"],
  settings: [
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.8.2l-.5.3a1.7 1.7 0 0 0-.9 1.5v.2h-4v-.2a1.7 1.7 0 0 0-.9-1.5l-.5-.3a1.7 1.7 0 0 0-1.8-.2l-.2.1-2-3.4.1-.1a1.7 1.7 0 0 0 .3-1.9l-.3-.5a1.7 1.7 0 0 0-1.5-.8H3v-4h.2a1.7 1.7 0 0 0 1.5-.8l.3-.5a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 1.8-.2l.5-.3a1.7 1.7 0 0 0 .9-1.5V2h4v.2a1.7 1.7 0 0 0 .9 1.5l.5.3a1.7 1.7 0 0 0 1.8.2l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.9l.3.5a1.7 1.7 0 0 0 1.5.8h.2v4h-.2a1.7 1.7 0 0 0-1.5.8Z",
  ],
  stop: ["M7 7h10v10H7z"],
  tool: [
    "M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2Z",
  ],
}

function Icon({ name }: { name: IconName }): ReactElement {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {ICON_PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

export function App(): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<UserPreferences | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState("")
  const [grants, setGrants] = useState<CapabilityGrant[]>([])
  const [terminalTrust, setTerminalTrust] = useState<TerminalTrustGrant[]>([])
  const [terminalRuns, setTerminalRuns] = useState<TerminalRunRecord[]>([])
  const [terminalRunQuery, setTerminalRunQuery] = useState("")
  const [terminalRunDiff, setTerminalRunDiff] = useState<{
    left: string
    right: string
    different: boolean
  } | null>(null)
  const [trustedWorkspace, setTrustedWorkspace] = useState<TrustedWorkspace | null>(null)
  const [trustedWorkspaceBusy, setTrustedWorkspaceBusy] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [auditRecords, setAuditRecords] = useState<AuditRecord[]>([])
  const [appearanceScale, setAppearanceScale] = useState(1)
  const [petState, setPetState] = useState<PetState>("idle")
  const [petStateRevision, setPetStateRevision] = useState(0)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [conversation, setConversation] = useState<ConversationDetail | null>(null)
  const [conversationSummaries, setConversationSummaries] = useState<ConversationSummary[]>([])
  const [draft, setDraft] = useState("")
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskState, setTaskState] = useState<TaskState | "ready">("ready")
  const [notice, setNotice] = useState("提出任务，Pingo 会在需要时先请求授权。")
  const [toolActivity, setToolActivity] = useState("")
  const [operationLogs, setOperationLogs] = useState<OperationLogEntry[]>([])
  const [logsPaused, setLogsPaused] = useState(false)
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest>>({})
  const [approvalReasons, setApprovalReasons] = useState<Record<string, string>>({})
  const [lastResult, setLastResult] = useState<OperationResult | null>(null)
  const [permissionBusy, setPermissionBusy] = useState(false)
  const [approvalNow, setApprovalNow] = useState(() => Date.now())
  const dragStart = useRef<{ x: number; y: number; pointerId: number; didDrag: boolean } | null>(
    null,
  )
  const assistantId = useRef<string | null>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const operationLogsEnd = useRef<HTMLDivElement>(null)
  const petStateTimer = useRef<number | null>(null)
  const currentPetState = PET_STATE_CONFIG[petState]
  const approvalList = Object.values(approvals)
  const taskIsActive = Boolean(taskId && !["completed", "failed", "cancelled"].includes(taskState))
  const canUndoContext = Boolean(
    conversation?.items.some(
      (item) =>
        item.kind === "context-cleared" &&
        item.contextEpochId === conversation.activeContextEpochId,
    ),
  )

  useEffect(() => {
    if (approvalList.length === 0) return
    const timer = window.setInterval(() => setApprovalNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [approvalList.length])

  useEffect(() => {
    let active = true
    void window.pingo.trustedWorkspace
      .get()
      .then((workspace) => {
        if (!active) return
        setTrustedWorkspace(workspace)
        if (!workspace && localStorage.getItem(TRUSTED_WORKSPACE_PROMPTED_KEY) !== "1") {
          setExpanded(true)
          setOnboardingOpen(true)
          void window.pingo.pet.setExpanded(true)
        }
      })
      .catch(() => {
        // Keep the normal task surface available if the first-run check fails.
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    for (const imageSource of new Set(Object.values(PET_IMAGES))) {
      const image = new window.Image()
      image.decoding = "async"
      image.src = imageSource
    }
  }, [])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    if (!logsPaused) operationLogsEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [logsPaused, operationLogs])

  useEffect(() => {
    return () => {
      if (petStateTimer.current !== null) window.clearTimeout(petStateTimer.current)
    }
  }, [])

  const showPetState = useCallback((nextState: PetState, durationMs?: number) => {
    if (petStateTimer.current !== null) window.clearTimeout(petStateTimer.current)
    setPetState(nextState)
    setPetStateRevision((current) => current + 1)
    if (durationMs && durationMs > 0 && nextState !== "idle") {
      petStateTimer.current = window.setTimeout(() => {
        setPetState("idle")
        setPetStateRevision((current) => current + 1)
        petStateTimer.current = null
      }, durationMs)
    }
  }, [])

  const applyConversation = useCallback((nextConversation: ConversationDetail) => {
    setConversation(nextConversation)
    setMessages(
      nextConversation.items
        .filter(
          (item) => item.kind === "message" && (item.role === "user" || item.role === "assistant"),
        )
        .map((item) => ({
          id: item.itemId,
          role: item.status === "error" ? "error" : item.role === "user" ? "user" : "assistant",
          content: item.content,
        })),
    )
    setConversationSummaries((current) => {
      const summary = {
        conversationId: nextConversation.conversationId,
        title: nextConversation.title,
        activeContextEpochId: nextConversation.activeContextEpochId,
        revision: nextConversation.revision,
        createdAt: nextConversation.createdAt,
        updatedAt: nextConversation.updatedAt,
        ...(nextConversation.archivedAt === undefined
          ? {}
          : { archivedAt: nextConversation.archivedAt }),
      }
      return [
        summary,
        ...current.filter((item) => item.conversationId !== summary.conversationId),
      ].sort((left, right) => right.updatedAt - left.updatedAt)
    })
  }, [])

  const refreshConversation = useCallback(
    async (conversationId?: string) => {
      const targetId = conversationId ?? conversation?.conversationId
      if (!targetId) return
      const nextConversation = await window.pingo.conversation.get(targetId)
      if (nextConversation) applyConversation(nextConversation)
    },
    [applyConversation, conversation?.conversationId],
  )

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const legacyMessages = loadLegacyMessages()
        const imported = legacyMessages.length
          ? await window.pingo.conversation.importLegacy(legacyMessages)
          : null
        if (imported && legacyMessages.length) localStorage.removeItem(LEGACY_STORAGE_KEY)
        const summaries = await window.pingo.conversation.list()
        if (!active) return
        setConversationSummaries(summaries)
        const initial =
          imported ??
          (summaries[0]
            ? await window.pingo.conversation.get(summaries[0].conversationId)
            : await window.pingo.conversation.create())
        if (initial && active) applyConversation(initial)
      } catch {
        if (active) setNotice("聊天记录读取失败；请重试或新建对话。")
      }
    })()
    return () => {
      active = false
    }
  }, [applyConversation])

  const openSettings = useCallback(async () => {
    setExpanded(true)
    setSettingsOpen(true)
    setSettingsBusy(true)
    setSettingsNotice("")
    void window.pingo.pet.setExpanded(true)
    try {
      const [current, currentGrants, currentTrust, currentAudit, currentRuns] = await Promise.all([
        window.pingo.settings.get(),
        window.pingo.capabilities.list(),
        window.pingo.terminalTrust.list(),
        window.pingo.audit.list(),
        window.pingo.terminalRuns.list(),
      ])
      const currentTrustedWorkspace = await window.pingo.trustedWorkspace.get()
      setSettings(current)
      setSettingsDraft(current)
      setGrants(currentGrants)
      setTerminalTrust(currentTrust)
      setTerminalRuns(currentRuns)
      setAuditRecords(currentAudit)
      setTrustedWorkspace(currentTrustedWorkspace)
    } catch {
      setSettingsNotice("设置读取失败，请重试。")
    } finally {
      setSettingsBusy(false)
    }
  }, [])

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const chooseTrustedWorkspace = useCallback(async () => {
    setTrustedWorkspaceBusy(true)
    try {
      const workspace = await window.pingo.trustedWorkspace.choose()
      if (workspace) {
        setTrustedWorkspace(workspace)
        setOnboardingOpen(false)
        localStorage.setItem(TRUSTED_WORKSPACE_PROMPTED_KEY, "1")
        setGrants(await window.pingo.capabilities.list())
        setSettingsNotice("已持续授权该目录，目录内文件操作不会重复询问。")
      }
    } catch {
      setSettingsNotice("目录授权失败，请重试。")
    } finally {
      setTrustedWorkspaceBusy(false)
    }
  }, [])

  const disableTrustedWorkspace = useCallback(async () => {
    setTrustedWorkspaceBusy(true)
    try {
      const disabled = await window.pingo.trustedWorkspace.disable()
      if (disabled) {
        setTrustedWorkspace(null)
        setGrants(await window.pingo.capabilities.list())
        setSettingsNotice("已关闭持续授权；目录记录仍保留。")
      }
    } catch {
      setSettingsNotice("关闭持续授权失败，请重试。")
    } finally {
      setTrustedWorkspaceBusy(false)
    }
  }, [])

  const forgetTrustedWorkspace = useCallback(async () => {
    setTrustedWorkspaceBusy(true)
    try {
      const forgotten = await window.pingo.trustedWorkspace.forget()
      if (forgotten) {
        setTrustedWorkspace(null)
        setGrants([])
        setSettingsNotice("已忘记目录；下次使用时需要重新选择。")
      }
    } catch {
      setSettingsNotice("忘记目录失败，请重试。")
    } finally {
      setTrustedWorkspaceBusy(false)
    }
  }, [])

  const handleTaskEvent = useCallback(
    (event: ChatStreamEvent) => {
      if (event.type === "start") {
        setNotice("Pingo 正在组织任务…")
        setTaskState("planning")
        showPetState("thinking")
        return
      }
      if (event.type === "operation-progress") {
        setOperationLogs((current) => [
          ...current,
          {
            id: `${event.operationId}-${event.seq}`,
            operationId: event.operationId,
            taskId: event.taskId,
            stream: event.stream,
            content: event.content,
            truncatedSoFar: event.truncatedSoFar,
          },
        ])
        return
      }
      if (event.type === "task-state") {
        setTaskState(event.state)
        if (event.state === "awaiting_permission") {
          setNotice("需要你授予目录能力")
          showPetState("reminder")
        } else if (event.state === "awaiting_confirmation") {
          setNotice("请检查操作预览并决定是否允许一次")
          showPetState("worried")
        } else if (event.state === "executing") {
          setNotice("正在执行已确认操作")
          showPetState("focus")
        } else if (event.state === "completed") {
          setNotice("任务完成")
          showPetState("nod", HAPPY_STATE_DURATION_MS)
          void refreshConversation()
        } else if (event.state === "cancelled") {
          setNotice("任务已取消")
          showPetState("idle")
          void refreshConversation()
        } else if (event.state === "failed") {
          setNotice("任务失败，请查看 Pingo 的说明")
          showPetState("worried")
          void refreshConversation()
        }
        return
      }
      if (event.type === "capability-request") {
        setTaskId(event.taskId)
        setPermission({
          taskId: event.taskId,
          capabilities: event.capabilities,
          scopeRoots: event.scopeRoots,
        })
        return
      }
      if (event.type === "approval-request") {
        setTaskId(event.request.taskId)
        setApprovals((current) => ({ ...current, [event.request.operationId]: event.request }))
        return
      }
      if (event.type === "operation-result") {
        setLastResult(event.result)
        setApprovals((current) => {
          const next = { ...current }
          delete next[event.result.operationId]
          return next
        })
        if (event.result.status !== "completed") setNotice(event.result.detail)
        return
      }
      if (event.type === "tool") {
        setToolActivity(event.detail)
        return
      }
      const currentAssistantId = assistantId.current
      if (event.type === "chunk" && currentAssistantId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === currentAssistantId
              ? { ...message, content: `${message.content}${event.content}` }
              : message,
          ),
        )
      } else if (event.type === "done") {
        assistantId.current = null
        setToolActivity("")
        void refreshConversation()
      } else if (event.type === "cancelled") {
        assistantId.current = null
        setTaskState("cancelled")
        setNotice("任务已取消")
        showPetState("idle")
        void refreshConversation()
      } else if (event.type === "error") {
        assistantId.current = null
        setTaskState("failed")
        setNotice(event.message)
        showPetState("worried")
        if (currentAssistantId) {
          setMessages((current) =>
            current.map((message) =>
              message.id === currentAssistantId
                ? { ...message, role: "error", content: event.message }
                : message,
            ),
          )
        }
        void refreshConversation()
      }
    },
    [refreshConversation, showPetState],
  )

  useEffect(() => {
    const removeWindowState = window.pingo.pet.onWindowState((state) => setExpanded(state.expanded))
    const removeSettings = window.pingo.pet.onSettingsRequest(() => void openSettings())
    const removeAppearance = window.pingo.pet.onAppearance((appearance) =>
      setAppearanceScale(appearance.scale),
    )
    const removePetState = window.pingo.pet.onStateChange((event) =>
      showPetState(event.state, event.durationMs),
    )
    const removeTask = window.pingo.task.onEvent(handleTaskEvent)
    return () => {
      removeWindowState()
      removeSettings()
      removeAppearance()
      removePetState()
      removeTask()
    }
  }, [handleTaskEvent, openSettings, showPetState])

  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = {
      x: event.screenX,
      y: event.screenY,
      pointerId: event.pointerId,
      didDrag: false,
    }
    window.pingo.pet.dragStart(event.screenX, event.screenY)
  }, [])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = dragStart.current
    if (!session || session.pointerId !== event.pointerId) return
    if (Math.hypot(event.screenX - session.x, event.screenY - session.y) > POINTER_TAP_THRESHOLD_PX)
      session.didDrag = true
    if (session.didDrag) window.pingo.pet.dragMove(event.screenX, event.screenY)
  }, [])

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const session = dragStart.current
      if (!session || session.pointerId !== event.pointerId) return
      dragStart.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId)
      window.pingo.pet.dragEnd()
      if (
        !session.didDrag &&
        Math.hypot(event.screenX - session.x, event.screenY - session.y) <= POINTER_TAP_THRESHOLD_PX
      ) {
        const nextExpanded = !expanded
        setExpanded(nextExpanded)
        void window.pingo.pet.setExpanded(nextExpanded)
        if (!nextExpanded) showPetState("happy", HAPPY_STATE_DURATION_MS)
      }
    },
    [expanded, showPetState],
  )

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current || dragStart.current.pointerId !== event.pointerId) return
    dragStart.current = null
    window.pingo.pet.dragEnd()
  }, [])

  const handleContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    window.pingo.pet.showContextMenu()
  }, [])

  const stopTask = useCallback(() => {
    if (taskId) window.pingo.task.cancel(taskId)
    assistantId.current = null
    setApprovals({})
    setPermission(null)
    setNotice("正在取消，等待终端进程真正结束…")
  }, [taskId])

  const createConversation = useCallback(async () => {
    if (taskId && !["completed", "failed", "cancelled"].includes(taskState)) return
    try {
      const nextConversation = await window.pingo.conversation.create()
      assistantId.current = null
      setTaskId(null)
      setTaskState("ready")
      setNotice("已新建对话。")
      setToolActivity("")
      setOperationLogs([])
      setLogsPaused(false)
      setPermission(null)
      setApprovals({})
      setLastResult(null)
      applyConversation(nextConversation)
    } catch {
      setNotice("新建对话失败，请重试。")
    }
  }, [applyConversation, taskId, taskState])

  const switchConversation = useCallback(
    async (conversationId: string) => {
      if (conversationId === conversation?.conversationId) return
      if (taskId && !["completed", "failed", "cancelled"].includes(taskState)) {
        setNotice("请先结束当前任务，再切换对话。")
        return
      }
      try {
        const nextConversation = await window.pingo.conversation.get(conversationId)
        if (nextConversation) {
          assistantId.current = null
          setTaskId(null)
          setTaskState("ready")
          setPermission(null)
          setApprovals({})
          setLastResult(null)
          setOperationLogs([])
          setLogsPaused(false)
          applyConversation(nextConversation)
        }
      } catch {
        setNotice("切换对话失败，请重试。")
      }
    },
    [applyConversation, conversation?.conversationId, taskId, taskState],
  )

  const clearConversationContext = useCallback(async () => {
    if (!conversation) return
    if (taskId && !["completed", "failed", "cancelled"].includes(taskState)) {
      setNotice("请先取消并等待当前任务结束，再清空上下文。")
      return
    }
    if (!window.confirm("清空后续模型上下文？历史记录会保留，之后的回答不会再引用此前对话。"))
      return
    try {
      const nextConversation = await window.pingo.conversation.clearContext({
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
      })
      applyConversation(nextConversation)
      setNotice("已清空上下文。可在发送下一条消息前撤销。")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "清空上下文失败，请重试。")
    }
  }, [applyConversation, conversation, taskId, taskState])

  const undoClearConversationContext = useCallback(async () => {
    if (!conversation) return
    try {
      const nextConversation = await window.pingo.conversation.undoClearContext(
        conversation.conversationId,
      )
      if (!nextConversation) {
        setNotice("此操作已不能撤销。")
        return
      }
      applyConversation(nextConversation)
      setNotice("已恢复先前上下文。")
    } catch {
      setNotice("恢复上下文失败，请重试。")
    }
  }, [applyConversation, conversation])

  const submitTask = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault()
      const content = draft.trim()
      if (
        !content ||
        (taskState !== "ready" && !["completed", "failed", "cancelled"].includes(taskState))
      )
        return
      if (!conversation) return
      setDraft("")
      setApprovals({})
      setPermission(null)
      setLastResult(null)
      setOperationLogs([])
      setLogsPaused(false)
      setTaskState("proposed")
      setNotice("正在提交任务…")
      try {
        const response = await window.pingo.conversation.submit({
          conversationId: conversation.conversationId,
          clientRequestId: crypto.randomUUID(),
          expectedRevision: conversation.revision,
          expectedContextEpochId: conversation.activeContextEpochId,
          content,
        })
        applyConversation(response.conversation)
        const nextAssistant = response.conversation.items
          .filter((item) => item.kind === "message" && item.role === "assistant")
          .at(-1)
        assistantId.current = nextAssistant?.itemId ?? null
        setTaskId(response.taskId)
      } catch (error) {
        assistantId.current = null
        setTaskState("failed")
        setNotice(error instanceof Error ? error.message : "任务提交失败，请重试。")
      }
    },
    [applyConversation, conversation, draft, taskState],
  )

  const handleDraftKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void submitTask()
      }
    },
    [submitTask],
  )

  const grantPermission = useCallback(async () => {
    if (!permission) return
    setPermissionBusy(true)
    try {
      const grant = await window.pingo.task.grant({
        taskId: permission.taskId,
        capabilities: permission.capabilities,
        duration: "session",
      })
      if (!grant) setNotice("未授予权限，操作不会执行。")
      setPermission(null)
    } catch {
      setNotice("权限申请失败，操作不会执行。")
    } finally {
      setPermissionBusy(false)
    }
  }, [permission])

  const denyPermission = useCallback(async () => {
    if (!permission) return
    await window.pingo.task.deny(permission.taskId)
    setPermission(null)
    setNotice("已拒绝权限，操作不会执行。")
  }, [permission])

  const decideApproval = useCallback(
    async (approval: ApprovalRequest, decision: OperationDecision["decision"]) => {
      const reason = approvalReasons[approval.operationId]?.trim()
      await window.pingo.task.decide({
        taskId: approval.taskId,
        operationId: approval.operationId,
        decision,
        ...(reason ? { reason } : {}),
      })
      setApprovals((current) => {
        const next = { ...current }
        delete next[approval.operationId]
        return next
      })
      setApprovalReasons((current) => {
        const next = { ...current }
        delete next[approval.operationId]
        return next
      })
    },
    [approvalReasons],
  )

  const copyApprovalCommand = useCallback(async (request: ApprovalRequest) => {
    const terminalPlan = request.plan.terminalPlan
    const command = terminalPlan
      ? formatDisplayCommand(terminalPlan.executable.displayName, terminalPlan.argv)
      : request.plan.preview
    try {
      await navigator.clipboard.writeText(command)
      setNotice("已复制真实命令（不会执行）")
    } catch {
      setNotice("复制失败，请手动选择预览中的命令")
    }
  }, [])

  const copyOperationLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(operationLogs.map((entry) => entry.content).join(""))
      setNotice("已复制终端日志")
    } catch {
      setNotice("日志复制失败，请重试")
    }
  }, [operationLogs])

  const openLogLocation = useCallback(async (path: string, line: number, column?: number) => {
    try {
      await window.pingo.project.openPath(path, line, column)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "文件路径不在授权目录内")
    }
  }, [])

  const undoLast = useCallback(async () => {
    if (!lastResult?.undoId || !taskId) return
    await window.pingo.task.undo(taskId, lastResult.undoId)
    setLastResult(null)
  }, [lastResult, taskId])

  const saveSettings = useCallback(async () => {
    if (!settingsDraft) return
    setSettingsBusy(true)
    setSettingsNotice("")
    try {
      const saved = await window.pingo.settings.update(settingsDraft)
      setSettings(saved)
      setSettingsDraft(saved)
      setSettingsNotice("设置已保存")
    } catch {
      setSettingsNotice("设置无效或保存失败，请检查输入。")
    } finally {
      setSettingsBusy(false)
    }
  }, [settingsDraft])

  const revokeGrant = useCallback(async (grantId: string) => {
    await window.pingo.capabilities.revoke(grantId)
    setGrants(await window.pingo.capabilities.list())
    setSettingsNotice("授权已撤销，关联任务已停止。")
  }, [])

  const revokeAllTerminalTrust = useCallback(async () => {
    await window.pingo.terminalTrust.revokeAll()
    setTerminalTrust([])
    setSettingsNotice("已撤销所有 Terminal 同类信任，后续会恢复逐次确认。")
  }, [])

  const searchTerminalRuns = useCallback(async (query: string) => {
    setTerminalRunQuery(query)
    setTerminalRuns(await window.pingo.terminalRuns.list(query))
  }, [])

  const rerunTerminalRun = useCallback(async (runId: string) => {
    try {
      await window.pingo.terminalRuns.rerun(runId)
      setSettingsOpen(false)
      setExpanded(true)
      setNotice("历史命令已重新提交，请检查新的确认卡")
    } catch (error) {
      setSettingsNotice(error instanceof Error ? error.message : "历史命令重跑失败")
    }
  }, [])

  const diffTerminalRuns = useCallback(async (leftRunId: string, rightRunId: string) => {
    setTerminalRunDiff(await window.pingo.terminalRuns.diff(leftRunId, rightRunId))
  }, [])

  return (
    <main
      className={`app-shell ${expanded ? "expanded" : "collapsed"}`}
      style={{ "--pet-scale": appearanceScale } as CSSProperties}
    >
      {expanded && (
        <section className="task-panel" aria-label="Pingo 任务面板">
          <header className="task-header">
            <div className={`panel-status panel-status--${taskState}`} role="status">
              <Icon
                name={
                  settingsOpen
                    ? "settings"
                    : approvalList.length > 0 || permission
                      ? "info"
                      : taskState === "executing"
                        ? "tool"
                        : "send"
                }
              />
            </div>
            <div className="task-header-title">
              <strong>{settingsOpen ? "设置" : "Pingo 任务"}</strong>
              <span>{settingsOpen ? "本地配置" : formatTaskState(taskState)}</span>
            </div>
            <div className="header-actions">
              {settingsOpen ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="返回任务"
                  title="返回"
                  onClick={closeSettings}
                >
                  <Icon name="arrow-left" />
                </button>
              ) : (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="打开设置"
                  title="设置"
                  onClick={() => void openSettings()}
                >
                  <Icon name="settings" />
                </button>
              )}
              <button
                className="icon-button"
                type="button"
                aria-label="收起任务面板"
                title="收起"
                onClick={() => {
                  setExpanded(false)
                  void window.pingo.pet.setExpanded(false)
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          </header>

          {settingsOpen ? (
            <SettingsView
              settings={settings}
              draft={settingsDraft}
              busy={settingsBusy}
              notice={settingsNotice}
              grants={grants}
              auditRecords={auditRecords}
              terminalTrust={terminalTrust}
              terminalRuns={terminalRuns}
              terminalRunQuery={terminalRunQuery}
              terminalRunDiff={terminalRunDiff}
              trustedWorkspace={trustedWorkspace}
              trustedWorkspaceBusy={trustedWorkspaceBusy}
              setDraft={setSettingsDraft}
              save={saveSettings}
              chooseTrustedWorkspace={chooseTrustedWorkspace}
              disableTrustedWorkspace={disableTrustedWorkspace}
              forgetTrustedWorkspace={forgetTrustedWorkspace}
              revokeGrant={revokeGrant}
              revokeAllTerminalTrust={revokeAllTerminalTrust}
              searchTerminalRuns={searchTerminalRuns}
              rerunTerminalRun={rerunTerminalRun}
              diffTerminalRuns={diffTerminalRuns}
            />
          ) : (
            <>
              <div className="conversation-actions" aria-label="对话操作">
                <select
                  aria-label="选择历史对话"
                  value={conversation?.conversationId ?? ""}
                  disabled={taskIsActive}
                  onChange={(event) => void switchConversation(event.target.value)}
                >
                  {conversationSummaries.map((item) => (
                    <option key={item.conversationId} value={item.conversationId}>
                      {item.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={taskIsActive}
                  onClick={() => void createConversation()}
                >
                  新建
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={!conversation || taskIsActive}
                  onClick={() => void clearConversationContext()}
                >
                  清空上下文
                </button>
                {canUndoContext && (
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void undoClearConversationContext()}
                  >
                    撤销清空
                  </button>
                )}
              </div>
              {onboardingOpen && (
                <div
                  className="action-card permission-card"
                  role="dialog"
                  aria-label="持续目录授权"
                >
                  <strong>选择目录并持续授权</strong>
                  <p>
                    授权后，Pingo 可以在所选目录内自动读取、创建、修改、移动文件或将文件移入废纸篓，
                    不再重复询问。目录外访问、Terminal、项目脚本和系统自动化仍不会被放开。
                  </p>
                  <div className="action-buttons">
                    <button
                      type="button"
                      disabled={trustedWorkspaceBusy}
                      onClick={() => void chooseTrustedWorkspace()}
                    >
                      选择目录并授权
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={trustedWorkspaceBusy}
                      onClick={() => {
                        localStorage.setItem(TRUSTED_WORKSPACE_PROMPTED_KEY, "1")
                        setOnboardingOpen(false)
                      }}
                    >
                      暂不授权
                    </button>
                  </div>
                </div>
              )}
              <div className="message-list" aria-live="polite">
                {messages.map((message) => (
                  <article key={message.id} className={`message message--${message.role}`}>
                    <p>{message.content || (message.id === assistantId.current ? "…" : "")}</p>
                  </article>
                ))}
                <div ref={messagesEnd} />
              </div>
              {operationLogs.length > 0 && (
                <section className="operation-log-card" aria-label="终端实时日志">
                  <div className="operation-log-header">
                    <strong>
                      终端实时日志
                      {operationLogs.some((entry) => entry.truncatedSoFar) && " · 中间输出已折叠"}
                    </strong>
                    <div className="operation-log-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setLogsPaused((current) => !current)}
                      >
                        {logsPaused ? "继续滚动" : "暂停滚动"}
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void copyOperationLogs()}
                      >
                        复制
                      </button>
                    </div>
                  </div>
                  <div className="operation-log" aria-live="polite">
                    {operationLogs.map((entry) => (
                      <div
                        className={`operation-log-line operation-log-line--${entry.stream}`}
                        key={entry.id}
                      >
                        <span className="operation-log-stream">
                          {entry.stream === "stdout" ? "out" : "err"}
                        </span>
                        <AnsiLogText text={entry.content} onOpenPath={openLogLocation} />
                      </div>
                    ))}
                    <div ref={operationLogsEnd} />
                  </div>
                </section>
              )}
              {lastResult?.content && (
                <section className="operation-result-card" aria-label="操作结果">
                  <strong>操作结果</strong>
                  <pre>{lastResult.content}</pre>
                </section>
              )}
              {permission && (
                <div
                  className="action-card permission-card"
                  role="dialog"
                  aria-label="请求目录权限"
                >
                  <strong>先授权，Pingo 才能访问电脑</strong>
                  <p>
                    能力：{permission.capabilities.join("、")}
                    <br />
                    范围：{permission.scopeRoots[0] || "需要选择一个目录"}
                    <br />
                    本次授权只持续当前会话，可随时撤销。
                  </p>
                  <div className="action-buttons">
                    <button
                      type="button"
                      disabled={permissionBusy}
                      onClick={() => void grantPermission()}
                    >
                      授权本次会话
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={permissionBusy}
                      onClick={() => void denyPermission()}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              )}
              {approvalList.map((approval) => {
                const terminalPlan = approval.plan.terminalPlan
                const remainingMs = Math.max(0, approval.expiresAt - approvalNow)
                const remainingSeconds = Math.ceil(remainingMs / 1_000)
                const expired = remainingMs === 0
                return (
                  <div
                    key={approval.operationId}
                    className="action-card approval-card"
                    role="dialog"
                    aria-label={`操作确认 ${approval.operationId}`}
                  >
                    <strong>
                      {approval.plan.risk} ·{" "}
                      {terminalPlan ? "Terminal operation" : approval.plan.kind}
                    </strong>
                    <p className="risk-reason">{approval.plan.riskReason}</p>
                    {terminalPlan ? (
                      <>
                        <div className="approval-command">
                          <span>真实命令</span>
                          <code>
                            {formatDisplayCommand(
                              terminalPlan.executable.displayName,
                              terminalPlan.argv,
                            )}
                          </code>
                        </div>
                        <div className="approval-facts">
                          <span>工作目录：{terminalPlan.cwd.relativePath || "."}</span>
                          <span>
                            代码执行：{terminalPlan.effects.projectCodeExecution ? "是" : "否"}
                          </span>
                          <span>文件范围：workspace {terminalPlan.effects.workspace}</span>
                          <span>沙箱档位：{terminalPlan.sandbox.tier}</span>
                          <span>网络：关闭（公网、localhost、私网、Unix socket）</span>
                          <span>HOME/密钥/目录外：不可用</span>
                          <span>
                            限制：{terminalPlan.limits.timeoutMs / 1_000}s · 输出{" "}
                            {terminalPlan.limits.outputBytes} bytes · 可撤销：否
                          </span>
                        </div>
                        {terminalPlan.projectScript && (
                          <div className="approval-script">
                            <span>
                              脚本：{terminalPlan.projectScript.name} · 来源：
                              {terminalPlan.projectScript.packageJsonRelativePath}
                            </span>
                            <code>{terminalPlan.projectScript.body}</code>
                            <small>
                              package.json SHA-256：{terminalPlan.projectScript.packageJsonSha256}
                            </small>
                          </div>
                        )}
                      </>
                    ) : (
                      <pre>{approval.plan.preview}</pre>
                    )}
                    <p>
                      一次性 token · 计划摘要{" "}
                      {(terminalPlan?.planDigest ?? approval.plan.digest).slice(0, 12)}… ·{" "}
                      {expired ? "已过期，请重新规划" : `${remainingSeconds}s 后过期`}
                    </p>
                    {approval.display && (
                      <div className="approval-impact">
                        <span>
                          人类指纹：{approval.display.fingerprint.words.join(" · ")} · 沙箱：
                          {approval.display.riskBadge.label}
                        </span>
                        <span>
                          读取根：{approval.display.pathPreview.readRoots.join("、") || "无"}
                        </span>
                        <span>
                          写入根：{approval.display.pathPreview.writeRoots.join("、") || "无"}
                        </span>
                      </div>
                    )}
                    <label className="approval-reason">
                      <span>拒绝理由（可选）</span>
                      <input
                        value={approvalReasons[approval.operationId] ?? ""}
                        maxLength={240}
                        placeholder="例如：范围太大，改为只检查一个文件"
                        onChange={(event) =>
                          setApprovalReasons((current) => ({
                            ...current,
                            [approval.operationId]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="action-buttons">
                      <button
                        type="button"
                        disabled={expired}
                        onClick={() => void decideApproval(approval, "approve")}
                      >
                        运行一次
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={expired}
                        onClick={() => void decideApproval(approval, "deny")}
                      >
                        拒绝
                      </button>
                      {terminalPlan?.sandbox.tier === "read-only" && terminalPlan.risk === "R1" && (
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={expired}
                          onClick={() => void decideApproval(approval, "trust")}
                        >
                          本会话允许同类
                        </button>
                      )}
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void copyApprovalCommand(approval)}
                      >
                        复制命令
                      </button>
                    </div>
                  </div>
                )
              })}
              {lastResult?.undoId && lastResult.status === "completed" && (
                <div className="result-actions">
                  <span>这项文件操作可以撤销。</span>
                  <button type="button" onClick={() => void undoLast()}>
                    撤销
                  </button>
                </div>
              )}
              <form className="composer" onSubmit={(event) => void submitTask(event)}>
                <div className="composer-shell">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleDraftKeyDown}
                    disabled={
                      Boolean(approvalList.length > 0 || permission || onboardingOpen) ||
                      taskState === "executing" ||
                      taskState === "planning"
                    }
                    placeholder="告诉 Pingo 要做什么…"
                    rows={2}
                  />
                  <div className="composer-footer">
                    <span>{toolActivity || notice}</span>
                    {taskState === "planning" ||
                    taskState === "executing" ||
                    taskState === "awaiting_permission" ||
                    taskState === "awaiting_confirmation" ? (
                      <button
                        className="icon-button icon-button--stop"
                        type="button"
                        aria-label="取消任务"
                        title="取消"
                        onClick={stopTask}
                      >
                        <Icon name="stop" />
                      </button>
                    ) : (
                      <button
                        className="icon-button icon-button--primary"
                        type="submit"
                        aria-label="提交任务"
                        title="提交"
                        disabled={!draft.trim()}
                      >
                        <Icon name="send" />
                      </button>
                    )}
                  </div>
                </div>
              </form>
            </>
          )}
        </section>
      )}

      <div className="pet-dock">
        <button
          className={`pet-button pet-state-${petState}`}
          type="button"
          aria-label={`Pingo 桌面宠物，当前${currentPetState.label}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
        >
          <span
            key={`${petState}-${petStateRevision}`}
            className={`pet-visual pet-motion--${petState}`}
            aria-hidden="true"
          >
            <span className="pet-face-slot">
              {PET_IMAGE_ENTRIES.map(([imageKey, imageSource]) => (
                <img
                  key={imageKey}
                  className={`pet-face pet-face--${imageKey} ${currentPetState.image === imageKey ? "pet-face--active" : ""}`}
                  src={imageSource}
                  alt=""
                  draggable={false}
                  decoding="async"
                />
              ))}
            </span>
          </span>
          <span className="pet-state" aria-hidden="true">
            {currentPetState.label}
          </span>
        </button>
      </div>
    </main>
  )
}

interface AnsiStyle {
  bold: boolean
  color?: string
}

const ANSI_COLORS: Record<number, string> = {
  30: "#4b5563",
  31: "#dc2626",
  32: "#16a34a",
  33: "#ca8a04",
  34: "#2563eb",
  35: "#9333ea",
  36: "#0891b2",
  37: "#374151",
}

function AnsiLogText({
  text,
  onOpenPath,
}: {
  text: string
  onOpenPath: (path: string, line: number, column?: number) => Promise<void>
}): ReactElement {
  const segments = parseAnsiSegments(text)
  return (
    <span className="operation-log-content">
      {segments.map((segment, index) => (
        <span
          key={`${segment.text}-${index}`}
          style={{ color: segment.style.color, fontWeight: segment.style.bold ? 700 : 400 }}
        >
          {renderLogLocations(segment.text, onOpenPath, `${index}`)}
        </span>
      ))}
    </span>
  )
}

function parseAnsiSegments(text: string): Array<{ text: string; style: AnsiStyle }> {
  const escape = String.fromCharCode(27)
  const bell = String.fromCharCode(7)
  const sanitized = text
    .replace(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "g"), "")
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), (sequence) =>
      sequence.endsWith("m") ? sequence : "",
    )
  const pattern = new RegExp(`${escape}\\[([0-9;]*)m`, "g")
  const segments: Array<{ text: string; style: AnsiStyle }> = []
  let style: AnsiStyle = { bold: false }
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sanitized))) {
    const currentMatch = match
    if (currentMatch.index > cursor)
      segments.push({ text: sanitized.slice(cursor, currentMatch.index), style })
    style = applyAnsiCodes(style, currentMatch[1] ?? "0")
    cursor = pattern.lastIndex
  }
  if (cursor < sanitized.length) segments.push({ text: sanitized.slice(cursor), style })
  return segments
}

function applyAnsiCodes(style: AnsiStyle, codes: string): AnsiStyle {
  let next = { ...style }
  for (const rawCode of codes.split(";")) {
    const code = Number(rawCode || 0)
    if (code === 0) next = { bold: false }
    else if (code === 1) next.bold = true
    else if (code === 22) next.bold = false
    else if (code === 39) delete next.color
    else if (ANSI_COLORS[code]) next.color = ANSI_COLORS[code]
  }
  return next
}

function renderLogLocations(
  text: string,
  onOpenPath: (path: string, line: number, column?: number) => Promise<void>,
  keyPrefix: string,
): ReactNode {
  const pattern = /((?:\/|\.\/|(?:[\w.-]+\/)+)[^\s():]+):(\d+)(?::(\d+))?/g
  const parts: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const currentMatch = match
    const path = (currentMatch[1] ?? "").replace(/[),.;]+$/, "")
    if (!path) continue
    const matchStart = currentMatch.index
    const matchText = currentMatch[0]
    const line = Number(currentMatch[2])
    const column = currentMatch[3] === undefined ? undefined : Number(currentMatch[3])
    const pathLength = path.length
    if (matchStart > cursor) parts.push(text.slice(cursor, matchStart))
    parts.push(
      <button
        className="operation-log-link"
        key={`${keyPrefix}-${matchStart}`}
        type="button"
        onClick={() => void onOpenPath(path, line, column)}
      >
        {matchText.slice(0, pathLength)}
      </button>,
    )
    if (matchText.length > pathLength) parts.push(matchText.slice(pathLength))
    cursor = matchStart + matchText.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length ? parts : text
}

function SettingsView({
  settings,
  draft,
  busy,
  notice,
  grants,
  auditRecords,
  terminalTrust,
  terminalRuns,
  terminalRunQuery,
  terminalRunDiff,
  trustedWorkspace,
  trustedWorkspaceBusy,
  setDraft,
  save,
  chooseTrustedWorkspace,
  disableTrustedWorkspace,
  forgetTrustedWorkspace,
  revokeGrant,
  revokeAllTerminalTrust,
  searchTerminalRuns,
  rerunTerminalRun,
  diffTerminalRuns,
}: {
  settings: AppSettings | null
  draft: UserPreferences | null
  busy: boolean
  notice: string
  grants: CapabilityGrant[]
  auditRecords: AuditRecord[]
  terminalTrust: TerminalTrustGrant[]
  terminalRuns: TerminalRunRecord[]
  terminalRunQuery: string
  terminalRunDiff: { left: string; right: string; different: boolean } | null
  trustedWorkspace: TrustedWorkspace | null
  trustedWorkspaceBusy: boolean
  setDraft: React.Dispatch<React.SetStateAction<UserPreferences | null>>
  save: () => Promise<void>
  chooseTrustedWorkspace: () => Promise<void>
  disableTrustedWorkspace: () => Promise<void>
  forgetTrustedWorkspace: () => Promise<void>
  revokeGrant: (grantId: string) => Promise<void>
  revokeAllTerminalTrust: () => Promise<void>
  searchTerminalRuns: (query: string) => Promise<void>
  rerunTerminalRun: (runId: string) => Promise<void>
  diffTerminalRuns: (leftRunId: string, rightRunId: string) => Promise<void>
}): ReactElement {
  if (!draft)
    return (
      <div className="settings-loading" role="status">
        <span className="loading-ring" />
      </div>
    )
  return (
    <div className="settings-view">
      <div className="settings-form">
        <label>
          <span>模型接口</span>
          <input
            value={draft.modelBaseUrl}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, modelBaseUrl: event.target.value } : current,
              )
            }
          />
        </label>
        <label>
          <span>模型名称</span>
          <input
            value={draft.modelName}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, modelName: event.target.value } : current,
              )
            }
          />
        </label>
        <label>
          <span>默认城市</span>
          <input
            value={draft.defaultLocation}
            disabled={busy}
            placeholder="例如：上海"
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, defaultLocation: event.target.value } : current,
              )
            }
          />
        </label>
        <div className="settings-readonly">
          <div>
            <span>API Key</span>
            <strong>{settings?.apiKeyConfigured ? "已配置" : "未配置"}</strong>
          </div>
          <span className="info-icon" role="img" aria-label="API Key 仅由主进程读取。">
            <Icon name="info" />
          </span>
        </div>
        <div className="settings-section">
          <strong>持续目录授权</strong>
          {trustedWorkspace ? (
            <>
              <span>已授权目录：{trustedWorkspace.path}</span>
              <span>目录内结构化文件操作不会重复询问；Terminal 不包含在内。</span>
              <div className="grant-row">
                <button
                  type="button"
                  disabled={trustedWorkspaceBusy}
                  onClick={() => void disableTrustedWorkspace()}
                >
                  关闭持续授权
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={trustedWorkspaceBusy}
                  onClick={() => void forgetTrustedWorkspace()}
                >
                  忘记目录
                </button>
              </div>
            </>
          ) : (
            <>
              <span>未开启。授权后，所选目录内的文件操作不会重复询问。</span>
              <button
                type="button"
                disabled={trustedWorkspaceBusy}
                onClick={() => void chooseTrustedWorkspace()}
              >
                选择目录并授权
              </button>
            </>
          )}
        </div>
        <div className="settings-section">
          <strong>当前能力授权</strong>
          {grants.length === 0 ? (
            <span>没有活动授权</span>
          ) : (
            grants.map((grant) => (
              <div className="grant-row" key={grant.grantId}>
                <span>
                  {grant.capabilities.join("、")} · {grant.scopeRoots[0]}
                </span>
                <button type="button" onClick={() => void revokeGrant(grant.grantId)}>
                  撤销
                </button>
              </div>
            ))
          )}
        </div>
        <div className="settings-section">
          <strong>Terminal 同类信任</strong>
          {terminalTrust.length === 0 ? (
            <span>没有已积累的只读信任</span>
          ) : (
            <>
              {terminalTrust.map((grant) => (
                <span className="audit-row" key={grant.trustId}>
                  {grant.kind}/{grant.action || "*"} · 已用 {grant.useCount}/{grant.maxUses} ·{" "}
                  {Math.max(0, Math.ceil((grant.expiresAt - Date.now()) / 60_000))} 分钟后失效
                </span>
              ))}
              <button type="button" onClick={() => void revokeAllTerminalTrust()}>
                一键撤销全部 Terminal 信任
              </button>
            </>
          )}
        </div>
        <div className="settings-section">
          <strong>操作历史</strong>
          {auditRecords.length === 0 ? (
            <span>暂无记录</span>
          ) : (
            auditRecords
              .slice(-5)
              .reverse()
              .map((record) => (
                <span className="audit-row" key={record.auditId}>
                  {record.kind} · {record.status} ·{" "}
                  {new Date(record.createdAt).toLocaleTimeString()}
                </span>
              ))
          )}
        </div>
        <div className="settings-section">
          <strong>Terminal 运行台账</strong>
          <input
            value={terminalRunQuery}
            placeholder="按意图、状态或输出搜索"
            onChange={(event) => void searchTerminalRuns(event.target.value)}
          />
          {terminalRuns.length === 0 ? (
            <span>暂无匹配的终端运行记录</span>
          ) : (
            terminalRuns.slice(0, 8).map((run) => {
              const comparison = terminalRuns.find(
                (candidate) =>
                  candidate.runId !== run.runId && candidate.planDigest === run.planDigest,
              )
              return (
                <div className="terminal-run-row" key={run.runId}>
                  <span>
                    {run.intentKind}/{run.intentAction || "*"} · {run.status} · {run.fingerprint}
                  </span>
                  <small>
                    {new Date(run.finishedAt).toLocaleString()} · {run.outputBytes} bytes
                    {run.truncated ? " · 已截断" : ""}
                  </small>
                  <code>{run.outputRedacted.slice(0, 240)}</code>
                  <div className="grant-row">
                    <button type="button" onClick={() => void rerunTerminalRun(run.runId)}>
                      重跑（重新确认）
                    </button>
                    {comparison && (
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void diffTerminalRuns(run.runId, comparison.runId)}
                      >
                        对比同计划
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
          {terminalRunDiff && (
            <pre className="terminal-run-diff">
              {terminalRunDiff.different ? "两次输出不同" : "两次输出相同"}
              {"\n\n本次：\n"}
              {terminalRunDiff.left}
              {"\n\n对比：\n"}
              {terminalRunDiff.right}
            </pre>
          )}
        </div>
        <label className="range-setting">
          <span>
            宠物大小 <strong>{draft.petScale.toFixed(1)}×</strong>
          </span>
          <input
            type="range"
            min="0.7"
            max="1.4"
            step="0.1"
            value={draft.petScale}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, petScale: Number(event.target.value) } : current,
              )
            }
          />
        </label>
        <label className="range-setting">
          <span>
            透明度 <strong>{Math.round(draft.transparency * 100)}%</strong>
          </span>
          <input
            type="range"
            min="0.5"
            max="1"
            step="0.05"
            value={draft.transparency}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, transparency: Number(event.target.value) } : current,
              )
            }
          />
        </label>
        <label className="checkbox-setting">
          <input
            type="checkbox"
            checked={draft.launchAtLogin}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, launchAtLogin: event.target.checked } : current,
              )
            }
          />
          <span>登录 macOS 后自动启动</span>
        </label>
        <div className="settings-actions">
          <button
            className="icon-button icon-button--primary"
            type="button"
            disabled={busy}
            aria-label="保存设置"
            title="保存"
            onClick={() => void save()}
          >
            <Icon name="check" />
          </button>
        </div>
        {notice && <p className="settings-notice">{notice}</p>}
      </div>
    </div>
  )
}

function loadLegacyMessages(): LocalMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]")
    if (!Array.isArray(value)) return []
    return value.filter(isLocalMessage).slice(-200)
  } catch {
    return []
  }
}

function isLocalMessage(value: unknown): value is LocalMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<LocalMessage>
  return (
    typeof message.id === "string" &&
    ["user", "assistant", "error"].includes(message.role ?? "") &&
    typeof message.content === "string"
  )
}

function formatDisplayCommand(executable: string, argv: string[]): string {
  return [executable, ...argv]
    .map((value) => (/^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ")
}

function formatTaskState(state: TaskState | "ready"): string {
  const labels: Record<TaskState | "ready", string> = {
    ready: "等待输入",
    proposed: "已提出",
    awaiting_permission: "等待授权",
    planning: "规划中",
    awaiting_confirmation: "等待确认",
    executing: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }
  return labels[state]
}
