// @tau/session — snapshot.ts:快照权威(序列化/恢复)。
// 所有读操作基于最新快照;崩溃恢复 = 事件重放 + 快照重建,不靠内存。

import type { Goal, PendingSyscall, SessionSnapshot } from "@tau/contract"
import type { Store } from "@tau/store"

export const SNAPSHOT_KEY = (sessionId: string) => `snapshot:${sessionId}`
export const GOALS_KEY = (sessionId: string) => `goals:${sessionId}`
export const PENDING_KEY = (sessionId: string) => `pending:${sessionId}`
export const USAGE_KEY = (sessionId: string) => `usage:${sessionId}`
export const SUMMARY_KEY = (sessionId: string) => `summary:${sessionId}`

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
