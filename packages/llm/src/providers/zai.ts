// @tau/llm — providers/zai.ts:智谱 GLM(z.ai / open.bigmodel.cn)通道。
// GLM 走 OpenAI 兼容协议;thinking 经 providerOptions.zai 透传(clear_thinking:false 保思考块),无官方包。

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import type { Model } from "@tau/contract"
import type { ChatOptionsReq } from "../route.ts"

export const ZAI_API = "zai"

export function zaiProvider(model: Model, apiKey: string): LanguageModel {
  const baseURL = model.provider.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4"
  const provider = createOpenAICompatible({
    name: ZAI_API,
    baseURL,
    apiKey,
  }).languageModel(model.id)
  return provider as unknown as LanguageModel
}

/** GLM 思考块须回传,clear_thinking 固定 false;thinking 未声明时不下发(目录 supportsThinking 决定开)。 */
export function zaiChatOptions(req: ChatOptionsReq): Record<string, unknown> | undefined {
  if (req.thinking === undefined) return undefined
  return { [ZAI_API]: { thinking: { type: req.thinking ? "enabled" : "disabled", clear_thinking: false } } }
}
