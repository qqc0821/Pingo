import type { ChatMessageInput, ChatStreamEvent } from "../../shared/types.js"
import type { ToolDefinition, ToolExecution } from "../tools/types.js"

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1/chat/completions"
const DEFAULT_MODEL = "deepseek-chat"
const NETWORK_REQUEST_TIMEOUT_MS = 60_000
const MAX_HISTORY = 24
const MAX_TOOL_LOOPS = 6

const TOOL_SYSTEM_MESSAGE: ChatMessageInput = {
  role: "system",
  content:
    "你是 Pingo，本地项目助手。只能通过结构化工具提出请求；权限、风险等级、确认结果和实际执行都由 Pingo 主进程决定。不要索要或读取密钥、环境变量、.git、.ssh 或目录外文件；收到 denied、未授权或策略拒绝结果时，向用户解释并停止重复相同操作。不要构造 Shell 字符串，不要提出 Shell、解释器、sudo、安装、永久删除或系统自动化请求。",
}

interface ActiveRequest {
  controller: AbortController
  cancelled: boolean
  timedOut: boolean
}

interface ToolCall {
  id: string
  name: string
  arguments: string
}

interface ModelToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type ModelRequestMessage =
  | ChatMessageInput
  | { role: "assistant"; content: string | null; tool_calls: ModelToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
}

export type ToolExecutor = (name: string, args: unknown) => Promise<ToolExecution>

export class ModelClient {
  private activeRequest: ActiveRequest | null = null

  async stream(
    messages: ChatMessageInput[],
    emit: (event: ChatStreamEvent) => void,
    executeTool?: ToolExecutor,
    toolDefinitions: ToolDefinition[] = [],
  ): Promise<void> {
    this.cancel()

    const apiKey = process.env.MODEL_API_KEY?.trim()
    if (!apiKey) {
      emit({
        type: "error",
        message:
          "尚未配置模型密钥。开发环境请复制 .env.example 为 .env；打包版请在 ~/Library/Application Support/pingo/.env 中填写 MODEL_API_KEY。",
      })
      return
    }

    const request: ActiveRequest = {
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
    }
    this.activeRequest = request
    emit({ type: "start" })

    try {
      if (executeTool && toolDefinitions.length > 0) {
        await this.streamWithTools(messages, emit, executeTool, toolDefinitions, apiKey, request)
      } else {
        await this.streamText(messages, emit, apiKey, request)
      }
      if (!request.cancelled) emit({ type: "done" })
    } catch (error) {
      if (request.cancelled) emit({ type: "cancelled" })
      else if (request.timedOut) emit({ type: "error", message: "模型请求超时，请稍后重试。" })
      else emit({ type: "error", message: toSafeErrorMessage(error) })
    } finally {
      if (this.activeRequest === request) this.activeRequest = null
    }
  }

  cancel(): void {
    if (!this.activeRequest) return
    this.activeRequest.cancelled = true
    this.activeRequest.controller.abort()
    this.activeRequest = null
  }

  private async streamText(
    messages: ChatMessageInput[],
    emit: (event: ChatStreamEvent) => void,
    apiKey: string,
    request: ActiveRequest,
  ): Promise<void> {
    const response = await this.fetchCompletion(messages.slice(-MAX_HISTORY), apiKey, true, request)
    if (!response.body) throw new Error("模型服务没有返回可读取的流")
    await readServerSentEvents(response.body, emit, request.controller.signal)
  }

  private async streamWithTools(
    messages: ChatMessageInput[],
    emit: (event: ChatStreamEvent) => void,
    executeTool: ToolExecutor,
    toolDefinitions: ToolDefinition[],
    apiKey: string,
    request: ActiveRequest,
  ): Promise<void> {
    let conversation: ModelRequestMessage[] = [TOOL_SYSTEM_MESSAGE, ...messages.slice(-MAX_HISTORY)]

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
      const response = await this.fetchCompletion(
        conversation,
        apiKey,
        false,
        request,
        toolDefinitions,
      )
      const result = parseCompletion(await response.json())
      if (result.content) emit({ type: "chunk", content: result.content })
      if (result.toolCalls.length === 0) return

      conversation = [
        ...conversation,
        {
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map(toModelToolCall),
        },
      ]
      for (const toolCall of result.toolCalls) {
        if (request.cancelled) return
        const args = parseToolArguments(toolCall.arguments)
        // This promise may intentionally wait for a human permission or approval decision.
        // Execution-specific limits belong to the tool (for example TerminalRunner), not here.
        const execution = await executeTool(toolCall.name, args)
        emit({ type: "tool", name: toolCall.name, detail: execution.detail })
        conversation.push({ role: "tool", tool_call_id: toolCall.id, content: execution.content })
      }
    }

    throw new Error("模型连续请求工具次数过多，已停止本次对话。")
  }

  private async fetchCompletion(
    messages: ModelRequestMessage[],
    apiKey: string,
    stream: boolean,
    request: ActiveRequest,
    toolDefinitions: ToolDefinition[] = [],
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: process.env.MODEL_NAME?.trim() || DEFAULT_MODEL,
      messages,
      stream,
      temperature: stream ? 1.4 : 0.2,
    }
    if (toolDefinitions.length > 0) {
      body.tools = toolDefinitions
      body.tool_choice = "auto"
    }

    const networkController = new AbortController()
    const abortNetwork = () => networkController.abort()
    request.controller.signal.addEventListener("abort", abortNetwork, { once: true })
    if (request.controller.signal.aborted) networkController.abort()
    const timeout = setTimeout(() => {
      request.timedOut = true
      networkController.abort()
    }, NETWORK_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(process.env.MODEL_BASE_URL?.trim() || DEFAULT_BASE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: networkController.signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).trim().slice(0, 180)
        throw new Error(`模型服务返回 ${response.status}${detail ? `：${detail}` : ""}`)
      }
      return response
    } finally {
      clearTimeout(timeout)
      request.controller.signal.removeEventListener("abort", abortNetwork)
    }
  }
}

async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  emit: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (signal.aborted) return

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") return

      const content = getDeltaContent(data)
      if (content) emit({ type: "chunk", content })
    }
  }
}

function parseCompletion(value: unknown): CompletionResult {
  if (typeof value !== "object" || value === null) throw new Error("模型返回格式无效")
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("模型没有返回候选回答")
  const choice = choices[0]
  if (typeof choice !== "object" || choice === null) throw new Error("模型返回格式无效")
  const message = (choice as { message?: unknown }).message
  if (typeof message !== "object" || message === null) throw new Error("模型没有返回消息")

  const contentValue = (message as { content?: unknown }).content
  const rawCalls = (message as { tool_calls?: unknown }).tool_calls
  const toolCalls = Array.isArray(rawCalls) ? rawCalls.flatMap(parseToolCall) : []
  return { content: typeof contentValue === "string" ? contentValue : "", toolCalls }
}

function parseToolCall(value: unknown): ToolCall[] {
  if (typeof value !== "object" || value === null) return []
  const call = value as { id?: unknown; function?: unknown }
  if (typeof call.id !== "string" || typeof call.function !== "object" || call.function === null)
    return []
  const functionCall = call.function as { name?: unknown; arguments?: unknown }
  if (typeof functionCall.name !== "string" || typeof functionCall.arguments !== "string") return []
  return [{ id: call.id, name: functionCall.name, arguments: functionCall.arguments }]
}

function toModelToolCall(toolCall: ToolCall): ModelToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function getDeltaContent(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const choices = (parsed as { choices?: unknown }).choices
    if (!Array.isArray(choices) || choices.length === 0) return null
    const firstChoice = choices[0]
    if (typeof firstChoice !== "object" || firstChoice === null) return null
    const delta = (firstChoice as { delta?: unknown }).delta
    if (typeof delta !== "object" || delta === null) return null
    const content = (delta as { content?: unknown }).content
    return typeof content === "string" ? content : null
  } catch {
    return null
  }
}

function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240)
  return "模型请求失败，请检查网络和模型配置。"
}
