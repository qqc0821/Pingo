import { contextBridge, ipcRenderer } from "electron"
import type { PingoAPI, WindowAppearance, WindowState } from "../shared/types.js"

const api: PingoAPI = {
  platform: process.platform,
  version: "0.1.0",
  pet: {
    setExpanded: (expanded) => ipcRenderer.invoke("pet:set-expanded", expanded),
    showContextMenu: () => ipcRenderer.send("pet:show-context-menu"),
    dragStart: (screenX, screenY) => ipcRenderer.send("pet:drag-start", screenX, screenY),
    dragMove: (screenX, screenY) => ipcRenderer.send("pet:drag-move", screenX, screenY),
    dragEnd: () => ipcRenderer.send("pet:drag-end"),
    onWindowState: (listener) => subscribe("pingo:window-state", listener),
    onSettingsRequest: (listener) => subscribe("pingo:settings-request", listener),
    onAppearance: (listener) => subscribe("pingo:appearance", listener),
  },
  project: {
    get: () => ipcRenderer.invoke("project:get"),
    choose: () => ipcRenderer.invoke("project:choose"),
    revoke: () => ipcRenderer.invoke("project:revoke"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (settings) => ipcRenderer.invoke("settings:update", settings),
  },
}

contextBridge.exposeInMainWorld("pingo", api)

function subscribe(
  channel: "pingo:window-state",
  listener: (state: WindowState) => void,
): () => void
function subscribe(channel: "pingo:settings-request", listener: () => void): () => void
function subscribe(
  channel: "pingo:appearance",
  listener: (appearance: WindowAppearance) => void,
): () => void
function subscribe(channel: string, listener: (...args: never[]) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    ;(listener as (...values: unknown[]) => void)(...args)
  }
  ipcRenderer.on(channel, wrappedListener)
  return () => ipcRenderer.removeListener(channel, wrappedListener)
}
