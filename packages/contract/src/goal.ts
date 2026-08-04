// @tau/contract — Goal 目标契约。
// 目标经 session.setGoal 进入投影与快照;判定策略决定"何时算完成"。

import { z } from "zod"

export const GoalStatusSchema = z.enum(["active", "paused", "completed", "failed", "cancelled"])
export type GoalStatus = z.infer<typeof GoalStatusSchema>

/** 完成判定策略:
 * - explicit: 用户/系统显式置完成
 * - llm_judged: 模型自评(默认,需在投影中告知策略)
 * - checklist: checklist 全项满足即完成
 */
export const GoalStrategySchema = z.enum(["explicit", "llm_judged", "checklist"])
export type GoalStrategy = z.infer<typeof GoalStrategySchema>

/** 目标状态机:active ⇄ paused;active → completed | failed | cancelled。progress 0..1。 */
export const GoalSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: GoalStatusSchema.default("active"),
  progress: z.number().min(0).max(1).default(0),
  strategy: GoalStrategySchema.default("llm_judged"),
  checklist: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})
export type Goal = z.infer<typeof GoalSchema>

export function goal(
  id: string,
  text: string,
  opts?: Partial<Omit<Goal, "id" | "text">>,
): Goal {
  return {
    id,
    text,
    status: opts?.status ?? "active",
    progress: opts?.progress ?? 0,
    strategy: opts?.strategy ?? "llm_judged",
    checklist: opts?.checklist ?? [],
    createdAt: opts?.createdAt ?? new Date().toISOString(),
  }
}
