// @tau/llm — cache.ts:prompt cache 策略位。
// 只输出策略与命中率观测,不干预会话;命中率指标供 surface 呈现。

export type CachePolicy = "none" | "auto"

const CACHE_PREFIX_KINDS = ["anthropic", "google"] as const

/** 当前仅前缀缓存类 api(anthropic/google)开启 auto;其余 none。策略由契约 api 决定,不猜模型。 */
export function promptCache(api: string): CachePolicy {
  return (CACHE_PREFIX_KINDS as readonly string[]).includes(api) ? "auto" : "none"
}

export type CacheStats = {
  calls: number
  cachedTokenCandidates: number
  cacheReadTokens: number
}

/** 命中率观测位:kernel 每次 finish 时调用,会话层决定是否展示。 */
export function recordCacheHit(stats: CacheStats, usage: { promptTokens: number; cacheReadTokens?: number }): CacheStats {
  return {
    calls: stats.calls + 1,
    cachedTokenCandidates: stats.cachedTokenCandidates + usage.promptTokens,
    cacheReadTokens: stats.cacheReadTokens + (usage.cacheReadTokens ?? 0),
  }
}

export function cacheHitRate(stats: CacheStats): number {
  if (stats.cachedTokenCandidates === 0) return 0
  return stats.cacheReadTokens / stats.cachedTokenCandidates
}
