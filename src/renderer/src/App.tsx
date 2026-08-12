import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  ReactElement,
  UIEvent,
} from "react"
import petGentleImage from "../../assets/pet-gentle.png"
import petImage from "../../assets/pet.png"
import petHappyImage from "../../assets/pet-happy.png"
import petThinkingImage from "../../assets/pet-thinking.png"
import type { ChatStreamEvent, PetState, TaskState } from "../../shared/types.js"

type PetImageKey = "idle" | "happy" | "thinking" | "gentle"
type PromptTone = "neutral" | "progress" | "success" | "warning" | "error"

const HAPPY_STATE_DURATION_MS = 1800
const POINTER_TAP_THRESHOLD_PX = 4
const PROMPT_DETAIL_ID = "pingo-prompt-detail"

interface PetPrompt {
  tone: PromptTone
  label: string
  content: string
  expandable?: boolean
}

const BLOCKED_TASK_PROMPT: PetPrompt = {
  tone: "warning",
  label: "需要注意",
  content: "等待你的确认。请选择是否继续此操作。",
}

function promptForTaskState(state: TaskState): PetPrompt {
  switch (state) {
    case "proposed":
      return {
        tone: "progress",
        label: "准备中",
        content: "正在检查执行环境与项目上下文。",
      }
    case "planning":
      return {
        tone: "progress",
        label: "分析中",
        content: "正在拆解目标并规划下一步。",
      }
    case "awaiting_permission":
    case "awaiting_confirmation":
      return BLOCKED_TASK_PROMPT
    case "executing":
      return {
        tone: "progress",
        label: "执行中",
        content: "正在应用已确认的操作。",
      }
    case "completed":
      return {
        tone: "progress",
        label: "整理中",
        content: "操作已结束，正在整理最终结果。",
      }
    case "failed":
      return {
        tone: "error",
        label: "需要处理",
        content: "未能完成该请求。请检查任务描述或项目权限，调整后再试一次。",
      }
    case "cancelled":
      return {
        tone: "neutral",
        label: "已取消",
        content: "没有继续执行操作。你可以随时重新输入任务。",
      }
  }
}

const DEFAULT_PROMPT_PREVIEW: PetPrompt = {
  tone: "progress",
  label: "分析中",
  content: "正在检查信息层级、长内容与不同消息状态。",
}

const PROMPT_PREVIEWS: Record<string, PetPrompt> = {
  progress: DEFAULT_PROMPT_PREVIEW,
  success: {
    tone: "success",
    label: "已完成",
    content: "提示框的信息层级与交互表现已经更新。",
    expandable: true,
  },
  warning: {
    tone: "warning",
    label: "需要注意",
    content: "项目状态需要检查。请确认任务描述或项目状态后再试。",
    expandable: true,
  },
  error: {
    tone: "error",
    label: "执行失败",
    content: "没有找到目标文件。请确认项目目录是否正确，然后再试一次。",
    expandable: true,
  },
  long: {
    tone: "success",
    label: "已完成",
    content:
      "桌面共有 12 个文件夹。\n\n其中包括：Projects、Documents、Downloads、Screenshots 等。\n\n我已按名称整理完整列表，展开后可以继续查看全部内容。",
    expandable: true,
  },
}

function readPromptPreview(): PetPrompt | null {
  if (!import.meta.env.DEV || window.pingo !== undefined) return null
  const previewName = new URLSearchParams(window.location.search).get("promptPreview") ?? "progress"
  return PROMPT_PREVIEWS[previewName] ?? DEFAULT_PROMPT_PREVIEW
}

function PromptIcon({ tone }: { tone: PromptTone }): ReactElement {
  if (tone === "success") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7.5 12.5 3 3 6-7" />
      </svg>
    )
  }
  if (tone === "warning") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 8.25v4.5" />
        <path d="M12 16.25h.01" />
        <path d="M10.35 4.5 4.1 16a2 2 0 0 0 1.76 3h12.28a2 2 0 0 0 1.76-3L13.65 4.5a1.88 1.88 0 0 0-3.3 0Z" />
      </svg>
    )
  }
  if (tone === "error") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="7.75" />
        <path d="m9.5 9.5 5 5m0-5-5 5" />
      </svg>
    )
  }
  if (tone === "progress") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 12a7 7 0 1 1-2.05-4.95" />
        <path d="M17 4.75v3.5h3.5" />
      </svg>
    )
  }
  return (
    <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 7.5v5" />
      <path d="M12 16.5h.01" />
      <circle cx="12" cy="12" r="7.75" />
    </svg>
  )
}

function PromptCard({
  prompt,
  expanded,
  onToggle,
  onDismiss,
}: {
  prompt: PetPrompt
  expanded: boolean
  onToggle: () => void
  onDismiss: () => void
}): ReactElement {
  const liveMode = prompt.tone === "error" ? "assertive" : "polite"
  const contentRef = useRef<HTMLParagraphElement>(null)
  const [contentIsClipped, setContentIsClipped] = useState(false)
  const [contentHasScroll, setContentHasScroll] = useState(false)
  const [contentAtEnd, setContentAtEnd] = useState(true)

  useLayoutEffect(() => {
    const contentElement = contentRef.current
    if (!contentElement) return
    const measure = () => {
      const hasOverflow = contentElement.scrollHeight > contentElement.clientHeight + 1
      setContentIsClipped(!expanded && prompt.expandable === true && hasOverflow)
      setContentHasScroll(expanded && hasOverflow)
      setContentAtEnd(
        !expanded ||
          !hasOverflow ||
          contentElement.scrollTop + contentElement.clientHeight >= contentElement.scrollHeight - 1,
      )
    }
    const observer = new ResizeObserver(measure)

    measure()
    observer.observe(contentElement)
    return () => observer.disconnect()
  }, [expanded, prompt.content, prompt.expandable])

  const handleContentScroll = useCallback((event: UIEvent<HTMLParagraphElement>) => {
    const contentElement = event.currentTarget
    setContentAtEnd(
      contentElement.scrollTop + contentElement.clientHeight >= contentElement.scrollHeight - 1,
    )
  }, [])

  const showToggle = expanded || contentIsClipped

  return (
    <section
      className={`pet-prompt pet-prompt--${prompt.tone} ${expanded ? "pet-prompt--expanded" : ""} ${contentHasScroll && !contentAtEnd ? "pet-prompt--content-overflow" : ""}`}
      role={prompt.tone === "error" ? "alert" : "status"}
      aria-live={liveMode}
      aria-atomic="true"
    >
      <span className="visually-hidden">Pingo 提示：{prompt.label}。</span>
      <div className="pet-prompt-header">
        <span className="pet-prompt-icon" aria-hidden="true">
          <span className="pet-prompt-icon-motion">
            <PromptIcon tone={prompt.tone} />
          </span>
        </span>
        <div className="pet-prompt-heading">
          <span className="pet-prompt-label">{prompt.label}</span>
          <p
            ref={contentRef}
            id={PROMPT_DETAIL_ID}
            className="pet-prompt-content"
            onScroll={handleContentScroll}
          >
            {prompt.content}
          </p>
        </div>
        {showToggle ? (
          <button
            className="pet-prompt-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={PROMPT_DETAIL_ID}
            onClick={onToggle}
          >
            <span>{expanded ? "收起" : "查看完整结果"}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.75 6.25 3.25 3.25 3.25-3.25" />
            </svg>
          </button>
        ) : null}
        <div className="pet-prompt-actions">
          <button
            className="pet-prompt-dismiss"
            type="button"
            aria-label="关闭提示"
            onClick={onDismiss}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
      {prompt.tone === "progress" ? (
        <span className="pet-prompt-progress" aria-hidden="true">
          <span />
        </span>
      ) : null}
    </section>
  )
}

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
  worried: { image: "thinking", label: "需要注意" },
  encourage: { image: "happy", label: "鼓励" },
  sleepy: { image: "gentle", label: "困倦" },
  reminder: { image: "thinking", label: "提醒" },
  focus: { image: "gentle", label: "专注" },
  celebrate: { image: "happy", label: "庆祝" },
}

export function App(): ReactElement {
  const [previewPrompt] = useState(readPromptPreview)
  const [expanded, setExpanded] = useState(() => previewPrompt !== null)
  const [appearanceScale, setAppearanceScale] = useState(1)
  const [petState, setPetState] = useState<PetState>(() =>
    previewPrompt?.tone === "success"
      ? "happy"
      : previewPrompt?.tone === "error" || previewPrompt?.tone === "warning"
        ? "worried"
        : previewPrompt
          ? "thinking"
          : "idle",
  )
  const [petStateRevision, setPetStateRevision] = useState(0)
  const [draft, setDraft] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [showInput, setShowInput] = useState(false)
  const [prompt, setPrompt] = useState<PetPrompt | null>(previewPrompt)
  const [promptExpanded, setPromptExpanded] = useState(
    () =>
      previewPrompt !== null &&
      new URLSearchParams(window.location.search).get("detailOpen") === "1",
  )
  const dragStart = useRef<{ x: number; y: number; pointerId: number; didDrag: boolean } | null>(
    null,
  )
  const petStateTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const petButtonRef = useRef<HTMLButtonElement>(null)
  const taskIsActive = useRef(false)
  const responseBuffer = useRef("")
  const operationResultBuffer = useRef("")
  const currentPetState = PET_STATE_CONFIG[petState]

  useEffect(() => {
    for (const imageSource of new Set(Object.values(PET_IMAGES))) {
      const image = new window.Image()
      image.decoding = "async"
      image.src = imageSource
    }
  }, [])

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

  useEffect(() => {
    const api = window.pingo
    if (!api) return
    const removeAppearance = api.pet.onAppearance((appearance) =>
      setAppearanceScale(appearance.scale),
    )
    const removePetState = api.pet.onStateChange((event) =>
      showPetState(event.state, event.durationMs),
    )
    return () => {
      removeAppearance()
      removePetState()
    }
  }, [showPetState])

  useEffect(() => {
    if (expanded && showInput) inputRef.current?.focus()
  }, [expanded, showInput])

  useEffect(() => {
    void window.pingo?.pet.setDetailExpanded(promptExpanded)
  }, [promptExpanded])

  const closeDialog = useCallback((restorePetFocus = true) => {
    setExpanded(false)
    setPromptExpanded(false)
    void window.pingo?.pet.setExpanded(false)
    if (restorePetFocus) window.requestAnimationFrame(() => petButtonRef.current?.focus())
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !expanded) return
      event.preventDefault()
      closeDialog()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [closeDialog, expanded])

  const showPrompt = useCallback((nextPrompt: PetPrompt | null, reveal = false) => {
    setPrompt(nextPrompt)
    setPromptExpanded(false)
    if (!reveal) return
    setExpanded(true)
    void window.pingo?.pet.setExpanded(true)
  }, [])

  const openDialog = useCallback(() => {
    setExpanded(true)
    setShowInput(true)
    setPromptExpanded(false)
    void window.pingo?.pet.setExpanded(true)
  }, [])

  const handleTaskEvent = useCallback(
    (event: ChatStreamEvent) => {
      if (!taskIsActive.current) return
      if (event.type === "start") {
        responseBuffer.current = ""
        operationResultBuffer.current = ""
        setIsSending(true)
        showPrompt({
          tone: "progress",
          label: "分析中",
          content: "正在理解目标并确定下一步。",
        })
        showPetState("thinking")
        return
      }
      if (event.type === "chunk") {
        responseBuffer.current += event.content
        return
      }
      if (event.type === "agent-step") {
        const detail =
          event.detail ??
          (event.toolNames?.length
            ? `正在使用：${event.toolNames.join("、")}`
            : "Pingo 正在继续处理。")
        const content = detail === event.title ? event.title : `${event.title}\n${detail}`
        showPrompt({
          tone:
            event.status === "failed"
              ? "error"
              : event.phase === "awaiting_approval"
                ? "warning"
                : "progress",
          label:
            event.status === "failed"
              ? "步骤失败"
              : event.phase === "awaiting_approval"
                ? "需要注意"
                : "处理中",
          content,
          expandable: event.status === "failed",
        })
        return
      }
      if (event.type === "task-state") {
        showPrompt(promptForTaskState(event.state))
        return
      }
      if (event.type === "tool") {
        showPrompt(
          event.detail.startsWith("读取被拒绝：")
            ? {
                tone: "warning",
                label: "需要处理",
                content: `无法读取项目目录。\n${event.detail}\n请检查项目目录后再试。`,
                expandable: true,
              }
            : {
                tone: "progress",
                label: "工具运行中",
                content: event.detail || `正在使用 ${event.name}。`,
              },
        )
        return
      }
      if (event.type === "operation-progress") {
        showPrompt({
          tone: "progress",
          label: "执行中",
          content: event.stream === "stderr" ? "正在检查命令反馈。" : "命令正在执行。",
        })
        return
      }
      if (event.type === "capability-request" || event.type === "approval-request") {
        showPrompt(BLOCKED_TASK_PROMPT)
        return
      }
      if (event.type === "operation-result") {
        const operationResult = event.result.content || event.result.detail
        if (operationResult) operationResultBuffer.current = operationResult
        if (event.result.status !== "completed") {
          showPrompt({
            tone: "error",
            label: "操作未完成",
            content: operationResult || "未能完成当前操作。请检查权限或调整任务后再试一次。",
            expandable: true,
          })
        }
        return
      }
      if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
        taskIsActive.current = false
        setIsSending(false)
        const finalResult = responseBuffer.current.trim() || operationResultBuffer.current.trim()
        showPrompt(
          event.type === "done"
            ? {
                tone: "success",
                label: "已完成",
                content: finalResult || "请求已处理完毕，暂未返回额外说明。",
                expandable: true,
              }
            : {
                tone: event.type === "error" ? "error" : "neutral",
                label: event.type === "error" ? "未完成" : "已取消",
                content:
                  event.type === "error"
                    ? `${event.message}\n请检查设置或调整任务后再试。`
                    : "任务已取消，没有继续执行操作。你可以随时重新开始。",
                expandable: true,
              },
          true,
        )
        showPetState(event.type === "done" ? "happy" : "worried", HAPPY_STATE_DURATION_MS)
      }
    },
    [showPetState, showPrompt],
  )

  useEffect(() => {
    const api = window.pingo
    if (!api) return
    return api.task.onEvent(handleTaskEvent)
  }, [handleTaskEvent])

  const submitMessage = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      const content = draft.trim()
      if (!content || isSending) return

      taskIsActive.current = true
      responseBuffer.current = ""
      operationResultBuffer.current = ""
      setDraft("")
      setIsSending(true)
      setShowInput(false)
      showPrompt({
        tone: "progress",
        label: "新任务",
        content: `正在处理：${content}`,
      })
      showPetState("thinking")

      void window.pingo?.task.submit([{ role: "user", content }]).catch(() => {
        if (!taskIsActive.current) return
        taskIsActive.current = false
        setIsSending(false)
        showPrompt(
          {
            tone: "error",
            label: "无法开始",
            content: "暂时无法开始任务。请检查模型设置与网络连接，然后再试一次。",
            expandable: true,
          },
          true,
        )
        showPetState("worried", HAPPY_STATE_DURATION_MS)
      })
    },
    [draft, isSending, showPetState, showPrompt],
  )

  const handleDraftKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault()
        submitMessage()
      }
    },
    [submitMessage],
  )

  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStart.current = {
      x: event.screenX,
      y: event.screenY,
      pointerId: event.pointerId,
      didDrag: false,
    }
    window.pingo?.pet.dragStart(event.screenX, event.screenY)
  }, [])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = dragStart.current
    if (!session || session.pointerId !== event.pointerId) return
    if (Math.hypot(event.screenX - session.x, event.screenY - session.y) > POINTER_TAP_THRESHOLD_PX)
      session.didDrag = true
    if (session.didDrag) window.pingo?.pet.dragMove(event.screenX, event.screenY)
  }, [])

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const session = dragStart.current
      if (!session || session.pointerId !== event.pointerId) return
      dragStart.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId)
      window.pingo?.pet.dragEnd()
      if (
        !session.didDrag &&
        Math.hypot(event.screenX - session.x, event.screenY - session.y) <= POINTER_TAP_THRESHOLD_PX
      ) {
        showPetState("happy", HAPPY_STATE_DURATION_MS)
        openDialog()
      }
    },
    [openDialog, showPetState],
  )

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current || dragStart.current.pointerId !== event.pointerId) return
    dragStart.current = null
    window.pingo?.pet.dragEnd()
  }, [])

  const handlePetKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      showPetState("happy", HAPPY_STATE_DURATION_MS)
      openDialog()
    },
    [openDialog, showPetState],
  )

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    window.pingo?.pet.showContextMenu()
  }, [])

  return (
    <main
      className={`app-shell ${expanded ? "expanded" : "collapsed"} ${promptExpanded ? "prompt-detail-open" : ""}`}
      style={{ "--pet-scale": appearanceScale } as CSSProperties}
    >
      {expanded && (
        <div className="pet-prompt-layer">
          {prompt && (
            <PromptCard
              prompt={prompt}
              expanded={promptExpanded}
              onToggle={() => setPromptExpanded((current) => !current)}
              onDismiss={() => closeDialog()}
            />
          )}
          {showInput && (
            <form className="quick-composer" onSubmit={submitMessage}>
              <label className="visually-hidden" htmlFor="pingo-message">
                输入给 Pingo 的消息
              </label>
              <div className="quick-composer-shell">
                <input
                  ref={inputRef}
                  id="pingo-message"
                  name="message"
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  placeholder="告诉 Pingo 你想完成什么…"
                  autoComplete="off"
                  disabled={isSending}
                />
                <button type="submit" disabled={!draft.trim() || isSending}>
                  {isSending ? "处理中…" : "发送"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      <div className="pet-dock">
        <button
          ref={petButtonRef}
          className={`pet-button pet-state-${petState}`}
          type="button"
          aria-label={`Pingo 桌面宠物，当前${currentPetState.label}`}
          onKeyDown={handlePetKeyDown}
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
                  width={108}
                  height={108}
                  draggable={false}
                  decoding="async"
                />
              ))}
            </span>
          </span>
        </button>
      </div>
    </main>
  )
}
