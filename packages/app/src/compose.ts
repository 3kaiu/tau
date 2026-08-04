// @tau/app — compose.ts:唯一拼装点。依赖图只在此声明,其他包禁止互相 new。
// 注入点:测试/doctor 可传 override(如 fake llm),生产走默认。

import { createMemoryStore, type Store } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import { createLlmKernel, defaultCatalog, type LlmKernel } from "@tau/llm"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler, type Scheduler, type SchedulerOptions } from "@tau/orchestrate"
import { createCommandFace, type CommandFace } from "@tau/surface"
import type { Model } from "@tau/contract"

export type ComposeOptions = {
  sessionId?: string
  cwd?: string
  workspaceRoots?: string[]
  model?: string
  autoApprove?: boolean
  store?: Store
  llm?: LlmKernel
  schedulerOptions?: Omit<SchedulerOptions, "model">
  catalog?: readonly Model[]
}

export type TauRuntime = {
  store: Store
  session: Session
  llm: LlmKernel
  action: ActionPlane
  scheduler: Scheduler
  face: CommandFace
}

export function compose(options: ComposeOptions = {}): TauRuntime {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoots = options.workspaceRoots ?? [cwd]
  const store = options.store ?? createMemoryStore()
  const sessionId = options.sessionId ?? "main"
  const catalog = options.catalog ?? defaultCatalog()
  const modelId = options.model ?? catalog[0]?.id ?? "default"

  const action = createActionPlane(store, { workspaceRoots, autoApprove: options.autoApprove ?? false })
  let schedulerBridge: ((event: import("@tau/contract").Event) => void) | null = null

  const sessionModel = catalog.find((m) => m.id === modelId)
  const session = createSession({
    store,
    sessionId,
    cwd,
    workspaceRoots,
    tools: action.registry.all(),
    ...(sessionModel !== undefined ? { model: sessionModel } : {}),
    onEvent: (event) => schedulerBridge?.(event),
  })

  const llm =
    options.llm ??
    createLlmKernel({
      catalog,
      getApiKey: (model) => process.env[`TAU_${model.provider.provider.toUpperCase()}_API_KEY`] ?? null,
    })

  const scheduler = createScheduler(
    { llm, session, action },
    { ...(modelId !== "default" ? { model: modelId } : {}), ...options.schedulerOptions },
  )
  schedulerBridge = (event) => scheduler.notify(event)
  const face = createCommandFace({ orchestrate: scheduler, session })

  return { store, session, llm, action, scheduler, face }
}
