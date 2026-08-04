// @tau/contract — SystemCall 契约与工具结果。
// 副作用唯一出口;ErrorCode 必填,模型据此区分"该重试 / 换工具 / 问用户"。

import { z } from "zod"
import type { ToolTier } from "./model.ts"

/** 错误码必填。模型的分诊依据:retryable→重试;not_found→换工具;permission_denied/rejected→问用户;其余→上报。 */
export const ErrorCodeSchema = z.enum([
  "retryable",
  "not_found",
  "permission_denied",
  "timeout",
  "cancelled",
  "rejected",
  "internal",
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const ToolErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ToolError = z.infer<typeof ToolErrorSchema>

/** ToolResult:stdout/stderr 分离;截断带分页标记,续读走 result:page 协议,不整段重灌。
 * exitCode 为 null 表示工具无进程语义(如纯数据查询)。 */
export const ToolResultSchema = z.object({
  exitCode: z.number().int().nullable().default(null),
  stdout: z.string().nullable().default(null),
  stderr: z.string().nullable().default(null),
  truncated: z.boolean().default(false),
  totalPages: z.number().int().min(0).default(1),
  page: z.number().int().min(0).default(0),
})
export type ToolResult = z.infer<typeof ToolResultSchema>

/** 续读协议工具:截断结果按页续读。工具名与参数名是 wire 契约,不可改。 */
export const RESULT_PAGE_TOOL_NAME = "result"
export const RESULT_PAGE_PARAM = "page"

/** 三态权限规则:allow/ask/deny + scope。投影只带摘要,完整规则经 `system` syscall 返回。 */
export const CapabilityRuleSchema = z.object({
  pattern: z.string(),
  rule: z.enum(["allow", "ask", "deny"]),
  scope: z.enum(["tool", "path", "network", "process"]).default("tool"),
  reason: z.string().optional(),
})
export type CapabilityRule = z.infer<typeof CapabilityRuleSchema>

/** SystemCall 契约。parameters 是 JSON Schema 对象(wire 契约,供 MCP 互操作与跨语言消费)。
 * maxOutputTokens:调用前可知输出上限,与截断语义对齐;tier:工具分级。 */
export const SystemCallSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  tier: z.enum(["T0", "T1"]).default("T1") satisfies z.ZodType<ToolTier>,
  maxOutputTokens: z.number().int().positive().optional(),
  dangerous: z.boolean().default(false),
  defaultRule: CapabilityRuleSchema.optional(),
})
export type SystemCall = z.infer<typeof SystemCallSchema>

/** 工具结果构造器:分页/分离字段给默认,调用方只写实际数据。 */
export function toolResult(result: Partial<ToolResult> = {}): ToolResult {
  return {
    exitCode: result.exitCode ?? null,
    stdout: result.stdout ?? null,
    stderr: result.stderr ?? null,
    truncated: result.truncated ?? false,
    totalPages: result.totalPages ?? 1,
    page: result.page ?? 0,
  }
}

export function toolError(code: ErrorCode, message: string, details?: Record<string, unknown>): ToolError {
  return details === undefined ? { code, message } : { code, message, details }
}
