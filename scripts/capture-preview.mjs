// 本地视觉检查脚本:渲染宠物窗口各预览场景,输出布局度量并截图。
// 用法:node_modules/.bin/electron scripts/capture-preview.mjs
import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import { writeFileSync, mkdirSync } from "node:fs"

const ROOT = "/Users/nicolas/Projects_app/Pingo"
const RENDERER = join(ROOT, "out/renderer/index.html")
const OUT = process.env.PINGO_CAPTURE_DIR || join(ROOT, "build/pet-shots")
const EXPANDED_SIZE = { width: 392, height: 350 }
const DETAIL_EXPANDED_SIZE = { width: 464, height: 558 }

const SCENES = [
  { name: "stack", query: { promptPreview: "stack" } },
  { name: "stack-detail", query: { promptPreview: "stack", detailOpen: "1" } },
  { name: "stack-composer", query: { promptPreview: "stack", composer: "1" } },
  { name: "success-composer", query: { promptPreview: "success", composer: "1" } },
  { name: "success", query: { promptPreview: "success" } },
  { name: "progress", query: { promptPreview: "progress" } },
  { name: "warning", query: { promptPreview: "warning" } },
  { name: "error", query: { promptPreview: "error" } },
  { name: "long", query: { promptPreview: "long" } },
]

const ONLY = process.argv.find((arg) => arg.startsWith("--scene="))?.slice("--scene=".length)
const SHOW_PET_TOGGLE = process.argv.includes("--show-pet-toggle")
const SHOW_PREVIOUS_MESSAGE = process.argv.includes("--previous-message")
const targets = ONLY ? SCENES.filter((scene) => scene.name === ONLY) : SCENES

const METRICS_JS = `(() => {
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  const cards = [...document.querySelectorAll(".pet-prompt")].map((el) => ({
    tone: el.className.match(/pet-prompt--(\\w+)/)?.[1],
    expanded: el.classList.contains("pet-prompt--expanded"),
    rect: rect(el),
    contentHeight: Math.round(el.querySelector(".pet-prompt-content")?.getBoundingClientRect().height ?? 0),
    contentScrollHeight: el.querySelector(".pet-prompt-content")?.scrollHeight ?? 0,
  }))
  const stack = document.querySelector(".pet-prompt-stack")
  const layer = document.querySelector(".pet-prompt-layer")
  const overflow = (el, label) => {
    if (!el) return null
    return { label, scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, overflowY: getComputedStyle(el).overflowY }
  }
  const textarea = document.querySelector(".quick-composer textarea")
  return {
    viewport: { w: vw, h: vh },
    layer: rect(layer),
    stack: rect(stack),
    stackOverflow: overflow(stack, "stack"),
    carouselNav: rect(document.querySelector(".pet-prompt-carousel-nav")),
    carouselPosition: document.querySelector(".pet-prompt-carousel-nav span")?.textContent?.trim() ?? null,
    composer: rect(document.querySelector(".quick-composer")),
    composerShell: rect(document.querySelector(".quick-composer-shell")),
    textareaHeight: textarea ? Math.round(textarea.getBoundingClientRect().height) : null,
    dock: rect(document.querySelector(".pet-dock")),
    petToggle: rect(document.querySelector(".pet-prompt-toggle-button")),
    cards,
    cardGap: cards.length > 1 ? Math.round(cards[1].rect.top - cards[0].rect.bottom) : null,
    bodyScroll: document.body.scrollHeight,
  }
})()`

app.commandLine.appendSwitch("no-sandbox")
app.commandLine.appendSwitch("disable-gpu")
app.commandLine.appendSwitch("disable-gpu-compositing")
app.commandLine.appendSwitch("disable-software-rasterizer")
app.disableHardwareAcceleration()

async function captureScene(scene) {
  const isDetail = scene.query.detailOpen === "1"
  const size = isDetail ? DETAIL_EXPANDED_SIZE : EXPANDED_SIZE
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
  })
  try {
    await win.loadFile(RENDERER, { query: scene.query })
    await new Promise((resolve) => setTimeout(resolve, 900))
    await win.webContents
      .executeJavaScript(
        `document.documentElement.style.setProperty("background", "#eceff3");
         document.body.style.setProperty("background", "#eceff3");
         document.querySelector(".app-shell")?.style.setProperty("background", "#eceff3");`,
      )
      .catch(() => {})
    if (SHOW_PET_TOGGLE) {
      const point = await win.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector(".pet-dock")?.getBoundingClientRect()
        return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height - 18) } : null
      })()`)
      if (point) win.webContents.sendInputEvent({ type: "mouseMove", ...point })
    }
    if (SHOW_PREVIOUS_MESSAGE) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.pet-prompt-carousel-nav button[aria-label="上一条消息"]')?.click()`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    const metrics = await win.webContents.executeJavaScript(METRICS_JS)
    console.log(`\n=== ${scene.name} ===`)
    console.log(JSON.stringify(metrics, null, 1))
    const image = await win.webContents.capturePage()
    writeFileSync(join(OUT, `${scene.name}.png`), image.toPNG())
  } catch (error) {
    console.error(`\n=== ${scene.name} FAILED ===`, error?.message ?? error)
  } finally {
    win.destroy()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  for (const scene of targets) {
    await captureScene(scene)
  }
  console.log(`\nsaved shots to ${OUT}`)
  app.quit()
})
