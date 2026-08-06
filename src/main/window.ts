import { BrowserWindow, screen } from "electron"
import { join } from "node:path"
import type {
  PetState,
  PetStateEvent,
  WindowAppearance,
  WindowPosition,
  WindowState,
} from "../shared/types.js"
import type { SettingsStore } from "./store.js"

export const COLLAPSED_SIZE = { width: 132, height: 132 }
export const EXPANDED_SIZE = { width: 392, height: 640 }

const EDGE_SNAP_DISTANCE = 24
const WINDOW_MARGIN = 16

let petWindow: BrowserWindow | null = null
let settingsStore: SettingsStore | null = null
let expanded = false

interface DragSession {
  startMouseX: number
  startMouseY: number
  startWindowX: number
  startWindowY: number
}

let dragSession: DragSession | null = null

export function createPetWindow(store: SettingsStore): BrowserWindow {
  settingsStore = store
  const position = getSafePosition(store.getWindowPosition(), COLLAPSED_SIZE)

  petWindow = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: COLLAPSED_SIZE.width,
    height: COLLAPSED_SIZE.height,
    minWidth: COLLAPSED_SIZE.width,
    minHeight: COLLAPSED_SIZE.height,
    maxWidth: EXPANDED_SIZE.width,
    maxHeight: EXPANDED_SIZE.height,
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
    },
  })

  petWindow.setAlwaysOnTop(true, "floating")
  petWindow.setVisibleOnAllWorkspaces(true)
  const preferences = store.getPreferences()
  setPetPreferences(preferences.petScale, preferences.transparency)
  petWindow.on("move", persistAnchorPosition)
  petWindow.on("closed", () => {
    petWindow = null
    dragSession = null
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

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}

export function setPetExpanded(nextExpanded: boolean): void {
  const window = petWindow
  if (!window || expanded === nextExpanded) return

  const currentBounds = window.getBounds()
  const anchor = getAnchorPosition(currentBounds)
  const size = nextExpanded ? EXPANDED_SIZE : COLLAPSED_SIZE
  const nextPosition = nextExpanded
    ? getExpandedPosition(anchor, size)
    : getSafePosition(anchor, size)

  expanded = nextExpanded
  window.setBounds({ ...nextPosition, ...size }, false)
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

export function hidePetWindow(): void {
  petWindow?.hide()
}

export function sendSettingsRequest(): void {
  petWindow?.webContents.send("pingo:settings-request")
}

export function sendPetState(state: PetState, durationMs?: number): void {
  if (!petWindow) return
  const event: PetStateEvent = durationMs === undefined ? { state } : { state, durationMs }
  petWindow.webContents.send("pingo:pet-state", event)
}

export function setPetPreferences(scale: number, opacity: number): void {
  if (!petWindow) return
  petWindow.setOpacity(opacity)
  const appearance: WindowAppearance = { scale }
  petWindow.webContents.send("pingo:appearance", appearance)
}

function getAnchorPosition(bounds: Electron.Rectangle): WindowPosition {
  return {
    x: expanded ? bounds.x + EXPANDED_SIZE.width - COLLAPSED_SIZE.width : bounds.x,
    y: expanded ? bounds.y + EXPANDED_SIZE.height - COLLAPSED_SIZE.height : bounds.y,
  }
}

function getExpandedPosition(
  anchor: WindowPosition,
  size: { width: number; height: number },
): WindowPosition {
  return getSafePosition(
    {
      x: anchor.x - (EXPANDED_SIZE.width - COLLAPSED_SIZE.width),
      y: anchor.y - (EXPANDED_SIZE.height - COLLAPSED_SIZE.height),
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
