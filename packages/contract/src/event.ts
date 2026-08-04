// @tau/contract — Event 封闭联合。
// 事件不可变、可重放、按 id 因果排序;敏感字段以 `redact`(字段路径)标记,落盘时脱敏。

import { z } from "zod"
import { CommandSchema } from "./command.ts"
import { MessageSchema } from "./context.ts"
import { ToolErrorSchema, ToolResultSchema } from "./syscall.ts"

/** 事件基础字段:id 全局唯一(因果/幂等/重放);causeId 指向前因;redact 声明落盘脱敏的字段路径。 */
const EventBaseSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  causeId: z.string().optional(),
  redact: z.array(z.string()).default([]),
})

export const InputAcceptedEventSchema = EventBaseSchema.extend({
  kind: z.literal("input_accepted"),
  command: CommandSchema,
})
export type InputAcceptedEvent = z.infer<typeof InputAcceptedEventSchema>

export const TranscriptEventSchema = EventBaseSchema.extend({
  kind: z.literal("transcript"),
  message: MessageSchema,
})
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>

export const ToolEventSchema = EventBaseSchema.extend({
  kind: z.literal("tool"),
  toolCallId: z.string(),
  name: z.string(),
  state: z.enum(["started", "completed", "failed"]),
  args: z.record(z.string(), z.unknown()).optional(),
  result: ToolResultSchema.optional(),
  error: ToolErrorSchema.optional(),
})
export type ToolEvent = z.infer<typeof ToolEventSchema>

/** permission_request 广播带 params 摘要(summary),不携带原始参数——分支不携带 secrets。 */
export const PermissionEventSchema = EventBaseSchema.extend({
  kind: z.literal("permission"),
  requestId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  state: z.enum(["requested", "granted", "denied", "timeout"]),
})
export type PermissionEvent = z.infer<typeof PermissionEventSchema>

export const CompressionEventSchema = EventBaseSchema.extend({
  kind: z.literal("compression"),
  droppedIds: z.array(z.string()),
  strategy: z.string(),
})
export type CompressionEvent = z.infer<typeof CompressionEventSchema>

export const LifecycleEventSchema = EventBaseSchema.extend({
  kind: z.literal("lifecycle"),
  sessionId: z.string(),
  state: z.enum(["created", "active", "closed", "archived", "checkpointed"]),
  detail: z.string().optional(),
})
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>

export const BudgetExceededEventSchema = EventBaseSchema.extend({
  kind: z.literal("budget_exceeded"),
  metric: z.string(),
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
})
export type BudgetExceededEvent = z.infer<typeof BudgetExceededEventSchema>

export const LoopDetectedEventSchema = EventBaseSchema.extend({
  kind: z.literal("loop_detected"),
  turn: z.number().int().nonnegative(),
  pattern: z.string(),
})
export type LoopDetectedEvent = z.infer<typeof LoopDetectedEventSchema>

export const RetryEventSchema = EventBaseSchema.extend({
  kind: z.literal("retry"),
  cause: z.string(),
  attempts: z.number().int().nonnegative(),
})
export type RetryEvent = z.infer<typeof RetryEventSchema>

export const ModelSwitchedEventSchema = EventBaseSchema.extend({
  kind: z.literal("model_switched"),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
})
export type ModelSwitchedEvent = z.infer<typeof ModelSwitchedEventSchema>

export const InterruptedEventSchema = EventBaseSchema.extend({
  kind: z.literal("interrupted"),
  targetId: z.string(),
})
export type InterruptedEvent = z.infer<typeof InterruptedEventSchema>

export const RecoveryEventSchema = EventBaseSchema.extend({
  kind: z.literal("recovery"),
  from: z.string(),
  detail: z.string().optional(),
})
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>

export const GoalEventSchema = EventBaseSchema.extend({
  kind: z.literal("goal"),
  goalId: z.string(),
  status: z.enum(["completed", "blocked", "progress"]),
  progress: z.number().min(0).max(1),
  reason: z.string(),
})
export type GoalEvent = z.infer<typeof GoalEventSchema>

/** Event 封闭联合:新增分支必须同时改本联合与 invariant 检查器(编译期穷尽)。 */
export const EventSchema = z.discriminatedUnion("kind", [
  InputAcceptedEventSchema,
  TranscriptEventSchema,
  ToolEventSchema,
  PermissionEventSchema,
  CompressionEventSchema,
  LifecycleEventSchema,
  BudgetExceededEventSchema,
  LoopDetectedEventSchema,
  RetryEventSchema,
  ModelSwitchedEventSchema,
  InterruptedEventSchema,
  RecoveryEventSchema,
  GoalEventSchema,
])
export type Event = z.infer<typeof EventSchema>

/** 事件 id 生成器:进程内单调序列 + 进程前缀;序号定宽补零,字典序 = 因果序。
 * 跨源/跨进程排序按 (epoch, id) 字典序;权威写入侧(session/action)各自持有一个实例。 */
export function createEventIdGenerator(prefix?: string): () => string {
  const p = prefix ?? `p${Math.random().toString(36).slice(2, 8)}`
  let counter = 0
  return () => `${p}-${String(++counter).padStart(12, "0")}`
}

/** 需进投影"最近活动块"的事件种类(模型必须看到自己刚被打断/重试/换模型)。 */
export const RECENT_ACTIVITY_KINDS = ["retry", "interrupted", "model_switched", "recovery", "compression"] as const
export type RecentActivityKind = (typeof RECENT_ACTIVITY_KINDS)[number]

/** 从事件推导最近活动(纯函数,供 session 组装投影)。无相关事件返回 null。 */
export function recentActivityFrom(
  events: readonly Event[],
): { kind: RecentActivityKind; text: string; eventId: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e === undefined) continue
    if (e.kind === "retry") {
      return { kind: "retry", text: `retry after ${e.cause} (attempt ${e.attempts})`, eventId: e.id }
    }
    if (e.kind === "interrupted") {
      return { kind: "interrupted", text: `interrupted at ${e.targetId}`, eventId: e.id }
    }
    if (e.kind === "model_switched") {
      return { kind: "model_switched", text: `${e.from} -> ${e.to}: ${e.reason}`, eventId: e.id }
    }
    if (e.kind === "recovery") {
      return { kind: "recovery", text: `recovery: ${e.detail ?? e.from}`, eventId: e.id }
    }
    if (e.kind === "compression") {
      return { kind: "compression", text: `compressed ${e.droppedIds.length} msgs`, eventId: e.id }
    }
  }
  return null
}

/** 落盘脱敏:按字段路径深拷贝替换为 "[redacted]"。
 * 路径为点分("args.command");"*" 结尾表示该键下的所有后代("args.*")。 */
export function redactFields<T>(value: T, paths: readonly string[]): T {
  if (paths.length === 0) return value
  const seen = new Set<string>(paths)
  const walk = (node: unknown, path: string, wild: boolean): unknown => {
    if (node === null || node === undefined || typeof node !== "object") return node
    if (Array.isArray(node)) return node.map((item) => walk(item, path, wild))
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      const full = path === "" ? key : `${path}.${key}`
      const isWild = wild || (path !== "" && seen.has(`${path}.*`))
      out[key] = isWild || seen.has(full) ? "[redacted]" : walk(val, full, isWild)
    }
    return out
  }
  return walk(value, "", false) as T
}

/** 会话恢复告知断言:eval 用——崩溃恢复后必须存在 recovery 事件(模型与用户可见)。 */
export function hasRecoveryNotice(events: readonly Event[]): boolean {
  return events.some((e) => e.kind === "recovery")
}
