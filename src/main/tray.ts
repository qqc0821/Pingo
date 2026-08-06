import { app, Menu, nativeImage, Tray } from "electron"
import { getPetWindow, hidePetWindow, sendSettingsRequest, showPetWindow } from "./window.js"

let tray: Tray | null = null

export function createTray(): Tray {
  const icon = createTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip("Pingo")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 Pingo", click: showPetWindow },
      { label: "隐藏 Pingo", click: hidePetWindow },
      { type: "separator" },
      { label: "设置", click: sendSettingsRequest },
      { type: "separator" },
      { label: "退出 Pingo", click: () => app.quit() },
    ]),
  )
  tray.on("click", () => {
    const window = getPetWindow()
    if (window?.isVisible()) window.hide()
    else showPetWindow()
  })
  return tray
}

function createTrayIcon(): Electron.NativeImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="14" fill="#6366f1"/>
      <circle cx="11" cy="14" r="2" fill="#fff"/>
      <circle cx="21" cy="14" r="2" fill="#fff"/>
      <path d="M11 20c2.8 2.4 7.2 2.4 10 0" fill="none" stroke="#fff" stroke-linecap="round" stroke-width="2"/>
    </svg>
  `
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 18, height: 18 })
}
