import { contextBridge, ipcRenderer } from "electron"
import type {
  ChatStreamEvent,
  PetStateEvent,
  PingoAPI,
  WindowAppearance,
  WindowState,
} from "../shared/types.js"

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
    onStateChange: (listener) => subscribe("pingo:pet-state", listener),
  },
  project: {
    get: () => ipcRenderer.invoke("project:get"),
    choose: () => ipcRenderer.invoke("project:choose"),
    revoke: () => ipcRenderer.invoke("project:revoke"),
    openPath: (path, line, column) =>
      ipcRenderer.invoke("project:open-path", { path, line, column }),
  },
  trustedWorkspace: {
    get: () => ipcRenderer.invoke("trusted-workspace:get"),
    choose: () => ipcRenderer.invoke("trusted-workspace:choose"),
    disable: () => ipcRenderer.invoke("trusted-workspace:disable"),
    forget: () => ipcRenderer.invoke("trusted-workspace:forget"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (settings) => ipcRenderer.invoke("settings:update", settings),
  },
  task: {
    submit: (messages) => ipcRenderer.invoke("task:submit", messages),
    cancel: (taskId) => ipcRenderer.send("task:cancel", taskId),
    decide: (decision) => ipcRenderer.invoke("task:decide", decision),
    undo: (taskId, undoId) => ipcRenderer.invoke("task:undo", { taskId, undoId }),
    grant: (request) => ipcRenderer.invoke("task:grant", request),
    deny: (taskId) => ipcRenderer.invoke("task:deny", taskId),
    onEvent: (listener) => subscribe("pingo:task-event", listener),
  },
  audit: {
    list: () => ipcRenderer.invoke("audit:list"),
  },
  capabilities: {
    list: () => ipcRenderer.invoke("capabilities:list"),
    revoke: (grantId) => ipcRenderer.invoke("capabilities:revoke", grantId),
  },
  terminalTrust: {
    list: () => ipcRenderer.invoke("terminal-trust:list"),
    revokeAll: () => ipcRenderer.invoke("terminal-trust:revoke-all"),
  },
  terminalRuns: {
    list: (query, limit) => ipcRenderer.invoke("terminal-runs:list", { query, limit }),
    rerun: (runId) => ipcRenderer.invoke("terminal-runs:rerun", runId),
    diff: (leftRunId, rightRunId) =>
      ipcRenderer.invoke("terminal-runs:diff", { leftRunId, rightRunId }),
  },
}

contextBridge.exposeInMainWorld("pingo", api)

function subscribe(
  channel: "pingo:window-state",
  listener: (state: WindowState) => void,
): () => void
function subscribe(channel: "pingo:settings-request", listener: () => void): () => void
function subscribe(channel: "pingo:pet-state", listener: (event: PetStateEvent) => void): () => void
function subscribe(
  channel: "pingo:appearance",
  listener: (appearance: WindowAppearance) => void,
): () => void
function subscribe(
  channel: "pingo:task-event",
  listener: (event: ChatStreamEvent) => void,
): () => void
function subscribe(channel: string, listener: (...args: never[]) => void): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    ;(listener as (...values: unknown[]) => void)(...args)
  }
  ipcRenderer.on(channel, wrappedListener)
  return () => ipcRenderer.removeListener(channel, wrappedListener)
}
