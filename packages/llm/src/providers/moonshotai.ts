// @tau/llm — providers/moonshotai.ts:月之暗面(Kimi)官方通道。
// 思考经 thinking(budgetTokens)与 reasoningHistory(interleaved/preserved)请求级选项。

import { createMoonshotAI } from "@ai-sdk/moonshotai"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import type { ChatOptionsReq } from "../route.ts"

export const MOONSHOT_API = "moonshot"

export function moonshotProvider(model: Model, apiKey: string): LanguageModel {
  const baseURL = model.provider.baseUrl
  const provider = baseURL ? createMoonshotAI({ apiKey, baseURL }) : createMoonshotAI({ apiKey })
  return provider.languageModel(model.id) as unknown as LanguageModel
}

export function moonshotChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined && req.thinkingBudgetTokens === undefined) return undefined
  return {
    [MOONSHOT_API]: {
      thinking: {
        ...(req.thinking !== undefined ? { type: req.thinking ? "enabled" : "disabled" } : {}),
        ...(req.thinkingBudgetTokens !== undefined ? { budgetTokens: req.thinkingBudgetTokens } : {}),
      },
    },
  }
}
