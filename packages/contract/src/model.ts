// @tau/contract — 模型与提供方元数据。
// 只声明模型"是什么",不声明"怎么用";投影裁剪的唯一依据是 capabilities。

import { z } from "zod"

/** 工具分级:T0 常驻每轮注入;T1 按需经 tool:catalog 查询后注入本 turn。
 * 每轮工具描述 token 只花在会用到的上。 */
export const ToolTierSchema = z.enum(["T0", "T1"])
export type ToolTier = z.infer<typeof ToolTierSchema>

/** 模型能力面。投影裁剪依据:能力缺则对应工具/system 块不注入。 */
export const ModelCapabilitiesSchema = z.object({
  supportsTools: z.boolean().default(true),
  supportsThinking: z.boolean().default(false),
  supportsParallelCalls: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  supportsStreaming: z.boolean().default(true),
})
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>

/** 成本(USD/百万 token)。缺 tokenizer 时由字符估算时声明误差。 */
export const CostSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
})
export type Cost = z.infer<typeof CostSchema>

/** 提供方元数据。auth 方式决定 llm 层取 key 的路径,不含密钥本体。 */
export const AuthKindSchema = z.enum(["apiKey", "oauth", "none"])
export type AuthKind = z.infer<typeof AuthKindSchema>

export const ProviderMetaSchema = z.object({
  api: z.string(),
  provider: z.string(),
  baseUrl: z.string().url().optional(),
  envKey: z.string().optional(),
  auth: AuthKindSchema.default("apiKey"),
})
export type ProviderMeta = z.infer<typeof ProviderMetaSchema>

export const ContextWindowSchema = z.object({
  maxTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
})
export type ContextWindow = z.infer<typeof ContextWindowSchema>

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  provider: ProviderMetaSchema,
  capabilities: z.preprocess((v) => (v === undefined ? {} : v), ModelCapabilitiesSchema),
  cost: CostSchema,
  contextWindow: ContextWindowSchema,
  /** 降级链:失败后按序下探的备选模型 id(声明式,非启发式);空数组 = 无降级。 */
  fallback: z.array(z.string()).default([]),
})
export type Model = z.infer<typeof ModelSchema>
