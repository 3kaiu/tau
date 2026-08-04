// @tau/app - compose.ts:唯一拼装点。依赖图只在此声明,其他包禁止互相 new。
// 注入点:测试/doctor 可传 override(如 fake llm),生产走默认。

import { createMemoryStore, createStore, type Store } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import { createLlmKernel, defaultCatalog, type LlmKernel } from "@tau/llm"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler, type Scheduler, type SchedulerOptions } from "@tau/orchestrate"
import { createCommandFace, type CommandFace } from "@tau/surface"
import { createEnhancer, type Enhancer } from "@tau/enhance"
import { SystemCallSchema, type Model } from "@tau/contract"

export type ComposeOptions = {
  sessionId?: string
  cwd?: string
  workspaceRoots?: string[]
  model?: string
  autoApprove?: boolean
  store?: Store
  /** SQLite 文件路径;提供则用 sqlite 驱动,否则 memory。 */
  storePath?: string
  llm?: LlmKernel
  schedulerOptions?: Omit<SchedulerOptions, "model">
  catalog?: readonly Model[]
  /** 跳过 enhancer 装载(测试用)。 */
  skipEnhancer?: boolean
}

export type TauRuntime = {
  store: Store
  session: Session
  llm: LlmKernel
  action: ActionPlane
  scheduler: Scheduler
  face: CommandFace
  enhancer: Enhancer | null
}

export function compose(options: ComposeOptions = {}): TauRuntime {
  const cwd = options.cwd ?? process.cwd()
  const workspaceRoots = options.workspaceRoots ?? [cwd]
  const store = options.store ?? (options.storePath !== undefined ? createStore("sqlite", options.storePath) : createMemoryStore())
  const sessionId = options.sessionId ?? "main"
  const catalog = options.catalog ?? defaultCatalog()
  const modelId = options.model ?? catalog[0]?.id ?? "default"

  // enhancer 装载 skills + AGENTS.md -> 投影块
  const enhancer = options.skipEnhancer === true ? null : createEnhancer({ cwd, store })
  const enhancerApplied = enhancer?.apply() ?? { systemBlocks: [], skillNames: [], skillsDir: "" }

  const action = createActionPlane(store, { workspaceRoots, autoApprove: options.autoApprove ?? false })

  // skill:load syscall -- 按名取 skill 全文
  if (enhancer !== null) {
    const skillLoadSchema = SystemCallSchema.parse({
      name: "skill:load",
      description: "加载技能全文。name 来自 self.skills.names 目录。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名称" } },
        required: ["name"],
      },
      tier: "T0",
      dangerous: false,
      defaultRule: { pattern: "skill:load", rule: "allow", scope: "tool" },
    })
    action.registry.register(skillLoadSchema)
    action.registerExecutor("skill:load", async (req) => {
      const name = String(req.args.name ?? "")
      const text = enhancer.getSkill(name)
      if (text === null) {
        return { exitCode: 1, stdout: `skill "${name}" 不存在;可用: ${enhancer.catalog().names.join(", ")}`, stderr: null, truncated: false, totalPages: 1, page: 0 }
      }
      return { exitCode: 0, stdout: text, stderr: null, truncated: false, totalPages: 1, page: 0 }
    })
  }

  let schedulerBridge: ((event: import("@tau/contract").Event) => void) | null = null

  const sessionModel = catalog.find((m) => m.id === modelId)
  const session = createSession({
    store,
    sessionId,
    cwd,
    workspaceRoots,
    tools: action.registry.all(),
    extraSystemBlocks: enhancerApplied.systemBlocks,
    skills: { dir: enhancerApplied.skillsDir, names: enhancerApplied.skillNames },
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

  return { store, session, llm, action, scheduler, face, enhancer }
}
