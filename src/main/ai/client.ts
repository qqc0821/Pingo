import type { ChatMessageInput } from "../../shared/types.js"
import type { ToolDefinition } from "../tools/types.js"

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1/chat/completions"
const DEFAULT_MODEL = "deepseek-v4-pro"
const NETWORK_REQUEST_TIMEOUT_MS = 60_000

interface ActiveRequest {
  controller: AbortController
  cancelled: boolean
  timedOut: boolean
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ModelToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ModelRequestMessage =
  | ChatMessageInput
  | { role: "assistant"; content: string | null; tool_calls: ModelToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
}

/** Narrow model boundary used by the agent loop and task owner. */
export interface ModelGateway {
  completeWithTools(
    messages: ModelRequestMessage[],
    toolDefinitions: ToolDefinition[],
  ): Promise<CompletionResult>
  cancel(): void
}

export class ModelClient implements ModelGateway {
  private activeRequest: ActiveRequest | null = null

  cancel(): void {
    if (!this.activeRequest) return
    this.activeRequest.cancelled = true
    this.activeRequest.controller.abort()
    this.activeRequest = null
  }

  async completeWithTools(
    messages: ModelRequestMessage[],
    toolDefinitions: ToolDefinition[],
  ): Promise<CompletionResult> {
    this.cancel()
    const apiKey = process.env.MODEL_API_KEY?.trim()
    if (!apiKey) {
      throw new Error(
        "尚未配置模型密钥。开发环境请复制 .env.example 为 .env；打包版请在 ~/Library/Application Support/pingo/.env 中填写 MODEL_API_KEY。",
      )
    }

    const request: ActiveRequest = {
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
    }
    this.activeRequest = request
    try {
      const response = await this.fetchCompletion(messages, apiKey, request, toolDefinitions)
      return parseCompletion(await response.json())
    } catch (error) {
      if (request.timedOut) throw new Error("模型请求超时，请稍后重试。")
      throw error
    } finally {
      if (this.activeRequest === request) this.activeRequest = null
    }
  }

  private async fetchCompletion(
    messages: ModelRequestMessage[],
    apiKey: string,
    request: ActiveRequest,
    toolDefinitions: ToolDefinition[] = [],
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: process.env.MODEL_NAME?.trim() || DEFAULT_MODEL,
      messages,
      stream: false,
      temperature: 0.2,
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

export function parseCompletion(value: unknown): CompletionResult {
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
  if (typeof functionCall.name !== "string") return []
  if (typeof functionCall.arguments === "string") {
    return [{ id: call.id, name: functionCall.name, arguments: functionCall.arguments }]
  }
  if (typeof functionCall.arguments === "object" && functionCall.arguments !== null) {
    return [
      {
        id: call.id,
        name: functionCall.name,
        arguments: JSON.stringify(functionCall.arguments),
      },
    ]
  }
  return []
}

export function parseToolArguments(value: string | Record<string, unknown>): unknown {
  if (typeof value === "object" && value !== null) return value
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}
