// @tau/llm — providers/deepseek.ts:DeepSeek 官方通道。
// 思考模式经 thinking/reasoningEffort 请求级选项;V4 空 reasoning 补全由官方包内部处理。

import { createDeepSeek } from "@ai-sdk/deepseek"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import type { ChatOptionsReq } from "../route.ts"

export const DEEPSEEK_API = "deepseek"

export function deepseekProvider(model: Model, apiKey: string): LanguageModel {
  const baseURL = model.provider.baseUrl
  const provider = baseURL ? createDeepSeek({ apiKey, baseURL }) : createDeepSeek({ apiKey })
  return provider.languageModel(model.id) as unknown as LanguageModel
}

export function deepseekChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined && req.reasoningEffort === undefined) return undefined
  return {
    [DEEPSEEK_API]: {
      ...(req.thinking !== undefined ? { thinking: { type: req.thinking ? "enabled" : "disabled" } } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
    },
  }
}
