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
export { resolveApiKey, resolveAuth } from "./auth.ts"
export type { CredentialSource, AuthResolution } from "./auth.ts"
export { routeProvider, registerProvider, chatOptionsFor } from "./route.ts"
export type { ProviderFactory, ChatOptionsReq } from "./route.ts"
export { openaiCompatibleProvider, OPENAI_COMPATIBLE_API } from "./providers/openai-compatible.ts"
export { alibabaProvider, ALIBABA_API } from "./providers/alibaba.ts"
export { deepseekProvider, DEEPSEEK_API } from "./providers/deepseek.ts"
export { minimaxProvider, MINIMAX_API } from "./providers/minimax.ts"
export { moonshotProvider, MOONSHOT_API } from "./providers/moonshotai.ts"
export { zaiProvider, ZAI_API } from "./providers/zai.ts"
export { anthropicProvider, ANTHROPIC_API, KIMI_CODING_API } from "./providers/anthropic.ts"
export { fetchRemoteCatalog, modelsApiToCatalog, MODELS_API_URL } from "./catalog-remote.ts"

/** 默认目录:openai-compatible 生态 + 国产官方通道;首个为免 key 的 opencode zen 网关(开箱即用)。
 * 价格为样例占位,动态目录接入点在 kernel.refresh()。 */
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
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0, outputPerMillion: 0 },
      contextWindow: { maxTokens: 256_000 },
      fallback: [],
    },
    {
      id: "gpt-5-mini",
      name: "GPT-5 mini(OpenAI 兼容)",
      ...base,
      capabilities: { supportsTools: true, supportsThinking: false, supportsParallelCalls: true, supportsVision: true, supportsStreaming: true },
      cost: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      contextWindow: { maxTokens: 400_000 },
      fallback: [],
    },
    {
      id: "gpt-5",
      name: "GPT-5(OpenAI 兼容)",
      ...base,
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: true, supportsStreaming: true },
      cost: { inputPerMillion: 1.25, outputPerMillion: 10 },
      contextWindow: { maxTokens: 400_000 },
      fallback: [],
    },
    {
      id: "deepseek-v4-flash-0731",
      name: "DeepSeek V4 Flash",
      provider: { api: "deepseek", provider: "deepseek", envKey: "DEEPSEEK_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.07, outputPerMillion: 0.28, cacheReadPerMillion: 0.014, cacheWritePerMillion: 0.07 },
      contextWindow: { maxTokens: 1_000_000 },
      fallback: [],
    },
    {
      id: "qwen3-max",
      name: "Qwen3-Max(百炼)",
      provider: { api: "alibaba", provider: "alibaba", envKey: "DASHSCOPE_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 1.6, outputPerMillion: 6.4, cacheReadPerMillion: 0.32, cacheWritePerMillion: 1.6 },
      contextWindow: { maxTokens: 256_000 },
      fallback: [],
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2(z.ai)",
      provider: { api: "zai", provider: "zai", envKey: "ZHIPU_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.4, outputPerMillion: 1.6 },
      contextWindow: { maxTokens: 1_000_000 },
      fallback: [],
    },
    {
      id: "kimi-k3",
      name: "Kimi K3(月之暗面)",
      provider: { api: "moonshot", provider: "moonshot", envKey: "MOONSHOT_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 1, outputPerMillion: 8, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 },
      contextWindow: { maxTokens: 256_000 },
      fallback: [],
    },
    {
      id: "minimax-m3",
      name: "MiniMax M3",
      provider: { api: "minimax", provider: "minimax", envKey: "MINIMAX_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.5, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.5 },
      contextWindow: { maxTokens: 1_000_000 },
      fallback: [],
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash(opencode go)",
      provider: { api: "openai-compatible", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", envKey: "OPENCODE_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028 },
      contextWindow: { maxTokens: 1_000_000, maxOutputTokens: 384_000 },
      fallback: [],
    },
    {
      id: "qwen3.7-max",
      name: "Qwen3.7 Max(opencode go)",
      provider: { api: "openai-compatible", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", envKey: "OPENCODE_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.7, outputPerMillion: 2.8 },
      contextWindow: { maxTokens: 1_000_000, maxOutputTokens: 384_000 },
      fallback: [],
    },
    {
      id: "kimi-for-coding",
      name: "Kimi Coding Plan(coding plan)",
      provider: { api: "kimi-coding", provider: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/v1", envKey: "KIMI_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.6, outputPerMillion: 2.5 },
      contextWindow: { maxTokens: 262_144, maxOutputTokens: 32_768 },
      fallback: [],
    },
    {
      id: "hy3",
      name: "Hy3(腾讯 coding plan)",
      provider: { api: "openai-compatible", provider: "tencent-coding-plan", baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3", envKey: "TENCENT_CODING_PLAN_API_KEY", auth: "apiKey" },
      capabilities: { supportsTools: true, supportsThinking: true, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
      cost: { inputPerMillion: 0.2, outputPerMillion: 0.8 },
      contextWindow: { maxTokens: 204_800, maxOutputTokens: 32_768 },
      fallback: [],
    },
  ]
}
