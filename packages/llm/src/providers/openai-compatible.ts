// @tau/llm — providers/openai-compatible.ts:OpenAI 兼容端点。
// 任何 OpenAI 兼容 baseURL(自有网关/代理)经标准配置接入,零绑定私有渠道。

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import { resolveBaseUrl } from "../endpoint.ts"

export const OPENAI_COMPATIBLE_API = "openai-compatible"

export function openaiCompatibleProvider(model: Model, apiKey: string): LanguageModel {
  const baseUrl = resolveBaseUrl(model.provider) ?? "https://api.openai.com/v1"
  const provider = createOpenAICompatible({
    name: model.provider.api,
    baseURL: baseUrl,
    apiKey,
  }).languageModel(model.id)
  return provider as unknown as LanguageModel
}
