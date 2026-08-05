// @tau/contract — SystemCall 契约与工具结果。
// 副作用唯一出口;ErrorCode 必填,模型据此区分"该重试 / 换工具 / 问用户"。

import { z } from "zod"
import type { ToolTier } from "./model.ts"

/** 错误码必填。模型的分诊依据:retryable→重试;not_found→换工具;permission_denied/rejected→问用户;
 * insufficient_funds→报账(余额不足,重试无益);overloaded→资源不足(错峰重试);其余→上报。 */
export const ErrorCodeSchema = z.enum([
  "retryable",
  "not_found",
  "permission_denied",
  "timeout",
  "cancelled",
  "rejected",
  "insufficient_funds",
  "overloaded",
  "internal",
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const ToolErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ToolError = z.infer<typeof ToolErrorSchema>

/** 文件类结果的元数据:模型判断"我读的文件是否已被改过"(陈旧 → 重读),也是幂等判定依据。 */
export const FileMetaSchema = z.object({
  mtime: z.string(),
  size: z.number().int().nonnegative(),
  hash: z.string().optional(),
})
export type FileMeta = z.infer<typeof FileMetaSchema>

/** ToolResult:stdout/stderr 分离;截断带分页标记,续读走 result:page 协议,不整段重灌。
 * exitCode 为 null 表示工具无进程语义(如纯数据查询);文件类结果必填 fileMeta。 */
export const ToolResultSchema = z.object({
  exitCode: z.number().int().nullable().default(null),
  stdout: z.string().nullable().default(null),
  stderr: z.string().nullable().default(null),
  truncated: z.boolean().default(false),
  totalPages: z.number().int().min(0).default(1),
  page: z.number().int().min(0).default(0),
  fileMeta: FileMetaSchema.optional(),
})
export type ToolResult = z.infer<typeof ToolResultSchema>

/** 危险命令模式清单(契约级):action 的 bash 检测与 eval 断言共用。
 * 定位:检测是防线不是安全边界——降低误执行率,不承诺对抗绕过。 */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+).*(\/|\*)/,
  /\bgit\s+push\b.*--force/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:/,
  /\bchmod\s+(-[a-zA-Z]*\s+)?777\s+\//,
  />\s*\/dev\/sd[a-z]/,
]

/** bash 参数过危险命令模式检测:命中 → 强制询问(与 capability 门叠加,不走静默允许)。 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command))
}

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
  tier: z.enum(["T0", "T1", "T2"]).default("T1") satisfies z.ZodType<ToolTier>,
  maxOutputTokens: z.number().int().positive().optional(),
  dangerous: z.boolean().default(false),
  defaultRule: CapabilityRuleSchema.optional(),
})
export type SystemCall = z.infer<typeof SystemCallSchema>

/** 工具结果构造器:分页/分离字段给默认,调用方只写实际数据。 */
export function toolResult(result: Partial<ToolResult> = {}): ToolResult {
  const base: ToolResult = {
    exitCode: result.exitCode ?? null,
    stdout: result.stdout ?? null,
    stderr: result.stderr ?? null,
    truncated: result.truncated ?? false,
    totalPages: result.totalPages ?? 1,
    page: result.page ?? 0,
  }
  return result.fileMeta === undefined ? base : { ...base, fileMeta: result.fileMeta }
}

export function toolError(code: ErrorCode, message: string, details?: Record<string, unknown>): ToolError {
  return details === undefined ? { code, message } : { code, message, details }
}
