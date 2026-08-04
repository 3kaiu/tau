// @tau/llm — providers/anthropic.ts:Anthropic 协议通道。
// 通用 anthropic 端点(Claude 系)经 thinking enabled+budgetTokens;
// kimi-coding(api.kimi.com/coding/v1)思考走 adaptive+summarized(参考 opencode transform.ts)。

import { createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import type { ChatOptionsReq } from "../route.ts"

export const ANTHROPIC_API = "anthropic"
export const KIMI_CODING_API = "kimi-coding"

export function anthropicProvider(model: Model, apiKey: string): LanguageModel {
  const baseURL = model.provider.baseUrl
  const provider = baseURL ? createAnthropic({ apiKey, baseURL }) : createAnthropic({ apiKey })
  return provider.languageModel(model.id) as unknown as LanguageModel
}

/** Claude 系思考:enabled + budgetTokens(必填,缺省 16k)。 */
export function anthropicChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined) return undefined
  return {
    [ANTHROPIC_API]: {
      thinking: {
        type: req.thinking ? "enabled" : "disabled",
        ...(req.thinkingBudgetTokens !== undefined ? { budgetTokens: req.thinkingBudgetTokens } : {}),
      },
    },
  }
}

/** Kimi coding 端点思考:adaptive + summarized(思考块保序回传);effort 默认 high。 */
export function kimiCodingChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined) return undefined
  return {
    [ANTHROPIC_API]: {
      thinking: { type: req.thinking ? "adaptive" : "disabled", display: "summarized" },
      ...(req.thinking ? { effort: "high" } : {}),
    },
  }
}
