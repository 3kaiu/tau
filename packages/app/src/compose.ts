// @tau/app - compose.ts:唯一拼装点。依赖图只在此声明,其他包禁止互相 new。
// 注入点:测试/doctor 可传 override(如 fake llm),生产走默认。
// MCP 注册必须先于 session 创建(投影 tools 是构造期快照)→ 生产用 composeAsync,同步 compose 不注册 MCP。

import { createMemoryStore, createStore, type Store } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import { createLlmKernel, defaultCatalog, fetchRemoteCatalog, type LlmKernel } from "@tau/llm"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler, type Scheduler, type SchedulerOptions } from "@tau/orchestrate"
import { createCommandFace, type CommandFace } from "@tau/surface"
import { createEnhancer, type Enhancer } from "@tau/enhance"
import { SystemCallSchema, type Event, type Model } from "@tau/contract"
import { registerMcpServers, type McpServerConfig } from "./mcp.ts"

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
  /** MCP server 配置;经 syscall 通道接入(审批/审计不绕行)。 */
  mcpServers?: readonly McpServerConfig[]
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
  /** MCP client 清理(进程退出前调用;stdio 子进程句柄不释放会阻塞退出)。 */
  mcpDispose: () => Promise<void>
}

type Prep = {
  cwd: string
  workspaceRoots: string[]
  store: Store
  sessionId: string
  catalog: readonly Model[]
  modelId: string
  llm: LlmKernel | undefined
  schedulerOptions: Omit<SchedulerOptions, "model"> | undefined
  enhancer: Enhancer | null
  enhancerApplied: { systemBlocks: import("@tau/contract").SystemBlock[]; skillNames: string[]; skillsDir: string }
  action: ActionPlane
  mcpRuntime: { dispose?: () => Promise<void> }
}

/** 同步拼装(不注册 MCP;测试/诊断用)。MCP 场景走 composeAsync。 */
export function compose(options: ComposeOptions = {}): TauRuntime {
  return finishRuntime(prepare(options), [])
}

/** 异步拼装:MCP server 注册先于 session 创建(投影 tools 快照必须含 MCP 工具)。 */
export async function composeAsync(options: ComposeOptions = {}): Promise<TauRuntime> {
  const prep = prepare(options)
  const servers = options.mcpServers
  if (servers === undefined || servers.length === 0) return finishRuntime(prep, [])
  const { registered, failed, dispose } = await registerMcpServers(prep.action, servers)
  prep.mcpRuntime.dispose = dispose
  const events: Event[] = []
  if (failed.length > 0) {
    events.push({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      redact: [],
      kind: "tool",
      toolCallId: "mcp-setup",
      name: "mcp",
      state: "failed",
      error: { code: "internal", message: `MCP 注册失败: ${failed.join("; ")}` },
    })
  }
  events.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    redact: [],
    kind: "tool",
    toolCallId: "mcp-setup",
    name: "mcp",
    state: "completed",
    result: { exitCode: 0, stdout: `MCP 工具已注册 ${registered} 个`, stderr: null, truncated: false, totalPages: 1, page: 0 },
  })
  return finishRuntime(prep, events)
}

function prepare(options: ComposeOptions): Prep {
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

  // skill_load syscall -- 按名取 skill 全文
  if (enhancer !== null) {
    const skillLoadSchema = SystemCallSchema.parse({
      name: "skill_load",
      description: "加载技能全文。name 来自 self.skills.names 目录。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名称" } },
        required: ["name"],
      },
      tier: "T0",
      dangerous: false,
      defaultRule: { pattern: "skill_load", rule: "allow", scope: "tool" },
    })
    action.registry.register(skillLoadSchema)
    action.registerExecutor("skill_load", async (req) => {
      const name = String(req.args.name ?? "")
      const text = enhancer.getSkill(name)
      if (text === null) {
        return { exitCode: 1, stdout: `skill "${name}" 不存在;可用: ${enhancer.catalog().names.join(", ")}`, stderr: null, truncated: false, totalPages: 1, page: 0 }
      }
      return { exitCode: 0, stdout: text, stderr: null, truncated: false, totalPages: 1, page: 0 }
    })
  }

  return { cwd, workspaceRoots, store, sessionId, catalog, modelId, llm: options.llm, schedulerOptions: options.schedulerOptions, enhancer, enhancerApplied, action, mcpRuntime: {} }}

function finishRuntime(prep: Prep, mcpEvents: readonly Event[]): TauRuntime {
  const { cwd, workspaceRoots, store, sessionId, catalog, modelId, llm, schedulerOptions, enhancer, enhancerApplied, action, mcpRuntime } = prep

  let schedulerBridge: ((event: Event) => void) | null = null

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

  const kernel =
    llm ??
    createLlmKernel({
      catalog,
      getApiKey: (model) => process.env[`TAU_${model.provider.provider.toUpperCase()}_API_KEY`] ?? null,
    })

  const scheduler = createScheduler(
    { llm: kernel, session, action },
    {
      ...(modelId !== "default" ? { model: modelId } : {}),
      ...(enhancer !== null ? { compact: { summarize: (i) => enhancer.summarize(i.sessionId, i.messages, i.reason) } } : {}),
      ...schedulerOptions,
    },
  )
  schedulerBridge = (event) => scheduler.notify(event)

  // 补发 MCP 注册事件
  for (const ev of mcpEvents) schedulerBridge(ev)

  const face = createCommandFace({ orchestrate: scheduler, session, action })

  return { store, session, llm: kernel, action, scheduler, face, enhancer, mcpDispose: async () => mcpRuntime.dispose?.() }
}

/** 异步增强:拉取远程目录并合并进 kernel;失败静默回退静态目录。 */
export async function applyRemoteCatalog(
  llm: LlmKernel,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; onResult?: (ok: boolean, count: number) => void } = {},
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000)
  try {
    const remote = await fetchRemoteCatalog({ ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}), signal: controller.signal })
    llm.refresh(remote)
    opts.onResult?.(true, remote.length)
    return true
  } catch {
    opts.onResult?.(false, 0)
    return false
  } finally {
    clearTimeout(timer)
  }
}
