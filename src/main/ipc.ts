import { app, ipcMain, Menu, shell } from "electron"
import { dialog } from "electron"
import type { OpenDialogOptions } from "electron"
import { realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AppSettings, TrustedWorkspace, UserPreferences } from "../shared/types.js"
import type {
  Capability,
  CapabilityRequest,
  ChatMessageInput,
  OperationDecision,
} from "../shared/types.js"
import type { SettingsStore } from "./store.js"
import { AuditLogger } from "./security/auditLogger.js"
import { TerminalRunStore } from "./terminal/runStore.js"
import { getRealProjectRoot, isSensitiveRelativePath } from "./security/pathGuard.js"
import { TaskManager } from "./tasks/taskManager.js"
import {
  beginDrag,
  endDrag,
  getPetWindow,
  moveDrag,
  setPetDetailExpanded,
  setPetExpanded,
  setPetPreferences,
} from "./window.js"

export function registerIpcHandlers(settingsStore: SettingsStore): void {
  const auditLogger = new AuditLogger(join(app.getPath("userData"), "operation-history.jsonl"))
  const terminalRunStore = new TerminalRunStore()
  const taskManager = new TaskManager({
    settingsStore,
    auditLogger,
    terminalRunStore,
    skipUserConfirmation: true,
  })

  app.on("browser-window-created", (_event, window) => {
    window.on("closed", () => {
      taskManager.revokeAllCapabilities()
    })
  })

  app.once("will-quit", () => terminalRunStore.close())

  ipcMain.handle("pet:set-expanded", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "boolean") throw new TypeError("expanded must be a boolean")
    setPetExpanded(value)
  })

  ipcMain.handle("pet:set-detail-expanded", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "boolean") throw new TypeError("detail expanded must be a boolean")
    setPetDetailExpanded(value)
  })

  ipcMain.on("pet:show-context-menu", (event) => {
    const owner = getPetWindow()
    if (!owner || owner.webContents !== event.sender) return

    Menu.buildFromTemplate([{ label: "关闭宠物", click: () => app.quit() }]).popup({
      window: owner,
    })
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
    const realSelectedPath = await chooseDirectory(settingsStore, "选择 Pingo 项目目录")
    if (!realSelectedPath) return null
    taskManager.revokeAllCapabilities()
    settingsStore.clearTrustedWorkspace()
    settingsStore.setAuthorizedProjectPath(realSelectedPath)
    return getProjectInfo(realSelectedPath)
  })

  ipcMain.handle("project:revoke", (event) => {
    assertTrustedSender(event.sender)
    taskManager.revokeAllCapabilities()
    settingsStore.clearTrustedWorkspace()
    settingsStore.clearAuthorizedProjectPath()
  })

  ipcMain.handle("project:open-path", async (event, value: unknown): Promise<boolean> => {
    assertTrustedSender(event.sender)
    const request = parseOpenPathRequest(value)
    const projectPath = settingsStore.getAuthorizedProjectPath()
    if (!projectPath) throw new Error("当前项目目录不可用")
    const root = getRealProjectRoot(projectPath)
    const candidate = isAbsolute(request.path) ? request.path : resolve(root, request.path)
    const target = realpathSync.native(candidate)
    const targetRelative = relative(root, target)
    if (
      targetRelative === ".." ||
      targetRelative.startsWith(`..${sep}`) ||
      isAbsolute(targetRelative) ||
      isSensitiveRelativePath(targetRelative) ||
      !statSync(target).isFile()
    ) {
      throw new Error("日志路径不在当前项目的普通文件范围内")
    }
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return true
  })

  ipcMain.handle("trusted-workspace:get", (event): TrustedWorkspace | null => {
    assertTrustedSender(event.sender)
    return getTrustedWorkspaceInfo(settingsStore)
  })

  ipcMain.handle("trusted-workspace:choose", async (event): Promise<TrustedWorkspace | null> => {
    assertTrustedSender(event.sender)
    const selectedPath = await chooseDirectory(settingsStore, "选择 Pingo 项目目录")
    if (!selectedPath) return null
    taskManager.revokeAllCapabilities()
    settingsStore.setTrustedWorkspace(selectedPath)
    auditLogger.record({
      taskId: "system",
      kind: "trusted_workspace.enable",
      targets: [selectedPath],
      status: "enabled",
    })
    return getTrustedWorkspaceInfo(settingsStore)
  })

  ipcMain.handle("trusted-workspace:disable", (event): boolean => {
    assertTrustedSender(event.sender)
    const storedWorkspace = settingsStore.getTrustedWorkspace()
    if (!storedWorkspace) return false
    taskManager.revokeAllCapabilities()
    settingsStore.clearTrustedWorkspace()
    auditLogger.record({
      taskId: "system",
      kind: "trusted_workspace.disable",
      targets: [storedWorkspace.path],
      status: "disabled",
    })
    return true
  })

  ipcMain.handle("trusted-workspace:forget", (event): boolean => {
    assertTrustedSender(event.sender)
    const storedWorkspace = settingsStore.getTrustedWorkspace()
    const storedProjectPath = settingsStore.getAuthorizedProjectPath()
    if (!storedWorkspace && !storedProjectPath) return false
    taskManager.revokeAllCapabilities()
    settingsStore.clearTrustedWorkspace()
    settingsStore.clearAuthorizedProjectPath()
    auditLogger.record({
      taskId: "system",
      kind: "trusted_workspace.forget",
      targets: [storedWorkspace?.path ?? storedProjectPath ?? ""],
      status: "forgotten",
    })
    return true
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
      const defaultPath = getSuggestedProjectPath(settingsStore)
      const options: OpenDialogOptions = {
        title: "选择要授权给 Pingo 的项目目录",
        properties: ["openDirectory", "createDirectory"],
        ...(defaultPath ? { defaultPath } : {}),
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
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

  ipcMain.handle("terminal-trust:list", (event) => {
    assertTrustedSender(event.sender)
    return taskManager.listTerminalTrust()
  })

  ipcMain.handle("terminal-trust:revoke-all", (event) => {
    assertTrustedSender(event.sender)
    taskManager.revokeAllTerminalTrust()
  })

  ipcMain.handle("terminal-runs:list", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    const query = parseTerminalRunQuery(value)
    return terminalRunStore.searchTerminalRuns(query.query, query.limit)
  })

  ipcMain.handle("terminal-runs:rerun", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "string" || value.length > 120) throw new TypeError("运行记录 ID 无效")
    const sender = event.sender
    return taskManager.rerunTerminalRun(String(sender.id), value, (taskEvent) => {
      if (!sender.isDestroyed()) sender.send("pingo:task-event", taskEvent)
    })
  })

  ipcMain.handle("terminal-runs:diff", (event, value: unknown) => {
    assertTrustedSender(event.sender)
    if (typeof value !== "object" || value === null) throw new TypeError("运行对比参数无效")
    const candidate = value as { leftRunId?: unknown; rightRunId?: unknown }
    if (
      typeof candidate.leftRunId !== "string" ||
      candidate.leftRunId.length > 120 ||
      typeof candidate.rightRunId !== "string" ||
      candidate.rightRunId.length > 120
    ) {
      throw new TypeError("运行对比参数无效")
    }
    return terminalRunStore.diffTerminalRuns(candidate.leftRunId, candidate.rightRunId)
  })

  ipcMain.handle("audit:list", (event) => {
    assertTrustedSender(event.sender)
    return taskManager.getAuditHistory()
  })
}

async function chooseDirectory(
  settingsStore: SettingsStore,
  title: string,
): Promise<string | null> {
  const defaultPath = getSuggestedProjectPath(settingsStore)
  const options: OpenDialogOptions = {
    title,
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  }
  const owner = getPetWindow()
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  const selectedPath = result.filePaths.at(0)
  if (result.canceled || !selectedPath) return null
  const realSelectedPath = realpathSync.native(selectedPath)
  if (!statSync(realSelectedPath).isDirectory()) throw new Error("选择的路径不是目录")
  return realSelectedPath
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

function parseOpenPathRequest(value: unknown): { path: string; line?: number; column?: number } {
  if (typeof value !== "object" || value === null) throw new TypeError("打开路径参数无效")
  const candidate = value as { path?: unknown; line?: unknown; column?: unknown }
  if (
    typeof candidate.path !== "string" ||
    !candidate.path.trim() ||
    candidate.path.length > 4_096 ||
    (candidate.line !== undefined &&
      (!Number.isSafeInteger(candidate.line) || (candidate.line as number) < 1)) ||
    (candidate.column !== undefined &&
      (!Number.isSafeInteger(candidate.column) || (candidate.column as number) < 1))
  ) {
    throw new TypeError("打开路径参数无效")
  }
  return {
    path: candidate.path.trim(),
    ...(candidate.line === undefined ? {} : { line: candidate.line as number }),
    ...(candidate.column === undefined ? {} : { column: candidate.column as number }),
  }
}

function parseTerminalRunQuery(value: unknown): { query: string; limit: number } {
  if (value === undefined || value === null) return { query: "", limit: 50 }
  if (typeof value !== "object") throw new TypeError("运行查询参数无效")
  const candidate = value as { query?: unknown; limit?: unknown }
  if (
    (candidate.query !== undefined &&
      (typeof candidate.query !== "string" || candidate.query.length > 200)) ||
    (candidate.limit !== undefined &&
      (!Number.isSafeInteger(candidate.limit) ||
        (candidate.limit as number) < 1 ||
        (candidate.limit as number) > 100))
  ) {
    throw new TypeError("运行查询参数无效")
  }
  return {
    query: typeof candidate.query === "string" ? candidate.query : "",
    limit: typeof candidate.limit === "number" ? candidate.limit : 50,
  }
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
    !["approve", "deny", "trust"].includes(candidate.decision as string) ||
    (candidate.reason !== undefined &&
      (typeof candidate.reason !== "string" || candidate.reason.length > 240))
  ) {
    throw new TypeError("operation decision 参数无效")
  }
  return {
    taskId: candidate.taskId,
    operationId: candidate.operationId,
    decision: candidate.decision as OperationDecision["decision"],
    ...(candidate.reason === undefined ? {} : { reason: candidate.reason.trim() }),
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

function getSuggestedProjectPath(settingsStore: SettingsStore): string | undefined {
  return [
    settingsStore.getTrustedWorkspace()?.path,
    settingsStore.getAuthorizedProjectPath(),
    app.isPackaged ? undefined : process.cwd(),
  ].find(isExistingDirectory)
}

function isExistingDirectory(value: string | undefined): value is string {
  if (!value || !isAbsolute(value)) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function getTrustedWorkspaceInfo(settingsStore: SettingsStore): TrustedWorkspace | null {
  const trusted = settingsStore.getTrustedWorkspace()
  if (!trusted) return null
  const project = getProjectInfo(trusted.path)
  if (!project) return null
  return { ...trusted, path: project.path, name: project.name }
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
