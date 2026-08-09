import type { ChatMessageInput } from "../../shared/types.js"
import type { ModelRequestMessage } from "../ai/client.js"

export const TOOL_SYSTEM_CONTENT =
  "你是 Pingo，本地项目助手。回答项目相关问题时，必须通过结构化 tool_calls 获取事实，不要凭空猜测仓库内容。" +
  "权限、风险等级、确认结果和实际执行都由 Pingo 主进程决定。" +
  "不要索要或读取密钥、环境变量、.git、.ssh 或目录外文件；收到 denied、未授权或策略拒绝结果时，向用户解释并停止重复相同操作。" +
  "不要构造 Shell 字符串；不要提出 Shell、解释器、sudo、安装、永久删除或系统自动化请求。" +
  "硬性规则：若需要查看、搜索、读取或修改项目，必须在同一轮回复里直接发起 tool_calls；禁止只说计划、打算或步骤后就结束本轮。" +
  "调用工具时只输出 tool_calls 字段，绝不要把函数名、JSON 参数或伪造的调用写进 content。" +
  "纯闲聊、解释概念或不依赖本地文件的问题可以不调用工具。" +
  "有 tool_calls 时，content 可为空或只保留极短意图；最终对用户的完整回答放在工具结果返回之后的那一轮。"

export interface ToolConversationOptions {
  maxHistory?: number
  /** 已授权项目时注入，降低模型“空聊不调工具”的概率 */
  projectAuthorized?: boolean
  projectName?: string
}

export function buildToolConversation(
  messages: ChatMessageInput[],
  options: ToolConversationOptions | number = {},
): ModelRequestMessage[] {
  const normalized =
    typeof options === "number" ? { maxHistory: options } : (options ?? {})
  const maxHistory = normalized.maxHistory ?? 24
  const parts = [TOOL_SYSTEM_CONTENT]
  if (normalized.projectAuthorized) {
    const name = normalized.projectName?.trim()
    parts.push(
      name
        ? `用户已授权本地项目「${name}」。请优先调用 list_files、search_files、read_file 等工具查阅后再回答。`
        : "用户已授权本地项目目录。请优先调用 list_files、search_files、read_file 等工具查阅后再回答。",
    )
  } else {
    parts.push(
      "用户尚未授权项目目录时，不要假装已经读过文件；若任务依赖本地项目，请明确请用户先选择并授权目录。",
    )
  }

  return [{ role: "system", content: parts.join("") }, ...messages.slice(-maxHistory)]
}

/** 用于判断“只说了计划却没调工具”的弱信号，触发一次强制重试 */
export function looksLikePlanWithoutTools(content: string): boolean {
  const text = content.trim()
  if (!text) return false
  if (text.length > 400) return false
  // 避免匹配最终答复里的普通用词（如「已安全读取」）
  return /(我先|让我|我会|我将|打算|准备|接下来|步骤如下|分析一下|看一下|先搜索|先读取|先列出|先查看)/.test(
    text,
  )
}

export const TOOL_NUDGE_MESSAGE: ChatMessageInput = {
  role: "user",
  content:
    "系统提醒：上一轮没有发起 tool_calls。若任务依赖本地项目，请立刻调用合适的工具；不要只描述计划。",
}
