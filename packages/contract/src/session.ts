// @tau/contract — 会话权威状态。
// SessionSnapshot 是真相源;pendingSyscalls 走增量计数,不进全量重扫。

import { z } from "zod"
import { GoalSchema } from "./goal.ts"

export const SessionStatusSchema = z.enum(["active", "archived", "closed"])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

/** 挂起中的 syscall:模型在等用户回答。questionId 与 Command.answer.questionId 配对。 */
export const PendingSyscallSchema = z.object({
  questionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  raisedAt: z.string(),
})
export type PendingSyscall = z.infer<typeof PendingSyscallSchema>

/** 会话快照:权威状态,含 pendingSyscalls/activeGoals/epoch。
 * epoch 与投影 version 同源(重放一致性断言点)。 */
export const SessionSnapshotSchema = z.object({
  sessionId: z.string(),
  epoch: z.number().int().nonnegative(),
  status: SessionStatusSchema,
  activeGoals: z.array(GoalSchema).default([]),
  pendingSyscalls: z.array(PendingSyscallSchema).default([]),
  transcriptCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>
