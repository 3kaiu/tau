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
