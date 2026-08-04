// @tau/orchestrate — scheduler.ts:turn 状态机(唯一时钟)。
// 不生成上下文(委托 session.project)、不执行工具(委托 action.execute);
// turn 是原子单位;任何中断是状态机输入;重试/打断/循环全可见可审计。

import type { Event, Goal, Message } from "@tau/contract"
import type { LlmKernel, LlmCollectResult, LlmRequest } from "@tau/llm"
import type { Session } from "@tau/session"
import type { ActionPlane } from "@tau/action"

export type SchedulerDeps = {
  llm: LlmKernel
  session: Session
  action: ActionPlane
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
}

export type SchedulerInput = {
  text: string
  source?: "prompt" | "steer"
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
  steer(input: SchedulerInput): Promise<void>
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

  const listeners = new Set<(event: Event) => void>()
  const fingerprints = new Map<string, number>()
  let abortController: AbortController | null = null
  let running: Promise<unknown> | null = null
  let steerQueue: SchedulerInput[] = []
  let steerEpoch = 0

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
    const wakeReason: "steer" | "prompt" = input.source === "steer" ? "steer" : "prompt"
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
        const fp = `${call.name}:${JSON.stringify(call.args)}`
        const count = (fingerprints.get(fp) ?? 0) + 1
        fingerprints.set(fp, count)
        if (count > loopGuard) {
          looped = true
          emitRaw({ kind: "loop_detected", turn: turns, pattern: fp })
          appendToolError(call.id, call.name, "rejected", `检测到循环:${fp} 已重复 ${count} 次,已停止`)
          break
        }
        const outcome = await action.execute(
          { sessionId: session.sessionId, toolCallId: call.id, name: call.name, args: call.args as Record<string, unknown>, cwd: session.project().self.cwd },
          { timeoutMs: maxTurnMs },
        )
        if (outcome.ok) {
          appendToolResult(call.id, call.name, outcome.result)
        } else {
          appendToolError(call.id, call.name, outcome.error.code, outcome.error.message)
        }
      }
      if (looped) break
      if (calls.length === 0) break
      if (myEpoch !== steerEpoch) break
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

  return {
    async prompt(input) {
      const job = (async () => runTurn(input))()
      running = job
      try {
        return await job
      } finally {
        running = null
      }
    },
    async steer(input) {
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
