/**
 * dsh-plugin-pet-notify —— DSH 主机插件
 *
 * 监听 DSH 的通知类事件,把短消息推送给 AI 桌面宠物(Pingo)显示气泡。
 *
 * 数据流(直连宠物,不依赖 pet-mcp-server):
 *   DSH 事件(turn/end、subagent/end、goal/changed …)
 *     → 本插件 → POST http://127.0.0.1:8790/notify (Pingo 主进程)
 *     → 宠物窗口显示气泡 + 动画。
 *
 * 配置(cordis.patch.yml 的 insert 项里写 config):
 *   url                    — 宠物通知地址,默认 http://127.0.0.1:8790/notify
 *   announceTurnEnd        — 正常回复完成时通知,默认 true
 *   announceSubagentEnd    — 子代理结束时通知,默认 true
 *   announceGoalChange     — 目标状态变更时通知,默认 true
 *   announceSessionCreated — 新会话创建时通知,默认 false(子代理也会建会话,噪声大)
 *
 * 也可以用环境变量 DSH_PET_NOTIFY_URL 覆盖 url(优先级低于 config.url)。
 */

const DEFAULT_NOTIFY_URL = "http://127.0.0.1:8790/notify"
const MAX_TEXT_LENGTH = 160
const HTTP_TIMEOUT_MS = 5000

const name = "pet-notify"

function readConfig(config) {
  const cfg = config && typeof config === "object" ? config : {}
  return {
    url:
      typeof cfg.url === "string" && cfg.url
        ? cfg.url
        : process.env.DSH_PET_NOTIFY_URL || DEFAULT_NOTIFY_URL,
    announceTurnEnd: cfg.announceTurnEnd !== false,
    announceSubagentEnd: cfg.announceSubagentEnd !== false,
    announceGoalChange: cfg.announceGoalChange !== false,
    // session/created 也会被子代理会话触发,噪声较大,默认关闭。
    announceSessionCreated: cfg.announceSessionCreated === true,
  }
}

async function push(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      console.error(`[pet-notify] 推送失败(${url}) status=${res.status}: ${detail.slice(0, 200)}`)
    }
    return res.ok
  } catch (error) {
    console.error(`[pet-notify] 推送失败(${url}): ${error?.message ?? error}`)
    return false
  }
}

/** content 可能是字符串,也可能是 content blocks 数组。 */
function extractContentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ")
    .trim()
}

/** lastAssistantMessage 可能是字符串,也可能是 content blocks 数组(子代理事件)。 */
function extractBlocksText(value) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .filter((block) => block && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ")
    .trim()
}

function summarize(text, max = MAX_TEXT_LENGTH) {
  const clean = String(text).replace(/\s+/g, " ").trim()
  if (!clean) return ""
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** 取本会话最后一条 assistant/message 的文本。 */
function extractLastAssistantText(session) {
  const events = session && Array.isArray(session.events) ? session.events : []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.type === "assistant/message") {
      const text = extractContentText(event.data?.message?.content)
      if (text) return text
    }
  }
  return ""
}

const GOAL_OPERATION_LABELS = {
  create: "已创建",
  edit: "已更新",
  pause: "已暂停",
  resume: "已恢复",
  complete: "已完成",
  blocked: "被阻塞",
}

function apply(ctx, config) {
  const options = readConfig(config)
  ctx.logger.info(`pet-notify: 通知将推送到 ${options.url}`)

  if (options.announceTurnEnd) {
    ctx.on(
      "session/event",
      (session, event) => {
        if (!event || event.type !== "turn/end") return
        // 子代理会话由 announceSubagentEnd 负责,避免重复提示。
        if (session?.header?.origin === "subagent") return
        const kind = event.data?.reason?.kind
        if (kind === "blocked" || kind === "aborted") return
        if (kind === "error") {
          void push(options.url, {
            text: "DSH 执行出错了",
            mood: "sad",
            kind: "turn",
            source: "dsh:turn/end:error",
          })
          return
        }
        const reply = summarize(extractLastAssistantText(session))
        void push(options.url, {
          text: reply ? `DSH 回复:${reply}` : "DSH 已完成回复",
          mood: "happy",
          kind: "turn",
          source: "dsh:turn/end",
        })
      },
      { global: true },
    )
  }

  if (options.announceSubagentEnd) {
    ctx.on(
      "subagent/end",
      (info) => {
        const detail = summarize(extractBlocksText(info?.lastAssistantMessage))
        const stop = info?.stopReason ?? "completed"
        const text = detail ? `子代理完成:${detail}` : `子代理结束(${stop})`
        void push(options.url, {
          text,
          mood: "neutral",
          kind: "subagent",
          source: `dsh:subagent/end:${stop}`,
        })
      },
      { global: true },
    )
  }

  if (options.announceGoalChange) {
    ctx.on(
      "goal/changed",
      (payload) => {
        const change = payload?.change
        const operation = change?.operation ?? "update"
        const goal = change?.goal
        const objective =
          goal && typeof goal.objective === "string" ? summarize(goal.objective) : ""
        const label = GOAL_OPERATION_LABELS[operation] ?? "已更新"
        const text = objective ? `目标${label}:${objective}` : `目标状态更新:${operation}`
        void push(options.url, {
          text,
          mood: operation === "blocked" ? "sad" : "neutral",
          kind: "goal",
          source: `dsh:goal/${operation}`,
        })
      },
      { global: true },
    )
  }

  if (options.announceSessionCreated) {
    ctx.on(
      "session/created",
      () => {
        void push(options.url, {
          text: "新会话已创建",
          mood: "neutral",
          kind: "system",
          source: "dsh:session/created",
        })
      },
      { global: true },
    )
  }
}

export { apply, name }
