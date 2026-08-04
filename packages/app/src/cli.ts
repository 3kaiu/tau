// @tau/app - cli.ts:参数解析 + 子命令路由。
// print 模式(`tau -p`)、交互 TUI 模式(`tau`)、serve、acp、doctor、eval。

import { compose } from "./compose.ts"
import { createPrintRenderer } from "@tau/surface"
import { CommandSchema, EventSchema } from "@tau/contract"

const HELP = `tau - agent 运行时

用法:
  tau                    交互模式(TUI:发布/观察/打断/批准)
  tau -p <prompt>        print 模式(脚本友好)
  tau -p                read prompt from stdin (echo "..." | tau -p)
  tau serve [--port N]   HTTP/SSE 服务器(缺省 3000)
  tau acp                ACP 服务器(JSON-RPC over stdio,editor 驱动)
  tau eval              运行行为评测(18 个契约级断言,FauxLlm 离线)
  tau doctor            环境自检(模型/凭据/契约 wire/store/capability 门)
  tau log <sessionId>   导出会话事件流(JSONL,可 grep/重放;缺省 main)
  tau replay <sessionId> 重放事件 → 投影 → 渲染转述时间线(缺省 main)
  tau --help            显示本帮助

选项:
  --model <id>          指定模型(缺省目录首个)
  --auto-approve        自动批准 ask 类工具(危险,默认拒绝)
  --workspace <dir>     工作区根(缺省当前目录)
  --store <path>        SQLite 持久化路径(缺省内存,重启丢失)
  --json                以 JSONL 输出事件(wire 格式)
`

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return 0
  }

  const [sub] = argv
  if (sub === "doctor") {
    return doctor(argv.slice(1))
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
  if (sub === "serve") {
    return serveMode(argv.slice(1))
  }
  if (sub === "acp") {
    return acpMode(argv.slice(1))
  }
  if (sub === "-p" || sub === "--print") {
    return printMode(argv.slice(1))
  }
  // 无参数或 --model/--store 等选项 -> TUI 交互模式
  if (sub === undefined || sub.startsWith("--")) {
    return tuiMode(argv)
  }

  console.error(`tau:未知参数 "${sub}"\n${HELP}`)
  return 2
}

/** 解析通用选项(--model / --auto-approve / --workspace / --store)。 */
function parseCommonOpts(args: string[]): {
  model?: string
  autoApprove: boolean
  workspace: string
  storePath?: string
} {
  const modelIdx = args.indexOf("--model")
  const autoApprove = args.includes("--auto-approve")
  const wsIdx = args.indexOf("--workspace")
  const wsValue = wsIdx >= 0 ? args[wsIdx + 1] : undefined
  const workspace = wsIdx >= 0 && wsValue !== undefined ? wsValue : process.cwd()
  const storeIdx = args.indexOf("--store")
  const storePath = storeIdx >= 0 && args[storeIdx + 1] !== undefined ? args[storeIdx + 1] : undefined
  const model = modelIdx >= 0 && args[modelIdx + 1] !== undefined ? args[modelIdx + 1] : undefined
  const result: { autoApprove: boolean; workspace: string; model?: string; storePath?: string } = { autoApprove, workspace }
  if (model !== undefined) result.model = model
  if (storePath !== undefined) result.storePath = storePath
  return result
}

/** 从剩余参数中取首个位置参数作为 sessionId;跳过选项旗标及其值(--store/--workspace/--model 带值,--auto-approve/--json 为布尔)。 */
function parseSessionId(args: string[]): string {
  const valueFlags = new Set(["--model", "--workspace", "--store"])
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (valueFlags.has(a)) {
      i += 2
      continue
    }
    if (a.startsWith("--")) {
      i += 1
      continue
    }
    return a
  }
  return "main"
}

async function printMode(rest: string[]): Promise<number> {
  const opts = parseCommonOpts(rest)

  let prompt = ""
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) continue
    if (arg.startsWith("-")) continue
    prompt = arg
    break
  }
  if (prompt === "") {
    prompt = await readStdin()
  }
  if (prompt === "") {
    console.error('tau:缺 prompt(用法:tau -p "..." 或 echo "..." | tau -p)')
    return 2
  }

  const runtime = compose({
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    autoApprove: opts.autoApprove,
    ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
  })

  const renderer = createPrintRenderer({ showToolCalls: true })
  runtime.scheduler.subscribe((event) => {
    renderer.consume(event)
    const chunk = renderer.flush()
    if (chunk !== "") console.log(chunk)
  })

  const result = await runtime.face.publish({ kind: "prompt", sender: { clientId: "cli", kind: "cli" }, text: prompt })
  if (result.accepted === false) {
    console.error(`tau:${result.detail}`)
    return 1
  }
  const tail = renderer.flush()
  if (tail !== "") console.log(tail)
  return 0
}

async function tuiMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)

  const { createTui } = await import("@tau/tui")

  const runtime = compose({
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    autoApprove: opts.autoApprove,
    ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
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

  const runtime = compose({
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    autoApprove: opts.autoApprove,
    ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
  })

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

  const runtime = compose({
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    autoApprove: opts.autoApprove,
    ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
  })

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
      resolveApiKey(null, m.provider.envKey, m.provider.api === "openai" ? "OPENAI_API_KEY" : `${m.provider.api.toUpperCase()}_API_KEY`) !== null,
  )
  checks.push({ name: "至少一模型有凭据", ok: hasKey })

  // 2. 契约 wire 往返(Command / Event 可序列化还原)
  try {
    const cmd = CommandSchema.parse({ kind: "prompt", sender: { clientId: "doctor", kind: "cli" }, text: "ping" })
    const evt = EventSchema.parse({ id: "e1", timestamp: "t", redact: [], kind: "input_accepted", command: cmd })
    const roundtrip = EventSchema.parse(JSON.parse(JSON.stringify(evt)))
    checks.push({ name: "契约 wire 往返(Command/Event)", ok: roundtrip.kind === "input_accepted" })
  } catch (e) {
    checks.push({ name: "契约 wire 往返(Command/Event)", ok: false, detail: String(e) })
  }

  // 3. store 可达 + replay 可用(尊重 --store,否则 memory)
  try {
    const runtime = compose({
      cwd: opts.workspace,
      workspaceRoots: [opts.workspace],
      skipEnhancer: true,
      ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
    })
    const replayed = runtime.store.events.replay("doctor-probe")
    checks.push({ name: "store 可达 + replay 可用", ok: Array.isArray(replayed), detail: opts.storePath ?? "memory" })
    runtime.store.close?.()
  } catch (e) {
    checks.push({ name: "store 可达 + replay 可用", ok: false, detail: String(e) })
  }

  // 4. capability 门生效(默认规则存在且可决策)
  try {
    const runtime = compose({
      cwd: opts.workspace,
      workspaceRoots: [opts.workspace],
      skipEnhancer: true,
      ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
    })
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

/** `tau log <sessionId>`:从 store 重放会话事件,逐行输出 JSONL(wire 格式,机器消费)。 */
async function logMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)
  const sessionId = parseSessionId(args)
  const runtime = compose({
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    skipEnhancer: true,
    ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
  })
  const events = runtime.store.events.replay(sessionId)
  for (const e of events) {
    process.stdout.write(`${JSON.stringify(e)}\n`)
  }
  console.error(`tau log:${events.length} 条事件 (session=${sessionId})`)
  runtime.store.close?.()
  return 0
}

/** `tau replay <sessionId>`:重放事件 → 投影 → 渲染人类可读转述时间线(复用 surface 渲染器)。 */
async function replayMode(args: string[]): Promise<number> {
  const opts = parseCommonOpts(args)
  const sessionId = parseSessionId(args)
  const runtime = compose({
    cwd: opts.workspace,
    workspaceRoots: [opts.workspace],
    skipEnhancer: true,
    ...(opts.storePath !== undefined ? { storePath: opts.storePath } : {}),
  })
  const events = runtime.store.events.replay(sessionId)
  const renderer = createPrintRenderer({ showToolCalls: true })
  for (const e of events) {
    renderer.consume(e)
    const chunk = renderer.flush()
    if (chunk !== "") console.log(chunk)
  }
  console.error(`tau replay:${events.length} 条事件 (session=${sessionId})`)
  runtime.store.close?.()
  return 0
}

async function evalSuite(): Promise<number> {
  const { runSuite, allAsserts, formatSummary } = await import("@tau/eval")
  const result = await runSuite(allAsserts)
  console.log(formatSummary(result))
  return result.failed > 0 ? 1 : 0
}
