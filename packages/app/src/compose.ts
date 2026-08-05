// @tau/app - compose.ts:唯一拼装点。依赖图只在此声明,其他包禁止互相 new。
// 注入点:测试/doctor 可传 override(如 fake llm),生产走默认。
// MCP 注册必须先于 session 创建(投影 tools 是构造期快照)→ 生产用 composeAsync,同步 compose 不注册 MCP。

import { createMemoryStore, createStore, type Store } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import { createLlmKernel, defaultCatalog, fetchRemoteCatalog, type LlmKernel } from "@tau/llm"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler, runSubagent, type Scheduler, type SchedulerOptions } from "@tau/orchestrate"
import { createCommandFace, type CommandFace } from "@tau/surface"
import { createEnhancer, type Enhancer } from "@tau/enhance"
import { SystemCallSchema, parseMergedConfig, type Config, type Event, type Model } from "@tau/contract"
import { loadConfigFromStore } from "./config.ts"
import { gitInfo } from "./git.ts"
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
  /** 配置装载源(config:* kv);loadConfigFromStore 合并进 session(预算/tier 规则)。 */
  configStore?: Store | null
  /** 程序化配置覆写(优先于 configStore 装载的基线)。 */
  config?: Partial<Config>
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
  /** 合并后的配置(state.kv 装载基线 + options.config 程序化覆写)。 */
  config: Config | null
  mcpRuntime: { dispose?: () => Promise<void> }
  /** 事件桥锚点(唯一拼装点接线:session/action 事件在 finishRuntime 就绪前暂存,就绪后分发)。 */
  bridges: {
    scheduler: ((event: Event) => void) | null
    face: ((event: Event) => void) | null
  }
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
  // 配置提前解析:model 键参与模型选择(config.model 为缺省,options.model 显式优先)
  const config = resolveConfig(options)
  const modelId = options.model ?? config?.model ?? catalog[0]?.id ?? "default"
  const bridges: Prep["bridges"] = { scheduler: null, face: null }

  // enhancer 装载 skills + AGENTS.md -> 投影块
  const enhancer = options.skipEnhancer === true ? null : createEnhancer({ cwd, store })
  const enhancerApplied = enhancer?.apply(sessionId) ?? { systemBlocks: [], skillNames: [], skillsDir: "" }

  const action = createActionPlane(store, {
    workspaceRoots,
    autoApprove: options.autoApprove ?? false,
    // 事件桥:tool/permission 事件统一汇入(face 分发 + scheduler 转发),不再断链
    onEvent: (event) => {
      bridges.scheduler?.(event)
      bridges.face?.(event)
    },
  })

  // capabilityDefaults 消费方(config 三态表 merge 进 gate;与 syscall defaultRule 同表后置优先)
  if (config?.capabilityDefaults !== undefined && config.capabilityDefaults.length > 0) {
    for (const rule of config.capabilityDefaults) action.gate.addRule(rule)
  }

  // 注册 syscall + 规则进 gate(声明 defaultRule 真实生效;否则危险工具无规则直接 deny)
  const registerSyscall = (syscall: import("@tau/contract").SystemCall, exec: Parameters<ActionPlane["registerExecutor"]>[1]) => {
    action.registry.register(syscall)
    if (syscall.defaultRule !== undefined && syscall.defaultRule !== null) {
      action.gate.addRule({ ...syscall.defaultRule, scope: "tool" })
    }
    action.registerExecutor(syscall.name, exec)
  }

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
    registerSyscall(skillLoadSchema, async (req) => {
      const name = String(req.args.name ?? "")
      const text = enhancer.getSkill(name)
      if (text === null) {
        return { exitCode: 1, stdout: `skill "${name}" 不存在;可用: ${enhancer.catalog().names.join(", ")}`, stderr: null, truncated: false, totalPages: 1, page: 0 }
      }
      return { exitCode: 0, stdout: text, stderr: null, truncated: false, totalPages: 1, page: 0 }
    })
  }

  // memory:* syscall 面 -- 记忆读写(经 action.execute 审批/审计;会话级,长程可跨会话续用)
  if (enhancer !== null) {
    const memTool = (name: string, description: string, properties: Record<string, unknown>, required: string[], exec: (req: { args: Record<string, unknown> }) => string) => {
      const syscall = SystemCallSchema.parse({
        name,
        description,
        parameters: { type: "object", properties, required },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: name, rule: "allow", scope: "tool" },
      })
      registerSyscall(syscall, async (req) => {
        const stdout = exec(req)
        return { exitCode: 0, stdout, stderr: null, truncated: false, totalPages: 1, page: 0 }
      })
    }
    memTool(
      "memory_write",
      "写入一条会话记忆(key → 内容)。overwrite: true 才允许覆盖已有 key,缺省拒绝(防误覆盖)。",
      {
        key: { type: "string", description: "记忆键(见投影记忆索引)" },
        content: { type: "string", description: "记忆内容" },
        overwrite: { type: "boolean", description: "是否允许覆盖已有 key" },
      },
      ["key", "content"],
      (req) => {
        const ok = enhancer.remember(sessionId, String(req.args.key), String(req.args.content), { overwrite: req.args.overwrite === true })
        return ok ? "已写入" : `拒绝覆盖:key "${req.args.key}" 已存在(需 overwrite: true)`
      },
    )
    memTool(
      "memory_read",
      "读取一条会话记忆全文。key 来自投影记忆索引或 memory_list。",
      { key: { type: "string" } },
      ["key"],
      (req) => {
        const entry = enhancer.recall(sessionId, String(req.args.key))
        if (entry === null) return `无记忆 "${req.args.key}"`
        return entry.content
      },
    )
    memTool(
      "memory_search",
      "检索会话记忆(key/内容命中 + 时间衰减,缺省前 5 条)。",
      { query: { type: "string" }, limit: { type: "integer", description: "返回条数上限(缺省 5)" } },
      ["query"],
      (req) => {
        const hits = enhancer.searchMemories(sessionId, String(req.args.query), req.args.limit === undefined ? {} : { limit: Number(req.args.limit) })
        if (hits.length === 0) return "0 命中"
        return hits.map((e) => `[${e.key}] ${e.updatedAt}:\n${e.content}`).join("\n\n")
      },
    )
    memTool(
      "memory_list",
      "枚举会话记忆(更新序倒序,最新在前)。",
      {},
      [],
      () => {
        const entries = enhancer.listMemory(sessionId)
        if (entries.length === 0) return "无记忆"
        return entries.map((e) => `- [${e.key}] ${e.updatedAt}`).join("\n")
      },
    )
    memTool(
      "memory_forget",
      "删除一条会话记忆。",
      { key: { type: "string" } },
      ["key"],
      (req) => {
        enhancer.forget(sessionId, String(req.args.key))
        return "已删除"
      },
    )
  }

  // artifact_list syscall -- 枚举会话已外置的 artifact(executor 在 finishRuntime 闭包就绪后覆盖)
  {
    const artifactListSchema = SystemCallSchema.parse({
      name: "artifact_list",
      description: "枚举本会话已外置的 artifact 引用(ref/size/hash/mime;正文经 artifact_read 按 ref 取回)。",
      parameters: { type: "object", properties: {}, required: [] },
      tier: "T0",
      dangerous: false,
      defaultRule: { pattern: "artifact_list", rule: "allow", scope: "tool" },
    })
    registerSyscall(artifactListSchema, async () => ({
      exitCode: 1,
      stdout: "artifact_list 执行器未就绪(compose 装配未完成)",
      stderr: null,
      truncated: false,
      totalPages: 1,
      page: 0,
    }))
  }

  // subagent_run syscall -- 多代理委派(元数据先注册进投影;executor 在 finishRuntime 闭包就绪后覆盖)
  {
    const subagentSchema = SystemCallSchema.parse({
      name: "subagent_run",
      description: "委派子代理执行任务(独立子会话 + 独立工作树;缺省只读能力面,修改类操作须显式声明 tools 白名单;结果截断回传,完整产出留在子会话)。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "子代理任务" },
          context: { type: "string", description: "父会话上下文(作为数据注入,非指令)" },
          tools: { type: "array", items: { type: "string" }, description: "工具白名单(缺省只读集)" },
          background: { type: "boolean", description: "true 时立即返回 running,结果落注册表" },
          maxTurns: { type: "integer", description: "子会话 turn 预算(缺省 8)" },
        },
        required: ["task"],
      },
      tier: "T0",
      dangerous: true,
      defaultRule: { pattern: "subagent_run", rule: "ask", scope: "tool" },
    })
    registerSyscall(subagentSchema, async () => ({
      exitCode: 1,
      stdout: "subagent_run 执行器未就绪(compose 装配未完成)",
      stderr: null,
      truncated: false,
      totalPages: 1,
      page: 0,
    }))
  }

  return {
    cwd,
    workspaceRoots,
    store,
    sessionId,
    catalog,
    modelId,
    llm: options.llm,
    schedulerOptions: options.schedulerOptions,
    enhancer,
    enhancerApplied,
    action,
    config,
    mcpRuntime: {},
    bridges,
  }
}

function resolveConfig(options: ComposeOptions): Config | null {
  if (options.configStore === undefined && options.config === undefined) return null
  const entries: Record<string, unknown> = {}
  if (options.configStore !== undefined && options.configStore !== null) {
    Object.assign(entries, loadConfigFromStore(options.configStore))
  }
  if (options.config !== undefined) {
    for (const [key, value] of Object.entries(options.config)) if (value !== undefined) entries[key] = value
  }
  return parseMergedConfig(entries)
}

function finishRuntime(prep: Prep, mcpEvents: readonly Event[]): TauRuntime {
  const { cwd, workspaceRoots, store, sessionId, catalog, modelId, llm, schedulerOptions, enhancer, enhancerApplied, action, config, mcpRuntime, bridges } = prep
  const git = gitInfo(cwd)

  const sessionModel = catalog.find((m) => m.id === modelId)
  const session = createSession({
    store,
    sessionId,
    cwd,
    workspaceRoots,
    tools: action.registry.all(),
    extraSystemBlocks: enhancerApplied.systemBlocks,
    skills: { dir: enhancerApplied.skillsDir, names: enhancerApplied.skillNames },
    // 自省块缺料补齐(P0-2):模型必须看到真实权限规则与 git 现场,而非空壳
    permissions: action.gate.rules,
    ...(git !== null ? { projectRoot: git.projectRoot, git: git.git } : {}),
    ...(sessionModel !== undefined ? { model: sessionModel } : {}),
    ...(config?.maxContextTokens !== undefined ? { maxContextTokens: config.maxContextTokens } : {}),
    // turnBudget 消费方:session 投影 resources.budget(与 scheduler 预算同源)
    ...(config?.turnBudget !== undefined ? { budget: config.turnBudget } : {}),
    ...(config?.toolTierRules !== undefined ? { toolTierRules: config.toolTierRules } : {}),
    ...(config?.compaction !== undefined ? { compactionKeepRecent: config.compaction.keepRecent } : {}),
    // thinking 消费方:策略缺省 32KB,与 session 截断缺省一致(显式覆盖经 config.thinking.maxBytes)
    ...(config?.thinking !== undefined ? { maxThinkingBytes: config.thinking.maxBytes } : {}),
    onEvent: (event) => {
      bridges.scheduler?.(event)
      bridges.face?.(event)
    },
  })

  const kernel =
    llm ??
    createLlmKernel({
      catalog,
      // provider id 含 "-"(如 openai-compatible)时规范化环境变量名:TAU_OPENAI_COMPATIBLE_API_KEY
      getApiKey: (model) => process.env[`TAU_${model.provider.provider.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`] ?? null,
    })

  const scheduler = createScheduler(
    { llm: kernel, session, action },
    {
      ...(modelId !== "default" ? { model: modelId } : {}),
      // turnBudget 消费方:config 键映射到调度器预算(显式 schedulerOptions 仍优先)
      ...(config?.turnBudget !== undefined
        ? {
            maxTurns: config.turnBudget.maxTurns,
            maxTurnMs: config.turnBudget.maxTurnMs,
            maxToolCallsPerTurn: config.turnBudget.maxToolCallsPerTurn,
          }
        : {}),
      ...(enhancer !== null
        ? {
            compact: {
              summarize: (i) => enhancer.summarize(i.sessionId, i.messages, i.reason),
              ...(config?.compaction !== undefined ? { thresholdRatio: config.compaction.triggerRatio } : {}),
            },
          }
        : {}),
      ...schedulerOptions,
    },
  )
  bridges.scheduler = (event) => scheduler.notify(event)

  // 调度器自产事件(recent 种类:retry/interrupted/model_switched + 流式增量 text_delta + 用量 usage)→ 事件日志持久化。
  // 只持久化 session 不自产的种类,防双写(compression/recovery 由 session 自持)。
  scheduler.subscribe((event) => {
    if (event.kind === "retry" || event.kind === "interrupted" || event.kind === "model_switched" || event.kind === "text_delta" || event.kind === "usage") {
      store.events.append(sessionId, event)
    }
  })

  // retrieve 接历史检索(P0-3):production 经 session.retrieve(活跃历史 + 归档全文,FTS5),
  // 模型可对压缩/截断内容回源——ResultPageStore 仅保留给 result:page 续读
  action.registerExecutor("retrieve", async (req) => {
    const query = String(req.args.query ?? "")
    if (query === "") return { exitCode: 1, stdout: "retrieve:缺 query 参数", stderr: null, truncated: false, totalPages: 1, page: 0 }
    const { results, total } = session.retrieve({ query, limit: 20 })
    if (total === 0) return { exitCode: 0, stdout: `无命中:${query}`, stderr: null, truncated: false, totalPages: 1, page: 0 }
    const lines = results.map((r) => `[${r.source} ${r.id}] ${r.excerpt.replace(/\n/g, " ")}`)
    return { exitCode: 0, stdout: `${results.length}/${total} 命中\n${lines.join("\n")}`, stderr: null, truncated: false, totalPages: 1, page: 0 }
  })

  // artifact_list executor 就绪(枚举会话 artifact 引用,正文仍走 artifact_read)
  action.registerExecutor("artifact_list", async () => {
    const metas = session.listArtifacts()
    if (metas.length === 0) return { exitCode: 0, stdout: "0 个 artifact", stderr: null, truncated: false, totalPages: 1, page: 0 }
    const lines = metas.map((m) => `- ${m.ref} size=${m.size} hash=${m.hash.slice(0, 8)}${m.mime !== undefined ? ` mime=${m.mime}` : ""}`)
    return { exitCode: 0, stdout: `${metas.length} 个 artifact\n${lines.join("\n")}`, stderr: null, truncated: false, totalPages: 1, page: 0 }
  })

  // subagent_run executor 就绪(闭包 kernel/session;多代理委派经 orchestrate 唯一出口)
  action.registerExecutor("subagent_run", async (req) => {
    const task = String(req.args.task ?? "")
    if (task === "") return { exitCode: 1, stdout: "subagent_run 缺 task", stderr: null, truncated: false, totalPages: 1, page: 0 }
    const result = await runSubagent(
      {
        llm: kernel,
        store,
        action,
        session,
        // 子代理事件 → 仅父 face 转发(实时观察),不落入 scheduler 持久化(避免污染父会话日志)
        onEvent: (event) => {
          bridges.face?.(event)
        },
      },
      {
        parentSessionId: sessionId,
        task,
        ...(req.args.context !== undefined ? { context: String(req.args.context) } : {}),
        ...(req.args.tools !== undefined ? { tools: (req.args.tools as unknown[]).map(String) } : {}),
        ...(req.args.background === true ? { background: true } : {}),
        ...(req.args.maxTurns !== undefined ? { maxTurns: Number(req.args.maxTurns) } : {}),
      },
    )
    const summary = [
      `[子代理 ${result.sessionId || "(拒绝)"}] ${result.status}`,
      `深度: ${result.depth} | turns: ${result.turns} | 工具调用: ${result.toolCalls}`,
      "",
      result.text,
    ].join("\n")
    return { exitCode: result.status === "completed" ? 0 : 1, stdout: summary, stderr: null, truncated: false, totalPages: 1, page: 0 }
  })

  // 补发 MCP 注册事件(scheduler 订阅者 + face 全量可见)
  for (const ev of mcpEvents) {
    bridges.scheduler?.(ev)
    bridges.face?.(ev)
  }

  const face = createCommandFace({
    orchestrate: scheduler,
    session,
    action,
    // set_model 解析:模型目录查询(静态 + 远程合并后)
    resolveModel: (id) => {
      const found = kernel.models().find((m) => m.id === id)
      return found ?? null
    },
  })
  bridges.face = (event) => face.notify(event)

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
