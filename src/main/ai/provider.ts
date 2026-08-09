import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import type { ModelDiagnostics } from "./modelDiagnostics.js"

export const DEFAULT_MODEL_NAME = "deepseek-chat"
export const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com/v1"

export interface ModelProviderOptions {
  apiKey: string
  modelName?: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  diagnostics?: ModelDiagnostics
}

export interface PingoModelProvider {
  model: LanguageModel
  modelName: string
  baseUrl: string
}

/** Accept both the SDK root URL and the legacy `/chat/completions` endpoint. */
export function normalizeModelBaseUrl(value?: string): string {
  const raw = value?.trim()
  if (!raw) return DEFAULT_MODEL_BASE_URL
  const withoutTrailingSlash = raw.replace(/\/+$/, "")
  const legacySuffix = "/chat/completions"
  return withoutTrailingSlash.endsWith(legacySuffix)
    ? withoutTrailingSlash.slice(0, -legacySuffix.length) || DEFAULT_MODEL_BASE_URL
    : withoutTrailingSlash
}

export function normalizeLegacyModelEndpoint(value?: string): string {
  return `${normalizeModelBaseUrl(value)}/chat/completions`
}

export function getModelBaseUrlHost(value?: string): string {
  try {
    return new URL(normalizeModelBaseUrl(value)).host || "(empty-host)"
  } catch {
    return "(invalid-url)"
  }
}

export function createPingoModel(options: ModelProviderOptions): PingoModelProvider {
  const modelName = options.modelName?.trim() || DEFAULT_MODEL_NAME
  const baseUrl = normalizeModelBaseUrl(options.baseUrl)
  const provider = createOpenAICompatible({
    name: "pingo-ai-lab",
    apiKey: options.apiKey,
    baseURL: baseUrl,
    fetch: options.diagnostics?.wrapFetch(options.fetch) ?? options.fetch,
  })
  return { model: provider(modelName), modelName, baseUrl }
}
