import type { PetNotification, PetPromptItem } from "./types.js"

/** 默认只平铺展示的折叠卡数量,超出部分收进"还有 N 条"分组。
    小窗口(392×312)内 2 行紧凑卡可无滚动放下,3 行会触发内部滚动。 */
export const MAX_VISIBLE_PROMPTS = 2
/** 同一来源通知在冷却窗内合并为一张卡(更新内容 + 计数)。 */
export const NOTIFICATION_COOLDOWN_MS = 4000
/** 非 sticky 通知卡超过该时长后自动折入"更多"分组(仅折叠,不删除)。 */
export const NOTIFICATION_FOLD_TTL_MS = 60000
/** 外部 id / source 的合理上限,超出截断。 */
export const MAX_SOURCE_LENGTH = 64

let nextPromptId = 0

/** 生成渲染层唯一 id(进程内自增,足够稳定用于 React key 与 aria-controls)。 */
export function createPromptId(prefix: string): string {
  nextPromptId += 1
  return `${prefix}-${nextPromptId}-${Date.now().toString(36)}`
}

/** 任务卡的去重键:一次任务 = 一张卡。 */
export function taskDedupKey(taskId: string): string {
  return `task:${taskId}`
}

/** 外部通知的去重键:id 优先,其次 source;两者都没有则按内容归一。 */
export function dedupeKeyFor(notification: PetNotification): string | null {
  const id = typeof notification.id === "string" && notification.id ? notification.id : ""
  if (id) return `id:${id.slice(0, MAX_SOURCE_LENGTH)}`
  const source = typeof notification.source === "string" ? notification.source : ""
  if (source) return `src:${source.slice(0, MAX_SOURCE_LENGTH)}`
  const text = typeof notification.text === "string" ? notification.text.trim() : ""
  if (text) return `text:${text.slice(0, 120)}`
  return null
}

export interface UpsertPromptItemOptions {
  /** 归一化后的内容;提供则替换 content/tone/label/expandable。 */
  tone?: PetPromptItem["tone"]
  label?: string
  content?: string
  summary?: string
  expandable?: boolean
  sticky?: boolean
  kind?: PetPromptItem["kind"]
  /** 合并计数(用于通知卡);缺省 1。 */
  count?: number
}

/**
 * 按 dedupKey 原地更新或追加一张卡。
 * 已存在:更新字段并刷新 updatedAt,保留原位置与 id。
 * 不存在:追加到末尾(堆叠中末尾 = 最新,紧贴宠物)。
 */
export function upsertPromptItem(
  stack: PetPromptItem[],
  base: PetPromptItem,
  patch: UpsertPromptItemOptions = {},
  now = Date.now(),
): PetPromptItem[] {
  const existing = stack.find(
    (item) => item.dedupKey !== undefined && item.dedupKey === base.dedupKey,
  )
  if (existing) {
    const merged: PetPromptItem = {
      ...existing,
      ...patch,
      content: patch.content ?? existing.content,
      summary: patch.summary ?? existing.summary,
      label: patch.label ?? existing.label,
      tone: patch.tone ?? existing.tone,
      expandable: patch.expandable ?? existing.expandable,
      updatedAt: now,
      count: patch.count ?? existing.count,
    }
    return stack.map((item) => (item === existing ? merged : item))
  }
  return [
    ...stack,
    {
      ...base,
      ...patch,
      content: patch.content ?? base.content,
      summary: patch.summary ?? base.summary,
      label: patch.label ?? base.label,
      tone: patch.tone ?? base.tone,
      createdAt: base.createdAt,
      updatedAt: now,
      count: patch.count ?? base.count ?? 1,
    },
  ]
}

export interface PushNotificationOptions {
  now?: number
  cooldownMs?: number
  /** 由调用方提供的渲染字段(如分类标签)。 */
  labelFor?: (notification: PetNotification) => string
  toneFor?: (notification: PetNotification) => PetPromptItem["tone"]
}

/**
 * 把一条外部通知推入堆叠。
 * 冷却窗内同去重键 → 合并到已有卡(内容更新、计数 +1);
 * 否则在末尾追加一张新通知卡。
 */
export function pushNotification(
  stack: PetPromptItem[],
  notification: PetNotification,
  options: PushNotificationOptions = {},
): PetPromptItem[] {
  const now = options.now ?? Date.now()
  const cooldownMs = options.cooldownMs ?? NOTIFICATION_COOLDOWN_MS
  const label = options.labelFor ? options.labelFor(notification) : "新通知"
  const tone = options.toneFor ? options.toneFor(notification) : "neutral"

  const dedupKey = dedupeKeyFor(notification)
  if (dedupKey) {
    // 只与"最近一张"同 key 卡合并,避免越过冷却窗后还合进旧卡。
    let target: PetPromptItem | undefined
    for (let i = stack.length - 1; i >= 0; i--) {
      const candidate = stack[i]
      if (candidate && candidate.dedupKey === dedupKey) {
        target = candidate
        break
      }
    }
    if (target && now - target.updatedAt <= cooldownMs) {
      const merged: PetPromptItem = {
        ...target,
        content: notification.text || target.content,
        tone,
        updatedAt: now,
        count: (target.count ?? 1) + 1,
        notification,
      }
      return stack.map((item) => (item === target ? merged : item))
    }
  }

  return [
    ...stack,
    {
      id: createPromptId("note"),
      kind: notification.kind === "mcp" ? "mcp" : "notification",
      tone,
      label,
      content: notification.text,
      expandable: notification.text.length > 120,
      createdAt: now,
      updatedAt: now,
      dedupKey: dedupKey ?? undefined,
      count: 1,
      notification,
    },
  ]
}

/** 移除指定 id 的卡,返回新堆叠。 */
export function removePromptItem(stack: PetPromptItem[], id: string): PetPromptItem[] {
  return stack.filter((item) => item.id !== id)
}

export interface CollapseStackOptions {
  maxVisible?: number
  now?: number
  ttlMs?: number
}

export interface CollapsedStack {
  /** 平铺展示的卡(顺序保持:最新在末尾)。 */
  visible: PetPromptItem[]
  /** 折入"更多"分组的卡。 */
  hidden: PetPromptItem[]
}

/**
 * 计算平铺可见卡与折叠卡:
 * - 最近的 maxVisible 张卡始终可见(堆叠数组顺序为旧→新,末尾最新);
 * - 其余卡折入 hidden;非 sticky 卡超过 TTL 后也折入 hidden(仅折叠,不删除)。
 */
export function collapseStack(
  stack: PetPromptItem[],
  options: CollapseStackOptions = {},
): CollapsedStack {
  const now = options.now ?? Date.now()
  const maxVisible = options.maxVisible ?? MAX_VISIBLE_PROMPTS
  const ttlMs = options.ttlMs ?? NOTIFICATION_FOLD_TTL_MS

  const visible: PetPromptItem[] = []
  const hidden: PetPromptItem[] = []
  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i]
    if (!item) continue
    const expired = !item.sticky && now - item.updatedAt > ttlMs
    if (expired || visible.length >= maxVisible) {
      hidden.push(item)
    } else {
      visible.push(item)
    }
  }
  // 收集时是最新在前,翻转回时间顺序(旧→新,最新在末尾)。
  visible.reverse()
  hidden.reverse()
  return { visible, hidden }
}
