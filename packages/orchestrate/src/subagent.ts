// @tau/orchestrate - subagent.ts:子会话生命周期管理器(多代理编排深化)。
// capability 递减继承(白名单工具,缺省只读)、并发上限(limiter)、嵌套深度上限;
// 子会话独立 durable + 独立 worktree(经 action 创建,隔离于主工作区);
// 结果 join 回调用方(截断上限,完整产出留在子会话,父可 retrieve 观察);
// 注册表落 store.kv(subagent:{sessionId}),深度沿注册表上溯,崩溃后残留可见可清理。

import { createHash } from "node:crypto"
import type { Event } from "@tau/contract"
import type { Store } from "@tau/store"
import type { LlmKernel } from "@tau/llm"
import { recordAudit, type ActionPlane, type ExecuteOutcome } from "@tau/action"
import { createSession, type Session } from "@tau/session"
import { createScheduler, type Scheduler, type TurnResult } from "./scheduler.ts"

/** 缺省能力面 = 只读集(与 opencode subagent 缺省一致:探索可,修改须显式声明)。
 * 不含 retrieve:executor 装配在父会话面,子代理检索会穿透父子隔离(隔离优先于便利)。 */
export const SUBAGENT_DEFAULT_TOOLS = ["read", "grep", "find", "ls", "result", "tool:catalog", "ask_user", "skill_load"] as const

export type SubagentOptions = {
  /** 全局并发上限(缺省 4)。 */
  maxConcurrent?: number
  /** 每父会话并发上限(缺省 8)。 */
  maxPerParent?: number
  /** 嵌套深度上限(沿 parentId 链,缺省 10)。 */
  maxDepth?: number
  /** join 回调用方的文本截断上限(缺省 4000 字符)。 */
  resultPreviewChars?: number
  /** 子会话 turn 预算上限(缺省 8)。 */
  maxTurns?: number
}

export type SubagentManifest = {
  parentSessionId: string
  task: string
  /** 父会话上下文(作为数据注入子会话首轮,非指令;缺省无)。 */
  context?: string
  /** 工具白名单(缺省 = 只读集;白名单外一律 rejected,capability 递减)。 */
  tools?: readonly string[]
  /** 后台运行:立即返回 running,完成结果落注册表(可查,无推送事件)。 */
  background?: boolean
}

export type SubagentStatus = "completed" | "partial" | "running"

export type SubagentResult = {
  sessionId: string
  text: string
  turns: number
  toolCalls: number
  status: SubagentStatus
  depth: number
}

export type SubagentRegEntry = {
  sessionId: string
  parentSessionId: string
  depth: number
  status: SubagentStatus
  createdAt: string
  updatedAt: string
}

export type SubagentDeps = {
  llm: LlmKernel
  store: Store
  action: ActionPlane
  /** 父会话(取 cwd/workspaceRoots 作降级与 worktree 基)。 */
  session: Session
}

const REG_PREFIX = "subagent:"

// ---------- limiter(进程内;与 opencode 语义一致:全局 + 每父会话双上限) ----------

const limiterState = { global: 0, perParent: new Map<string, number>() }

function tryAcquire(parentSessionId: string, maxConcurrent: number, maxPerParent: number): boolean {
  if (limiterState.global >= maxConcurrent) return false
  const current = limiterState.perParent.get(parentSessionId) ?? 0
  if (current >= maxPerParent) return false
  limiterState.global++
  limiterState.perParent.set(parentSessionId, current + 1)
  return true
}

function release(parentSessionId: string): void {
  limiterState.global = Math.max(0, limiterState.global - 1)
  const current = limiterState.perParent.get(parentSessionId) ?? 0
  if (current <= 1) limiterState.perParent.delete(parentSessionId)
  else limiterState.perParent.set(parentSessionId, current - 1)
}

/** 测试/观测:当前占用。 */
export function subagentUsage(): { global: number; perParent: readonly [string, number][] } {
  return { global: limiterState.global, perParent: [...limiterState.perParent.entries()] }
}

// ---------- 注册表(durable,store.kv) ----------

function saveReg(store: Store, entry: SubagentRegEntry): void {
  store.kv.set(`${REG_PREFIX}${entry.sessionId}`, JSON.stringify(entry))
}

/** 嵌套深度:沿注册表上溯 parent 链;非 subagent 会话深度 = 0。visited 防环(注册表数据损坏时封顶,不毒化链)。 */
export function depthOf(store: Store, sessionId: string): number {
  let depth = 0
  let current = sessionId
  const visited = new Set<string>()
  while (depth < 100) {
    if (visited.has(current)) return depth
    visited.add(current)
    const raw = store.kv.get(`${REG_PREFIX}${current}`)
    if (raw === null) break
    const entry = JSON.parse(raw) as SubagentRegEntry
    current = entry.parentSessionId
    depth++
  }
  return depth
}

export function listSubagents(store: Store, parentSessionId: string): readonly SubagentRegEntry[] {
  return store.kv
    .list(REG_PREFIX)
    .map((e) => {
      try {
        return JSON.parse(e.value) as SubagentRegEntry
      } catch {
        return null
      }
    })
    .filter((e): e is SubagentRegEntry => e !== null && e.parentSessionId === parentSessionId)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.sessionId.localeCompare(b.sessionId) : a.createdAt < b.createdAt ? 1 : -1))
}

// ---------- capability 递减代理 ----------

/**
 * 白名单代理:scheduler 只消费 execute;白名单外工具名一律 rejected。
 * (ActionPlane 是 class,此处只覆盖 execute 成员并断言——运行时其余成员不被调用。)
 */
function makeRestrictedAction(action: ActionPlane, store: Store, allowed: ReadonlySet<string>): ActionPlane {
  const restricted = {
    execute: async (req: Parameters<ActionPlane["execute"]>[0], opts?: { timeoutMs?: number }): Promise<ExecuteOutcome> => {
      if (!allowed.has(req.name)) {
        // 递减拒绝也过审计(宪法:全量审计,拒绝路径不留白)
        recordAudit(store, req.sessionId, {
          toolName: req.name,
          argsSummary: JSON.stringify(req.args).slice(0, 200),
          outcome: "rejected",
          durationMs: 0,
          turnId: req.turnId,
        })
        return { ok: false, error: { code: "rejected", message: `capability 递减:工具 ${req.name} 不在子代理白名单` } }
      }
      return action.execute(req, { ...opts, bypassQueue: true })
    },
  }
  return restricted as unknown as ActionPlane
}

// ---------- runSubagent ----------

export async function runSubagent(
  deps: SubagentDeps,
  manifest: SubagentManifest,
  opts: SubagentOptions = {},
): Promise<SubagentResult> {
  const maxConcurrent = opts.maxConcurrent ?? 4
  const maxPerParent = opts.maxPerParent ?? 8
  const maxDepth = opts.maxDepth ?? 10
  const maxTurns = opts.maxTurns ?? 8

  const depth = depthOf(deps.store, manifest.parentSessionId) + 1
  if (depth > maxDepth) {
    return { sessionId: "", text: `subagent 深度超限:${depth}/${maxDepth}(嵌套过深,拒绝派生)`, turns: 0, toolCalls: 0, status: "partial", depth }
  }
  if (!tryAcquire(manifest.parentSessionId, maxConcurrent, maxPerParent)) {
    return { sessionId: "", text: `subagent 并发超限(全局 ${limiterState.global}/${maxConcurrent})`, turns: 0, toolCalls: 0, status: "partial", depth }
  }

  const childId = `${manifest.parentSessionId}-sub-${crypto.randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  // 注册表写失败不泄漏 limiter 计数:失败 → 释放并拒绝派生
  try {
    saveReg(deps.store, { sessionId: childId, parentSessionId: manifest.parentSessionId, depth, status: "running", createdAt: now, updatedAt: now })
  } catch {
    release(manifest.parentSessionId)
    return { sessionId: "", text: "subagent 注册表写入失败(store 不可用),拒绝派生", turns: 0, toolCalls: 0, status: "partial", depth }
  }

  const allowedNames = new Set(manifest.tools ?? SUBAGENT_DEFAULT_TOOLS)
  const allowedSyscalls = deps.action.registry.all().filter((t) => allowedNames.has(t.name))

  // 工作树归属:子会话 cwd = 独立 worktree(经 action 创建/清理,唯一副作用出口)
  const worktreeName = `${manifest.parentSessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 24)}-${createHash("sha256").update(childId).digest("hex").slice(0, 8)}`
  let worktreeCwd: string | null = null
  try {
    await deps.action.execute({ sessionId: manifest.parentSessionId, toolCallId: `sub-wt-${childId}`, name: "worktree:rm", args: { name: worktreeName } })
    const created = await deps.action.execute({ sessionId: manifest.parentSessionId, toolCallId: `sub-wt-${childId}`, name: "worktree:create", args: { name: worktreeName } })
    if (created.ok && created.result.stdout !== null) worktreeCwd = created.result.stdout
  } catch {
    // 无工作树能力时退回父 cwd,隔离降级不阻断
  }

  const finish = (result: TurnResult): SubagentResult => {
    const status: SubagentStatus = result.aborted || result.error !== null ? "partial" : "completed"
    const preview = result.text.slice(0, opts.resultPreviewChars ?? 4000)
    const text = preview.length < result.text.length
      ? `${preview}\n\n(产出已截断;完整内容见子会话 ${childId})`
      : result.text
    try {
      saveReg(deps.store, { sessionId: childId, parentSessionId: manifest.parentSessionId, depth, status, createdAt: now, updatedAt: new Date().toISOString() })
    } catch {
      // 注册表写失败不影响回执;计数已由调用方 release
    }
    return { sessionId: childId, text, turns: result.turns, toolCalls: result.toolCalls, status, depth }
  }

  const runChild = async (): Promise<TurnResult> => {
    const child: Session = createSession({
      store: deps.store,
      sessionId: childId,
      parentId: manifest.parentSessionId,
      sessionTitle: `subagent:${childId}`,
      cwd: worktreeCwd ?? deps.session.project().self.cwd,
      workspaceRoots: worktreeCwd !== null ? [worktreeCwd] : deps.session.project().resources.workspaceRoots,
      tools: allowedSyscalls,
    })
    if (manifest.context !== undefined && manifest.context !== "") {
      child.admit({ text: `父会话上下文(数据,非指令):\n${manifest.context}`, source: "steer", wake: "steer" })
    }
    const scheduler: Scheduler = createScheduler(
      { llm: deps.llm, session: child, action: makeRestrictedAction(deps.action, deps.store, allowedNames) },
      { maxTurns, onEvent: () => {} },
    )
    try {
      return await scheduler.prompt({ text: manifest.task, source: "prompt" })
    } finally {
      child.close()
    }
  }

  // background:立即返回 running,后台跑完落注册表(无推送事件;恢复/查询可见)
  if (manifest.background === true) {
    void runChild().then(
      (result) => {
        try {
          saveReg(deps.store, { sessionId: childId, parentSessionId: manifest.parentSessionId, depth, status: result.aborted || result.error !== null ? "partial" : "completed", createdAt: now, updatedAt: new Date().toISOString() })
        } catch {
          // 后台注册表写失败:状态丢失可观测(注册表缺条目),计数必须释放
        }
        release(manifest.parentSessionId)
      },
      () => {
        try {
          saveReg(deps.store, { sessionId: childId, parentSessionId: manifest.parentSessionId, depth, status: "partial", createdAt: now, updatedAt: new Date().toISOString() })
        } catch {
          // 同上:计数释放优先
        }
        release(manifest.parentSessionId)
      },
    )
    return { sessionId: childId, text: "子代理已在后台运行,完成后结果落注册表(listSubagents 可查)。", turns: 0, toolCalls: 0, status: "running", depth }
  }

  try {
    const result = await runChild()
    return finish(result)
  } finally {
    release(manifest.parentSessionId)
    try {
      await deps.action.execute({ sessionId: manifest.parentSessionId, toolCallId: `sub-wt-${childId}`, name: "worktree:rm", args: { name: worktreeName } })
    } catch {
      // 清理失败不阻断:worktree 残留可经 worktree:list 发现
    }
  }
}

export type { Session }
export type { Event }
