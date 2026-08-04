// @tau/llm — route.ts:模型 → 供应商路由。
// 路由决定权在契约(Model.provider.api),不做启发式猜测。

import type { LanguageModel } from "ai"
import type { Model, ProviderMeta } from "@tau/contract"
import { openaiCompatibleProvider } from "./providers/openai-compatible.ts"
import { alibabaProvider, ALIBABA_API, alibabaChatOptions } from "./providers/alibaba.ts"
import { anthropicProvider, ANTHROPIC_API, KIMI_CODING_API, anthropicChatOptions, kimiCodingChatOptions } from "./providers/anthropic.ts"
import { deepseekProvider, DEEPSEEK_API, deepseekChatOptions } from "./providers/deepseek.ts"
import { minimaxProvider, MINIMAX_API, minimaxChatOptions } from "./providers/minimax.ts"
import { moonshotProvider, MOONSHOT_API, moonshotChatOptions } from "./providers/moonshotai.ts"
import { zaiProvider, ZAI_API, zaiChatOptions } from "./providers/zai.ts"

export type ProviderFactory = (model: Model, apiKey: string) => LanguageModel

export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  "openai-compatible": openaiCompatibleProvider,
  openai: openaiCompatibleProvider,
  [ALIBABA_API]: alibabaProvider,
  [ANTHROPIC_API]: anthropicProvider,
  [DEEPSEEK_API]: deepseekProvider,
  [KIMI_CODING_API]: anthropicProvider,
  [MINIMAX_API]: minimaxProvider,
  [MOONSHOT_API]: moonshotProvider,
  [ZAI_API]: zaiProvider,
}

/** 注册(懒加载路径:动态 import 供应商模块后调用本函数)。 */
export function registerProvider(api: string, factory: ProviderFactory): void {
  PROVIDER_FACTORIES[api] = factory
}

/** 按契约 api 路由;未知 api 返回 null(编排层据此发 error 事件,而非猜测)。 */
export function routeProvider(meta: ProviderMeta): ProviderFactory | null {
  return PROVIDER_FACTORIES[meta.api] ?? null
}

/** 请求级厂商差异选项(思考/努力度),映射到各 provider 的 providerOptions。 */
export type ChatOptionsReq = {
  thinking?: boolean
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"
  thinkingBudgetTokens?: number
}

const CHAT_OPTIONS_FACTORIES: Record<string, (req: ChatOptionsReq) => Record<string, unknown> | undefined> = {
  [ALIBABA_API]: alibabaChatOptions,
  [ANTHROPIC_API]: anthropicChatOptions,
  [DEEPSEEK_API]: deepseekChatOptions,
  [KIMI_CODING_API]: kimiCodingChatOptions,
  [MINIMAX_API]: minimaxChatOptions,
  [MOONSHOT_API]: moonshotChatOptions,
  [ZAI_API]: zaiChatOptions,
}

/** 未声明思考类选项或无适配的通道 → undefined(不注入 providerOptions)。 */
export function chatOptionsFor(meta: ProviderMeta, req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined && req.reasoningEffort === undefined && req.thinkingBudgetTokens === undefined) return undefined
  return CHAT_OPTIONS_FACTORIES[meta.api]?.(req)
}
