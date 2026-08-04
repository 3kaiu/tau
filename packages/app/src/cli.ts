// @tau/app - cli.ts:参数解析 + 子命令路由。
// print 模式(`tau -p`)、交互 TUI 模式(`tau`)、serve、acp、doctor、eval。

import { compose } from "./compose.ts"
import { createPrintRenderer } from "@tau/surface"

const HELP = `tau - agent 运行时

用法:
  tau                    交互模式(TUI:发布/观察/打断/批准)
  tau -p <prompt>        print 模式(脚本友好)
  tau -p                read prompt from stdin (echo "..." | tau -p)
  tau serve [--port N]   HTTP/SSE 服务器(缺省 3000)
  tau acp                ACP 服务器(JSON-RPC over stdio,editor 驱动)
  tau eval              运行行为评测(13 个契约级断言,FauxLlm 离线)
  tau doctor            环境自检(模型/凭据)
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
    return doctor()
  }
  if (sub === "eval") {
    return evalSuite()
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

async function doctor(): Promise<number> {
  const { defaultCatalog } = await import("@tau/llm")
  const { resolveApiKey } = await import("@tau/llm")
  const catalog = defaultCatalog()
  console.log(`模型目录:${catalog.length} 个`)
  let ok = 0
  for (const model of catalog) {
    const key = resolveApiKey(null, model.provider.envKey, model.provider.api === "openai" ? "OPENAI_API_KEY" : `${model.provider.api.toUpperCase()}_API_KEY`)
    const has = key !== null
    if (has) ok++
    console.log(`  ${has ? "✓" : "✗"} ${model.id} (${model.provider.provider})${has ? "" : " - 缺凭据"}`)
  }
  if (ok === 0) {
    console.log(`提示:export OPENAI_API_KEY=... 或 TAU_<PROVIDER>_API_KEY=...`)
  }
  return ok > 0 ? 0 : 1
}

async function evalSuite(): Promise<number> {
  const { runSuite, allAsserts, formatSummary } = await import("@tau/eval")
  const result = await runSuite(allAsserts)
  console.log(formatSummary(result))
  return result.failed > 0 ? 1 : 0
}
