// @tau/app — cli.ts:参数解析 + 子命令路由。
// M2:print 模式(`tau -p` / 管道 stdin)与 doctor;JSONL/TUI/HTTP/ACP 随里程碑。

import { compose } from "./compose.ts"
import { createPrintRenderer } from "@tau/surface"

const HELP = `tau — agent 运行时

用法:
  tau -p <prompt>        print 模式(脚本友好)
  tau -p                read prompt from stdin (echo "..." | tau -p)
  tau doctor            环境自检(模型/凭据)
  tau --help            显示本帮助

选项:
  --model <id>          指定模型(缺省目录首个)
  --auto-approve        自动批准 ask 类工具(危险,默认拒绝)
  --workspace <dir>     工作区根(缺省当前目录)
  --json                以 JSONL 输出事件(wire 格式,M2 部分实现)
`

export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return 0
  }

  const [sub] = argv
  if (sub === "doctor") {
    return doctor()
  }
  if (sub !== "-p" && sub !== "--print") {
    console.error(`tau:未知参数 "${sub}"\n${HELP}`)
    return 2
  }

  const rest = argv.slice(1)
  const modelIdx = rest.indexOf("--model")
  const model = modelIdx >= 0 && rest[modelIdx + 1] !== undefined ? rest[modelIdx + 1] : undefined
  const autoApprove = rest.includes("--auto-approve")
  const wsIdx = rest.indexOf("--workspace")
  const wsValue = rest[wsIdx + 1]
  const workspace = wsIdx >= 0 && wsValue !== undefined ? wsValue : process.cwd()

  let prompt = ""
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) continue
    if (arg.startsWith("-") && arg !== "-p") continue
    if (arg === "-p") continue
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
    cwd: workspace,
    workspaceRoots: [workspace],
    ...(model !== undefined ? { model } : {}),
    autoApprove,
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
    console.log(`  ${has ? "✓" : "✗"} ${model.id} (${model.provider.provider})${has ? "" : " — 缺凭据"}`)
  }
  if (ok === 0) {
    console.log(`提示:export OPENAI_API_KEY=... 或 TAU_<PROVIDER>_API_KEY=...`)
  }
  return ok > 0 ? 0 : 1
}
