// @tau/orchestrate - goals.ts:Goal 判定(每 turn 后:完成/继续/阻塞/超限)。
// Goal 经 session.setGoal() 进投影(模型感知),判定独立于模型(启发式 + 可选 judge)。

import type { Goal, Message } from "@tau/contract"
import type { Session } from "@tau/session"

export type GoalJudgeResult = {
  status: "completed" | "active" | "blocked"
  progress: number
  reason: string
}

export type GoalJudgeOptions = {
  /** 启发式判定:检查最近消息是否包含完成标记。 */
  heuristic?: boolean
  /** 可选 LLM judge:用模型评估目标完成度。 */
  llmJudge?: (goal: Goal, messages: readonly Message[]) => Promise<GoalJudgeResult>
}

/** 默认启发式判定:检查最近消息是否包含完成关键词。 */
export function judgeGoalHeuristic(goal: Goal, messages: readonly Message[]): GoalJudgeResult {
  const recent = messages.slice(-6)
  const lastAssistant = recent.findLast((m) => m.role === "assistant")

  if (!lastAssistant) {
    return { status: "active", progress: 0.5, reason: "无助手回复" }
  }

  const text = lastAssistant.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .toLowerCase()

  // 完成关键词
  const completionKeywords = ["完成", "已完成", "done", "finished", "完成目标", "目标达成"]
  const hasCompletion = completionKeywords.some((kw) => text.includes(kw))

  if (hasCompletion) {
    return { status: "completed", progress: 1.0, reason: "检测到完成标记" }
  }

  // 阻塞关键词
  const blockedKeywords = ["无法完成", "失败", "error", "blocked", "卡住"]
  const hasBlocked = blockedKeywords.some((kw) => text.includes(kw))

  if (hasBlocked) {
    return { status: "blocked", progress: 0.3, reason: "检测到阻塞标记" }
  }

  // 估算进度(基于工具调用数量)
  const toolCalls = recent.filter((m) => m.role === "tool").length
  const progress = Math.min(0.9, 0.1 + toolCalls * 0.1)

  return { status: "active", progress, reason: `进行中(${toolCalls} 次工具调用)` }
}

/** Goal 判定器:每 turn 后调用,更新目标状态。 */
export class GoalJudge {
  private options: GoalJudgeOptions

  constructor(options: GoalJudgeOptions = {}) {
    this.options = options
  }

  async judge(goal: Goal, session: Session): Promise<GoalJudgeResult> {
    const messages = session.project().history

    // 优先使用 LLM judge
    if (this.options.llmJudge) {
      return this.options.llmJudge(goal, messages)
    }

    // 默认启发式
    if (this.options.heuristic !== false) {
      return judgeGoalHeuristic(goal, messages)
    }

    return { status: "active", progress: 0.5, reason: "未配置判定策略" }
  }

  /** 更新 goal 状态到 session。 */
  updateGoal(session: Session, goal: Goal, result: GoalJudgeResult): Goal {
    const updated: Goal = {
      ...goal,
      status: result.status === "completed" ? "completed" : result.status === "blocked" ? "paused" : "active",
      progress: result.progress,
      updatedAt: new Date().toISOString(),
    }
    session.setGoal(updated)
    return updated
  }
}
