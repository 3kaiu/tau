// @tau/llm — 宿主内核(薄)汇总出口。

import type { Model } from "@tau/contract"

export const version = "0.0.1"

export { createLlmKernel } from "./kernel.ts"
export type { LlmKernel, LlmKernelOptions, LlmRequest } from "./kernel.ts"
export { assembleSystem, toAiMessages, toToolSet } from "./kernel.ts"
export type { LlmEvent, LlmUsage, LlmCollectResult } from "./stream.ts"
export { normalizeStream, collectStream, errorCodeOf } from "./stream.ts"
export { promptCache, recordCacheHit, cacheHitRate } from "./cache.ts"
export type { CachePolicy, CacheStats } from "./cache.ts"
export { resolveBaseUrl, DEFAULT_ENDPOINTS } from "./endpoint.ts"
export { resolveApiKey } from "./auth.ts"
export { routeProvider, registerProvider } from "./route.ts"
export type { ProviderFactory } from "./route.ts"
export { openaiCompatibleProvider, OPENAI_COMPATIBLE_API } from "./providers/openai-compatible.ts"

/** 默认目录:openai-compatible 生态模型;首个为免 key 的 opencode zen 网关(开箱即用)。 */
export function defaultCatalog(): Model[] {
  const base = {
    provider: {
      api: "openai-compatible",
      provider: "openai",
      envKey: "OPENAI_API_KEY",
      auth: "apiKey" as const,
    },
  }
  return [
    {
      id: "deepseek-v4-flash-free",
      name: "deepseek-v4-flash-free(opencode zen,免 key)",
      provider: {
        api: "openai-compatible",
        provider: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        auth: "none",
      },
      capabilities: { supportsTools: true, supportsThinking: false, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0, outputPerMillion: 0 },
      contextWindow: { maxTokens: 256_000 },
    },
    {
      id: "gpt-5-mini",
      name: "GPT-5 mini(OpenAI 兼容)",
      ...base,
      capabilities: { supportsTools: true, supportsThinking: false, supportsParallelCalls: true, supportsVision: true, supportsStreaming: true },
      cost: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      contextWindow: { maxTokens: 400_000 },
    },
    {
      id: "gpt-5",
      name: "GPT-5(OpenAI 兼容)",
      ...base,
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: true, supportsStreaming: true },
      cost: { inputPerMillion: 1.25, outputPerMillion: 10 },
      contextWindow: { maxTokens: 400_000 },
    },
  ]
}
