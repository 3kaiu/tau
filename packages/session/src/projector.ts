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
  type ToolTierRules,
  type TurnBudget,
  type Wake,
} from "@tau/contract"
import type { UsageState } from "./snapshot.ts"

/** 摘要消息 id 列表在"历史已压缩"提示中的最大展示数(超出只列最近几条 + 总数,防投影无限变长)。 */
const SUMMARY_IDS_SHOWN = 8

export type ProjectorOptions = {
  sessionId: string
  /** 会话身份(契约 self.session):title 供 UI 标题,parentId 标识子会话来源。 */
  sessionTitle?: string
  parentId?: string
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
  /** Config tier 规则:缺省 = 全量注入(兼容现状);提供规则时按 tier 裁剪(见 ProjectorInput.requestedT1)。 */
  toolTierRules?: ToolTierRules
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
  /** 本 turn 已注入的 T1 工具名(经 tool_catalog 发现后按需请求);仅 toolTierRules 存在时生效。 */
  requestedT1?: readonly string[]
}

/** 工具注入裁剪:T2(内部机制)永不注入;无 tier 规则 → 其余全量注入;有 → T0 常驻 + 本 turn 请求过的 T1 + tool_catalog(发现入口)恒在。 */
function injectedTools(opts: ProjectorOptions, input: ProjectorInput): SystemCall[] {
  if (opts.toolTierRules === undefined) return [...opts.tools].filter((tool) => tool.tier !== "T2")
  const { overrides, defaultTier } = opts.toolTierRules
  const requested = new Set(input.requestedT1 ?? [])
  return opts.tools.filter((tool) => {
    if (tool.tier === "T2") return false
    const effectiveTier = overrides[tool.name] ?? tool.tier ?? defaultTier
    return effectiveTier === "T0" || requested.has(tool.name) || tool.name === "tool_catalog"
  })
}

export function project(input: ProjectorInput, opts: ProjectorOptions): ContextProjection {
  const system = assembleBlocks(opts, input)
  return {
    version: input.epoch,
    wake: input.wake,
    system,
    history: [...input.history],
    tools: injectedTools(opts, input),
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
      session: { id: opts.sessionId, ...(opts.sessionTitle !== undefined ? { title: opts.sessionTitle } : {}), ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}) },
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
    const shown = input.summaryIds.length <= SUMMARY_IDS_SHOWN ? input.summaryIds.join(", ") : `${input.summaryIds.slice(-SUMMARY_IDS_SHOWN).join(", ")}, …(共 ${input.summaryIds.length} 条)`
    blocks.push({
      kind: "context",
      priority: 10,
      content: `历史已压缩:${input.summaryIds.length} 条消息摘要化(可经 retrieve 工具取回;摘要消息 id: ${shown})`,
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
  // 按 priority 降序装配;同 priority 后插入者在前(冲突以后置为准,契约注释语义)
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => (a.block.priority === b.block.priority ? b.index - a.index : b.block.priority - a.block.priority))
    .map(({ block }) => block)
}
