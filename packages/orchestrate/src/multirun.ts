// @tau/orchestrate - multirun.ts:多模型并行执行。
// 同一任务在多个模型上并行运行,收集结果供后续决策。

import type { Event } from "@tau/contract"
import type { LlmKernel } from "@tau/llm"
import type { Session } from "@tau/session"
import type { ActionPlane } from "@tau/action"
import { createScheduler, type Scheduler, type TurnResult } from "./scheduler.ts"

export type MultiRunConfig = {
  models: string[]
  task: string
  maxConcurrent?: number
}

export type RunResult = {
  model: string
  result: TurnResult
  events: Event[]
}

export type MultiRunResult = {
  runs: RunResult[]
  completedAt: string
}

export type MultiRunDeps = {
  llm: LlmKernel
  session: Session
  action: ActionPlane
}

/**
 * 多模型并行执行:同一任务在多个模型上并行运行。
 * 每个模型使用独立的 scheduler 实例,共享同一个 session 和 action。
 */
export async function runMultiRun(
  deps: MultiRunDeps,
  config: MultiRunConfig,
): Promise<MultiRunResult> {
  const { models, task, maxConcurrent = 3 } = config
  const runs: RunResult[] = []

  // 限制并发数
  const chunks = chunkArray(models, maxConcurrent)

  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (model) => {
      const events: Event[] = []
      const eventCollector = (event: Event) => {
        events.push(event)
      }

      // 为每个模型创建独立的 scheduler
      const scheduler: Scheduler = createScheduler(
        { llm: deps.llm, session: deps.session, action: deps.action },
        { model, onEvent: eventCollector },
      )

      // 执行任务
      const result = await scheduler.prompt({ text: task, source: "prompt" })

      return {
        model,
        result,
        events,
      }
    })

    // 等待当前批次完成
    const chunkResults = await Promise.all(chunkPromises)
    runs.push(...chunkResults)
  }

  return {
    runs,
    completedAt: new Date().toISOString(),
  }
}

/**
 * 将数组分成指定大小的块。
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

/**
 * 从多个运行结果中选择最佳结果。
 * 当前使用简单策略:选择工具调用最少的结果(假设更高效)。
 */
export function selectBestRun(runs: RunResult[]): RunResult | null {
  if (runs.length === 0) return null

  // 过滤出成功的运行
  const successfulRuns = runs.filter((r) => !r.result.aborted && r.result.error === null)
  if (successfulRuns.length === 0) return runs[0] ?? null

  // 选择工具调用最少的
  return successfulRuns.reduce((best, current) => {
    return current.result.toolCalls < best.result.toolCalls ? current : best
  })
}

/**
 * 融合多个运行结果:合并所有工具调用结果,去重。
 */
export function fuseRunResults(runs: RunResult[]): Map<string, unknown> {
  const fused = new Map<string, unknown>()

  for (const run of runs) {
    for (const event of run.events) {
      if (event.kind === "tool" && event.state === "completed" && event.result !== undefined) {
        const key = `${event.name}:${JSON.stringify(event.args)}`
        if (!fused.has(key)) {
          fused.set(key, event.result)
        }
      }
    }
  }

  return fused
}
