import { BrowserWindow, screen } from "electron"
import { join } from "node:path"
import type {
  PetNotification,
  WindowAppearance,
  WindowPosition,
  WindowState,
} from "../shared/types.js"
import type { SettingsStore } from "./store.js"

/** 宠物下方预留 38px，完整容纳消息按钮与焦点环。 */
export const COLLAPSED_SIZE = { width: 132, height: 170 }
export const EXPANDED_SIZE = { width: 392, height: 350 }
export const DETAIL_EXPANDED_SIZE = { width: 464, height: 558 }

const EDGE_SNAP_DISTANCE = 24
const WINDOW_MARGIN = 16

let petWindow: BrowserWindow | null = null
let settingsStore: SettingsStore | null = null
let expanded = false
let detailExpanded = false
let petScale = 1

interface DragSession {
  startMouseX: number
  startMouseY: number
  startWindowX: number
  startWindowY: number
}

let dragSession: DragSession | null = null

export function createPetWindow(store: SettingsStore): BrowserWindow {
  settingsStore = store
  const size = getPetWindowSize(false, false)
  const position = getSafePosition(store.getWindowPosition(), size)

  petWindow = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    minWidth: COLLAPSED_SIZE.width,
    minHeight: COLLAPSED_SIZE.height,
    maxWidth: DETAIL_EXPANDED_SIZE.width,
    maxHeight: DETAIL_EXPANDED_SIZE.height + Math.round((1.4 - 1) * 108),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    focusable: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  petWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  petWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  petWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })

  petWindow.setAlwaysOnTop(true, "floating")
  petWindow.setVisibleOnAllWorkspaces(true)
  const preferences = store.getPreferences()
  setPetPreferences(preferences.petScale, preferences.transparency)
  petWindow.on("move", persistAnchorPosition)
  petWindow.on("closed", () => {
    petWindow = null
    dragSession = null
    expanded = false
    detailExpanded = false
  })
  petWindow.once("ready-to-show", () => {
    const currentPreferences = store.getPreferences()
    setPetPreferences(currentPreferences.petScale, currentPreferences.transparency)
    petWindow?.show()
    sendWindowState()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void petWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void petWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }

  return petWindow
}

function isAllowedNavigation(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      const allowed = new URL(process.env.ELECTRON_RENDERER_URL)
      const target = new URL(url)
      return target.origin === allowed.origin
    } catch {
      return false
    }
  }
  return url.startsWith("file://")
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}

export function setPetExpanded(nextExpanded: boolean): void {
  const window = petWindow
  if (!window) return
  if (expanded === nextExpanded) return

  const currentBounds = window.getBounds()
  const anchor = getAnchorPosition(currentBounds)
  const size = getPetWindowSize(nextExpanded, false)
  const nextPosition = nextExpanded
    ? getExpandedPosition(anchor, size)
    : getSafePosition(anchor, size)

  expanded = nextExpanded
  detailExpanded = false
  window.setBounds({ ...nextPosition, ...size }, false)
  persistAnchorPosition()
  sendWindowState()
}

export function setPetDetailExpanded(nextExpanded: boolean): void {
  const window = petWindow
  if (!window || !expanded || detailExpanded === nextExpanded) return

  const currentBounds = window.getBounds()
  const anchor = getAnchorPosition(currentBounds)
  const size = getPetWindowSize(true, nextExpanded)

  detailExpanded = nextExpanded
  window.setBounds({ ...getExpandedPosition(anchor, size), ...size }, false)
  persistAnchorPosition()
  sendWindowState()
}

export function beginDrag(screenX: number, screenY: number): void {
  const window = petWindow
  if (!window) return

  const { x: startWindowX, y: startWindowY } = window.getBounds()
  dragSession = { startMouseX: screenX, startMouseY: screenY, startWindowX, startWindowY }
}

export function moveDrag(screenX: number, screenY: number): void {
  const window = petWindow
  if (!window || !dragSession) return

  window.setPosition(
    dragSession.startWindowX + Math.round(screenX - dragSession.startMouseX),
    dragSession.startWindowY + Math.round(screenY - dragSession.startMouseY),
  )
}

export function endDrag(): void {
  if (!petWindow) return

  dragSession = null
  snapToEdge()
  persistAnchorPosition()
  sendWindowState()
}

export function showPetWindow(): void {
  petWindow?.show()
  petWindow?.focus()
}

/**
 * 非侵入式展示:显示窗口但不抢占键盘焦点。
 * 供外部通知(DSH / MCP)使用,避免每轮回复打断用户正在进行的输入。
 */
export function showPetWindowInactive(): void {
  petWindow?.showInactive()
}

export function hidePetWindow(): void {
  petWindow?.hide()
}

export function sendSettingsRequest(): void {
  petWindow?.webContents.send("pingo:settings-request")
}

export function sendPetNotification(notification: PetNotification): void {
  if (!petWindow) return
  petWindow.webContents.send("pingo:pet-notify", notification)
}

export function setPetPreferences(scale: number, opacity: number): void {
  if (!petWindow) return
  petScale = Number.isFinite(scale) ? Math.max(0.7, Math.min(scale, 1.4)) : 1
  petWindow.setOpacity(opacity)
  resizePetWindowForScale()
  const appearance: WindowAppearance = { scale: petScale }
  petWindow.webContents.send("pingo:appearance", appearance)
}

function resizePetWindowForScale(): void {
  const window = petWindow
  if (!window) return

  const size = getPetWindowSize(expanded, detailExpanded)
  const currentBounds = window.getBounds()
  if (currentBounds.width === size.width && currentBounds.height === size.height) return

  const nextPosition = getSafePosition(
    {
      x: currentBounds.x + currentBounds.width - size.width,
      y: currentBounds.y + currentBounds.height - size.height,
    },
    size,
  )
  window.setBounds({ ...nextPosition, ...size }, false)
  persistAnchorPosition()
  sendWindowState()
}

function getPetWindowSize(
  isExpanded: boolean,
  isDetailExpanded: boolean,
): {
  width: number
  height: number
} {
  const clearance = Math.max(0, Math.round((petScale - 1) * 108))
  if (!isExpanded) {
    return {
      width: COLLAPSED_SIZE.width + clearance,
      height: COLLAPSED_SIZE.height + clearance,
    }
  }
  const base = isDetailExpanded ? DETAIL_EXPANDED_SIZE : EXPANDED_SIZE
  return { width: base.width, height: base.height + clearance }
}

function getAnchorPosition(bounds: Electron.Rectangle): WindowPosition {
  const collapsedSize = getPetWindowSize(false, false)
  return {
    x: expanded ? bounds.x + bounds.width - collapsedSize.width : bounds.x,
    y: expanded ? bounds.y + bounds.height - collapsedSize.height : bounds.y,
  }
}

function getExpandedPosition(
  anchor: WindowPosition,
  size: { width: number; height: number },
): WindowPosition {
  const collapsedSize = getPetWindowSize(false, false)
  return getSafePosition(
    {
      x: anchor.x - (size.width - collapsedSize.width),
      y: anchor.y - (size.height - collapsedSize.height),
    },
    size,
  )
}

function getSafePosition(
  position: WindowPosition | undefined,
  size: { width: number; height: number },
): WindowPosition {
  const target = position ?? getDefaultPosition(size)
  const display = screen.getDisplayNearestPoint({ x: target.x, y: target.y })
  const area = display.workArea

  return {
    x: clamp(target.x, area.x, area.x + area.width - size.width),
    y: clamp(target.y, area.y, area.y + area.height - size.height),
  }
}

function getDefaultPosition(size: { width: number; height: number }): WindowPosition {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - size.width - WINDOW_MARGIN,
    y: area.y + area.height - size.height - WINDOW_MARGIN,
  }
}

function snapToEdge(): void {
  const window = petWindow
  if (!window) return

  const bounds = window.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  let x = clamp(bounds.x, area.x, area.x + area.width - bounds.width)
  let y = clamp(bounds.y, area.y, area.y + area.height - bounds.height)

  if (Math.abs(x - area.x) <= EDGE_SNAP_DISTANCE) x = area.x
  if (Math.abs(area.x + area.width - (x + bounds.width)) <= EDGE_SNAP_DISTANCE) {
    x = area.x + area.width - bounds.width
  }
  if (Math.abs(y - area.y) <= EDGE_SNAP_DISTANCE) y = area.y
  if (Math.abs(area.y + area.height - (y + bounds.height)) <= EDGE_SNAP_DISTANCE) {
    y = area.y + area.height - bounds.height
  }

  window.setPosition(x, y)
}

function persistAnchorPosition(): void {
  if (!petWindow || !settingsStore) return

  settingsStore.setWindowPosition(getAnchorPosition(petWindow.getBounds()))
}

function sendWindowState(): void {
  if (!petWindow) return

  const bounds = petWindow.getBounds()
  const state: WindowState = {
    expanded,
    position: { x: bounds.x, y: bounds.y },
    size: { width: bounds.width, height: bounds.height },
  }
  petWindow.webContents.send("pingo:window-state", state)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}
