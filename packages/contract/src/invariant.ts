// @tau/contract — 不变量检查器(纯函数,零 IO)。
// 双视角 / 预算 / 重放一致性,供单测、CI 与 eval 断言;assertX 失败即抛。

import { z } from "zod"
import type { Event } from "./event.ts"
import type { ContextProjection, Message } from "./context.ts"
import type { SessionSnapshot } from "./session.ts"

export interface InvariantViolation {
  code: string
  message: string
}

export type InvariantResult = { ok: true } | { ok: false; violations: readonly InvariantViolation[] }

export function pass(): InvariantResult {
  return { ok: true }
}

export function fail(...violations: InvariantViolation[]): InvariantResult {
  return { ok: false, violations }
}

export function assertInvariant(result: InvariantResult, what: string): void {
  if (!result.ok) {
    const detail = result.violations.map((v) => `[${v.code}] ${v.message}`).join("; ")
    throw new Error(`${what}: ${detail}`)
  }
}

// ---------- UiView(双视角不变量:UI 可见 ⊆ 投影 ∪ 事件) ----------

export const UiViewSchema = z.object({
  transcript: z.array(z.object({ messageId: z.string(), role: z.enum(["user", "assistant", "tool", "system"]) })),
  pendingSyscalls: z.array(z.object({ questionId: z.string(), toolName: z.string() })),
  activeGoals: z.array(z.object({ id: z.string(), status: z.enum(["active", "paused", "completed", "failed", "cancelled"]) })),
  status: z.enum(["active", "archived", "closed"]),
})
export type UiView = z.infer<typeof UiViewSchema>

/** 双视角不变量:UI 显示的任何信息都能从 Context 或 Events 推出。 */
export function checkDualView(ui: UiView, projection: ContextProjection, events: readonly Event[]): InvariantResult {
  const violations: InvariantViolation[] = []
  const projectionMessageIds = new Set(projection.history.map((m) => m.id))
  const eventMessageIds = new Set(events.filter((e) => e.kind === "transcript").map((e) => (e.kind === "transcript" ? e.message.id : "")))
  for (const row of ui.transcript) {
    if (!projectionMessageIds.has(row.messageId) && !eventMessageIds.has(row.messageId)) {
      violations.push({
        code: "dual_view.message_not_derivable",
        message: `UI 消息 ${row.messageId} 既不在投影 history 也不在 transcript 事件中`,
      })
    }
  }
  const pendingByQuestion = new Map(projection.pendingSyscalls.map((p) => [p.questionId, p.toolName]))
  const permissionRequested = new Set(
    events.filter((e) => e.kind === "permission" && e.state === "requested").map((e) => (e.kind === "permission" ? e.toolName : "")),
  )
  for (const sys of ui.pendingSyscalls) {
    if (pendingByQuestion.get(sys.questionId) !== sys.toolName && !permissionRequested.has(sys.toolName)) {
      violations.push({
        code: "dual_view.syscall_not_derivable",
        message: `UI 挂起请求 ${sys.questionId}(${sys.toolName}) 不可从投影或 permission 事件推出`,
      })
    }
  }
  const goalById = new Map(projection.activeGoals.map((g) => [g.id, g.status]))
  for (const g of ui.activeGoals) {
    if (goalById.get(g.id) !== g.status) {
      violations.push({ code: "dual_view.goal_not_derivable", message: `UI 目标 ${g.id} 不在投影 activeGoals 中` })
    }
  }
  const lifecycleState = lastLifecycleState(events)
  if (lifecycleState !== null && ui.status !== lifecycleState) {
    violations.push({
      code: "dual_view.status_not_derivable",
      message: `UI 状态 ${ui.status} 与生命周期事件推导的 ${lifecycleState} 不一致`,
    })
  }
  return violations.length === 0 ? pass() : fail(...violations)
}

// ---------- 预算检查器 ----------

/** 预算纪律:轮次/单轮工具调用/上下文窗。maxTurnMs 由 orchestrate 执行期强制,此处不判。 */
export function checkBudget(projection: ContextProjection): InvariantResult {
  const violations: InvariantViolation[] = []
  const { budget } = projection.resources
  const usage = projection.self.usage
  if (usage.turn > budget.maxTurns) {
    violations.push({ code: "budget.max_turns", message: `turn ${usage.turn} > maxTurns ${budget.maxTurns}` })
  }
  if (usage.toolCallsThisTurn > budget.maxToolCallsPerTurn) {
    violations.push({
      code: "budget.max_tool_calls_per_turn",
      message: `toolCallsThisTurn ${usage.toolCallsThisTurn} > maxToolCallsPerTurn ${budget.maxToolCallsPerTurn}`,
    })
  }
  const maxTokens = projection.self.model.contextWindow.maxTokens
  if (usage.totalTokens > maxTokens) {
    violations.push({ code: "budget.context_overflow", message: `totalTokens ${usage.totalTokens} > contextWindow ${maxTokens}` })
  }
  return violations.length === 0 ? pass() : fail(...violations)
}

// ---------- 重放一致性检查器 ----------

function lastLifecycleState(events: readonly Event[]): "active" | "archived" | "closed" | null {
  let state: "active" | "archived" | "closed" | null = null
  for (const e of events) {
    if (e.kind === "lifecycle") {
      state = e.state === "closed" ? "closed" : e.state === "archived" ? "archived" : "active"
    }
  }
  return state
}

/** 重放一致性:事件重放 → 重建投影 → 与快照一致(eval 断言 1 的配套)。
 * 投影重建由 session 完成,此处只做结构级一致性核对。 */
export function checkReplay(
  events: readonly Event[],
  projection: ContextProjection,
  snapshot: SessionSnapshot,
): InvariantResult {
  const violations: InvariantViolation[] = []
  if (projection.version !== snapshot.epoch) {
    violations.push({
      code: "replay.version_mismatch",
      message: `投影 version ${projection.version} != 快照 epoch ${snapshot.epoch}`,
    })
  }
  const replayedIds = events.filter((e) => e.kind === "transcript").map((e) => (e.kind === "transcript" ? e.message.id : ""))
  const projectedIds = projection.history.map((m) => m.id)
  if (replayedIds.length !== projectedIds.length || replayedIds.some((id, i) => id !== projectedIds[i])) {
    violations.push({
      code: "replay.transcript_mismatch",
      message: `transcript 事件序列与投影 history 不一致(${replayedIds.length} vs ${projectedIds.length})`,
    })
  }
  if (snapshot.transcriptCount !== projection.history.length) {
    violations.push({
      code: "replay.transcript_count_mismatch",
      message: `快照 transcriptCount ${snapshot.transcriptCount} != 投影 history ${projection.history.length}`,
    })
  }
  const snapSys = new Map(snapshot.pendingSyscalls.map((p) => [p.questionId, p.toolName]))
  for (const p of projection.pendingSyscalls) {
    if (snapSys.get(p.questionId) !== p.toolName) {
      violations.push({ code: "replay.syscall_mismatch", message: `投影挂起 ${p.questionId} 不在快照中` })
    }
  }
  const snapGoals = new Map(snapshot.activeGoals.map((g) => [g.id, g.status]))
  for (const g of projection.activeGoals) {
    if (snapGoals.get(g.id) !== g.status) {
      violations.push({ code: "replay.goal_mismatch", message: `投影目标 ${g.id} 与快照不一致` })
    }
  }
  const lifecycleState = lastLifecycleState(events)
  if (lifecycleState !== null && lifecycleState !== snapshot.status) {
    violations.push({
      code: "replay.status_mismatch",
      message: `生命周期事件推导 ${lifecycleState} != 快照状态 ${snapshot.status}`,
    })
  }
  return violations.length === 0 ? pass() : fail(...violations)
}

// ---------- 工具调用配对 ----------

/** 工具调用配对不变量:每个 toolCall 恰有一个 toolResult(按 callId),且无孤儿结果。 */
export function checkToolPairing(messages: readonly Message[]): InvariantResult {
  const violations: InvariantViolation[] = []
  const called = new Set<string>()
  const answered = new Map<string, number>()
  for (const m of messages) {
    for (const tc of m.toolCalls) {
      if (called.has(tc.id)) violations.push({ code: "pairing.duplicate_call", message: `toolCall ${tc.id} 重复` })
      called.add(tc.id)
    }
    for (const tr of m.toolResults) {
      answered.set(tr.callId, (answered.get(tr.callId) ?? 0) + 1)
      if (tr.result !== undefined && tr.error !== undefined) {
        violations.push({ code: "pairing.result_and_error", message: `toolResult ${tr.callId} 同时有 result 与 error` })
      }
    }
  }
  for (const [callId, n] of answered) {
    if (!called.has(callId)) violations.push({ code: "pairing.orphan_result", message: `toolResult ${callId} 无对应 toolCall` })
    if (n > 1) violations.push({ code: "pairing.duplicate_result", message: `toolResult ${callId} 重复 ${n} 次` })
  }
  for (const id of called) {
    if (!answered.has(id)) violations.push({ code: "pairing.missing_result", message: `toolCall ${id} 缺 toolResult` })
  }
  return violations.length === 0 ? pass() : fail(...violations)
}

// ---------- assertX 包装 ----------

export function assertDualView(ui: UiView, projection: ContextProjection, events: readonly Event[]): void {
  assertInvariant(checkDualView(ui, projection, events), "双视角不变量")
}

export function assertBudget(projection: ContextProjection): void {
  assertInvariant(checkBudget(projection), "预算不变量")
}

export function assertReplay(events: readonly Event[], projection: ContextProjection, snapshot: SessionSnapshot): void {
  assertInvariant(checkReplay(events, projection, snapshot), "重放一致性")
}

export function assertToolPairing(messages: readonly Message[]): void {
  assertInvariant(checkToolPairing(messages), "工具配对不变量")
}
