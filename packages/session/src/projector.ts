// @tau/session — projector.ts:投影管线(唯一组装)。
// 装配顺序固定(system → history → tools → self → resources),结果不可变;
// self 必含 clock/usage/cwd/permissions/skill 目录,wake 与最近活动块必含。

import {
  INJECTION_GUARD_TEMPLATE,
  INJECTION_PRIORITY,
  type CapabilityRule,
  type Clock,
  type ContextProjection,
  type GitStatus,
  type Goal,
  type Message,
  type Model,
  type PendingSyscall,
  type RecentActivity,
  type SystemBlock,
  type SystemCall,
  type TurnBudget,
  type Wake,
} from "@tau/contract"
import type { UsageState } from "./snapshot.ts"

export type ProjectorOptions = {
  sessionId: string
  model: Model
  cwd: string
  projectRoot?: string
  git?: GitStatus
  permissions: readonly CapabilityRule[]
  skills: { dir?: string; names: string[] }
  workspaceRoots: string[]
  budget: TurnBudget
  maxConcurrentTurns: number
  maxContextTokens: number
  extraSystemBlocks: readonly SystemBlock[]
  tools: readonly SystemCall[]
  onBudgetExceeded: "abort" | "pause" | "ask"
}

export type ProjectorInput = {
  epoch: number
  wake: Wake
  history: readonly Message[]
  summaryIds: readonly string[]
  usage: UsageState
  pendingSyscalls: readonly PendingSyscall[]
  activeGoals: readonly Goal[]
  recent: RecentActivity | null
  clock: Clock
  budgetAlarm: boolean
  recoveryNotice: string | null
}

export function project(input: ProjectorInput, opts: ProjectorOptions): ContextProjection {
  const system = assembleBlocks(opts, input)
  return {
    version: input.epoch,
    wake: input.wake,
    system,
    history: [...input.history],
    tools: [...opts.tools],
    self: {
      model: {
        id: opts.model.id,
        provider: opts.model.provider.provider,
        contextWindow: opts.model.contextWindow,
      },
      clock: input.clock,
      usage: {
        turn: input.usage.turn,
        toolCallsThisTurn: input.usage.toolCallsThisTurn,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        totalTokens: input.usage.totalTokens,
        cumulativeTokens: input.usage.cumulativeTokens,
        estimatedRemaining: Math.max(0, opts.maxContextTokens - input.usage.cumulativeTokens),
        costUsd: input.usage.costUsd,
        costEstimateErrorPct: input.usage.costEstimateErrorPct,
      },
      cwd: opts.cwd,
      ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
      ...(opts.git !== undefined ? { git: opts.git } : {}),
      permissions: [...opts.permissions],
      skills: { ...(opts.skills.dir !== undefined ? { dir: opts.skills.dir } : {}), names: [...opts.skills.names] },
    },
    resources: {
      maxConcurrentTurns: opts.maxConcurrentTurns,
      budget: { ...opts.budget },
      onBudgetExceeded: opts.onBudgetExceeded,
      workspaceRoots: [...opts.workspaceRoots],
    },
    pendingSyscalls: [...input.pendingSyscalls],
    activeGoals: [...input.activeGoals],
    ...(input.recent !== null ? { recent: input.recent } : {}),
  }
}

function assembleBlocks(opts: ProjectorOptions, input: ProjectorInput): SystemBlock[] {
  const blocks: SystemBlock[] = [
    { kind: "injection", priority: INJECTION_PRIORITY, content: INJECTION_GUARD_TEMPLATE },
    ...(opts.extraSystemBlocks ?? []),
  ]
  if (input.summaryIds.length > 0) {
    blocks.push({
      kind: "context",
      priority: 10,
      content: `历史已压缩:${input.summaryIds.length} 条消息摘要化(可经 retrieve 工具取回;摘要消息 id: ${input.summaryIds.join(", ")})`,
    })
  }
  if (input.budgetAlarm) {
    blocks.push({
      kind: "state",
      priority: 90,
      content: `预算告警:本轮 token 用量接近上限 ${opts.maxContextTokens};超限行为:${opts.onBudgetExceeded}`,
    })
  }
  if (input.recoveryNotice !== null) {
    blocks.push({ kind: "state", priority: 95, content: `恢复告知:${input.recoveryNotice}` })
  }
  for (const goal of input.activeGoals) {
    blocks.push({
      kind: "goal",
      priority: 60,
      content: `当前目标[${goal.status} ${Math.round(goal.progress * 100)}%]:${goal.text}${goal.strategy === "checklist" ? `(checklist: ${goal.checklist.join("; ")})` : ""}`,
    })
  }
  return blocks
}
