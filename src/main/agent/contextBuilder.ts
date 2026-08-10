import type { ChatMessageInput } from "../../shared/types.js"
import type { ModelRequestMessage } from "../ai/client.js"

export const TOOL_SYSTEM_CONTENT =
  "你是 Pingo，本地项目助手。回答项目相关问题时，必须通过结构化 tool_calls 获取事实，不要凭空猜测仓库内容。" +
  "实际执行由 Pingo 主进程决定。" +
  "不要索要或读取密钥、环境变量、.git、.ssh 或目录外文件；收到策略拒绝结果时，向用户解释并停止重复相同操作。" +
  "不要构造 Shell 字符串；不要提出 Shell、解释器、sudo、安装、永久删除或系统自动化请求。" +
  "硬性规则：若需要查看、搜索、读取或修改项目，必须在同一轮回复里直接发起 tool_calls；禁止只说计划、打算或步骤后就结束本轮。" +
  "调用工具时只输出 tool_calls 字段，绝不要把函数名、JSON 参数或伪造的调用写进 content。" +
  "纯闲聊、解释概念或不依赖本地文件的问题可以不调用工具。" +
  "有 tool_calls 时，content 可为空或只保留极短意图；最终对用户的完整回答放在工具结果返回之后的那一轮。" +
  "最终回答必须先直接给出用户要的结论或结果，再补充依据、列表或说明；不要用“任务已完成”“处理完成”等状态句代替结果。例如被问到文件夹数量时，先回答“桌面共有 12 个文件夹”。"

export interface ToolConversationOptions {
  maxHistory?: number
  /** 当前项目可用时注入，降低模型“空聊不调工具”的概率 */
  projectAuthorized?: boolean
  projectName?: string
  /** 当前项目目录的绝对路径，避免模型猜测路径或误判目录未挂载 */
  projectPath?: string
}

export function buildToolConversation(
  messages: ChatMessageInput[],
  options: ToolConversationOptions | number = {},
): ModelRequestMessage[] {
  const normalized = typeof options === "number" ? { maxHistory: options } : (options ?? {})
  const maxHistory = normalized.maxHistory ?? 24
  const parts = [TOOL_SYSTEM_CONTENT]
  if (normalized.projectAuthorized) {
    const name = normalized.projectName?.trim()
    const path = normalized.projectPath?.trim()
    parts.push(
      name
        ? `当前本地项目是「${name}」。请优先调用 list_files、search_files、read_file 等工具查阅后再回答。`
        : "当前本地项目目录可用。请优先调用 list_files、search_files、read_file 等工具查阅后再回答。",
    )
    if (path) {
      parts.push(
        `该目录的绝对路径是 ${path}；被问到项目位置时直接引用它，不要重新推断。` +
          "工具参数只接受相对这个目录的路径，“.”表示目录本身；" +
          "工具报告某个相对路径不存在或不可读时，说明只是那一项不可用，不代表项目目录不可用。",
      )
    }
  } else {
    parts.push("当前项目目录不可用时，不要假装已经读过文件；请解释目录不可访问并建议检查项目位置。")
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
