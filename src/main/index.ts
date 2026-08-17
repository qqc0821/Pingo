import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import { loadDotEnv } from "./env.js"
import { registerIpcHandlers } from "./ipc.js"
import { startNotifyServer, stopNotifyServer } from "./notifyServer.js"
import { SettingsStore } from "./store.js"
import { createTray } from "./tray.js"
import { createPetWindow } from "./window.js"

app.setAppUserModelId("com.pingo.desktop")

app.whenReady().then(() => {
  const appDataPath = app.getPath("appData")
  loadDotEnv([
    process.cwd(),
    app.getPath("userData"),
    join(appDataPath, "Pingo"),
    join(appDataPath, "pingo"),
  ])
  const store = new SettingsStore(app.getPath("userData"))
  const preferences = store.getPreferences()
  process.env.MODEL_BASE_URL = preferences.modelBaseUrl
  process.env.MODEL_NAME = preferences.modelName
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin })
  registerIpcHandlers(store)
  createPetWindow(store)
  createTray()
  startNotifyServer()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow(store)
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("will-quit", () => {
  stopNotifyServer()
})
