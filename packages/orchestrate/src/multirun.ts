// @tau/orchestrate - multirun.ts:多模型并行执行(子会话隔离)。
// 每个模型一个独立子会话(独立 durable 存储/审计/历史,parentId 标注来源),
// 互不污染主会话;fusion 汇总各 run 产出生成新会话(可继续对话)。

import type { Event } from "@tau/contract"
import type { Store } from "@tau/store"
import type { LlmKernel } from "@tau/llm"
import { createHash } from "node:crypto"
import { createSession, type Session } from "@tau/session"
import type { ActionPlane } from "@tau/action"
import { createScheduler, type Scheduler, type TurnResult } from "./scheduler.ts"

export type MultiRunConfig = {
  models: string[]
  task: string
  maxConcurrent?: number
}

export type RunResult = {
  model: string
  sessionId: string
  result: TurnResult
  events: Event[]
  /** 子会话 cwd:工作树隔离时指向独立 worktree;无工作树能力时退回祖先 cwd。 */
  cwd: string
}

export type MultiRunResult = {
  runs: RunResult[]
  completedAt: string
}

export type MultiRunDeps = {
  llm: LlmKernel
  /** 祖先会话:子会话从它的 cwd/workspaceRoots 继承;祖先历史不被子 run 污染。 */
  session: Session
  store: Store
  action: ActionPlane
}

/**
 * 多模型并行执行:同一任务在多个模型上并行运行。
 * 每个模型使用独立子会话(独立 scheduler + session,parentId 指向祖先),互不共享历史。
 */
export async function runMultiRun(
  deps: MultiRunDeps,
  config: MultiRunConfig,
): Promise<MultiRunResult> {
  const { models, task, maxConcurrent = 3 } = config
  const parent = deps.session
  const parentProj = parent.project()
  const runs: RunResult[] = []

  const chunks = chunkArray(models, maxConcurrent)
  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (model) => {
      const childId = `${parent.sessionId}-${model.replace(/[^a-zA-Z0-9-]/g, "-")}`
      const events: Event[] = []
      const eventCollector = (event: Event) => events.push(event)

      // 工作树归属:创建/清理委托 action(唯一副作用出口,经 execute 审计,tier T2 不注入)
      const worktreeName = `${parent.sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 24)}-${createHash("sha256").update(childId).digest("hex").slice(0, 8)}`
      let worktreeCwd = parentProj.self.cwd
      try {
        await deps.action.execute({ sessionId: parent.sessionId, toolCallId: `wt-${childId}`, name: "worktree:rm", args: { name: worktreeName } })
        const created = await deps.action.execute({ sessionId: parent.sessionId, toolCallId: `wt-${childId}`, name: "worktree:create", args: { name: worktreeName } })
        if (created.ok && created.result.stdout !== null) worktreeCwd = created.result.stdout
      } catch {
        // 无工作树能力(未绑定根/执行器缺省)时退回父会话 cwd,隔离降级不阻断运行
      }

      const child = createSession({
        store: deps.store,
        sessionId: childId,
        parentId: parent.sessionId,
        sessionTitle: `multirun:${model}`,
        cwd: worktreeCwd,
        workspaceRoots: [worktreeCwd],
        onEvent: eventCollector,
      })
      const scheduler: Scheduler = createScheduler(
        { llm: deps.llm, session: child, action: deps.action },
        { model, onEvent: eventCollector },
      )
      try {
        const result = await scheduler.prompt({ text: task, source: "prompt" })
        return { model, sessionId: childId, result, events, cwd: worktreeCwd }
      } finally {
        child.close()
        // 清理失败不抛:残留由下一次 worktree:create 前的 rm 接管,单 run 异常不覆灭整批
        try {
          await deps.action.execute({ sessionId: parent.sessionId, toolCallId: `wt-${childId}`, name: "worktree:rm", args: { name: worktreeName } })
        } catch {
          /* 降级:允许残留,下次 rm 清理 */
        }
      }
    })

    const chunkResults = await Promise.all(chunkPromises)
    runs.push(...chunkResults)
  }

  return {
    runs,
    completedAt: new Date().toISOString(),
  }
}

/** 融合多个 run 的产出,生成可继续对话的新会话(依赖单向向下,经 session 输入通道注入)。 */
export function createFusedSession(
  deps: { store: Store; session: Session },
  runs: readonly RunResult[],
  opts: { sessionId: string } = { sessionId: `${deps.session.sessionId}-fusion` },
): Session {
  const parts = runs.map((r) => {
    const text = r.result.text.trim()
    return `## ${r.model}(session ${r.sessionId})\n${text === "" ? "(无文本产出)" : text}`
  })
  const fused = createSession({
    store: deps.store,
    sessionId: opts.sessionId,
    parentId: deps.session.sessionId,
    sessionTitle: "fusion",
    cwd: deps.session.project().self.cwd,
    workspaceRoots: deps.session.project().resources.workspaceRoots,
  })
  fused.admit({ text: `以下是多模型并行执行同一任务的产出汇总,请合并去重、标注冲突,形成最终结论:\n\n${parts.join("\n\n")}`, source: "fusion", wake: "steer" })
  return fused
}

/**
 * 从多个运行结果中选择最佳结果。
 * 当前使用简单策略:选择工具调用最少的结果(假设更高效)。
 */
export function selectBestRun(runs: RunResult[]): RunResult | null {
  if (runs.length === 0) return null

  const successfulRuns = runs.filter((r) => !r.result.aborted && r.result.error === null)
  if (successfulRuns.length === 0) return runs[0] ?? null

  return successfulRuns.reduce((best, current) => {
    return current.result.toolCalls < best.result.toolCalls ? current : best
  })
}

/** 将数组分成指定大小的块。 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}
