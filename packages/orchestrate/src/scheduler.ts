// @tau/orchestrate — scheduler.ts:turn 状态机(唯一时钟)。
// 不生成上下文(委托 session.project)、不执行工具(委托 action.execute);
// turn 是原子单位;任何中断是状态机输入;重试/打断/循环全可见可审计。

import type { Event, Goal, Message } from "@tau/contract"
import type { LlmKernel, LlmCollectResult, LlmRequest } from "@tau/llm"
import type { Session } from "@tau/session"
import type { ActionPlane } from "@tau/action"
import { GoalJudge } from "./goals.ts"
import { LoopGuard, turnIdOf } from "./lifecycle.ts"

export type SchedulerDeps = {
  llm: LlmKernel
  session: Session
  action: ActionPlane
}

/** 上下文压缩策略(scheduler 触发,摘要源注入:enhance.summarize 或 LLM policy)。 */
export type CompactStrategy = {
  /** 触发阈值:投影历史估算 token 占模型上下文窗比例,超则压缩(缺省 0.8,与契约 Config.compaction.triggerRatio 基线一致)。 */
  thresholdRatio?: number
  /** 摘要生成(经 session.compact 落为 summary 消息;message 为完整历史)。 */
  summarize: (input: { sessionId: string; messages: readonly Message[]; reason: string }) => string | Promise<string>
}

export type SchedulerOptions = {
  maxTurns?: number
  maxTurnMs?: number
  maxToolCallsPerTurn?: number
  maxRetries?: number
  /** 同工具同参数指纹重复次数阈值 → loop_detected(防"成功但原地踏步")。 */
  loopGuard?: number
  model?: string
  onEvent?: (event: Event) => void
  /** Goal 判定配置:每 turn 后校验目标,未完成继续。 */
  goalJudge?: GoalJudge
  /** Goal 续跑轮数上限(goal_continue 唤醒不豁免预算,超限即停发 budget_exceeded)。 */
  goalContinueMaxTurns?: number
  /** 上下文压缩:超预算时自动压缩历史(缺省不压缩)。 */
  compact?: CompactStrategy
}

export type SchedulerInput = {
  text: string
  source?: "prompt" | "steer" | "goal_continue"
}

export type TurnResult = {
  turns: number
  text: string
  toolCalls: number
  aborted: boolean
  error: string | null
}

/** Event 按 kind 分发取 Omit(直接 Omit 联合体会塌缩为公共键)。 */
type EventInput = {
  [K in Event["kind"]]: Extract<Event, { kind: K }> extends infer E extends { kind: K }
    ? Omit<E, "id" | "timestamp" | "redact">
    : never
}[Event["kind"]]

const uuid = () => crypto.randomUUID()
const clock = () => new Date().toISOString()

export interface Scheduler {
  prompt(input: SchedulerInput): Promise<TurnResult>
  steer(input: SchedulerInput, opts?: { interrupt?: "turn" | "immediate" }): Promise<void>
  abort(): void
  subscribe(fn: (event: Event) => void): () => void
  notify(event: Event): void
  waitForIdle(): Promise<void>
  goals: {
    set(goal: Goal): void
    active(): Goal | null
  }
  busy(): boolean
}

export function createScheduler(deps: SchedulerDeps, options: SchedulerOptions = {}): Scheduler {
  const { session, action } = deps
  const maxTurns = options.maxTurns ?? 6
  const maxTurnMs = options.maxTurnMs ?? 120_000
  const maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 24
  const maxRetries = options.maxRetries ?? 2
  const loopGuard = options.loopGuard ?? 3
  const goalJudge = options.goalJudge ?? new GoalJudge()
  const goalContinueMaxTurns = options.goalContinueMaxTurns ?? 3

  const listeners = new Set<(event: Event) => void>()
  const behaviorGuard = new LoopGuard(loopGuard)
  let abortController: AbortController | null = null
  let running: Promise<unknown> | null = null
  let steerQueue: SchedulerInput[] = []
  let steerEpoch = 0
  let goalEpoch = 0

  function emit(event: Event): void {
    for (const fn of listeners) fn(event)
    options.onEvent?.(event)
  }

  function emitRaw(event: EventInput): void {
    emit({ id: uuid(), timestamp: clock(), redact: [], ...event } as Event)
  }

  function llmRequest(): LlmRequest {
    if (options.model !== undefined) return { model: options.model }
    return {}
  }

  async function runTurn(input: SchedulerInput): Promise<TurnResult> {
    steerEpoch++
    const myEpoch = steerEpoch
    const wakeReason = input.source === "steer" ? "steer" : input.source === "goal_continue" ? "goal_continue" : "prompt"
    session.admit({ text: input.text, source: input.source ?? "prompt", wake: wakeReason })
    abortController = new AbortController()
    const signal = abortController.signal

    let turns = 0
    let text = ""
    let toolCalls = 0
    let lastError: string | null = null

    for (; turns < maxTurns; ) {
      turns++
      if (signal.aborted) {
        emitRaw({ kind: "interrupted", targetId: session.sessionId })
        return { turns, text, toolCalls, aborted: true, error: lastError }
      }
      session.beginTurn()
      // turnId = 会话 epoch(经 kv 持久:跨重启单调不重置,进程内同会话不重复);审计与提交点共用此锚
      const turnId = turnIdOf(session.snapshot().epoch)

      let result: LlmCollectResult
      try {
        result = await runWithTimeout(() => deps.llm.complete(session.project(), llmRequest(), signal), maxTurnMs)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        lastError = msg
        emitRaw({ kind: "retry", cause: `turn 异常(${msg})`, attempts: 0 })
        appendAssistant(`(turn 异常:${msg})`, [], false)
        break
      }

      if (signal.aborted || result.aborted) {
        emitRaw({ kind: "interrupted", targetId: result.finishReason ?? "llm" })
        appendAssistant(result.text, result.toolCalls, true)
        return { turns, text, toolCalls, aborted: true, error: lastError }
      }

      let currentError = result.error
      if (currentError !== undefined) {
        if (currentError.retryable && maxRetries > 0) {
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            emitRaw({ kind: "retry", cause: currentError.message, attempts: attempt })
            const again = await deps.llm.complete(session.project(), llmRequest(), signal)
            result = again
            if (again.error === undefined) {
              currentError = undefined
              break
            }
            currentError = again.error
          }
        }
        if (currentError !== undefined) {
          lastError = currentError.message
          appendAssistant(`(模型调用失败:${currentError.message})`, [], false)
          break
        }
      }

      if (result.usage) session.recordUsage(result.usage)
      text = result.text

      const calls = result.toolCalls.slice(0, maxToolCallsPerTurn)
      appendAssistant(result.text, calls, false)
      if (calls.length > maxToolCallsPerTurn) {
        lastError = `工具调用超限:一轮最多 ${maxToolCallsPerTurn} 次`
        emitRaw({ kind: "budget_exceeded", metric: "maxToolCallsPerTurn", used: result.toolCalls.length, limit: maxToolCallsPerTurn })
      }

      let looped = false
      for (const call of calls) {
        toolCalls++
        session.recordToolCall()
        const pattern = behaviorGuard.check(call)
        if (pattern !== null) {
          looped = true
          emitRaw({ kind: "loop_detected", turn: turns, pattern })
          appendToolError(call.id, call.name, "rejected", `检测到循环:${pattern} 已重复超过 ${loopGuard} 次,已停止`)
          break
        }
        const outcome = await action.execute(
          { sessionId: session.sessionId, toolCallId: call.id, name: call.name, args: call.args as Record<string, unknown>, cwd: session.project().self.cwd,
            turnId,
            signal,
            // ask_user 挂起登记:pendingSyscalls 可见性由 session 承载(questionId 以 action 为准)
            onPending: (ask) => session.pendSyscall({ questionId: ask.questionId, toolCallId: ask.questionId, toolName: ask.toolName, summary: ask.summary }) },
          { timeoutMs: maxTurnMs },
        )
        if (outcome.ok) {
          appendToolResult(call.id, call.name, outcome.result)
        } else {
          appendToolError(call.id, call.name, outcome.error.code, outcome.error.message)
        }
        // 按需注入(T1 用过即注入本 turn 后续迭代;新 turn 由 session.beginTurn 重置)
        session.requestTools([call.name])
        // 立即断流(interrupt: "immediate"):在飞工具已中止(aborted),剩余调用不执行,本 turn 就此截断
        if (signal.aborted) break
      }
      // 提交点边界:本 turn 全部 syscall 结果已落盘,标记已提交(悬置判定:审计最后 turn ≠ 此锚 = 未提交)
      if (signal.aborted) emitRaw({ kind: "interrupted", targetId: session.sessionId })
      session.commitTurn(turnId)
      if (looped) break
      if (calls.length === 0) break
      // 上下文压缩:turn 尾部检查历史体积,超预算 → 摘要化老消息(下一轮看到压缩后历史)
      if (options.compact !== undefined) {
        await maybeCompact(session, options.compact)
      }
      if (myEpoch !== steerEpoch) break
    }

    // Goal 判定:每 turn 后校验目标,未完成继续
    const activeGoal = session.snapshot().activeGoals.find((g) => g.status === "active")
    if (activeGoal) {
      const judgeResult = await goalJudge.judge(activeGoal, session)
      goalJudge.updateGoal(session, activeGoal, judgeResult)
      if (judgeResult.status === "completed") {
        emitRaw({ kind: "goal", goalId: activeGoal.id, status: "completed", progress: 1.0, reason: judgeResult.reason })
      } else if (judgeResult.status === "blocked") {
        emitRaw({ kind: "goal", goalId: activeGoal.id, status: "blocked", progress: judgeResult.progress, reason: judgeResult.reason })
      }
    }

    if (turns >= maxTurns) {
      emitRaw({ kind: "budget_exceeded", metric: "maxTurns", used: turns, limit: maxTurns })
    }
    return { turns, text, toolCalls, aborted: signal.aborted, error: lastError }
  }

  function appendAssistant(textIn: string, calls: { id: string; name: string; args: unknown }[], interrupted: boolean): void {
    const message: Message = {
      id: uuid(),
      role: "assistant",
      content: textIn === "" ? [] : [{ type: "text", text: textIn }],
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: (c.args ?? {}) as Record<string, unknown> })),
      toolResults: [],
      interrupted,
      source: "model",
      modelId: options.model,
      retention: "normal",
      createdAt: clock(),
    }
    session.appendMessage(message)
  }

  function appendToolResult(callId: string, name: string, result: Record<string, unknown>): void {
    session.appendMessage({
      id: uuid(),
      role: "tool",
      content: [],
      toolCalls: [],
      toolResults: [{ callId, result: result as never }],
      interrupted: false,
      source: name,
      retention: "low",
      createdAt: clock(),
    })
  }

  function appendToolError(callId: string, name: string, code: string, message: string): void {
    session.appendMessage({
      id: uuid(),
      role: "tool",
      content: [],
      toolCalls: [],
      toolResults: [{ callId, error: { code: code as never, message } }],
      interrupted: false,
      source: name,
      retention: "low",
      createdAt: clock(),
    })
  }

  async function runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`turn 超时 ${ms}ms`)), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 投影历史体积估算(字符/4 ≈ token);artifact 引用按 size 计入,不因外置而漏算;超模型上下文窗阈值 → 摘要化老消息。 */
  async function maybeCompact(sessionIn: Session, strategy: CompactStrategy): Promise<void> {
    const projection = sessionIn.project()
    const history = projection.history
    const maxTokens = projection.self.model.contextWindow.maxTokens
    const estimatedTokens = history.reduce(
      (n, m) => n + m.content.reduce((acc, b) => acc + (b.type === "text" ? b.text.length : b.type === "artifact" && b.size !== undefined ? b.size : 0), 0) / 4,
      0,
    )
    if (estimatedTokens <= maxTokens * (strategy.thresholdRatio ?? 0.8)) return
    const summaryText = await strategy.summarize({ sessionId: sessionIn.sessionId, messages: history, reason: "context-overflow" })
    sessionIn.compact("context-overflow", summaryText)
  }

  /** Goal 续跑:目标未完成 → goal_continue 唤醒新一轮 turn(计入 goalContinueMaxTurns,超限预算止)。 */
  async function promptWithGoalContinue(input: SchedulerInput): Promise<TurnResult> {
    let result = await runTurn(input)
    const baseGoalEpoch = goalEpoch
    for (let gi = 0; gi < goalContinueMaxTurns; gi++) {
      if (result.aborted || goalEpoch !== baseGoalEpoch) break
      const activeGoal = session.snapshot().activeGoals.find((g) => g.status === "active")
      if (activeGoal === undefined) break
      const judgeResult = await goalJudge.judge(activeGoal, session)
      goalJudge.updateGoal(session, activeGoal, judgeResult)
      if (judgeResult.status === "completed") {
        emitRaw({ kind: "goal", goalId: activeGoal.id, status: "completed", progress: 1.0, reason: judgeResult.reason })
        break
      }
      if (judgeResult.status === "blocked") {
        emitRaw({ kind: "goal", goalId: activeGoal.id, status: "blocked", progress: judgeResult.progress, reason: judgeResult.reason })
        break
      }
      emitRaw({ kind: "goal", goalId: activeGoal.id, status: "progress", progress: judgeResult.progress, reason: `未完成,继续执行(${gi + 1}/${goalContinueMaxTurns})` })
      result = await runTurn({ text: `继续执行目标:${activeGoal.text}`, source: "goal_continue" })
    }
    return result
  }

  return {
    async prompt(input) {
      const job = (async () => {
        const result = await promptWithGoalContinue(input)
        // drain steer 队列:忙时入队的 steer 在此消费(runTurn 内 epoch 检查已中断主循环)
        while (steerQueue.length > 0) {
          const next = steerQueue.shift()
          if (next === undefined) break
          await promptWithGoalContinue(next)
        }
        return result
      })()
      running = job
      try {
        return await job
      } finally {
        running = null
      }
    },
    async steer(input, opts = {}) {
      goalEpoch++
      steerEpoch++
      // 立即断流:中止在飞 turn(llm 调用与工具执行共享 signal,工具收到 aborted;剩余调用不执行)
      if (opts.interrupt === "immediate") abortController?.abort()
      steerQueue.push({ ...input, source: "steer" })
      if (running === null) {
        const next = steerQueue.shift()
        if (next) await this.prompt(next)
      }
    },
    abort() {
      abortController?.abort()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** 外部事件桥(compose 用):session/action 发出的事件统一经调度器转发,订阅者拿到全量 Event 流。 */
    notify(event: Event) {
      emit(event)
    },
    async waitForIdle() {
      while (running !== null) await running
    },
    goals: {
      set: (goal: Goal) => session.setGoal(goal),
      active: () => session.snapshot().activeGoals.find((g) => g.status === "active") ?? null,
    },
    busy: () => running !== null,
  }
}
