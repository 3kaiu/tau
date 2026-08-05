// @tau/app - cli.ts:参数解析 + 子命令路由。
// print 模式(`tau -p`)、交互 TUI 模式(`tau`)、serve、acp、doctor、eval。

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { applyRemoteCatalog, composeAsync } from "./compose.ts"
import { createPrintRenderer } from "@tau/surface"
import { createMemoryStore, createStore, type Store } from "@tau/store"
import {
  dueEntries,
  loadSchedules,
  markRan,
  nextAfter,
  parseCron,
  removeSchedule,
  upsertSchedule,
  type ScheduleEntry,
} from "@tau/orchestrate"
import { CommandSchema, ConfigSchema, EventSchema, coerceConfigValue, formatConfigError, goal as makeGoal, isConfigKey, type Message, type SessionSnapshot } from "@tau/contract"
import { version } from "./index.ts"

const HELP = `tau ${version} - agent 运行时

用法:
  tau                    交互模式(TUI:发布/观察/打断/批准)
  tau -p <prompt>        print 模式(脚本友好;无 prompt 则读 stdin)
  tau -j <prompt>        JSONL 模式(= -p --json,逐事件 wire 格式,机器消费)
  tau serve [--port N]   HTTP/SSE 服务器(缺省 3000)
  tau acp                ACP 服务器(JSON-RPC over stdio,editor 驱动)
  tau eval              运行行为评测(22 个契约级断言,FauxLlm 离线)
  tau doctor            环境自检(模型/凭据/契约 wire/store/capability 门)

观测(本地优先,产物不外发):
  tau log <sessionId>   导出会话事件流(JSONL,可 grep/重放;缺省 main)
  tau replay <sessionId> 重放事件 → 投影 → 渲染转述时间线(缺省 main)
  tau export <sessionId> [--format jsonl|markdown] [--out <path>]  导出会话

治理:
  tau sessions list                会话注册表(需 --store 才有持久记录)
  tau sessions show <id>           单会话快照 + 事件计数
  tau sessions resume <id>         归档/关闭的会话置回 active
  tau sessions archive <id>        归档(只标记,不删历史)
  tau sessions delete <id>         等价 archive(tau 不物理删会话)
  tau config list|get <k>|set <k> <v>|unset <k>   配置(落 store.kv,拒明文 secrets)
  tau schedule list                定时目标调度表
  tau schedule add <cron> <目标>   新增定时目标(五段 cron 或 @daily 等别名)
  tau schedule rm <id>             删除调度
  tau schedule run [--dry-run]     触发所有到点调度(交给系统 cron 驱动)

选项:
  --model <id>          指定模型(缺省目录首个)
  --session <id>        指定会话(缺省 main)
  --auto-approve        自动批准 ask 类工具(危险,默认拒绝)
  --workspace <dir>     工作区根(缺省当前目录)
  --store <path>        SQLite 持久化路径(缺省内存,重启丢失)
  --json                以 JSONL 输出(wire 格式;print/sessions/config/schedule 通用)
  --version             显示版本
`

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return 0
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(`tau ${version}`)
    return 0
  }

  const [sub] = argv
  if (sub === "doctor") {
    return doctor(argv.slice(1))
  }
  if (sub === "sessions") {
    return sessionsMode(argv.slice(1))
  }
  if (sub === "config") {
    return configMode(argv.slice(1))
  }
  if (sub === "schedule") {
    return scheduleMode(argv.slice(1))
  }
  if (sub === "eval") {
    return evalSuite()
  }
  if (sub === "log") {
    return logMode(argv.slice(1))
  }
  if (sub === "replay") {
    return replayMode(argv.slice(1))
  }
  if (sub === "export") {
    return exportMode(argv.slice(1))
  }
  if (sub === "serve") {
    return serveMode(argv.slice(1))
  }
  if (sub === "acp") {
    return acpMode(argv.slice(1))
  }
  if (sub === "-p" || sub === "--print") {
    return printMode(argv.slice(1))
  }
  // -j 是 `-p --json` 的简写(机器消费:逐事件 wire JSONL)
  if (sub === "-j" || sub === "--jsonl") {
    return printMode([...argv.slice(1), "--json"])
  }
  // 无参数或 --model/--store 等选项 -> TUI 交互模式
  if (sub === undefined || sub.startsWith("--")) {
    return tuiMode(argv)
  }

  console.error(`tau:未知参数 "${sub}"\n${HELP}`)
  return 2
}

/** 带值旗标集合:位置参数解析必须跳过它们的取值,否则会把 `--store <path>` 的路径当成 sessionId。 */
const VALUE_FLAGS = new Set(["--model", "--workspace", "--store", "--session", "--format", "--out", "--port"])

type CommonOpts = {
  model?: string
  sessionId?: string
  autoApprove: boolean
  workspace: string
  storePath?: string
  json: boolean
}

/** 解析通用选项(--model / --session / --auto-approve / --workspace / --store / --json)。 */
function parseCommonOpts(args: string[]): CommonOpts {
  const wsIdx = args.indexOf("--workspace")
  const wsValue = wsIdx >= 0 ? args[wsIdx + 1] : undefined
  const result: CommonOpts = {
    autoApprove: args.includes("--auto-approve"),
    workspace: wsIdx >= 0 && wsValue !== undefined ? wsValue : process.cwd(),
    json: args.includes("--json"),
  }
  const model = getOptValue(args, "--model")
  const storePath = getOptValue(args, "--store")
  const sessionId = getOptValue(args, "--session")
  if (model !== undefined) result.model = model
  if (storePath !== undefined) result.storePath = storePath
  if (sessionId !== undefined) result.sessionId = sessionId
  return result
}

/** 位置参数列表(去掉旗标及其取值)。 */
function positionals(args: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (VALUE_FLAGS.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith("-")) {
      i += 1
      continue
    }
    out.push(a)
    i += 1
  }
  return out
}

/** 会话解析优先级:--session > 首个位置参数 > main。 */
function parseSessionId(args: string[]): string {
  return getOptValue(args, "--session") ?? positionals(args)[0] ?? "main"
}

/** 取选项旗标后的取值(如 --out <path>);缺失或紧随为旗标则返回 undefined。 */
function getOptValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const v = args[i + 1]
  return v !== undefined && !v.startsWith("-") ? v : undefined
}

/** 直接打开 store(治理/配置只读路径,不构造完整 runtime,避免副作用事件)。 */
function openStore(storePath?: string): Store {
  if (storePath === undefined) return createMemoryStore()
  mkdirSync(dirname(storePath), { recursive: true })
  return createStore("sqlite", storePath)
}

/** compose 的通用选项转发(含 --session)。 */
function parseMcpServers(env: NodeJS.ProcessEnv): import("./mcp.ts").McpServerConfig[] | undefined {
  const raw = env.TAU_MCP_SERVERS
  if (raw === undefined || raw.trim() === "") return undefined
  try {
    const parsed = JSON.parse(raw) as import("./mcp.ts").McpServerConfig[]
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    console.error("tau:TAU_MCP_SERVERS 不是合法 JSON,忽略 MCP 配置")
    return undefined
  }
}

function composeOpts(opts: CommonOpts, extra: { skipEnhancer?: boolean; store?: Store } = {}) {
  const mcpServers = parseMcpServers(process.env)
  return {
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    autoApprove: opts.autoApprove,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.storePath !== undefined && extra.store === undefined ? { storePath: opts.storePath } : {}),
    ...(extra.store !== undefined ? { store: extra.store } : {}),
    ...(extra.skipEnhancer === true ? { skipEnhancer: true } : {}),
    ...(mcpServers !== undefined && mcpServers.length > 0 ? { mcpServers } : {}),
  }
}

async function printMode(rest: string[]): Promise<number> {
  const opts = parseCommonOpts(rest)

  let prompt = positionals(rest)[0] ?? ""
  if (prompt === "") {
    prompt = await readStdin()
  }
  if (prompt === "") {
    console.error('tau:缺 prompt(用法:tau -p "..." 或 echo "..." | tau -p)')
    return 2
  }

  const runtime = await composeAsync(composeOpts(opts))

  // --json:逐事件 wire JSONL(机器消费,与 tau log 同格式);否则人类可读转述
  const renderer = opts.json ? null : createPrintRenderer({ showToolCalls: true })
  runtime.scheduler.subscribe((event) => {
    if (renderer === null) {
      process.stdout.write(`${JSON.stringify(event)}\n`)
      return
    }
    renderer.consume(event)
    const chunk = renderer.flush()
    if (chunk !== "") console.log(chunk)
  })

  const result = await runtime.face.publish({ kind: "prompt", sender: { clientId: "cli", kind: "cli" }, text: prompt })
  if (result.accepted === false) {
    console.error(`tau:${result.detail}`)
    return 1
  }
  const tail = renderer?.flush() ?? ""
  if (tail !== "") console.log(tail)
  await runtime.mcpDispose?.()
  return 0
}

async function tuiMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)

  const { createTui } = await import("@tau/tui")

  const runtime = await composeAsync(composeOpts(opts))

  // 远程目录增强(失败静默回退静态目录)
  await applyRemoteCatalog(runtime.llm, {
    onResult: (ok, count) => {
      if (ok) console.error(`tau:已合并远程模型目录(+${count - runtime.llm.models().length} 新模型)`)
    },
  })

  const sender = { clientId: "tui", kind: "tui" as const }
  const tui = createTui({
    face: runtime.face,
    sender,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    cwd: opts.workspace,
  })

  // 接入权限回调:TUI 弹窗 -> 用户决策 -> action 继续
  runtime.action.setPermissionHandler(async (req) => {
    return tui.askPermission(req)
  })

  await tui.run()
  return 0
}

async function serveMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)
  const portIdx = args.indexOf("--port")
  const port = portIdx >= 0 && args[portIdx + 1] !== undefined ? Number(args[portIdx + 1]) : 3000

  const runtime = await composeAsync(composeOpts(opts))

  const { serveHttp } = await import("@tau/surface")
  const server = serveHttp(
    { face: runtime.face, replay: () => runtime.store.events.replay(runtime.session.sessionId) },
    port,
  )

  console.log(`tau serve:HTTP/SSE 服务器启动于 http://localhost:${port}`)
  console.log(`  POST /command    发布命令`)
  console.log(`  GET  /events     订阅事件(SSE)`)
  console.log(`  GET  /snapshot   拉取会话快照`)
  console.log(`  Ctrl+C 停止`)

  // 等待信号
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.stop()
      resolve()
    })
    process.on("SIGTERM", () => {
      server.stop()
      resolve()
    })
  })

  return 0
}

async function acpMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)

  const runtime = await composeAsync(composeOpts(opts))

  const { runAcpServer } = await import("@tau/surface")
  console.error(`tau acp:ACP 服务器启动(JSON-RPC over stdio)`)
  await runAcpServer({
    face: runtime.face,
    replay: () => runtime.store.events.replay(runtime.session.sessionId),
  })

  return 0
}

async function readStdin(): Promise<string> {
  const text = await new Response(Bun.stdin).text()
  return text.trim()
}

async function doctor(args: string[] = []): Promise<number> {
  const opts = parseCommonOpts(args)
  const { defaultCatalog, resolveApiKey } = await import("@tau/llm")
  const catalog = defaultCatalog()
  const checks: { name: string; ok: boolean; detail?: string }[] = []

  // 1. 模型目录 + 凭据
  checks.push({ name: "模型目录非空", ok: catalog.length > 0, detail: `${catalog.length} 个` })
  const hasKey = catalog.some(
    (m) =>
      m.provider.auth === "none" ||
      resolveApiKey(null, m.provider.envKey, m.provider.api === "openai" ? "OPENAI_API_KEY" : `${m.provider.api.toUpperCase()}_API_KEY`) !== null,
  )
  checks.push({ name: "至少一模型可用(含免 key)", ok: hasKey })

  // 2. 契约 wire 往返(Command / Event 可序列化还原)
  try {
    const cmd = CommandSchema.parse({ kind: "prompt", sender: { clientId: "doctor", kind: "cli" }, text: "ping" })
    const evt = EventSchema.parse({ id: "e1", timestamp: "t", redact: [], kind: "input_accepted", command: cmd })
    const roundtrip = EventSchema.parse(JSON.parse(JSON.stringify(evt)))
    checks.push({ name: "契约 wire 往返(Command/Event)", ok: roundtrip.kind === "input_accepted" })
  } catch (e) {
    checks.push({ name: "契约 wire 往返(Command/Event)", ok: false, detail: String(e) })
  }

  // 3. store 可达 + 迁移到位 + replay 可用(尊重 --store,否则 memory)
  try {
    const store = openStore(opts.storePath)
    store.migrate()
    const replayed = store.events.replay("doctor-probe")
    const kvOk = store.kv.list("doctor-probe:").length === 0
    checks.push({
      name: "store 可达 + 迁移到位 + replay 可用",
      ok: Array.isArray(replayed) && kvOk,
      detail: opts.storePath ?? "memory",
    })
    store.close?.()
  } catch (e) {
    checks.push({ name: "store 可达 + 迁移到位 + replay 可用", ok: false, detail: String(e) })
  }

  // 4. capability 门生效(默认规则存在且可决策)
  try {
    const runtime = await composeAsync(composeOpts(opts, { skipEnhancer: true }))
    const ruleCount = runtime.action.gate.rules.length
    const decision = runtime.action.gate.decide("bash", true)
    const ok = ruleCount > 0 && decision.rule !== undefined
    checks.push({ name: "capability 门生效", ok, detail: `${ruleCount} 条规则` })
    runtime.store.close?.()
  } catch (e) {
    checks.push({ name: "capability 门生效", ok: false, detail: String(e) })
  }

  let allOk = true
  for (const c of checks) {
    if (!c.ok) allOk = false
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`)
  }
  if (!hasKey) console.log(`提示:export OPENAI_API_KEY=... 或 TAU_<PROVIDER>_API_KEY=...`)
  console.log(allOk ? "doctor: 全部通过" : "doctor: 存在失败项")
  return allOk ? 0 : 1
}

/** `tau log <sessionId>`:从 store 重放会话事件,逐行输出 JSONL(wire 格式,机器消费)。
 * 只开 store 不建 session:观测命令严格只读,绝不因"看一眼"往被观测的日志里写 recovery 事件。 */
function logMode(args: string[]): number {
  const opts = parseCommonOpts(args)
  const sessionId = parseSessionId(args)
  const store = openStore(opts.storePath)
  const events = store.events.replay(sessionId)
  for (const e of events) {
    process.stdout.write(`${JSON.stringify(e)}\n`)
  }
  console.error(`tau log:${events.length} 条事件 (session=${sessionId})`)
  store.close?.()
  return 0
}

/** `tau replay <sessionId>`:重放事件 → 渲染人类可读转述时间线(复用 surface 渲染器)。只读。 */
function replayMode(args: string[]): number {
  const opts = parseCommonOpts(args)
  const sessionId = parseSessionId(args)
  const store = openStore(opts.storePath)
  const events = store.events.replay(sessionId)
  const renderer = createPrintRenderer({ showToolCalls: true })
  for (const e of events) {
    renderer.consume(e)
    const chunk = renderer.flush()
    if (chunk !== "") console.log(chunk)
  }
  console.error(`tau replay:${events.length} 条事件 (session=${sessionId})`)
  store.close?.()
  return 0
}

/** `tau export <sessionId>`:导出会话为 JSONL(事件流)或 Markdown(转述流),本地落盘不外发。只读。 */
async function exportMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)
  const sessionId = parseSessionId(args)
  const format = getOptValue(args, "--format") ?? "jsonl"
  const out = getOptValue(args, "--out")
  if (format !== "jsonl" && format !== "markdown") {
    console.error(`tau export:未知 --format "${format}"(支持 jsonl|markdown)`)
    return 2
  }
  const store = openStore(opts.storePath)

  let body: string
  if (format === "markdown") {
    // 与 project().history 同源(投影 history 即 store.messages.list),免建 session 保持只读
    body = store.messages.list(sessionId).messages.map(renderMessageMarkdown).join("\n\n")
  } else {
    body = store.events.replay(sessionId).map((e) => JSON.stringify(e)).join("\n")
  }

  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true })
    await Bun.write(out, `${body}\n`)
    console.error(`tau export:${format} → ${out} (session=${sessionId})`)
  } else {
    process.stdout.write(`${body}\n`)
    console.error(`tau export:${format} (session=${sessionId})`)
  }
  store.close?.()
  return 0
}

/** 单条 Message → Markdown(转述流):文本原样,thinking 引述,artifact 引用,工具调用/结果列出。 */
function renderMessageMarkdown(msg: Message): string {
  const parts: string[] = [`### ${msg.role}`]
  for (const b of msg.content) {
    switch (b.type) {
      case "text":
        parts.push(b.text)
        break
      case "thinking":
        parts.push(`> _thinking:_ ${b.text}`)
        break
      case "artifact":
        parts.push(`[artifact${b.mime ? ` ${b.mime}` : ""}${b.size !== undefined ? ` ${b.size}B` : ""}${b.ref ? ` ref=${b.ref}` : ""}]`)
        break
      case "image":
        parts.push("[image]")
        break
    }
  }
  for (const call of msg.toolCalls) {
    parts.push(`- tool: \`${call.name}\` ${JSON.stringify(call.arguments)}`)
  }
  for (const ref of msg.toolResults) {
    if (ref.error) parts.push(`- error: [${ref.error.code}] ${ref.error.message}`)
    else if (ref.result) parts.push(`- result: ${ref.result.stdout ?? ""}`)
  }
  return parts.join("\n")
}

// ---------- 治理:tau sessions ----------

const NO_STORE_HINT = "(内存 store 无持久记录;用 --store <path> 指向 SQLite 文件)"

/** `tau sessions list|show|resume|archive|delete`。delete 走 archive:tau 不物理删会话。 */
async function sessionsMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)
  const [action = "list", target] = positionals(args)

  if (action === "list") {
    const store = openStore(opts.storePath)
    const rows = store.sessions.list()
    if (opts.json) {
      for (const s of rows) process.stdout.write(`${JSON.stringify(s)}\n`)
    } else if (rows.length === 0) {
      console.log(`tau sessions:无记录 ${NO_STORE_HINT}`)
    } else {
      console.log(formatSessionTable(rows))
    }
    store.close?.()
    return 0
  }

  if (action === "show") {
    if (target === undefined) return usage("tau sessions show <id>")
    const store = openStore(opts.storePath)
    const snap = store.sessions.get(target)
    if (snap === null) {
      console.error(`tau sessions:会话 "${target}" 不在注册表 ${NO_STORE_HINT}`)
      store.close?.()
      return 1
    }
    const events = store.events.count(target)
    const messages = store.messages.count(target)
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ...snap, events, messages })}\n`)
    } else {
      console.log(`会话 ${snap.sessionId}`)
      console.log(`  状态      ${snap.status}`)
      console.log(`  epoch     ${snap.epoch}`)
      console.log(`  转述/消息 ${snap.transcriptCount} / ${messages}`)
      console.log(`  事件      ${events}`)
      console.log(`  活动目标  ${snap.activeGoals.length}`)
      console.log(`  挂起权限  ${snap.pendingSyscalls.length}`)
      console.log(`  创建/更新 ${snap.createdAt} / ${snap.updatedAt}`)
    }
    store.close?.()
    return 0
  }

  if (action === "resume" || action === "archive" || action === "delete") {
    if (target === undefined) return usage(`tau sessions ${action} <id>`)
    const store = openStore(opts.storePath)
    if (store.sessions.get(target) === null) {
      console.error(`tau sessions:会话 "${target}" 不在注册表 ${NO_STORE_HINT}`)
      store.close?.()
      return 1
    }
    // 复用同一连接建 runtime:治理操作也要走 session,状态转移才有 lifecycle 事件可重放
    const runtime = await composeAsync(composeOpts({ ...opts, sessionId: target }, { skipEnhancer: true, store }))
    if (action === "resume") {
      runtime.session.resume()
      console.log(`tau sessions:${target} → active`)
    } else {
      runtime.session.archive()
      const note = action === "delete" ? "(delete 即 archive:历史不物理删,仍可 replay/resume)" : ""
      console.log(`tau sessions:${target} → archived ${note}`.trimEnd())
    }
    store.close?.()
    return 0
  }

  return usage(`tau sessions <list|show|resume|archive|delete>(收到 "${action}")`)
}

function formatSessionTable(rows: readonly SessionSnapshot[]): string {
  const head = ["会话", "状态", "epoch", "转述", "目标", "挂起", "最近更新"]
  const body = rows.map((s) => [
    s.sessionId,
    s.status,
    String(s.epoch),
    String(s.transcriptCount),
    String(s.activeGoals.length),
    String(s.pendingSyscalls.length),
    s.updatedAt,
  ])
  const widths = head.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i] ?? ""))))
  const line = (cells: string[]) => cells.map((c, i) => c + " ".repeat(Math.max(0, widths[i]! - width(c)))).join("  ").trimEnd()
  return [line(head), ...body.map(line)].join("\n")
}

/** 显示宽度:CJK 记 2 列,避免中文状态串把表格挤歪。 */
function width(s: string): number {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

// ---------- 分发:tau config ----------

const CONFIG_PREFIX = "config:"
/** 明文 secrets 拒绝落盘:key 命中即拒,指向环境变量。 */
const SECRET_KEY = /(^|[._-])(key|token|secret|password|passwd|credential)s?([._-]|$)/i

function defaultConfigStore(): string {
  return join(homedir(), ".tau", "config.sqlite")
}

/** `tau config list|get|set|unset`:落 store.kv(无旁路写),缺省全局库 ~/.tau/config.sqlite。 */
function configMode(args: string[]): number {
  const opts = parseCommonOpts(args)
  const [action = "list", key, value] = positionals(args)
  const path = opts.storePath ?? defaultConfigStore()
  const store = openStore(path)

  try {
    if (action === "list") {
      const entries = store.kv.list(CONFIG_PREFIX)
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(Object.fromEntries(entries.map((e) => [e.key.slice(CONFIG_PREFIX.length), e.value])))}\n`)
      } else if (entries.length === 0) {
        console.log(`tau config:空(${path})`)
      } else {
        for (const e of entries) console.log(`${e.key.slice(CONFIG_PREFIX.length)} = ${e.value}`)
      }
      return 0
    }

    if (action === "get") {
      if (key === undefined) return usage("tau config get <key>")
      const v = store.kv.get(CONFIG_PREFIX + key)
      if (v === null) {
        console.error(`tau config:未设置 "${key}"`)
        return 1
      }
      console.log(v)
      return 0
    }

    if (action === "set") {
      if (key === undefined || value === undefined) return usage("tau config set <key> <value>")
      if (SECRET_KEY.test(key)) {
        console.error(`tau config:拒绝明文落盘凭据 "${key}"`)
        console.error(`  改用环境变量:export TAU_<PROVIDER>_API_KEY=...(doctor 会检测)`)
        return 2
      }
      // 配置即契约:Config schema 已知键在落盘前强转 + 校验,非法给可操作报错
      if (isConfigKey(key)) {
        const coerced = coerceConfigValue(key, value)
        const picked = ConfigSchema.pick({ [key]: true } as never)
        const check = picked.safeParse({ [key]: coerced })
        if (!check.success) {
          console.error(`tau config:非法配置 "${key}" = ${value}`)
          console.error(formatConfigError(check.error, { [key]: value }))
          return 2
        }
      }
      store.kv.set(CONFIG_PREFIX + key, value)
      console.log(`tau config:${key} = ${value} (${path})`)
      return 0
    }

    if (action === "unset") {
      if (key === undefined) return usage("tau config unset <key>")
      store.kv.delete(CONFIG_PREFIX + key)
      console.log(`tau config:已删除 ${key}`)
      return 0
    }

    return usage(`tau config <list|get|set|unset>(收到 "${action}")`)
  } finally {
    store.close?.()
  }
}

// ---------- 治理:tau schedule(定时目标) ----------

/** `tau schedule list|add|rm|run`。run 为一次性检查,由系统 cron 驱动——tau 不常驻守护进程。 */
async function scheduleMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)
  const [action = "list", a1, a2] = positionals(args)
  const path = opts.storePath ?? defaultConfigStore()
  const store = openStore(path)

  try {
    if (action === "list") {
      const entries = loadSchedules(store)
      if (opts.json) {
        for (const e of entries) process.stdout.write(`${JSON.stringify(e)}\n`)
        return 0
      }
      if (entries.length === 0) {
        console.log(`tau schedule:无调度 (${path})`)
        return 0
      }
      const now = new Date()
      for (const e of entries) {
        const spec = parseCron(e.cron)
        const next = spec === null ? "非法 cron" : (nextAfter(spec, new Date(e.lastRunAt ?? e.createdAt))?.toISOString() ?? "无")
        console.log(`${e.id}  [${e.cron}]  session=${e.sessionId}`)
        console.log(`  目标  ${e.goalText}`)
        console.log(`  上次  ${e.lastRunAt ?? "未运行"}   下次  ${next}${isPast(next, now) ? "  (已到点)" : ""}`)
      }
      return 0
    }

    if (action === "add") {
      if (a1 === undefined || a2 === undefined) return usage('tau schedule add "<cron>" "<目标>"')
      if (parseCron(a1) === null) {
        console.error(`tau schedule:非法 cron "${a1}"(五段 "分 时 日 月 周",或 @hourly/@daily/@weekly/@monthly/@yearly)`)
        return 2
      }
      const entry: ScheduleEntry = {
        id: freshScheduleId(loadSchedules(store)),
        cron: a1,
        sessionId: opts.sessionId ?? "main",
        goalText: a2,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
      }
      upsertSchedule(store, entry)
      console.log(`tau schedule:已添加 ${entry.id} [${entry.cron}] → session=${entry.sessionId}`)
      console.log(`  由系统 cron 驱动:* * * * * tau schedule run --store ${path}`)
      return 0
    }

    if (action === "rm") {
      if (a1 === undefined) return usage("tau schedule rm <id>")
      if (!removeSchedule(store, a1)) {
        console.error(`tau schedule:无此调度 "${a1}"`)
        return 1
      }
      console.log(`tau schedule:已删除 ${a1}`)
      return 0
    }

    if (action === "run") {
      const now = new Date()
      const due = dueEntries(loadSchedules(store), now)
      if (due.length === 0) {
        console.log("tau schedule:无到点调度")
        return 0
      }
      if (args.includes("--dry-run")) {
        for (const e of due) console.log(`到点(dry-run) ${e.id} → session=${e.sessionId}:${e.goalText}`)
        return 0
      }
      let failed = 0
      for (const e of due) {
        // 目标经 session.setGoal 进投影(模型感知),再以 prompt 唤醒——不旁路拼 Context
        const runtime = await composeAsync(composeOpts({ ...opts, sessionId: e.sessionId }, { store }))
        runtime.scheduler.goals.set(makeGoal(e.id, e.goalText))
        const result = await runtime.face.publish({
          kind: "prompt",
          sender: { clientId: "cron", kind: "cli" },
          text: e.goalText,
        })
        markRan(store, e.id, now.toISOString())
        if (result.accepted === false) {
          console.error(`tau schedule:${e.id} 未被接受 — ${result.detail}`)
          failed += 1
        } else {
          console.log(`tau schedule:${e.id} 已触发 (session=${e.sessionId})`)
        }
      }
      return failed > 0 ? 1 : 0
    }

    return usage(`tau schedule <list|add|rm|run>(收到 "${action}")`)
  } finally {
    store.close?.()
  }
}

/** 调度 id:时间戳可读,但同毫秒连加两条会撞 id 并静默覆盖——所以撞了就补序号。 */
function freshScheduleId(existing: readonly ScheduleEntry[]): string {
  const base = `sch-${Date.now().toString(36)}`
  const taken = new Set(existing.map((e) => e.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function isPast(iso: string, now: Date): boolean {
  const t = Date.parse(iso)
  return !Number.isNaN(t) && t <= now.getTime()
}

/** 解析失败统一格式:exit code 2 + 一行原因(CLI 宪法第三条)。 */
function usage(line: string): number {
  console.error(`tau:用法 — ${line}`)
  return 2
}

async function evalSuite(): Promise<number> {
  const { runSuite, allAsserts, formatSummary } = await import("@tau/eval")
  const result = await runSuite(allAsserts)
  console.log(formatSummary(result))
  return result.failed > 0 ? 1 : 0
}
