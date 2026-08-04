// @tau/session — session.ts:Session 聚合(admit/命令/生命周期)。
// project() 是全世界唯一把状态变成 LLM 输入的地方;先落盘后响应;一切自动行为进投影。

import {
  type Clock,
  type Event,
  type Goal,
  type Message,
  type Model,
  type PendingSyscall,
  type SessionSnapshot,
  type WakeReason,
  ModelSchema,
  recentActivityFrom,
} from "@tau/contract"
import type { Store } from "@tau/store"
import { Epoch } from "./epoch.ts"
import { compactionCandidates } from "./history.ts"
import { project, type ProjectorOptions } from "./projector.ts"
import {
  EMPTY_USAGE,
  buildSnapshot,
  loadGoals,
  loadPending,
  loadSummaryIds,
  loadUsage,
  saveGoals,
  savePending,
  saveSummaryIds,
  saveUsage,
  type UsageState,
} from "./snapshot.ts"
import { retrieveFrom, type Retrieved } from "./retrieve.ts"

export type SessionOptions = Partial<ProjectorOptions> & {
  sessionId: string
  store: Store
  onEvent?: (event: Event) => void
  now?: () => string
  monotonic?: () => number
}

/** 缺省投影配置:调用方只传关心的字段,其余走基线(自包含,不散落 ?? 判断)。 */
export function normalizeProjectorOptions(sessionId: string, options: Partial<ProjectorOptions>): ProjectorOptions {
  const cwd = options.cwd ?? process.cwd()
  return {
    sessionId,
    maxContextTokens: options.maxContextTokens ?? 32_000,
    model: options.model ?? ModelSchema.parse({
      id: "default",
      name: "default",
      provider: { api: "openai", provider: "openai" },
      capabilities: { supportsTools: true },
      cost: { inputPerMillion: 0, outputPerMillion: 0 },
      contextWindow: { maxTokens: 128_000 },
    }),
    cwd,
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.git !== undefined ? { git: options.git } : {}),
    permissions: options.permissions ?? [],
    skills: { ...(options.skills?.dir !== undefined ? { dir: options.skills.dir } : {}), names: options.skills?.names ?? [] },
    maxConcurrentTurns: options.maxConcurrentTurns ?? 1,
    budget: options.budget ?? { maxTurns: 6, maxTurnMs: 120_000, maxToolCallsPerTurn: 24 },
    onBudgetExceeded: options.onBudgetExceeded ?? "ask",
    workspaceRoots: options.workspaceRoots ?? [cwd],
    extraSystemBlocks: options.extraSystemBlocks ?? [],
    tools: options.tools ?? [],
  }
}

export type AdmitInput = {
  text: string
  source: string
  wake: WakeReason
  retention?: "high" | "normal"
}

export type SessionDiff = {
  addedMessages: readonly string[]
  removedMessages: readonly string[]
  usageDelta: { tokensDelta: number; costDelta: number }
  changed: readonly string[]
}

export interface Session {
  readonly sessionId: string
  admit(input: AdmitInput): Message
  appendMessage(message: Message): void
  project(): ReturnType<typeof project>
  snapshot(): SessionSnapshot
  promote(text: string, source: string): Message
  steer(text: string, source: string): Message
  setGoal(goal: Goal): void
  pendSyscall(ask: { toolCallId: string; toolName: string; summary: string }): PendingSyscall
  resolvePending(questionId: string, approved: boolean): void
  recordUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number }): void
  beginTurn(): void
  recordToolCall(): void
  compact(reason: string, summaryText: string): void
  retrieve(options: { query: string; offset?: number; limit?: number }): { results: readonly Retrieved[]; total: number }
  diff(fromEpoch: number, toEpoch: number): SessionDiff
  recent(): ReturnType<typeof recentActivityFrom>
  close(): void
  archive(): void
}

const uuid = () => crypto.randomUUID()

export function createSession(options: SessionOptions): Session {
  const { store, sessionId } = options
  const projectionOptions = normalizeProjectorOptions(sessionId, options)
  const epoch = Epoch.load(store.kv, sessionId)
  const createdAt = options.now?.() ?? new Date().toISOString()
  const monotonicBase = options.monotonic?.() ?? 0

  let status: "active" | "archived" | "closed" = "active"
  let lastWake: { reason: WakeReason; source: string } = { reason: "prompt", source: "boot" }
  let usage = loadUsage(store, sessionId)
  let goals = loadGoals(store, sessionId)
  let pending = loadPending(store, sessionId)
  let summaryIds = loadSummaryIds(store, sessionId)
  let recoveryNotice: string | null = null
  let budgetAlarm = false
  let budgetExceededFired = false
  let cachedProjection: ReturnType<typeof project> | null = null
  let cachedEpoch = -1
  const epochHistory = new Map<number, { ids: string[]; usage: UsageState }>()

  function emit(event: Event): void {
    store.events.append(sessionId, event)
    options.onEvent?.(event)
  }

  function touch(): void {
    epoch.bump()
    cachedProjection = null
  }

  function recordEpochState(): void {
    const all = store.messages.list(sessionId)
    epochHistory.set(epoch.current, { ids: all.messages.map((m) => m.id), usage: { ...usage } })
  }

  function clock(): Clock {
    const wall = options.now?.() ?? new Date().toISOString()
    const monotonicMs = (options.monotonic?.() ?? monotonicBase) - monotonicBase
    const sessionElapsedMs = Math.max(0, Date.parse(wall) - Date.parse(createdAt))
    return { wall, monotonicMs, sessionElapsedMs }
  }

  /** 崩溃恢复:重启后从 store 重放,不靠内存。 */
  function recover(): void {
    const events = store.events.replay(sessionId)
    for (const e of events) {
      if (e.kind === "lifecycle" && e.state === "closed") status = "closed"
      if (e.kind === "lifecycle" && e.state === "archived") status = "archived"
      if (e.kind === "lifecycle" && e.state === "active" && status === "active") status = "active"
    }
    const hasWork = store.messages.count(sessionId) > 0
    if (hasWork && status === "active") {
      recoveryNotice =
        "上次 turn 未提交:期间副作用可能已落盘且无法回滚,先 git status 确认现场再继续"
      emit({
        id: uuid(),
        timestamp: clock().wall,
        redact: [],
        kind: "recovery",
        from: `crash@${events.length}`,
        detail: recoveryNotice,
      })
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "active" })
    }
  }

  recover()

  function baseProjectionInput() {
    const recent = recentActivityFrom(store.events.replay(sessionId))
    return {
      epoch: epoch.current,
      wake: lastWake,
      summaryIds,
      usage,
      pendingSyscalls: pending,
      activeGoals: goals,
      recent,
      clock: clock(),
      budgetAlarm,
      recoveryNotice,
    }
  }

  const api: Session = {
    sessionId,

    admit(input: AdmitInput): Message {
      const message: Message = {
        id: uuid(),
        role: "user",
        content: [{ type: "text", text: input.text }],
        toolCalls: [],
        toolResults: [],
        interrupted: false,
        retention: input.retention ?? "high",
        source: input.source,
        createdAt: clock().wall,
      }
      emit({
        id: uuid(),
        timestamp: clock().wall,
        redact: [],
        kind: "input_accepted",
        command: { kind: "prompt", sender: { clientId: input.source, kind: "cli" }, text: input.text },
      })
      store.messages.append(sessionId, message)
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "transcript", message })
      lastWake = { reason: input.wake, source: input.source }
      touch()
      recordEpochState()
      return message
    },

    appendMessage(message: Message): void {
      store.messages.append(sessionId, message)
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "transcript", message })
      touch()
      recordEpochState()
    },

    project() {
      if (cachedProjection !== null && cachedEpoch === epoch.current) return cachedProjection
      const history = store.messages.list(sessionId).messages
      const input = baseProjectionInput()
      const result = project({ ...input, history }, projectionOptions)
      cachedProjection = result
      cachedEpoch = epoch.current
      return result
    },

    snapshot(): SessionSnapshot {
      return buildSnapshot({
        sessionId,
        epoch: epoch.current,
        status,
        activeGoals: goals,
        pendingSyscalls: pending,
        transcriptCount: store.messages.count(sessionId),
        createdAt,
      })
    },

    promote(text, source) {
      return api.admit({ text, source, wake: "goal_continue" })
    },

    steer(text, source) {
      return api.admit({ text, source, wake: "steer" })
    },

    setGoal(goal: Goal): void {
      const existing = goals.findIndex((g) => g.id === goal.id)
      if (existing >= 0) goals[existing] = goal
      else goals.push(goal)
      saveGoals(store, sessionId, goals)
      touch()
    },

    pendSyscall(ask: { toolCallId: string; toolName: string; summary: string }): PendingSyscall {
      const syscall: PendingSyscall = {
        questionId: uuid(),
        toolCallId: ask.toolCallId,
        toolName: ask.toolName,
        raisedAt: clock().wall,
      }
      pending = [...pending, syscall]
      savePending(store, sessionId, pending)
      emit({
        id: uuid(),
        timestamp: clock().wall,
        redact: [],
        kind: "permission",
        requestId: syscall.questionId,
        toolName: ask.toolName,
        summary: ask.summary,
        state: "requested",
      })
      touch()
      return syscall
    },

    resolvePending(questionId: string, approved: boolean): void {
      const target = pending.find((p) => p.questionId === questionId)
      if (!target) return
      pending = pending.filter((p) => p.questionId !== questionId)
      savePending(store, sessionId, pending)
      emit({
        id: uuid(),
        timestamp: clock().wall,
        redact: [],
        kind: "permission",
        requestId: questionId,
        toolName: target.toolName,
        summary: "",
        state: approved ? "granted" : "denied",
      })
      touch()
    },

    recordUsage(r: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number }): void {
      usage = {
        ...usage,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        cumulativeTokens: usage.cumulativeTokens + r.promptTokens + r.completionTokens,
        costUsd: usage.costUsd + estimateCost(projectionOptions.model, r),
        costEstimateErrorPct: 0,
      }
      if (usage.cumulativeTokens >= projectionOptions.maxContextTokens && !budgetExceededFired) {
        budgetExceededFired = true
        budgetAlarm = true
        emit({
          id: uuid(),
          timestamp: clock().wall,
          redact: [],
          kind: "budget_exceeded",
          metric: "cumulativeTokens",
          used: usage.cumulativeTokens,
          limit: projectionOptions.maxContextTokens,
        })
      } else if (usage.cumulativeTokens >= projectionOptions.maxContextTokens * 0.9) {
        budgetAlarm = true
      }
      saveUsage(store, sessionId, usage)
      touch()
    },

    beginTurn(): void {
      usage = { ...usage, turn: usage.turn + 1, toolCallsThisTurn: 0 }
      saveUsage(store, sessionId, usage)
      touch()
    },

    recordToolCall(): void {
      usage = { ...usage, toolCallsThisTurn: usage.toolCallsThisTurn + 1 }
      saveUsage(store, sessionId, usage)
      touch()
    },

    compact(reason: string, summaryText: string): void {
      const history = store.messages.list(sessionId).messages
      const keepRecent = 6
      const { drop, keep } = compactionCandidates(history, keepRecent)
      void keep
      if (drop.length === 0) return
      const summary: Message = {
        id: uuid(),
        role: "system",
        content: [{ type: "text", text: summaryText }],
        toolCalls: [],
        toolResults: [],
        interrupted: false,
        retention: "high",
        source: "compaction",
        createdAt: clock().wall,
      }
      store.messages.delete(
        sessionId,
        drop.map((m) => m.id),
      )
      summaryIds = [...summaryIds, summary.id]
      saveSummaryIds(store, sessionId, summaryIds)
      store.messages.append(sessionId, summary)
      emit({
        id: uuid(),
        timestamp: clock().wall,
        redact: [],
        kind: "compression",
        droppedIds: drop.map((m) => m.id),
        strategy: reason,
      })
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "transcript", message: summary })
      touch()
    },

    retrieve(optionsIn: { query: string; offset?: number; limit?: number }) {
      const history = store.messages.list(sessionId).messages
      return retrieveFrom(history, summaryIds, optionsIn)
    },

    diff(fromEpoch: number, toEpoch: number): SessionDiff {
      const from = epochHistory.get(fromEpoch)
      const to = epochHistory.get(toEpoch)
      if (from === undefined || to === undefined) {
        return { addedMessages: [], removedMessages: [], usageDelta: { tokensDelta: 0, costDelta: 0 }, changed: ["epoch-history-missing"] }
      }
      const fromIds = new Set(from.ids)
      const added = to.ids.filter((id) => !fromIds.has(id))
      const toIds = new Set(to.ids)
      const removed = from.ids.filter((id) => !toIds.has(id))
      return {
        addedMessages: added,
        removedMessages: removed,
        usageDelta: {
          tokensDelta: to.usage.cumulativeTokens - from.usage.cumulativeTokens,
          costDelta: to.usage.costUsd - from.usage.costUsd,
        },
        changed: removed.length > 0 ? ["history-compacted"] : [],
      }
    },

    recent() {
      return recentActivityFrom(store.events.replay(sessionId))
    },

    close(): void {
      status = "closed"
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "closed" })
      touch()
    },

    archive(): void {
      status = "archived"
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "archived" })
      touch()
    },
  }

  return api
}

/** 成本估算:prompt/completion × 模型单价,无 tokenizer 时按模型成本表估算并声明误差。 */
function estimateCost(model: Model, usage: { promptTokens: number; completionTokens: number }): number {
  const cost = model.cost
  const inputCost = (usage.promptTokens / 1_000_000) * cost.inputPerMillion
  const outputCost = (usage.completionTokens / 1_000_000) * cost.outputPerMillion
  return inputCost + outputCost
}

export { EMPTY_USAGE }
export type { UsageState }
