// @tau/llm — endpoint.ts:端点解析。
// 契约声明 baseUrl 优先;缺省回落到 api 默认端点。代理透传由 Bun 运行时(HTTP(S)_PROXY)处理,本层零逻辑。

import type { ProviderMeta } from "@tau/contract"

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}

/** 解析模型端点:provider.baseUrl > api 默认。返回 null 表示不可路由(契约未声明且无默认)。 */
export function resolveBaseUrl(meta: ProviderMeta): string | null {
  if (meta.baseUrl) return meta.baseUrl
  return DEFAULT_ENDPOINTS[meta.api] ?? null
}
