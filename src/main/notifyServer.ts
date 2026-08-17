import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { showPetWindow, sendPetNotification } from "./window.js"
import type { PetNotification } from "../shared/types.js"

const DEFAULT_PORT = 8790
const MAX_BODY_BYTES = 64 * 1024

let server: Server | null = null

/**
 * 本地回环 HTTP 入口:让外部进程(DSH 插件 / pet-mcp-server 的 bridge)能
 * 把"宠物说话/换情绪/做动作"投递到 Pingo 的宠物窗口。
 *
 * 只绑定 127.0.0.1,不暴露到局域网。
 */
export function startNotifyServer(port = readPort()): void {
  if (server) return

  server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: String(error) })
    })
  })

  server.on("error", (error) => {
    console.error(`[pingo-notify] server error:`, error)
  })

  server.listen(port, "127.0.0.1", () => {
    console.log(`[pingo-notify] listening on http://127.0.0.1:${port}`)
  })
}

export function stopNotifyServer(): void {
  server?.close()
  server = null
}

function readPort(): number {
  const raw = Number(process.env.PINGO_NOTIFY_PORT ?? DEFAULT_PORT)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "method not allowed" })
    return
  }

  const body = await readJsonBody(req)
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "invalid JSON body" })
    return
  }

  const notification = normalizeNotification(body, url.pathname)
  if (!notification) {
    sendJson(res, 400, { ok: false, error: "nothing to do: need text, mood, or action" })
    return
  }

  sendPetNotification(notification)
  showPetWindow()
  sendJson(res, 200, { ok: true, received: notification })
}

function normalizeNotification(
  body: Record<string, unknown>,
  pathname: string,
): PetNotification | null {
  const text = typeof body.text === "string" ? body.text.slice(0, 2000) : ""
  const mood = isMood(body.mood) ? body.mood : undefined
  const action = isAction(body.action) ? body.action : undefined

  // 便捷路径:/mood /animate 只需一个字段。
  if (pathname === "/mood" && mood) return { text, mood }
  if (pathname === "/animate" && action) return { text, action }

  if (!text && !mood && !action) return null
  return { text, ...(mood ? { mood } : {}), ...(action ? { action } : {}) }
}

function isMood(value: unknown): value is NonNullable<PetNotification["mood"]> {
  return (
    typeof value === "string" &&
    ["happy", "sad", "excited", "sleepy", "angry", "neutral"].includes(value)
  )
}

function isAction(value: unknown): value is NonNullable<PetNotification["action"]> {
  return typeof value === "string" && ["dance", "wave", "jump", "sleep", "idle"].includes(value)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw.trim()) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {})
      } catch {
        resolve(null)
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}
