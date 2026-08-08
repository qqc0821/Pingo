import { useCallback, useEffect, useRef, useState } from "react"
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
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
  ChatMessageInput,
  ChatStreamEvent,
  OperationDecision,
  OperationResult,
  PetState,
  TaskState,
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

const STORAGE_KEY = "pingo:task-messages"
const TRUSTED_WORKSPACE_PROMPTED_KEY = "pingo:trusted-workspace-prompted"
const MAX_MESSAGES = 40
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
  const [trustedWorkspace, setTrustedWorkspace] = useState<TrustedWorkspace | null>(null)
  const [trustedWorkspaceBusy, setTrustedWorkspaceBusy] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [auditRecords, setAuditRecords] = useState<AuditRecord[]>([])
  const [appearanceScale, setAppearanceScale] = useState(1)
  const [petState, setPetState] = useState<PetState>("idle")
  const [petStateRevision, setPetStateRevision] = useState(0)
  const [messages, setMessages] = useState<LocalMessage[]>(loadMessages)
  const [draft, setDraft] = useState("")
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskState, setTaskState] = useState<TaskState | "ready">("ready")
  const [notice, setNotice] = useState("提出任务，Pingo 会在需要时先请求授权。")
  const [toolActivity, setToolActivity] = useState("")
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [lastResult, setLastResult] = useState<OperationResult | null>(null)
  const [permissionBusy, setPermissionBusy] = useState(false)
  const dragStart = useRef<{ x: number; y: number; pointerId: number; didDrag: boolean } | null>(
    null,
  )
  const assistantId = useRef<string | null>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const petStateTimer = useRef<number | null>(null)
  const currentPetState = PET_STATE_CONFIG[petState]

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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)))
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

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

  const openSettings = useCallback(async () => {
    setExpanded(true)
    setSettingsOpen(true)
    setSettingsBusy(true)
    setSettingsNotice("")
    void window.pingo.pet.setExpanded(true)
    try {
      const [current, currentGrants, currentAudit] = await Promise.all([
        window.pingo.settings.get(),
        window.pingo.capabilities.list(),
        window.pingo.audit.list(),
      ])
      const currentTrustedWorkspace = await window.pingo.trustedWorkspace.get()
      setSettings(current)
      setSettingsDraft(current)
      setGrants(currentGrants)
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
          showPetState("thinking")
        } else if (event.state === "completed") {
          setNotice("任务完成")
          showPetState("celebrate", HAPPY_STATE_DURATION_MS)
        } else if (event.state === "cancelled") {
          setNotice("任务已取消")
          showPetState("idle")
        } else if (event.state === "failed") {
          setNotice("任务失败，请查看 Pingo 的说明")
          showPetState("worried")
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
        setApproval(event.request)
        return
      }
      if (event.type === "operation-result") {
        setLastResult(event.result)
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
      } else if (event.type === "cancelled") {
        assistantId.current = null
        setTaskState("cancelled")
        setNotice("任务已取消")
        showPetState("idle")
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
      }
    },
    [showPetState],
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
    setTaskState("cancelled")
    setApproval(null)
    setPermission(null)
    setNotice("已取消当前任务")
    showPetState("idle")
  }, [showPetState, taskId])

  const submitTask = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault()
      const content = draft.trim()
      if (
        !content ||
        (taskState !== "ready" && !["completed", "failed", "cancelled"].includes(taskState))
      )
        return
      const userMessage: LocalMessage = { id: `user-${Date.now()}`, role: "user", content }
      const assistantMessage: LocalMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
      }
      const nextMessages: LocalMessage[] = [...messages, userMessage, assistantMessage].slice(
        -MAX_MESSAGES,
      )
      const nextAssistant = nextMessages.at(-1)
      if (!nextAssistant) return
      assistantId.current = nextAssistant.id
      setMessages(nextMessages)
      setDraft("")
      setApproval(null)
      setPermission(null)
      setLastResult(null)
      setTaskState("proposed")
      setNotice("正在提交任务…")
      try {
        const response = await window.pingo.task.submit(buildModelHistory(nextMessages))
        setTaskId(response.taskId)
      } catch {
        assistantId.current = null
        setTaskState("failed")
        setNotice("任务提交失败，请重试。")
      }
    },
    [draft, messages, taskState],
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
    async (decision: OperationDecision["decision"]) => {
      if (!approval) return
      await window.pingo.task.decide({
        taskId: approval.taskId,
        operationId: approval.operationId,
        decision,
      })
      setApproval(null)
    },
    [approval],
  )

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
                    : approval || permission
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
              trustedWorkspace={trustedWorkspace}
              trustedWorkspaceBusy={trustedWorkspaceBusy}
              setDraft={setSettingsDraft}
              save={saveSettings}
              chooseTrustedWorkspace={chooseTrustedWorkspace}
              disableTrustedWorkspace={disableTrustedWorkspace}
              forgetTrustedWorkspace={forgetTrustedWorkspace}
              revokeGrant={revokeGrant}
            />
          ) : (
            <>
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
              {approval && (
                <div className="action-card approval-card" role="dialog" aria-label="操作确认">
                  <strong>
                    {approval.plan.risk} · {approval.plan.kind}
                  </strong>
                  <p className="risk-reason">{approval.plan.riskReason}</p>
                  <pre>{approval.plan.preview}</pre>
                  <p>
                    可撤销：{approval.plan.reversible ? "是" : "否"} · 仅允许一次 · 预览摘要{" "}
                    {approval.plan.digest.slice(0, 12)}…
                  </p>
                  <div className="action-buttons">
                    <button type="button" onClick={() => void decideApproval("approve")}>
                      允许一次
                    </button>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void decideApproval("deny")}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              )}
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
                      Boolean(approval || permission || onboardingOpen) ||
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

function SettingsView({
  settings,
  draft,
  busy,
  notice,
  grants,
  auditRecords,
  trustedWorkspace,
  trustedWorkspaceBusy,
  setDraft,
  save,
  chooseTrustedWorkspace,
  disableTrustedWorkspace,
  forgetTrustedWorkspace,
  revokeGrant,
}: {
  settings: AppSettings | null
  draft: UserPreferences | null
  busy: boolean
  notice: string
  grants: CapabilityGrant[]
  auditRecords: AuditRecord[]
  trustedWorkspace: TrustedWorkspace | null
  trustedWorkspaceBusy: boolean
  setDraft: React.Dispatch<React.SetStateAction<UserPreferences | null>>
  save: () => Promise<void>
  chooseTrustedWorkspace: () => Promise<void>
  disableTrustedWorkspace: () => Promise<void>
  forgetTrustedWorkspace: () => Promise<void>
  revokeGrant: (grantId: string) => Promise<void>
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

function loadMessages(): LocalMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]")
    if (!Array.isArray(value)) return []
    return value.filter(isLocalMessage).slice(-MAX_MESSAGES)
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

function buildModelHistory(messages: LocalMessage[]): ChatMessageInput[] {
  return messages
    .slice(-24)
    .filter((message) => message.content || message.role === "assistant")
    .map((message) => ({
      role: message.role === "error" ? "assistant" : message.role,
      content: message.content,
    }))
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
