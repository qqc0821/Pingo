import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, MouseEvent, PointerEvent, ReactElement } from "react"
import petGentleImage from "../../assets/pet-gentle.png"
import petImage from "../../assets/pet.png"
import petHappyImage from "../../assets/pet-happy.png"
import petThinkingImage from "../../assets/pet-thinking.png"
import type { AppSettings, PetState, UserPreferences } from "../../shared/types.js"

type IconName = "check" | "close" | "info" | "settings"
type PetImageKey = "idle" | "happy" | "thinking" | "gentle"

interface PetStateConfig {
  image: PetImageKey
  label: string
}

const PET_IMAGES: Record<PetImageKey, string> = {
  idle: petImage,
  happy: petHappyImage,
  thinking: petThinkingImage,
  gentle: petGentleImage,
}

const PET_IMAGE_ENTRIES = Object.entries(PET_IMAGES) as Array<[PetImageKey, string]>

const PET_STATE_CONFIG: Record<PetState, PetStateConfig> = {
  idle: { image: "idle", label: "待机中" },
  happy: { image: "happy", label: "开心" },
  thinking: { image: "thinking", label: "思考中" },
  nod: { image: "gentle", label: "点头" },
  worried: { image: "thinking", label: "担心" },
  encourage: { image: "happy", label: "鼓励" },
  sleepy: { image: "gentle", label: "困倦" },
  reminder: { image: "thinking", label: "提醒" },
  focus: { image: "gentle", label: "专注陪伴" },
  celebrate: { image: "happy", label: "完成庆祝" },
}

const HAPPY_STATE_DURATION_MS = 1800
const POINTER_TAP_THRESHOLD_PX = 4

const ICON_PATHS: Record<IconName, readonly string[]> = {
  check: ["m5 12 4 4L19 6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  info: ["M12 16v-4", "M12 8h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  settings: [
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.8.2l-.5.3a1.7 1.7 0 0 0-.9 1.5v.2h-4v-.2a1.7 1.7 0 0 0-.9-1.5l-.5-.3a1.7 1.7 0 0 0-1.8-.2l-.2.1-2-3.4.1-.1a1.7 1.7 0 0 0 .3-1.9l-.3-.5a1.7 1.7 0 0 0-1.5-.8H3v-4h.2a1.7 1.7 0 0 0 1.5-.8l.3-.5a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 1.8-.2l.5-.3a1.7 1.7 0 0 0 .9-1.5V2h4v.2a1.7 1.7 0 0 0 .9 1.5l.5.3a1.7 1.7 0 0 0 1.8.2l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.9l.3.5a1.7 1.7 0 0 0 1.5.8h.2v4h-.2a1.7 1.7 0 0 0-1.5.8Z",
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
  const [appearanceScale, setAppearanceScale] = useState(1)
  const [petState, setPetState] = useState<PetState>("idle")
  const [petStateRevision, setPetStateRevision] = useState(0)
  const dragStart = useRef<{ x: number; y: number; pointerId: number; didDrag: boolean } | null>(
    null,
  )
  const petStateTimer = useRef<number | null>(null)

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
      if (petStateTimer.current !== null) {
        window.clearTimeout(petStateTimer.current)
        petStateTimer.current = null
      }
    }
  }, [])

  const showPetState = useCallback((nextState: PetState, durationMs?: number) => {
    if (petStateTimer.current !== null) {
      window.clearTimeout(petStateTimer.current)
      petStateTimer.current = null
    }

    setPetState(nextState)
    setPetStateRevision((current) => current + 1)

    if (durationMs !== undefined && durationMs > 0 && nextState !== "idle") {
      petStateTimer.current = window.setTimeout(() => {
        setPetState("idle")
        setPetStateRevision((current) => current + 1)
        petStateTimer.current = null
      }, durationMs)
    }
  }, [])

  const triggerHappyState = useCallback(() => {
    showPetState("happy", HAPPY_STATE_DURATION_MS)
  }, [showPetState])

  const openSettings = useCallback(async () => {
    setExpanded(true)
    setSettingsOpen(true)
    setSettingsBusy(true)
    setSettingsNotice("")
    void window.pingo.pet.setExpanded(true)
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

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setExpanded(false)
    void window.pingo.pet.setExpanded(false)
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
    const removePetStateListener = window.pingo.pet.onStateChange((event) => {
      showPetState(event.state, event.durationMs)
    })
    return () => {
      removeWindowStateListener()
      removeSettingsListener()
      removeAppearanceListener()
      removePetStateListener()
    }
  }, [openSettings, showPetState])

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

    const distance = Math.hypot(event.screenX - session.x, event.screenY - session.y)
    if (distance > POINTER_TAP_THRESHOLD_PX) {
      session.didDrag = true
    }
    if (session.didDrag) {
      window.pingo.pet.dragMove(event.screenX, event.screenY)
    }
  }, [])

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const session = dragStart.current
      if (!session || session.pointerId !== event.pointerId) return
      dragStart.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      window.pingo.pet.dragEnd()

      const distance = Math.hypot(event.screenX - session.x, event.screenY - session.y)
      if (!session.didDrag && distance <= POINTER_TAP_THRESHOLD_PX) {
        triggerHappyState()
      }
    },
    [triggerHappyState],
  )

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = dragStart.current
    if (!session || session.pointerId !== event.pointerId) return
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

  return (
    <main
      className={`app-shell ${expanded ? "expanded" : "collapsed"}`}
      style={{ "--pet-scale": appearanceScale } as CSSProperties}
    >
      {expanded && settingsOpen && (
        <section className="settings-panel" aria-label="Pingo 设置">
          <header className="settings-header">
            <div className="panel-status" aria-hidden="true">
              <Icon name="settings" />
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭设置"
              title="关闭"
              onClick={closeSettings}
            >
              <Icon name="close" />
            </button>
          </header>

          <div className="settings-view">
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
                    aria-label="API Key 仅由主进程读取。"
                    title="仅使用 MODEL_API_KEY；打包版配置在用户资源库的 Application Support/pingo/.env"
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
                  className={`pet-face pet-face--${imageKey} ${
                    currentPetState.image === imageKey ? "pet-face--active" : ""
                  }`}
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
