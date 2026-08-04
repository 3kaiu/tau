// @tau/eval - fixtures.ts:测试运行时夹具(FauxLlm + session + action + orchestrate + face)。
// 合成事件流的共享构造;断言间无共享状态,每个断言独立创建 fixture。

import { createMemoryStore, type Store } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler, type Scheduler, type SchedulerOptions } from "@tau/orchestrate"
import { createCommandFace, type CommandFace } from "@tau/surface"
import { createFauxLlm, type FauxScript } from "./faux.ts"
import type { LlmKernel } from "@tau/llm"
import type { Event, Model } from "@tau/contract"

const FAUX_MODEL: Model = {
  id: "faux-1",
  name: "FauxLlm",
  provider: { api: "openai-compatible", provider: "faux", envKey: "", auth: "none" },
  capabilities: { supportsTools: true, supportsThinking: false, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
  cost: { inputPerMillion: 0, outputPerMillion: 0 },
  contextWindow: { maxTokens: 128_000 },
}

export type FixtureOptions = {
  script: FauxScript
  cwd?: string
  workspaceRoots?: string[]
  autoApprove?: boolean
  schedulerOptions?: Partial<SchedulerOptions>
  sessionId?: string
  /** 复用已有 store(恢复测试用:新 session 从旧 store 重放)。 */
  store?: Store
}

export type Fixture = {
  store: Store
  session: Session
  action: ActionPlane
  scheduler: Scheduler
  face: CommandFace
  llm: LlmKernel
  events: Event[]
  /** 关闭 session(emit lifecycle closed);crash 模拟跳过此步。 */
  cleanup: () => void
  /** 不关闭 session,仅释放引用(crash 模拟:进程级终止不 emit closed)。 */
  abandon: () => void
}

export function createFixture(opts: FixtureOptions): Fixture {
  const cwd = opts.cwd ?? "/tmp/tau-eval"
  const workspaceRoots = opts.workspaceRoots ?? [cwd]
  const store = opts.store ?? createMemoryStore()
  const sessionId = opts.sessionId ?? "eval"

  const events: Event[] = []

  // 各源独立收集(不互相转发,防递归):session/action/scheduler 各自 emit -> events[]
  const collectEvent = (event: Event): void => {
    events.push(event)
  }

  const action = createActionPlane(store, {
    workspaceRoots,
    autoApprove: opts.autoApprove ?? true,
    onEvent: collectEvent,
  })

  const session = createSession({
    store,
    sessionId,
    cwd,
    workspaceRoots,
    tools: action.registry.all(),
    model: FAUX_MODEL,
    onEvent: collectEvent,
  })

  const llm = createFauxLlm(opts.script)

  const scheduler = createScheduler(
    { llm, session, action },
    { ...opts.schedulerOptions, onEvent: collectEvent },
  )

  const face = createCommandFace({ orchestrate: scheduler, session })

  return {
    store,
    session,
    action,
    scheduler,
    face,
    llm,
    events,
    cleanup: () => {
      session.close()
    },
    abandon: () => {
      // crash 模拟:不 emit closed,不 close store
    },
  }
}

/** 运行一个 prompt 并等待完成,返回收集的事件。 */
export async function runTurn(f: Fixture, text: string): Promise<Event[]> {
  const before = f.events.length
  await f.scheduler.prompt({ text, source: "prompt" })
  return f.events.slice(before)
}
