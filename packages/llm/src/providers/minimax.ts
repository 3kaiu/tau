// @tau/llm — providers/minimax.ts:MiniMax 官方通道(Anthropic 协议)。
// 思考经 thinking(type) 请求级选项;官方默认端点 https://api.minimax.io/anthropic/v1。

import { createMiniMax } from "@ai-sdk/minimax"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import type { ChatOptionsReq } from "../route.ts"

export const MINIMAX_API = "minimax"

export function minimaxProvider(model: Model, apiKey: string): LanguageModel {
  const baseURL = model.provider.baseUrl
  const provider = baseURL ? createMiniMax({ apiKey, baseURL }) : createMiniMax({ apiKey })
  return provider.languageModel(model.id) as unknown as LanguageModel
}

export function minimaxChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined) return undefined
  return { [MINIMAX_API]: { thinking: { type: req.thinking ? "adaptive" : "disabled" } } }
}
