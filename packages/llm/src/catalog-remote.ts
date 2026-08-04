// @tau/llm — catalog-remote.ts:opencode models-api 远程目录 → 契约 Model 映射。
// 数据源 https://models.opencode.ai/api.json(opencode 官方,180+ 供应商,公开拉取);
// 只映射 tau 已注册通道(route.ts PROVIDER_FACTORIES)的供应商,其余跳过。

import type { Model } from "@tau/contract"

export const MODELS_API_URL = "https://models.opencode.ai/api.json"

type RemoteModel = {
  id: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

type RemoteProvider = {
  id: string
  env?: string[]
  npm?: string
  api?: string
  models: Record<string, RemoteModel>
}

/** npm 包 → tau api。opencode 官方数据将 deepseek/moonshot/alibaba 标 openai-compatible,
 * 但 tau 优先官方包(thinking 语义更完整),按 provider 名特判分流。 */
function apiFor(providerId: string, npm: string): string | null {
  switch (npm) {
    case "@ai-sdk/deepseek":
      return "deepseek"
    case "@ai-sdk/alibaba":
      return "alibaba"
    case "@ai-sdk/moonshotai":
      return "moonshot"
    case "@ai-sdk/minimax":
      return "minimax"
    case "@ai-sdk/openai-compatible":
      if (providerId.includes("zai") || providerId.includes("zhipu")) return "zai"
      if (providerId === "deepseek") return "deepseek"
      if (providerId.startsWith("moonshotai")) return "moonshot"
      if (providerId.startsWith("alibaba")) return "alibaba"
      return "openai-compatible"
    case "@ai-sdk/anthropic":
      if (providerId === "kimi-for-coding") return "kimi-coding"
      if (providerId.startsWith("minimax")) return "minimax"
      return "anthropic"
    default:
      return null
  }
}

/** models.opencode.ai/api.json → tau 目录(仅已注册通道)。 */
export function modelsApiToCatalog(data: Record<string, RemoteProvider>): Model[] {
  const out: Model[] = []
  for (const [providerId, provider] of Object.entries(data)) {
    const api = apiFor(providerId, provider.npm ?? "")
    if (api === null) continue
    const baseUrl = provider.api
    for (const model of Object.values(provider.models)) {
      const cost = model.cost
      out.push({
        id: model.id,
        name: model.name ?? model.id,
        provider: {
          api,
          provider: providerId,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(provider.env?.[0] !== undefined ? { envKey: provider.env[0] } : {}),
          auth: "apiKey",
        },
        capabilities: {
          supportsTools: model.tool_call ?? false,
          supportsThinking: model.reasoning ?? false,
          supportsParallelCalls: true,
          supportsVision: model.attachment ?? false,
          supportsStreaming: true,
        },
        cost: {
          inputPerMillion: cost?.input ?? 0,
          outputPerMillion: cost?.output ?? 0,
          ...(cost?.cache_read !== undefined ? { cacheReadPerMillion: cost.cache_read } : {}),
          ...(cost?.cache_write !== undefined ? { cacheWritePerMillion: cost.cache_write } : {}),
        },
        contextWindow: {
          maxTokens: model.limit?.context ?? 128_000,
          ...(model.limit?.output !== undefined ? { maxOutputTokens: model.limit.output } : {}),
        },
        fallback: [],
      })
    }
  }
  return out
}

/** 拉取远程目录(失败抛错,由调用方决定兜底)。 */
export async function fetchRemoteCatalog(opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<Model[]> {
  const res = await (opts?.fetchImpl ?? fetch)(MODELS_API_URL, opts?.signal !== undefined ? { signal: opts.signal } : undefined)
  if (!res.ok) throw new Error(`models-api 拉取失败:${res.status}`)
  return modelsApiToCatalog((await res.json()) as Record<string, RemoteProvider>)
}
