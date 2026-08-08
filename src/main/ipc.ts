import { app, ipcMain, Menu } from "electron"
import { dialog } from "electron"
import type { OpenDialogOptions } from "electron"
import { realpathSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { AppSettings, PetState, UserPreferences } from "../shared/types.js"
import type {
  Capability,
  CapabilityRequest,
  ChatMessageInput,
  OperationDecision,
} from "../shared/types.js"
import type { SettingsStore } from "./store.js"
import { AuditLogger } from "./security/auditLogger.js"
import { TaskManager } from "./tasks/taskManager.js"
import {
  beginDrag,
  endDrag,
  getPetWindow,
  moveDrag,
  sendPetState,
  setPetExpanded,
  setPetPreferences,
} from "./window.js"

const PET_STATE_PREVIEWS: ReadonlyArray<{ label: string; state: PetState }> = [
  { label: "待机", state: "idle" },
  { label: "开心", state: "happy" },
  { label: "思考", state: "thinking" },
  { label: "点头", state: "nod" },
  { label: "担心", state: "worried" },
  { label: "鼓励", state: "encourage" },
  { label: "困倦", state: "sleepy" },
  { label: "提醒", state: "reminder" },
  { label: "专注陪伴", state: "focus" },
  { label: "完成庆祝", state: "celebrate" },
]

export function registerIpcHandlers(settingsStore: SettingsStore): void {
  const taskManager = new TaskManager({
    settingsStore,
    auditLogger: new AuditLogger(join(app.getPath("userData"), "operation-history.jsonl")),
  })

  app.on("browser-window-created", (_event, window) => {
    window.on("closed", () => {
      taskManager.revokeAllCapabilities()
    })
  })

  ipcMain.handle("pet:set-expanded", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "boolean") throw new TypeError("expanded must be a boolean")
    setPetExpanded(value)
  })

  ipcMain.on("pet:show-context-menu", (event) => {
    const owner = getPetWindow()
    if (!owner || owner.webContents !== event.sender) return

    Menu.buildFromTemplate([
      {
        label: "状态预览",
        submenu: PET_STATE_PREVIEWS.map(({ label, state }) => ({
          label,
          click: () => sendPetState(state, state === "idle" ? undefined : 3_500),
        })),
      },
      { type: "separator" },
      { label: "关闭 Pingo", click: () => app.quit() },
    ]).popup({ window: owner })
  })

  ipcMain.on("pet:drag-start", (event, screenX: unknown, screenY: unknown) => {
    if (!isTrustedSender(event.sender)) return
    if (!isScreenCoordinate(screenX) || !isScreenCoordinate(screenY)) return
    if (!event.sender.isDestroyed()) beginDrag(screenX, screenY)
  })

  ipcMain.on("pet:drag-move", (event, screenX: unknown, screenY: unknown) => {
    if (!isTrustedSender(event.sender)) return
    if (!isScreenCoordinate(screenX) || !isScreenCoordinate(screenY)) return
    moveDrag(screenX, screenY)
  })

  ipcMain.on("pet:drag-end", (event) => {
    if (!isTrustedSender(event.sender)) return
    endDrag()
  })

  ipcMain.handle("project:get", (event) => {
    assertTrustedSender(event.sender)
    return getProjectInfo(settingsStore.getAuthorizedProjectPath())
  })

  ipcMain.handle("project:choose", async (event) => {
    assertTrustedSender(event.sender)
    const options: OpenDialogOptions = {
      title: "选择要授权给 Pingo 的项目目录",
      properties: ["openDirectory", "createDirectory"],
    }
    const owner = getPetWindow()
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const selectedPath = result.filePaths.at(0)
    if (result.canceled || !selectedPath) return null

    const realSelectedPath = realpathSync.native(selectedPath)
    if (!statSync(realSelectedPath).isDirectory()) throw new Error("选择的路径不是目录")
    taskManager.revokeAllCapabilities()
    settingsStore.setAuthorizedProjectPath(realSelectedPath)
    return getProjectInfo(realSelectedPath)
  })

  ipcMain.handle("project:revoke", (event) => {
    assertTrustedSender(event.sender)
    taskManager.revokeAllCapabilities()
    settingsStore.clearAuthorizedProjectPath()
  })

  ipcMain.handle("settings:get", (event): AppSettings => {
    assertTrustedSender(event.sender)
    return getAppSettings(settingsStore)
  })

  ipcMain.handle("settings:update", (event, value: unknown): AppSettings => {
    assertTrustedSender(event.sender)
    const preferences = parseUserPreferences(value)
    settingsStore.setPreferences(preferences)
    process.env.MODEL_BASE_URL = preferences.modelBaseUrl
    process.env.MODEL_NAME = preferences.modelName
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin })
    setPetPreferences(preferences.petScale, preferences.transparency)
    return getAppSettings(settingsStore)
  })

  ipcMain.handle("task:submit", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    const messages = parseMessages(value)
    if (!messages) throw new TypeError("task messages are invalid")
    const sender = event.sender
    const taskId = taskManager.submit(String(sender.id), messages, (taskEvent) => {
      if (!sender.isDestroyed()) sender.send("pingo:task-event", taskEvent)
    })
    return { taskId }
  })

  ipcMain.on("task:cancel", (event, value: unknown) => {
    if (!isTrustedSender(event.sender) || typeof value !== "string" || value.length > 120) return
    taskManager.cancel(value, String(event.sender.id))
  })

  ipcMain.handle("task:decide", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    const decision = parseOperationDecision(value)
    return taskManager.decide(String(event.sender.id), decision)
  })

  ipcMain.handle("task:undo", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    const request = parseUndoRequest(value)
    return taskManager.undo(String(event.sender.id), request.taskId, request.undoId)
  })

  ipcMain.handle("task:grant", async (event, value: unknown) => {
    assertTrustedSender(event.sender)
    const request = parseCapabilityRequest(value)
    const owner = getPetWindow()
    const configuredProject = settingsStore.getAuthorizedProjectPath()
    let selectedPath = configuredProject
    if (!selectedPath) {
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: "选择要授权给 Pingo 的目录",
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: "选择要授权给 Pingo 的目录",
            properties: ["openDirectory", "createDirectory"],
          })
      if (result.canceled || !result.filePaths.at(0)) {
        taskManager.denyCapability(String(event.sender.id), request.taskId)
        return null
      }
      selectedPath = result.filePaths[0]
      if (!selectedPath) throw new Error("没有选择授权目录")
      selectedPath = realpathSync.native(selectedPath)
      if (!statSync(selectedPath).isDirectory()) throw new Error("授权范围不是目录")
      settingsStore.setAuthorizedProjectPath(selectedPath)
    }
    return taskManager.grantCapability(
      String(event.sender.id),
      request.taskId,
      request.capabilities,
      request.duration,
      [selectedPath],
    )
  })

  ipcMain.handle("task:deny", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "string" || value.length > 120) throw new TypeError("taskId 无效")
    return taskManager.denyCapability(String(event.sender.id), value)
  })

  ipcMain.handle("capabilities:list", (event) => {
    assertTrustedSender(event.sender)
    return taskManager.listCapabilities()
  })

  ipcMain.handle("capabilities:revoke", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "string" || value.length > 120) throw new TypeError("grantId 无效")
    return taskManager.revokeCapability(value)
  })

  ipcMain.handle("audit:list", (event) => {
    assertTrustedSender(event.sender)
    return taskManager.getAuditHistory()
  })
}

function isScreenCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isTrustedSender(sender: Electron.WebContents): boolean {
  const owner = getPetWindow()
  return Boolean(owner && !sender.isDestroyed() && owner.webContents === sender)
}

function assertTrustedSender(sender: Electron.WebContents): void {
  if (!isTrustedSender(sender)) throw new Error("IPC sender 未获信任")
}

function parseMessages(value: unknown): ChatMessageInput[] | null {
  if (!Array.isArray(value) || value.length > 24) return null
  if (!value.every(isChatMessageInput)) return null
  return value
}

function isChatMessageInput(value: unknown): value is ChatMessageInput {
  if (typeof value !== "object" || value === null) return false
  const message = value as Partial<ChatMessageInput>
  return (
    (message.role === "user" || message.role === "assistant" || message.role === "system") &&
    typeof message.content === "string" &&
    message.content.length <= 20_000
  )
}

function parseCapabilityRequest(value: unknown): CapabilityRequest {
  if (typeof value !== "object" || value === null) throw new TypeError("capability request 无效")
  const candidate = value as Partial<CapabilityRequest>
  const allowed: Capability[] = ["workspace.read", "workspace.write", "terminal.execute"]
  if (
    typeof candidate.taskId !== "string" ||
    candidate.taskId.length > 120 ||
    !Array.isArray(candidate.capabilities) ||
    candidate.capabilities.length === 0 ||
    candidate.capabilities.length > 3 ||
    !candidate.capabilities.every((capability) => allowed.includes(capability as Capability)) ||
    !(["once", "session", "persistent"] as const).includes(
      candidate.duration as "once" | "session" | "persistent",
    )
  ) {
    throw new TypeError("capability request 参数无效")
  }
  return {
    taskId: candidate.taskId,
    capabilities: [...new Set(candidate.capabilities as Capability[])],
    duration: candidate.duration as CapabilityRequest["duration"],
  }
}

function parseOperationDecision(value: unknown): OperationDecision {
  if (typeof value !== "object" || value === null) throw new TypeError("operation decision 无效")
  const candidate = value as Partial<OperationDecision>
  if (
    typeof candidate.taskId !== "string" ||
    candidate.taskId.length > 120 ||
    typeof candidate.operationId !== "string" ||
    candidate.operationId.length > 120 ||
    (candidate.decision !== "approve" && candidate.decision !== "deny")
  ) {
    throw new TypeError("operation decision 参数无效")
  }
  return {
    taskId: candidate.taskId,
    operationId: candidate.operationId,
    decision: candidate.decision,
  }
}

function parseUndoRequest(value: unknown): { taskId: string; undoId: string } {
  if (typeof value !== "object" || value === null) throw new TypeError("undo request 无效")
  const candidate = value as { taskId?: unknown; undoId?: unknown }
  if (
    typeof candidate.taskId !== "string" ||
    candidate.taskId.length > 120 ||
    typeof candidate.undoId !== "string" ||
    candidate.undoId.length > 120
  ) {
    throw new TypeError("undo request 参数无效")
  }
  return { taskId: candidate.taskId, undoId: candidate.undoId }
}

function getProjectInfo(projectPath: string | undefined) {
  if (!projectPath) return null
  try {
    const realPath = realpathSync.native(projectPath)
    if (!statSync(realPath).isDirectory()) return null
    return { path: realPath, name: basename(realPath) }
  } catch {
    return null
  }
}

function getAppSettings(settingsStore: SettingsStore): AppSettings {
  return {
    ...settingsStore.getPreferences(),
    apiKeyConfigured: Boolean(process.env.MODEL_API_KEY?.trim()),
  }
}

function parseUserPreferences(value: unknown): UserPreferences {
  if (typeof value !== "object" || value === null) throw new TypeError("settings must be an object")
  const candidate = value as Partial<UserPreferences>
  if (typeof candidate.modelBaseUrl !== "string" || !isHttpUrl(candidate.modelBaseUrl)) {
    throw new TypeError("modelBaseUrl must be an http(s) URL")
  }
  if (
    typeof candidate.modelName !== "string" ||
    !candidate.modelName.trim() ||
    candidate.modelName.length > 100
  ) {
    throw new TypeError("modelName is invalid")
  }
  if (typeof candidate.defaultLocation !== "string" || candidate.defaultLocation.length > 100) {
    throw new TypeError("defaultLocation is invalid")
  }
  if (!isNumberInRange(candidate.petScale, 0.7, 1.4)) throw new TypeError("petScale is invalid")
  if (!isNumberInRange(candidate.transparency, 0.5, 1))
    throw new TypeError("transparency is invalid")
  if (typeof candidate.launchAtLogin !== "boolean") throw new TypeError("launchAtLogin is invalid")
  return {
    modelBaseUrl: candidate.modelBaseUrl.trim(),
    modelName: candidate.modelName.trim(),
    defaultLocation: candidate.defaultLocation.trim(),
    petScale: candidate.petScale,
    transparency: candidate.transparency,
    launchAtLogin: candidate.launchAtLogin,
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
}
