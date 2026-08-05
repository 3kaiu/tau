// @tau/contract — Config schema(纯 schema)。
// "配置即契约"的兑现位:app 只做装载/合并/路径,非法配置在本 schema 校验期暴露。

import { z } from "zod"
import { ToolTierSchema } from "./model.ts"
import { TurnBudgetSchema } from "./context.ts"
import { CapabilityRuleSchema } from "./syscall.ts"

/** 工具 tier 规则:缺省分级 + 按名覆盖。投影裁剪(按需注入 T1)与执行并发策略共用。 */
export const ToolTierRulesSchema = z.object({
  defaultTier: ToolTierSchema.default("T1"),
  overrides: z.record(z.string(), ToolTierSchema).default({}),
})
export type ToolTierRules = z.infer<typeof ToolTierRulesSchema>

/** 压缩触发策略:缺省值 = 预算用至 80% 触发压缩;压缩后仍超 → 降级模型(经 fallback 链)。 */
export const CompactionPolicySchema = z.object({
  triggerRatio: z.number().min(0).max(1).default(0.8),
  keepRecent: z.number().int().positive().default(6),
})
export type CompactionPolicy = z.infer<typeof CompactionPolicySchema>

/** thinking 块体积上限:超限转摘要(摘要源 = enhance 策略)。 */
export const ThinkingPolicySchema = z.object({
  maxBytes: z.number().int().positive().default(32 * 1024),
})
export type ThinkingPolicy = z.infer<typeof ThinkingPolicySchema>

export const ConfigSchema = z.object({
  /** 默认模型 id。 */
  model: z.string().optional(),
  /** 上下文预算(token)。 */
  maxContextTokens: z.number().int().positive().optional(),
  turnBudget: TurnBudgetSchema.optional(),
  toolTierRules: ToolTierRulesSchema.default({ defaultTier: "T1", overrides: {} }),
  /** capability 缺省规则(三态表);投影 self.permissions 摘要由此来。 */
  capabilityDefaults: z.array(CapabilityRuleSchema).default([]),
  compaction: CompactionPolicySchema.default({ triggerRatio: 0.8, keepRecent: 6 }),
  thinking: ThinkingPolicySchema.default({ maxBytes: 32 * 1024 }),
})
export type Config = z.infer<typeof ConfigSchema>

// ---------- 配置装载配套(纯 schema 驱动,零业务决策;惯用型同 invariant.ts) ----------

const OBJECT_KEYS: ReadonlySet<string> = new Set(["turnBudget", "toolTierRules", "capabilityDefaults", "compaction", "thinking"])
const INT_KEYS: ReadonlySet<string> = new Set(["maxContextTokens"])
const KNOWN_KEYS: ReadonlySet<string> = new Set([...Object.keys(ConfigSchema.shape), ...OBJECT_KEYS, ...INT_KEYS])

/**
 * 把 store.kv 的原始字符串值按 Config schema 形状做类型强转:
 * 对象/数组键 → JSON.parse;整型键 → Number;未知键原样透传(不透明键不拦截)。
 * 解析失败保留原串,交由 ConfigSchema 校验期报错。
 */
export function coerceConfigValue(key: string, raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  if (OBJECT_KEYS.has(key)) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  if (INT_KEYS.has(key)) {
    const n = Number(raw)
    return Number.isInteger(n) ? n : raw
  }
  return raw
}

/** 该 key 是否属于 Config schema 已知键(装载校验用)。 */
export function isConfigKey(key: string): boolean {
  return KNOWN_KEYS.has(key)
}

/** 合并装载:raw 条目(kv 读出的字符串值)→ 强转 → ConfigSchema 校验 + 缺省填充。非法抛 ConfigError。 */
export function parseMergedConfig(entries: Record<string, unknown>): Config {
  const coerced: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entries)) coerced[key] = coerceConfigValue(key, value)
  const parsed = ConfigSchema.safeParse(coerced)
  if (!parsed.success) {
    throw new ConfigError(formatConfigError(parsed.error, entries))
  }
  return parsed.data
}

/** 非法配置的可操作报错("键 = 值 为什么非法 + 期望类型")。 */
export function formatConfigError(error: z.ZodError, raw?: Record<string, unknown>): string {
  const issues = error.issues
    .slice(0, 5)
    .map((i) => `  ${i.path.join(".")}: ${i.message}${raw !== undefined && i.path[0] !== undefined ? ` (received ${JSON.stringify(raw[String(i.path[0])])})` : ""}`)
    .join("\n")
  return `配置不合法:\n${issues}${error.issues.length > 5 ? `\n  …还有 ${error.issues.length - 5} 处` : ""}`
}

export class ConfigError extends Error {}
