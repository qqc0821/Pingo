import { useCallback, useEffect, useRef, useState } from "react"
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
} from "react"
import petImage from "../../assets/pet.png"
import type {
  AppSettings,
  ChatMessageInput,
  ChatStreamEvent,
  PetState,
  UserPreferences,
} from "../../shared/types.js"

type ChatRole = "user" | "assistant" | "error"
type ChatStatus = "ready" | "streaming" | "failed"

interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}

const MAX_MESSAGES = 50
const STORAGE_KEY = "pingo:chat-messages"
const PET_STATE_LABELS: Record<PetState, string> = {
  idle: "待机中",
  thinking: "思考中",
  success: "完成",
  error: "需要注意",
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "你好！这是 Pingo 的本地聊天预览。下一阶段我会接入真实模型。",
  },
]

type IconName =
  | "arrow-left"
  | "check"
  | "close"
  | "error"
  | "info"
  | "send"
  | "settings"
  | "sparkles"
  | "stop"
  | "tool"
  | "trash"

const ICON_PATHS: Record<IconName, readonly string[]> = {
  "arrow-left": ["M19 12H5", "m12 19-7-7 7-7"],
  check: ["m5 12 4 4L19 6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  error: [
    "M12 8v4",
    "M12 16h.01",
    "M10.3 3.7 2.2 17.8A1.5 1.5 0 0 0 3.5 20h17a1.5 1.5 0 0 0 1.3-2.2L13.7 3.7a2 2 0 0 0-3.4 0Z",
  ],
  info: ["M12 16v-4", "M12 8h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  send: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"],
  settings: [
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.8.2l-.5.3a1.7 1.7 0 0 0-.9 1.5v.2h-4v-.2a1.7 1.7 0 0 0-.9-1.5l-.5-.3a1.7 1.7 0 0 0-1.8-.2l-.2.1-2-3.4.1-.1a1.7 1.7 0 0 0 .3-1.9l-.3-.5a1.7 1.7 0 0 0-1.5-.8H3v-4h.2a1.7 1.7 0 0 0 1.5-.8l.3-.5a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 1.8-.2l.5-.3a1.7 1.7 0 0 0 .9-1.5V2h4v.2a1.7 1.7 0 0 0 .9 1.5l.5.3a1.7 1.7 0 0 0 1.8.2l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.9l.3.5a1.7 1.7 0 0 0 1.5.8h.2v4h-.2a1.7 1.7 0 0 0-1.5.8Z",
  ],
  sparkles: [
    "m12 3-1.2 3.3L7.5 7.5l3.3 1.2L12 12l1.2-3.3 3.3-1.2-3.3-1.2Z",
    "m5 13-.8 2.2L2 16l2.2.8L5 19l.8-2.2L8 16l-2.2-.8Z",
    "m18.5 14-1 2.5-2.5 1 2.5 1 1 2.5 1-2.5 2.5-1-2.5-1Z",
  ],
  stop: ["M7 7h10v10H7z"],
  tool: [
    "M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L4 17l3 3 8.3-8.3a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2Z",
  ],
  trash: ["M4 7h16", "M9 7V4h6v3", "m6 7 1 14h10l1-14", "M10 11v6", "M14 11v6"],
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
  const [petState, setPetState] = useState<PetState>("idle")
  const [notice, setNotice] = useState("点击我展开聊天面板")
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages)
  const [draft, setDraft] = useState("")
  const [chatStatus, setChatStatus] = useState<ChatStatus>("ready")
  const [toolActivity, setToolActivity] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<UserPreferences | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState("")
  const [appearanceScale, setAppearanceScale] = useState(1)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const didDrag = useRef(false)
  const activeAssistantId = useRef<string | null>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)

  const stopStreaming = useCallback(() => {
    if (activeAssistantId.current !== null) window.pingo.chat.cancel()
    activeAssistantId.current = null
    setChatStatus((current) => (current === "streaming" ? "ready" : current))
  }, [])

  const handleChatEvent = useCallback((event: ChatStreamEvent) => {
    const assistantId = activeAssistantId.current
    if (event.type === "start") {
      setChatStatus("streaming")
      setPetState("thinking")
      setNotice("Pingo 正在组织回答…")
      setToolActivity("")
      return
    }
    if (event.type === "tool") {
      setToolActivity(event.detail)
      setNotice(`正在使用只读工具：${event.name}`)
      return
    }
    if (!assistantId) return

    if (event.type === "chunk") {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, content: `${message.content}${event.content}` }
            : message,
        ),
      )
      return
    }
    if (event.type === "done") {
      activeAssistantId.current = null
      setChatStatus("ready")
      setPetState("success")
      setNotice("回答完成")
      setToolActivity("")
      return
    }
    if (event.type === "cancelled") {
      activeAssistantId.current = null
      setChatStatus("ready")
      setPetState("idle")
      setToolActivity("")
      return
    }

    activeAssistantId.current = null
    setChatStatus("failed")
    setPetState("error")
    setNotice(event.message)
    setToolActivity("")
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? { ...message, role: "error", content: event.message }
          : message,
      ),
    )
  }, [])

  const openSettings = useCallback(async () => {
    setExpanded(true)
    setSettingsOpen(true)
    setSettingsBusy(true)
    setSettingsNotice("")
    try {
      const current = await window.pingo.settings.get()
      setSettings(current)
      setSettingsDraft(current)
    } catch {
      setSettingsNotice("设置读取失败，请重试。")
    } finally {
      setSettingsBusy(false)
    }
  }, [])

  useEffect(() => {
    const removeWindowStateListener = window.pingo.pet.onWindowState((state) => {
      setExpanded(state.expanded)
    })
    const removeSettingsListener = window.pingo.pet.onSettingsRequest(() => {
      void openSettings()
    })
    const removeAppearanceListener = window.pingo.pet.onAppearance((appearance) => {
      setAppearanceScale(appearance.scale)
    })
    return () => {
      removeWindowStateListener()
      removeSettingsListener()
      removeAppearanceListener()
      stopStreaming()
    }
  }, [openSettings, stopStreaming])

  useEffect(() => {
    const removeChatListener = window.pingo.chat.onEvent(handleChatEvent)
    return removeChatListener
  }, [handleChatEvent])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)))
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const togglePanel = useCallback(() => {
    if (didDrag.current) {
      didDrag.current = false
      return
    }

    const nextExpanded = !expanded
    setExpanded(nextExpanded)
    setPetState("idle")
    setNotice(nextExpanded ? "聊天面板已展开" : "点击我展开聊天面板")
    void window.pingo.pet.setExpanded(nextExpanded)
  }, [expanded])

  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = { x: event.screenX, y: event.screenY }
    didDrag.current = false
    window.pingo.pet.dragStart(event.screenX, event.screenY)
  }, [])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current
    if (!start) return
    if (Math.abs(event.screenX - start.x) > 3 || Math.abs(event.screenY - start.y) > 3) {
      didDrag.current = true
    }
    window.pingo.pet.dragMove(event.screenX, event.screenY)
  }, [])

  const handlePointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current) return
    dragStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    window.pingo.pet.dragEnd()
  }, [])

  const handleContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    window.pingo.pet.showContextMenu()
  }, [])

  const sendMessage = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault()
      const content = draft.trim()
      if (!content || chatStatus === "streaming") return

      const assistantId = `assistant-${Date.now()}`
      stopStreaming()
      setDraft("")
      setChatStatus("streaming")
      setPetState("thinking")
      setNotice("Pingo 正在组织回答…")
      activeAssistantId.current = assistantId
      const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: "user", content }
      const nextMessages = trimMessages([
        ...messages,
        userMessage,
        { id: assistantId, role: "assistant", content: "" },
      ])
      setMessages(nextMessages)

      const modelMessages = buildModelHistory([...messages, userMessage])
      void window.pingo.chat.send(modelMessages).catch(() => {
        if (activeAssistantId.current !== assistantId) return
        activeAssistantId.current = null
        setChatStatus("failed")
        setPetState("error")
        setNotice("无法启动模型请求，请检查配置。")
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, role: "error", content: "无法启动模型请求，请检查配置。" }
              : message,
          ),
        )
      })
    },
    [chatStatus, draft, messages, stopStreaming],
  )

  const handleStop = useCallback(() => {
    stopStreaming()
    setPetState("idle")
    setNotice("已停止生成")
    setToolActivity("")
    setMessages((current) => {
      const last = current.at(-1)
      if (!last || last.role !== "assistant" || last.content.length === 0) return current
      return [...current.slice(0, -1), { ...last, content: `${last.content}\n\n（已停止）` }]
    })
  }, [stopStreaming])

  const clearConversation = useCallback(() => {
    handleStop()
    localStorage.removeItem(STORAGE_KEY)
    setMessages([])
    setPetState("idle")
    setNotice("会话已清空")
  }, [handleStop])

  const saveSettings = useCallback(async () => {
    if (!settingsDraft) return
    setSettingsBusy(true)
    setSettingsNotice("")
    try {
      const saved = await window.pingo.settings.update(settingsDraft)
      setSettings(saved)
      setSettingsDraft(saved)
      setSettingsNotice("设置已保存")
      setNotice("设置已更新")
    } catch {
      setSettingsNotice("设置无效或保存失败，请检查输入。")
    } finally {
      setSettingsBusy(false)
    }
  }, [settingsDraft])

  const handleDraftKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        sendMessage()
      }
    },
    [sendMessage],
  )

  const statusLabel = settingsOpen ? "设置" : toolActivity || notice
  const statusIcon: IconName = settingsOpen
    ? "settings"
    : toolActivity
      ? "tool"
      : petState === "error"
        ? "error"
        : petState === "success"
          ? "check"
          : "sparkles"

  return (
    <main
      className={`app-shell ${expanded ? "expanded" : "collapsed"}`}
      style={{ "--pet-scale": appearanceScale } as CSSProperties}
    >
      {expanded && (
        <section className="chat-panel" aria-label="Pingo 聊天面板">
          <header className="chat-header">
            <div
              className={`panel-status panel-status--${petState}`}
              role="status"
              aria-label={statusLabel}
              title={statusLabel}
            >
              <Icon name={statusIcon} />
            </div>
            <div className="header-actions">
              {settingsOpen ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="返回聊天"
                  title="返回聊天"
                  onClick={() => setSettingsOpen(false)}
                >
                  <Icon name="arrow-left" />
                </button>
              ) : (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="打开设置"
                  title="设置"
                  onClick={openSettings}
                >
                  <Icon name="settings" />
                </button>
              )}
              <button
                className="icon-button"
                type="button"
                aria-label="收起聊天面板"
                title="收起"
                onClick={togglePanel}
              >
                <Icon name="close" />
              </button>
            </div>
          </header>

          {settingsOpen ? (
            <div className="settings-view">
              <h2 className="visually-hidden">设置</h2>
              {settingsDraft ? (
                <div className="settings-form">
                  <label>
                    <span>模型接口</span>
                    <input
                      value={settingsDraft.modelBaseUrl}
                      disabled={settingsBusy}
                      onChange={(event) =>
                        setSettingsDraft((current) =>
                          current ? { ...current, modelBaseUrl: event.target.value } : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      value={settingsDraft.modelName}
                      disabled={settingsBusy}
                      onChange={(event) =>
                        setSettingsDraft((current) =>
                          current ? { ...current, modelName: event.target.value } : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    <span>默认城市</span>
                    <input
                      value={settingsDraft.defaultLocation}
                      disabled={settingsBusy}
                      placeholder="例如：上海"
                      onChange={(event) =>
                        setSettingsDraft((current) =>
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
                    <span
                      className="info-icon"
                      role="img"
                      aria-label="API Key 仅由主进程读取。打包版配置在用户资源库的 Application Support/pingo/.env。"
                      title="仅使用 MODEL_API_KEY；打包版配置在 ~/Library/Application Support/pingo/.env"
                    >
                      <Icon name="info" />
                    </span>
                  </div>
                  <label className="range-setting">
                    <span>
                      宠物大小 <strong>{settingsDraft.petScale.toFixed(1)}×</strong>
                    </span>
                    <input
                      type="range"
                      min="0.7"
                      max="1.4"
                      step="0.1"
                      value={settingsDraft.petScale}
                      disabled={settingsBusy}
                      onChange={(event) =>
                        setSettingsDraft((current) =>
                          current ? { ...current, petScale: Number(event.target.value) } : current,
                        )
                      }
                    />
                  </label>
                  <label className="range-setting">
                    <span>
                      透明度 <strong>{Math.round(settingsDraft.transparency * 100)}%</strong>
                    </span>
                    <input
                      type="range"
                      min="0.5"
                      max="1"
                      step="0.05"
                      value={settingsDraft.transparency}
                      disabled={settingsBusy}
                      onChange={(event) =>
                        setSettingsDraft((current) =>
                          current
                            ? { ...current, transparency: Number(event.target.value) }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className="checkbox-setting">
                    <input
                      type="checkbox"
                      checked={settingsDraft.launchAtLogin}
                      disabled={settingsBusy}
                      onChange={(event) =>
                        setSettingsDraft((current) =>
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
                      disabled={settingsBusy}
                      aria-label={settingsBusy ? "正在保存设置" : "保存设置"}
                      title={settingsBusy ? "保存中" : "保存"}
                      onClick={saveSettings}
                    >
                      <Icon name="check" />
                    </button>
                  </div>
                  {settingsNotice && <p className="settings-notice">{settingsNotice}</p>}
                </div>
              ) : (
                <div className="settings-loading" role="status">
                  <span className="loading-ring" aria-hidden="true" />
                  <span className="visually-hidden">正在读取设置</span>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="message-list" aria-live="polite">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={`message message--${message.role}`}
                    aria-label={
                      message.role === "user"
                        ? "你的消息"
                        : message.role === "error"
                          ? "错误消息"
                          : "Pingo 的消息"
                    }
                  >
                    {message.content ? (
                      <p>{message.content}</p>
                    ) : (
                      <span className="typing-indicator" aria-label="Pingo 正在思考">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </article>
                ))}
                <div ref={messagesEnd} />
              </div>

              <p className="visually-hidden" role="status" aria-live="polite">
                {notice}
              </p>

              <form className="composer" onSubmit={sendMessage}>
                <div className="composer-shell">
                  <textarea
                    value={draft}
                    rows={2}
                    disabled={chatStatus === "streaming"}
                    placeholder="消息"
                    aria-label="消息内容"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleDraftKeyDown}
                  />
                  <div className="composer-footer">
                    <button
                      className="icon-button icon-button--subtle"
                      type="button"
                      disabled={messages.length === 0}
                      aria-label="清空会话"
                      title="清空会话"
                      onClick={clearConversation}
                    >
                      <Icon name="trash" />
                    </button>
                    {chatStatus === "streaming" ? (
                      <button
                        className="icon-button icon-button--primary icon-button--stop"
                        type="button"
                        aria-label="停止生成"
                        title="停止"
                        onClick={handleStop}
                      >
                        <Icon name="stop" />
                      </button>
                    ) : (
                      <button
                        className="icon-button icon-button--primary"
                        type="submit"
                        disabled={!draft.trim()}
                        aria-label="发送消息"
                        title="发送"
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
          className={`pet-button pet-button--${petState}`}
          type="button"
          aria-label={expanded ? "收起 Pingo 聊天面板" : "展开 Pingo 聊天面板"}
          onClick={togglePanel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onContextMenu={handleContextMenu}
        >
          <img className="pet-face" src={petImage} alt="" aria-hidden="true" draggable={false} />
          <span className="pet-state" aria-hidden="true">
            {PET_STATE_LABELS[petState]}
          </span>
        </button>
      </div>
    </main>
  )
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_MESSAGES
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return INITIAL_MESSAGES
    const messages = parsed.filter(isChatMessage)
    return messages.length > 0 ? messages.slice(-MAX_MESSAGES) : INITIAL_MESSAGES
  } catch {
    return INITIAL_MESSAGES
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<ChatMessage>
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant" || message.role === "error") &&
    typeof message.content === "string"
  )
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_MESSAGES)
}

function buildModelHistory(messages: ChatMessage[]): ChatMessageInput[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-24)
    .map(({ role, content }) => ({ role: role === "user" ? "user" : "assistant", content }))
}
