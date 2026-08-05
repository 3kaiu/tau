// @tau/orchestrate — scheduler.ts:turn 状态机(唯一时钟)。
// 不生成上下文(委托 session.project)、不执行工具(委托 action.execute);
// turn 是原子单位;任何中断是状态机输入;重试/打断/循环全可见可审计。

import { createEventIdGenerator, estimateTokens, type ContextProjection, type Event, type Goal, type Message, type SenderKind, type WakeReason } from "@tau/contract"
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
  /** 唤醒来源 = wake.reason 全集(契约七值):模型永远知道"为什么现在醒"。 */
  source?: WakeReason
  /** 发布界面(审计溯源):face 透传 command.sender.kind,缺省 "cli"。 */
  sender?: SenderKind
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

const uuid = createEventIdGenerator()
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
    return {
      ...(options.model !== undefined ? { model: options.model } : {}),
      // model_switched 构造点:kernel 降级链事件 → 契约事件(经 emit 全量可见/落库)
      onEvent: (event) => {
        if (event.type === "model-switched") {
          emitRaw({ kind: "model_switched", from: event.from, to: event.to, reason: "fallback" })
        }
      },
    }
  }

  async function runTurn(input: SchedulerInput): Promise<TurnResult> {
    steerEpoch++
    const myEpoch = steerEpoch
    const wakeReason = input.source ?? "prompt"
    session.admit({ text: input.text, source: input.source ?? "prompt", wake: wakeReason, ...(input.sender !== undefined ? { senderKind: input.sender } : {}) })
    abortController = new AbortController()
    const signal = abortController.signal

    let turns = 0
    let text = ""
    let toolCalls = 0
    let lastError: string | null = null

    // 循环判定只限本 prompt 的迭代序列(任务边界重置:换任务后合法复用不被旧指纹毒化)
    behaviorGuard.reset()

    for (; turns < maxTurns; ) {
      turns++
      if (signal.aborted) {
        emitRaw({ kind: "interrupted", targetId: session.sessionId })
        return { turns, text, toolCalls, aborted: true, error: lastError }
      }
      // 预算强制(审计9 P1-4):onBudgetExceeded=abort 时累计超限 → 真 abort,不再调模型
      const proj = session.project()
      if (budgetAborted(proj)) {
        const limit = proj.self.usage.estimatedRemaining + proj.self.usage.cumulativeTokens
        lastError = `预算已超限(abort):累计 ${proj.self.usage.cumulativeTokens} >= ${limit}`
        emitRaw({ kind: "budget_exceeded", metric: "cumulativeTokens", used: proj.self.usage.cumulativeTokens, limit })
        break
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
      // 预算强制:无工具调用也会自然结束的 turn,若已超限同样在收尾前 abort
      if (budgetAborted(session.project())) {
        const projNow = session.project()
        const limit = projNow.self.usage.estimatedRemaining + projNow.self.usage.cumulativeTokens
        lastError = `预算已超限(abort):累计 ${projNow.self.usage.cumulativeTokens} >= ${limit}`
        emitRaw({ kind: "budget_exceeded", metric: "cumulativeTokens", used: projNow.self.usage.cumulativeTokens, limit })
        break
      }

      const calls = result.toolCalls.slice(0, maxToolCallsPerTurn)
      const truncatedCalls = result.toolCalls.slice(maxToolCallsPerTurn)
      // 工具阶段截断(steer immediate 在飞工具中止后):与 llm 阶段中断同形态,assistant 消息标 interrupted
      appendAssistant(result.text, calls, signal.aborted)
      if (truncatedCalls.length > 0) {
        // 超限静默删调 → 被删调用全部落显式 rejected 结果(模型可区分"被拦截"与"结果丢失")
        lastError = `工具调用超限:一轮最多 ${maxToolCallsPerTurn} 次(拦截 ${truncatedCalls.length} 个)`
        emitRaw({ kind: "budget_exceeded", metric: "maxToolCallsPerTurn", used: result.toolCalls.length, limit: maxToolCallsPerTurn })
        for (const dropped of truncatedCalls) {
          appendToolError(dropped.id, dropped.name, "rejected", `超出本轮工具调用上限(${maxToolCallsPerTurn}),调用被拦截`)
        }
      }

      let looped = false
      for (const call of calls) {
        if (looped) {
          // 循环触发后同批剩余调用不静默丢:显式 rejected,模型可见"被拦截"
          appendToolError(call.id, call.name, "rejected", "循环已检测,同批剩余调用被拦截")
          continue
        }
        toolCalls++
        session.recordToolCall()
        const pattern = behaviorGuard.check(call)
        if (pattern !== null) {
          looped = true
          emitRaw({ kind: "loop_detected", turn: turns, pattern })
          appendToolError(call.id, call.name, "rejected", `检测到循环:${pattern} 已重复超过 ${loopGuard} 次,已停止`)
          continue
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

  /** 预算 abort 判定:onBudgetExceeded=abort 且累计 tokens 达 maxContextTokens(estimatedRemaining + cumulative = 上限)。 */
  function budgetAborted(proj: ContextProjection): boolean {
    if (proj.resources.onBudgetExceeded !== "abort") return false
    const limit = proj.self.usage.estimatedRemaining + proj.self.usage.cumulativeTokens
    return proj.self.usage.cumulativeTokens >= limit
  }

  /** 投影历史体积估算(estimateTokens:CJK 加权);artifact 引用按 size 计入,不因外置而漏算。
   * 预算尺子与 session 对齐:effective = min(模型上下文窗, session maxContextTokens),超阈值 → 摘要化老消息。 */
  async function maybeCompact(sessionIn: Session, strategy: CompactStrategy): Promise<void> {
    const projection = sessionIn.project()
    const history = projection.history
    const maxTokens = projection.self.model.contextWindow.maxTokens
    const usage = projection.self.usage
    const sessionBudget = usage.estimatedRemaining + usage.cumulativeTokens
    const effectiveBudget = Math.min(maxTokens, sessionBudget)
    const estimatedTokens = history.reduce(
      (n, m) =>
        n +
        m.content.reduce(
          (acc, b) =>
            acc + (b.type === "text" ? estimateTokens(b.text) : b.type === "artifact" && b.size !== undefined ? estimateTokens("x".repeat(b.size)) : 0),
          0,
        ),
      0,
    )
    if (estimatedTokens <= effectiveBudget * (strategy.thresholdRatio ?? 0.8)) return
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
      // busy 守卫(P0-4):双回车 / 并发 POST / cron 叠 turn 一律拒绝,不并行跑同一 session
      // (两个 runTurn 并行 → turnId/审计交错;要排队请走 steer,或等 idle 后重发)
      if (running !== null) {
        return { turns: 0, text: "", toolCalls: 0, aborted: true, error: "会话忙:上一个 turn 未结束(等待 idle 或先 abort)" }
      }
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
