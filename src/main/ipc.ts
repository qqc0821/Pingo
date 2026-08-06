import { app, ipcMain, Menu } from "electron"
import { dialog } from "electron"
import type { OpenDialogOptions } from "electron"
import { realpathSync, statSync } from "node:fs"
import { basename } from "node:path"
import type { AppSettings, ChatMessageInput, UserPreferences } from "../shared/types.js"
import { ModelClient } from "./ai/client.js"
import { executeTool, TOOL_DEFINITIONS } from "./tools/registry.js"
import type { SettingsStore } from "./store.js"
import {
  beginDrag,
  endDrag,
  getPetWindow,
  moveDrag,
  setPetExpanded,
  setPetPreferences,
} from "./window.js"

const modelClient = new ModelClient()

export function registerIpcHandlers(settingsStore: SettingsStore): void {
  ipcMain.handle("pet:set-expanded", (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new TypeError("expanded must be a boolean")
    setPetExpanded(value)
  })

  ipcMain.on("pet:show-context-menu", (event) => {
    const owner = getPetWindow()
    if (!owner || owner.webContents !== event.sender) return

    Menu.buildFromTemplate([{ label: "关闭 Pingo", click: () => app.quit() }]).popup({
      window: owner,
    })
  })

  ipcMain.on("pet:drag-start", (event, screenX: unknown, screenY: unknown) => {
    if (!isScreenCoordinate(screenX) || !isScreenCoordinate(screenY)) return
    if (!event.sender.isDestroyed()) beginDrag(screenX, screenY)
  })

  ipcMain.on("pet:drag-move", (_event, screenX: unknown, screenY: unknown) => {
    if (!isScreenCoordinate(screenX) || !isScreenCoordinate(screenY)) return
    moveDrag(screenX, screenY)
  })

  ipcMain.on("pet:drag-end", () => {
    endDrag()
  })

  ipcMain.handle("chat:send", (event, value: unknown) => {
    const messages = parseMessages(value)
    if (!messages) throw new TypeError("chat messages are invalid")

    const sender = event.sender
    void modelClient.stream(
      messages,
      (streamEvent) => {
        if (!sender.isDestroyed()) sender.send("pingo:chat-event", streamEvent)
      },
      (name, args) => executeTool(settingsStore.getAuthorizedProjectPath(), name, args),
      TOOL_DEFINITIONS,
    )
  })

  ipcMain.on("chat:cancel", () => {
    modelClient.cancel()
  })

  ipcMain.handle("project:get", () => getProjectInfo(settingsStore.getAuthorizedProjectPath()))

  ipcMain.handle("project:choose", async () => {
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
    settingsStore.setAuthorizedProjectPath(realSelectedPath)
    return getProjectInfo(realSelectedPath)
  })

  ipcMain.handle("project:revoke", () => {
    settingsStore.clearAuthorizedProjectPath()
  })

  ipcMain.handle("settings:get", (): AppSettings => getAppSettings(settingsStore))

  ipcMain.handle("settings:update", (_event, value: unknown): AppSettings => {
    const preferences = parseUserPreferences(value)
    settingsStore.setPreferences(preferences)
    process.env.MODEL_BASE_URL = preferences.modelBaseUrl
    process.env.MODEL_NAME = preferences.modelName
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin })
    setPetPreferences(preferences.petScale, preferences.transparency)
    return getAppSettings(settingsStore)
  })
}

function isScreenCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
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
  if (!isNumberInRange(candidate.petScale, 0.7, 1.4)) throw new TypeError("petScale is invalid")
  if (!isNumberInRange(candidate.transparency, 0.5, 1))
    throw new TypeError("transparency is invalid")
  if (typeof candidate.launchAtLogin !== "boolean") throw new TypeError("launchAtLogin is invalid")
  return {
    modelBaseUrl: candidate.modelBaseUrl.trim(),
    modelName: candidate.modelName.trim(),
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
