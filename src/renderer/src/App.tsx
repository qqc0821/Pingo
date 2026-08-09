import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, PointerEvent, ReactElement } from "react"
import petActionVideo from "../../assets/pet-action.webm"
import petGentleImage from "../../assets/pet-gentle.png"
import petImage from "../../assets/pet.png"
import petHappyImage from "../../assets/pet-happy.png"
import petThinkingImage from "../../assets/pet-thinking.png"
import type { PetState } from "../../shared/types.js"

type PetImageKey = "idle" | "happy" | "thinking" | "gentle"

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
  worried: { image: "thinking", label: "需要注意" },
  encourage: { image: "happy", label: "鼓励" },
  sleepy: { image: "gentle", label: "困倦" },
  reminder: { image: "thinking", label: "提醒" },
  focus: { image: "gentle", label: "专注" },
  celebrate: { image: "happy", label: "庆祝" },
}

export function App(): ReactElement {
  const [appearanceScale, setAppearanceScale] = useState(1)
  const [petState, setPetState] = useState<PetState>("idle")
  const [petStateRevision, setPetStateRevision] = useState(0)
  const dragStart = useRef<{ x: number; y: number; pointerId: number; didDrag: boolean } | null>(
    null,
  )
  const petStateTimer = useRef<number | null>(null)
  const petVideoRef = useRef<HTMLVideoElement>(null)
  const currentPetState = PET_STATE_CONFIG[petState]
  const showIdleVideo = petState === "idle"

  useEffect(() => {
    for (const imageSource of new Set(Object.values(PET_IMAGES))) {
      const image = new window.Image()
      image.decoding = "async"
      image.src = imageSource
    }
  }, [])

  useEffect(() => {
    const video = petVideoRef.current
    if (!video) return
    if (showIdleVideo) {
      void video.play().catch(() => undefined)
      return
    }
    video.pause()
  }, [showIdleVideo, petStateRevision])

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
      }
    },
    [showPetState],
  )

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!dragStart.current || dragStart.current.pointerId !== event.pointerId) return
    dragStart.current = null
    window.pingo.pet.dragEnd()
  }, [])

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    window.pingo.pet.showContextMenu()
  }, [])

  return (
    <main
      className="app-shell collapsed"
      style={{ "--pet-scale": appearanceScale } as CSSProperties}
    >
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
            className={`pet-visual ${showIdleVideo ? "pet-motion--video" : `pet-motion--${petState}`}`}
            aria-hidden="true"
          >
            <span className="pet-face-slot">
              {showIdleVideo ? (
                <video
                  ref={petVideoRef}
                  className="pet-face pet-face--active pet-face--video"
                  src={petActionVideo}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="auto"
                />
              ) : (
                PET_IMAGE_ENTRIES.map(([imageKey, imageSource]) => (
                  <img
                    key={imageKey}
                    className={`pet-face pet-face--${imageKey} ${currentPetState.image === imageKey ? "pet-face--active" : ""}`}
                    src={imageSource}
                    alt=""
                    draggable={false}
                    decoding="async"
                  />
                ))
              )}
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
