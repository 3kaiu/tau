// @tau/llm — providers/alibaba.ts:阿里云百炼(DashScope)官方通道。
// 思考开关经 enableThinking/thinkingBudget 请求级选项;preserve_thinking 缺口见 SPEC。

import { createAlibaba } from "@ai-sdk/alibaba"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import type { ChatOptionsReq } from "../route.ts"

export const ALIBABA_API = "alibaba"

export function alibabaProvider(model: Model, apiKey: string): LanguageModel {
  const baseURL = model.provider.baseUrl
  const provider = baseURL ? createAlibaba({ apiKey, baseURL }) : createAlibaba({ apiKey })
  return provider.languageModel(model.id) as unknown as LanguageModel
}

export function alibabaChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined) return undefined
  return { [ALIBABA_API]: { enableThinking: req.thinking } }
}
