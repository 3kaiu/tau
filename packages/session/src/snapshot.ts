// @tau/session — snapshot.ts:快照权威(序列化/恢复)。
// 所有读操作基于最新快照;崩溃恢复 = 事件重放 + 快照重建,不靠内存。

import type { Goal, PendingSyscall, SessionSnapshot } from "@tau/contract"
import type { Store } from "@tau/store"

export const SNAPSHOT_KEY = (sessionId: string) => `snapshot:${sessionId}`
export const GOALS_KEY = (sessionId: string) => `goals:${sessionId}`
export const PENDING_KEY = (sessionId: string) => `pending:${sessionId}`
export const USAGE_KEY = (sessionId: string) => `usage:${sessionId}`
export const SUMMARY_KEY = (sessionId: string) => `summary:${sessionId}`
export const COMMITTED_KEY = (sessionId: string) => `committed:${sessionId}`

export type UsageState = {
  turn: number
  toolCallsThisTurn: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cumulativeTokens: number
  costUsd: number
  costEstimateErrorPct: number
}

export const EMPTY_USAGE: UsageState = {
  turn: 0,
  toolCallsThisTurn: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cumulativeTokens: 0,
  costUsd: 0,
  costEstimateErrorPct: 0,
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function loadUsage(store: Store, sessionId: string): UsageState {
  return { ...EMPTY_USAGE, ...parseJson<Partial<UsageState>>(store.kv.get(USAGE_KEY(sessionId)), {}) }
}

export function saveUsage(store: Store, sessionId: string, usage: UsageState): void {
  store.kv.set(USAGE_KEY(sessionId), JSON.stringify(usage))
}

export function loadGoals(store: Store, sessionId: string): Goal[] {
  return parseJson<Goal[]>(store.kv.get(GOALS_KEY(sessionId)), [])
}

export function saveGoals(store: Store, sessionId: string, goals: Goal[]): void {
  store.kv.set(GOALS_KEY(sessionId), JSON.stringify(goals))
}

export function loadPending(store: Store, sessionId: string): PendingSyscall[] {
  return parseJson<PendingSyscall[]>(store.kv.get(PENDING_KEY(sessionId)), [])
}

export function savePending(store: Store, sessionId: string, pending: PendingSyscall[]): void {
  store.kv.set(PENDING_KEY(sessionId), JSON.stringify(pending))
}

export function loadSummaryIds(store: Store, sessionId: string): string[] {
  return parseJson<string[]>(store.kv.get(SUMMARY_KEY(sessionId)), [])
}

export function saveSummaryIds(store: Store, sessionId: string, ids: string[]): void {
  store.kv.set(SUMMARY_KEY(sessionId), JSON.stringify(ids))
}

export function loadCommittedTurn(store: Store, sessionId: string): string | null {
  return store.kv.get(COMMITTED_KEY(sessionId))
}

export function saveCommittedTurn(store: Store, sessionId: string, turnId: string): void {
  store.kv.set(COMMITTED_KEY(sessionId), turnId)
}

/**
 * 副作用悬置判定(纯函数):从审计日志判定"上次 turn 已提交/未提交的 syscall"。
 * 判定规则:提交点由 orchestrate 在 turn 尾部写入(commitTurn,turnId = `t<epoch>`,epoch 跨重启单调)。
 * 崩溃必然发生在 turn 中途,故"审计最新 turn 晚于已提交锚点" = 该 turn 未提交,其全部 syscall 均为悬置。
 * 按序比较而非相等:提交锚点后的 turn 可能没有 syscall(无审计记录),相等比较会把"最后有审计的已提交 turn"误判为悬置。
 * 无带 turnId 的审计(旧数据)→ indeterminate,退回"无法精确判定"的通用告警。
 */
export function uncommittedSyscalls(
  audit: readonly { turnId?: string; action: string; detail: string }[],
  committedTurnId: string | null,
): { indeterminate: boolean; entries: readonly { toolName: string; argsSummary: string }[] } {
  const withTurn = audit.filter((e) => e.turnId !== undefined && e.turnId !== "")
  if (withTurn.length === 0) {
    return { indeterminate: audit.length > 0, entries: [] }
  }
  // audit.query 双驱动均按 timestamp DESC(最新在前)
  const last = withTurn[0]!
  const committed = committedTurnId === null ? -1 : epochOf(committedTurnId)
  if (epochOf(last.turnId!) <= committed) return { indeterminate: false, entries: [] }
  return {
    indeterminate: false,
    entries: withTurn
      .filter((e) => e.turnId === last.turnId)
      .map((e) => ({ toolName: e.action.split(":")[0] ?? e.action, argsSummary: e.detail })),
  }
}

/** turnId 提取 epoch(`t<epoch>` 格式);非数字(异常/旧数据)按"晚于一切提交锚点"处理,不静默放行。 */
function epochOf(turnId: string): number {
  const n = Number(turnId.startsWith("t") ? turnId.slice(1) : turnId)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

export function buildSnapshot(input: {
  sessionId: string
  epoch: number
  status: "active" | "archived" | "closed"
  activeGoals: Goal[]
  pendingSyscalls: PendingSyscall[]
  transcriptCount: number
  createdAt: string
}): SessionSnapshot {
  return {
    sessionId: input.sessionId,
    epoch: input.epoch,
    status: input.status,
    activeGoals: input.activeGoals,
    pendingSyscalls: input.pendingSyscalls,
    transcriptCount: input.transcriptCount,
    createdAt: input.createdAt,
    updatedAt: new Date().toISOString(),
  }
}
