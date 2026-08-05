// @tau/session — session.ts:Session 聚合(admit/命令/生命周期)。
// project() 是全世界唯一把状态变成 LLM 输入的地方;先落盘后响应;一切自动行为进投影。

import {
  type ArtifactBlock,
  type Clock,
  type Event,
  type Goal,
  type Message,
  type Model,
  type PendingSyscall,
  type SessionSnapshot,
  type SenderKind,
  type WakeReason,
  ModelSchema,
  createEventIdGenerator,
  recentActivityFrom,
} from "@tau/contract"
import type { ArtifactMeta, Store } from "@tau/store"
import { Epoch } from "./epoch.ts"
import { storeArtifact, readArtifact, listArtifacts, purgeArtifact, externalizeContent, DEFAULT_ARTIFACT_THRESHOLD_BYTES, type ArtifactBody } from "./artifacts.ts"
import { runCompact } from "./compaction.ts"
import { project, type ProjectorOptions } from "./projector.ts"
import {
  EMPTY_USAGE,
  buildSnapshot,
  loadCommittedTurn,
  loadGoals,
  loadPending,
  loadSummaryIds,
  loadUsage,
  saveCommittedTurn,
  saveGoals,
  savePending,
  saveSummaryIds,
  saveUsage,
  uncommittedSyscalls,
  type UsageState,
} from "./snapshot.ts"
import { type Retrieved } from "./retrieve.ts"

/** 消息纯文本(检索 excerpt 用)。 */
function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

export type SessionOptions = Partial<ProjectorOptions> & {
  sessionId: string
  store: Store
  onEvent?: (event: Event) => void
  now?: () => string
  monotonic?: () => number
  /** text 块超此字节数 → 外置为 artifact 引用(正文存 store,历史仅引用;缺省 16KB)。 */
  artifactThresholdBytes?: number
  /** 压缩交换保留尾部消息数(缺省 6;契约 Config.compaction.keepRecent 消费方)。 */
  compactionKeepRecent?: number
  /** thinking 块文本上限字节(超限截断 + 标记;缺省 32KB,与契约 ThinkingPolicySchema.maxBytes 一致)。 */
  maxThinkingBytes?: number
}

/** 缺省投影配置:调用方只传关心的字段,其余走基线(自包含,不散落 ?? 判断)。 */
export function normalizeProjectorOptions(sessionId: string, options: Partial<ProjectorOptions>): ProjectorOptions {
  const cwd = options.cwd ?? process.cwd()
  return {
    sessionId,
    ...(options.sessionTitle !== undefined ? { sessionTitle: options.sessionTitle } : {}),
    ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
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
    ...(options.toolTierRules !== undefined ? { toolTierRules: options.toolTierRules } : {}),
  }
}

export type AdmitInput = {
  text: string
  source: string
  wake: WakeReason
  retention?: "high" | "normal"
  /** 来源界面(审计溯源):face.publish 透传 command.sender.kind,缺省 "cli" 兼容直连调用。 */
  senderKind?: SenderKind
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
  /** 运行时切换会话模型(投影 self.model 随之更新;下一轮 llm 调用生效)。 */
  setModel(model: Model): void
  pendSyscall(ask: { questionId?: string; toolCallId: string; toolName: string; summary: string }): PendingSyscall
  resolvePending(questionId: string, approved: boolean): void
  recordUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number }): void
  beginTurn(): void
  recordToolCall(): void
  /** 按需注入请求(tier 规则存在时生效):本 turn 内请求过的 T1 工具进投影;beginTurn 重置。 */
  requestTools(names: readonly string[]): void
  /** 提交 turn(提交点边界):orchestrate 在 turn 尾部(全部 syscall 结果落盘后)调用;悬置判定以此为锚。 */
  commitTurn(turnId: string): void
  compact(reason: string, summaryText: string): void
  retrieve(options: { query: string; offset?: number; limit?: number }): { results: readonly Retrieved[]; total: number }
  diff(fromEpoch: number, toEpoch: number): SessionDiff
  recent(): ReturnType<typeof recentActivityFrom>
  close(): void
  archive(): void
  /** 归档/关闭的会话置回 active(治理面 resume;历史不删,只改状态)。 */
  resume(): void
  /** 大载荷:正文落 store,历史仅引用(模型按需检索,不烧上下文)。 */
  storeArtifact(input: { ref?: string; content: string; mime?: string }): ArtifactBlock
  readArtifact(ref: string): ArtifactBody | null
  listArtifacts(): readonly ArtifactMeta[]
  /** 删除 artifact;返回 false = 活跃历史仍引用(悬空),调用方应提示。 */
  purgeArtifact(ref: string): boolean
}

// 事件/消息 id 同一单调序列(进程前缀 + 定宽序号,字典序 = 因果序;消息 id 与事件 id 全局唯一)
const uuid = createEventIdGenerator()

export function createSession(options: SessionOptions): Session {
  const { store, sessionId } = options
  const projectionOptions = normalizeProjectorOptions(sessionId, options)
  const epoch = Epoch.load(store.kv, sessionId)
  // 出生时间取注册表已记录值:跨重启稳定,不因重新 createSession 而重置
  const createdAt = store.sessions.get(sessionId)?.createdAt ?? options.now?.() ?? new Date().toISOString()
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
  const requestedT1 = new Set<string>()

  function emit(event: Event): void {
    store.events.append(sessionId, event)
    options.onEvent?.(event)
  }

  function touch(): void {
    epoch.bump()
    cachedProjection = null
  }

  /** 会话注册表写路径:快照落 store.sessions。治理面(tau sessions)的唯一读端来源。 */
  function register(): void {
    store.sessions.upsert(api.snapshot())
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
      // 最后一条 lifecycle 为准,映射与契约 checkReplay/checkDualView 逐字对齐(否则重启后快照与事件互相打架)
      if (e.kind === "lifecycle") {
        status = e.state === "closed" ? "closed" : e.state === "archived" ? "archived" : "active"
      }
    }
    const hasWork = store.messages.count(sessionId) > 0
    if (hasWork && status === "active") {
      // 副作用悬置判定:审计带 turnId(提交点 = turn 尾部 commitTurn),崩溃必然发生在 turn 中途,
      // "审计最后一条带 turnId 的记录 ≠ 已提交 turn" = 该 turn 未提交,其 syscall 均为悬置——告警带清单,模型检查文件而非瞎猜
      const pending = uncommittedSyscalls(store.audit.query({ sessionId }), loadCommittedTurn(store, sessionId))
      if (pending.entries.length > 0 || pending.indeterminate) {
        const list = pending.entries.map((e) => `${e.toolName}(${e.argsSummary.slice(0, 120)})`).join("; ")
        recoveryNotice = pending.indeterminate
          ? "上次 turn 未提交:期间副作用可能已落盘且无法回滚,先 git status 确认现场再继续"
          : `上次 turn 未提交,以下 syscall 已执行但 turn 未收尾,副作用可能已落盘且无法回滚:${list};先检查现场再继续`
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
    storeArtifact: (input) => storeArtifact(store, { sessionId, ...input }),
    readArtifact: (ref) => readArtifact(store, ref),
    listArtifacts: () => listArtifacts(store, sessionId),
    purgeArtifact: (ref) => purgeArtifact(store, ref),

    admit(input: AdmitInput): Message {
      const artifactThreshold = options.artifactThresholdBytes ?? DEFAULT_ARTIFACT_THRESHOLD_BYTES
      const content = externalizeContent(store, sessionId, [{ type: "text", text: input.text }], artifactThreshold)
      const message: Message = {
        id: uuid(),
        role: "user",
        content,
        toolCalls: [],
        toolResults: [],
        interrupted: false,
        retention: input.retention ?? "normal",
        source: input.source,
        createdAt: clock().wall,
      }
      // 回执事件与历史同规:大输入不进事件流(与 externalizeContent 同阈值;超限给引用预览,正文只存 store)
      const receiptText =
        input.text.length > artifactThreshold
          ? `[大输入已外置 artifact(正文存 store,经 artifact_read 取回);前 200 字符:${input.text.slice(0, 200)}…]`
          : input.text
      emit({
        id: uuid(),
        timestamp: clock().wall,
        redact: [],
        kind: "input_accepted",
        command: { kind: "prompt", sender: { clientId: input.source, kind: input.senderKind ?? "cli" }, text: receiptText },
      })
      store.messages.append(sessionId, message)
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "transcript", message })
      lastWake = { reason: input.wake, source: input.source }
      touch()
      recordEpochState()
      register()
      return message
    },

    appendMessage(message: Message): void {
      // thinking 块体积上限:超限截断 + 标记(思路链保留头部,防单块撑爆历史)
      const maxThinking = options.maxThinkingBytes ?? 32_000
      const bounded = message.content.map((block) =>
        block.type === "thinking" && block.text.length > maxThinking
          ? { ...block, text: `${block.text.slice(0, maxThinking)}\n…(thinking 超限截断,剩余 ${block.text.length} 字符)` }
          : block,
      )
      // 大载荷外置:text 块超阈值 → artifact 引用(正文存 store,历史/投影/事件流只含引用)
      const artifactThreshold = options.artifactThresholdBytes ?? DEFAULT_ARTIFACT_THRESHOLD_BYTES
      const content = externalizeContent(store, sessionId, bounded, artifactThreshold)
      const stored: Message = { ...message, content }
      store.messages.append(sessionId, stored)
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "transcript", message: stored })
      touch()
      recordEpochState()
    },

    project() {
      if (cachedProjection !== null && cachedEpoch === epoch.current) return cachedProjection
      const history = store.messages.list(sessionId).messages
      const input = baseProjectionInput()
      const result = project({ ...input, history, requestedT1: [...requestedT1] }, projectionOptions)
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

    setModel(model: Model): void {
      projectionOptions.model = model
      touch()
    },

    pendSyscall(ask: { questionId?: string; toolCallId: string; toolName: string; summary: string }): PendingSyscall {
      const syscall: PendingSyscall = {
        questionId: ask.questionId ?? uuid(),
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
      requestedT1.clear()
      touch()
    },

    requestTools(names: readonly string[]): void {
      if (projectionOptions.toolTierRules === undefined) return
      const { overrides, defaultTier } = projectionOptions.toolTierRules
      const isT1 = (name: string): boolean => {
        const tool = projectionOptions.tools.find((t) => t.name === name)
        return (overrides[name] ?? tool?.tier ?? defaultTier) === "T1"
      }
      let changed = false
      for (const name of names) {
        if (isT1(name) && !requestedT1.has(name)) {
          requestedT1.add(name)
          changed = true
        }
      }
      if (changed) touch()
    },

    recordToolCall(): void {
      usage = { ...usage, toolCallsThisTurn: usage.toolCallsThisTurn + 1 }
      saveUsage(store, sessionId, usage)
      touch()
    },

    commitTurn(turnId: string): void {
      saveCommittedTurn(store, sessionId, turnId)
    },

    compact(reason: string, summaryText: string): void {
      runCompact({
        store,
        sessionId,
        messages: store.messages.list(sessionId).messages,
        keepRecent: options.compactionKeepRecent ?? 6,
        reason,
        summaryText,
        clockNow: () => clock().wall,
        emit,
        registerSummary: (id) => {
          summaryIds = [...summaryIds, id]
          saveSummaryIds(store, sessionId, summaryIds)
        },
        touch,
      })
      // 压缩完成 = 检查点落盘(契约 LifecycleEvent.checkpointed 的产出路径)
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "checkpointed" })
      register()
    },

    retrieve(optionsIn: { query: string; offset?: number; limit?: number }) {
      // 活跃历史 + 归档区(压缩交换的全文回取)合并检索;命中标注来源
      const live = store.messages.search(sessionId, optionsIn.query, 0, optionsIn.limit ?? Number.MAX_SAFE_INTEGER)
      const archived = store.messages.archiveSearch(sessionId, optionsIn.query, 0, optionsIn.limit ?? Number.MAX_SAFE_INTEGER)
      const liveResults: Retrieved[] = live.messages.map((m) => {
        const excerpt = textOf(m)
        return {
          id: m.id,
          source: summaryIds.includes(m.id) ? "summary" : "history",
          message: m,
          excerpt: excerpt.slice(0, 200),
        }
      })
      const archivedResults: Retrieved[] = archived.messages.map((m) => ({
        id: m.id,
        source: "history",
        message: m,
        excerpt: textOf(m).slice(0, 200),
      }))
      const all = [...liveResults, ...archivedResults]
      const offset = optionsIn.offset ?? 0
      const limit = optionsIn.limit ?? all.length
      return { results: all.slice(offset, offset + limit), total: all.length }
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
      register()
    },

    archive(): void {
      status = "archived"
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "archived" })
      touch()
      register()
    },

    resume(): void {
      status = "active"
      emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "active" })
      touch()
      register()
    },
  }

  // 新会话出生事件:治理面区分"创建"与"恢复"(created 仅发一次,重启恢复不发)
  if (store.sessions.get(sessionId) == null) {
    emit({ id: uuid(), timestamp: clock().wall, redact: [], kind: "lifecycle", sessionId, state: "created" })
  }
  register()

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
