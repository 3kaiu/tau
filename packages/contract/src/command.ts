// @tau/contract — Command 封闭联合。
// 用户与 tau 的一切交互都是 Command;任何分支不得携带 secrets(引用 id/摘要)。

import { z } from "zod"

export const SenderKindSchema = z.enum(["cli", "tui", "http", "sse", "acp", "remote", "system"])
export type SenderKind = z.infer<typeof SenderKindSchema>

/** 一切 Command 携带 sender——命令可审计,审计到人。 */
export const SenderSchema = z.object({
  clientId: z.string(),
  kind: SenderKindSchema,
})
export type Sender = z.infer<typeof SenderSchema>

export const PromptCommandSchema = z.object({
  kind: z.literal("prompt"),
  sender: SenderSchema,
  text: z.string(),
})
export type PromptCommand = z.infer<typeof PromptCommandSchema>

export const SteerCommandSchema = z.object({
  kind: z.literal("steer"),
  sender: SenderSchema,
  text: z.string(),
  ref: z.string().optional(),
})
export type SteerCommand = z.infer<typeof SteerCommandSchema>

/** approve 必带 capability(批准的是哪个权限)与理由——UI 据此渲染"批准 bash?" */
export const ApproveCommandSchema = z.object({
  kind: z.literal("approve"),
  sender: SenderSchema,
  toolCallId: z.string(),
  capability: z.string(),
  reason: z.string(),
})
export type ApproveCommand = z.infer<typeof ApproveCommandSchema>

/** 批准生命周期状态机:孤儿挂起(会话 abort 残留 pending)与超时过期有明确归宿,审批链可审计。 */
export const ApprovalStateSchema = z.enum(["active", "approved", "denied", "expired", "revoked"])
export type ApprovalState = z.infer<typeof ApprovalStateSchema>

/** deny 与 ApprovalState.denied 一一对应:用户/客户端显式拒绝某权限请求。 */
export const DenyCommandSchema = z.object({
  kind: z.literal("deny"),
  sender: SenderSchema,
  requestId: z.string(),
  reason: z.string().default(""),
})
export type DenyCommand = z.infer<typeof DenyCommandSchema>

/** answer 必带 questionId,与 pendingSyscalls.questionId 配对。 */
export const AnswerCommandSchema = z.object({
  kind: z.literal("answer"),
  sender: SenderSchema,
  questionId: z.string(),
  answer: z.union([z.string(), z.record(z.string(), z.unknown())]),
})
export type AnswerCommand = z.infer<typeof AnswerCommandSchema>

export const AbortCommandSchema = z.object({
  kind: z.literal("abort"),
  sender: SenderSchema,
  targetId: z.string().optional(),
})
export type AbortCommand = z.infer<typeof AbortCommandSchema>

/** select 多选:selected 是选项 id 列表,multiple 声明是否允许多选。 */
export const SelectCommandSchema = z.object({
  kind: z.literal("select"),
  sender: SenderSchema,
  questionId: z.string(),
  selected: z.array(z.string()),
  multiple: z.boolean().default(false),
})
export type SelectCommand = z.infer<typeof SelectCommandSchema>

/** observe = 只读 attach(订阅观察,多窗口/远程)。不带任何写权限语义。 */
export const ObserveCommandSchema = z.object({
  kind: z.literal("observe"),
  sender: SenderSchema,
  subscribe: z.boolean().default(true),
  streams: z.array(z.string()).default([]),
})
export type ObserveCommand = z.infer<typeof ObserveCommandSchema>

/** set_model = 运行时切换会话模型。model 是目录内的 id(不存在则由消费方拒绝)。 */
export const SetModelCommandSchema = z.object({
  kind: z.literal("set_model"),
  sender: SenderSchema,
  model: z.string(),
})
export type SetModelCommand = z.infer<typeof SetModelCommandSchema>

/** compact = 手动压缩上下文(立即摘要化老消息)。无参数。 */
export const CompactCommandSchema = z.object({
  kind: z.literal("compact"),
  sender: SenderSchema,
})
export type CompactCommand = z.infer<typeof CompactCommandSchema>

/** set_auto_approve = 切换权限模式(auto 静默放行 / ask 询问)。 */
export const SetAutoApproveCommandSchema = z.object({
  kind: z.literal("set_auto_approve"),
  sender: SenderSchema,
  enabled: z.boolean(),
})
export type SetAutoApproveCommand = z.infer<typeof SetAutoApproveCommandSchema>

/** Command 封闭联合:新增分支必须同时改本联合、Event 相关分支与 invariant 检查器(编译期穷尽)。 */
export const CommandSchema = z.discriminatedUnion("kind", [
  PromptCommandSchema,
  SteerCommandSchema,
  ApproveCommandSchema,
  DenyCommandSchema,
  AnswerCommandSchema,
  AbortCommandSchema,
  SelectCommandSchema,
  ObserveCommandSchema,
  SetModelCommandSchema,
  CompactCommandSchema,
  SetAutoApproveCommandSchema,
])
export type Command = z.infer<typeof CommandSchema>
