import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent, ReactElement } from "react"
import petGentleImage from "../../assets/pet-gentle.png"
import petImage from "../../assets/pet.png"
import petHappyImage from "../../assets/pet-happy.png"
import petThinkingImage from "../../assets/pet-thinking.png"
import type { ChatStreamEvent, PetState, TaskState } from "../../shared/types.js"

type PetImageKey = "idle" | "happy" | "thinking" | "gentle"

const HAPPY_STATE_DURATION_MS = 1800
const POINTER_TAP_THRESHOLD_PX = 4

interface PetPrompt {
  title: string
  detail: string
}

function promptForTaskState(state: TaskState): PetPrompt {
  switch (state) {
    case "proposed":
      return { title: "正在准备任务", detail: "Pingo 正在准备执行环境。" }
    case "planning":
      return { title: "正在分析你的任务", detail: "Pingo 正在规划下一步。" }
    case "awaiting_permission":
    case "awaiting_confirmation":
      return { title: "正在继续处理", detail: "Pingo 正在继续执行任务。" }
    case "executing":
      return { title: "正在执行任务", detail: "Pingo 正在执行操作。" }
    case "completed":
      return { title: "正在整理最终答案", detail: "Pingo 正在汇总执行结果。" }
    case "failed":
      return { title: "任务未完成", detail: "任务执行失败，请调整后重试。" }
    case "cancelled":
      return { title: "任务已取消", detail: "你可以随时重新输入任务。" }
  }
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
  const [expanded, setExpanded] = useState(false)
  const [appearanceScale, setAppearanceScale] = useState(1)
  const [petState, setPetState] = useState<PetState>("idle")
  const [petStateRevision, setPetStateRevision] = useState(0)
  const [draft, setDraft] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [showInput, setShowInput] = useState(false)
  const [prompt, setPrompt] = useState<PetPrompt | null>(null)
  const dragStart = useRef<{ x: number; y: number; pointerId: number; didDrag: boolean } | null>(
    null,
  )
  const petStateTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const petButtonRef = useRef<HTMLButtonElement>(null)
  const taskIsActive = useRef(false)
  const responseBuffer = useRef("")
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
    const removeAppearance = window.pingo.pet.onAppearance((appearance) =>
      setAppearanceScale(appearance.scale),
    )
    const removePetState = window.pingo.pet.onStateChange((event) =>
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

  const closeDialog = useCallback(() => {
    setExpanded(false)
    void window.pingo.pet.setExpanded(false)
    window.requestAnimationFrame(() => petButtonRef.current?.focus())
  }, [])

  const openDialog = useCallback(() => {
    setExpanded(true)
    setShowInput(true)
    if (!isSending) {
      setPrompt(null)
    }
    void window.pingo.pet.setExpanded(true)
  }, [isSending])

  const handleTaskEvent = useCallback(
    (event: ChatStreamEvent) => {
      if (!taskIsActive.current) return
      if (event.type === "start") {
        responseBuffer.current = ""
        setIsSending(true)
        setPrompt({ title: "正在处理你的任务", detail: "Pingo 正在分析下一步。" })
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
        setPrompt({ title: event.title, detail })
        return
      }
      if (event.type === "task-state") {
        setPrompt(promptForTaskState(event.state))
        return
      }
      if (event.type === "tool") {
        setPrompt(
          event.detail.startsWith("读取被拒绝：")
            ? {
                title: "无法读取当前项目目录",
                detail: event.detail,
              }
            : { title: `正在使用 ${event.name}`, detail: event.detail || "工具正在执行。" },
        )
        return
      }
      if (event.type === "operation-progress") {
        setPrompt({
          title: "正在运行命令",
          detail: event.stream === "stderr" ? "正在接收命令输出。" : "命令正在执行。",
        })
        return
      }
      if (event.type === "capability-request") {
        setPrompt({ title: "正在继续处理", detail: "Pingo 正在执行任务。" })
        return
      }
      if (event.type === "approval-request") {
        setPrompt({ title: "正在继续处理", detail: "Pingo 正在执行任务。" })
        return
      }
      if (event.type === "operation-result") {
        setPrompt({
          title: event.result.status === "completed" ? "操作已完成" : "操作未完成",
          detail: event.result.content || event.result.detail,
        })
        return
      }
      if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
        taskIsActive.current = false
        setIsSending(false)
        setPrompt(
          event.type === "done"
            ? { title: "任务已完成", detail: responseBuffer.current.trim() || "任务已完成。" }
            : {
                title: "任务未完成",
                detail: event.type === "error" ? event.message : "任务已取消，请调整后再试一次。",
              },
        )
        showPetState(event.type === "done" ? "happy" : "worried", HAPPY_STATE_DURATION_MS)
      }
    },
    [showPetState],
  )

  useEffect(() => window.pingo.task.onEvent(handleTaskEvent), [handleTaskEvent])

  const submitMessage = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      const content = draft.trim()
      if (!content || isSending) return

      taskIsActive.current = true
      responseBuffer.current = ""
      setDraft("")
      setIsSending(true)
      setShowInput(false)
      setPrompt({ title: content, detail: "Pingo 正在处理你的任务。" })
      showPetState("thinking")

      void window.pingo.task.submit([{ role: "user", content }]).catch(() => {
        if (!taskIsActive.current) return
        taskIsActive.current = false
        setIsSending(false)
        setPrompt({ title: "暂时无法开始", detail: "请检查模型设置后重试。" })
        showPetState("worried", HAPPY_STATE_DURATION_MS)
      })
    },
    [draft, isSending, showPetState],
  )

  const handleDraftKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeDialog()
      } else if (event.key === "Enter") {
        event.preventDefault()
        submitMessage()
      }
    },
    [closeDialog, submitMessage],
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
        showPetState("happy", HAPPY_STATE_DURATION_MS)
        openDialog()
      }
    },
    [openDialog, showPetState],
  )

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current || dragStart.current.pointerId !== event.pointerId) return
    dragStart.current = null
    window.pingo.pet.dragEnd()
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
    window.pingo.pet.showContextMenu()
  }, [])

  return (
    <main
      className={`app-shell ${expanded ? "expanded" : "collapsed"}`}
      style={{ "--pet-scale": appearanceScale } as CSSProperties}
    >
      {expanded && (
        <div className="pet-prompt-layer">
          {prompt && (
            <section className="pet-prompt" aria-live="polite" aria-label="Pingo 提示">
              <strong>{prompt.title}</strong>
              <span>{prompt.detail}</span>
            </section>
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
                  placeholder="想让 Pingo 做什么？"
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
