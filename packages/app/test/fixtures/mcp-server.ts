// @tau/app — test fixture:最小 stdio MCP server(JSON-RPC newline 帧,协议手写,零依赖)。
// 支持 initialize / notifications/initialized / tools/list / tools/call(echo)。

const readline = await import("node:readline")
const rl = readline.createInterface({ input: process.stdin, terminal: false })

const TOOLS = [
  {
    name: "echo",
    description: "回显参数 message",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
]

let _id = 0
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n")

rl.on("line", (line) => {
  let req: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {}
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const respond = (result: unknown) => send({ jsonrpc: "2.0", id: req.id, result })
  if (req.method === "initialize") {
    respond({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture-server", version: "0.0.1" } })
  } else if (req.method === "tools/list") {
    respond({ tools: TOOLS })
  } else if (req.method === "tools/call") {
    const message = String(req.params?.arguments?.message ?? "")
    respond({ content: [{ type: "text", text: `echo:${message}` }], isError: false })
  } else {
    respond({})
  }
})
