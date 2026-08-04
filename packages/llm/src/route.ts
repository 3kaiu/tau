// @tau/llm — route.ts:模型 → 供应商路由。
// 路由决定权在契约(Model.provider.api),不做启发式猜测。

import type { LanguageModel } from "ai"
import type { Model, ProviderMeta } from "@tau/contract"
import { openaiCompatibleProvider } from "./providers/openai-compatible.ts"

export type ProviderFactory = (model: Model, apiKey: string) => LanguageModel

export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  "openai-compatible": openaiCompatibleProvider,
  openai: openaiCompatibleProvider,
}

/** 注册(懒加载路径:动态 import 供应商模块后调用本函数)。 */
export function registerProvider(api: string, factory: ProviderFactory): void {
  PROVIDER_FACTORIES[api] = factory
}

/** 按契约 api 路由;未知 api 返回 null(编排层据此发 error 事件,而非猜测)。 */
export function routeProvider(meta: ProviderMeta): ProviderFactory | null {
  return PROVIDER_FACTORIES[meta.api] ?? null
}
