// @tau/surface - acp.ts:ACP 协议适配(editor 驱动,JSON-RPC over stdio)。
// editor(Zed 等)经 stdin 发 JSON-RPC 请求,tau 经 stdout 返回响应 + 事件通知。

import type { Command, Event } from "@tau/contract"
import type { CommandFace } from "./face.ts"

export type AcpDeps = {
  face: CommandFace
  /** 事件重放(用于初始化时发送历史事件)。 */
  replay?(): readonly Event[]
}

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

type JsonRpcNotification = {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

/** 运行 ACP 服务器:读 stdin / 写 stdout。 */
export async function runAcpServer(deps: AcpDeps): Promise<void> {
  const writer = (msg: JsonRpcResponse | JsonRpcNotification): void => {
    process.stdout.write(JSON.stringify(msg) + "\n")
  }

  // 订阅事件 -> 作为 notification 推送给 editor
  const unsubscribe = deps.face.subscribe((event: Event) => {
    writer({ jsonrpc: "2.0", method: "event", params: event })
  })

  const input = Bun.stdin.stream()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for await (const chunk of input) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === "") continue
        let req: JsonRpcRequest
        try {
          req = JSON.parse(trimmed) as JsonRpcRequest
        } catch {
          writer({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
          continue
        }
        await handleRequest(req, deps, writer)
      }
    }
  } finally {
    unsubscribe()
  }
}

async function handleRequest(
  req: JsonRpcRequest,
  deps: AcpDeps,
  writer: (msg: JsonRpcResponse | JsonRpcNotification) => void,
): Promise<void> {
  const id = req.id ?? null
  const method = req.method
  const params = req.params ?? {}

  switch (method) {
    case "initialize":
      writer({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "0.1.0",
          capabilities: {
            commands: ["prompt", "steer", "abort", "approve"],
            events: true,
          },
          serverInfo: { name: "tau", version: "0.0.1" },
        },
      })
      return

    case "session/snapshot":
      writer({ jsonrpc: "2.0", id, result: deps.face.snapshot() })
      return

    case "session/prompt": {
      const text = String(params.text ?? "")
      if (text === "") {
        writer({ jsonrpc: "2.0", id, error: { code: -32602, message: "缺 text" } })
        return
      }
      const command: Command = {
        kind: "prompt",
        sender: { clientId: "acp", kind: "acp" },
        text,
      }
      const result = await deps.face.publish(command)
      writer({ jsonrpc: "2.0", id, result })
      return
    }

    case "session/steer": {
      const text = String(params.text ?? "")
      const command: Command = {
        kind: "steer",
        sender: { clientId: "acp", kind: "acp" },
        text,
      }
      const result = await deps.face.publish(command)
      writer({ jsonrpc: "2.0", id, result })
      return
    }

    case "session/abort": {
      const command: Command = {
        kind: "abort",
        sender: { clientId: "acp", kind: "acp" },
      }
      const result = await deps.face.publish(command)
      writer({ jsonrpc: "2.0", id, result })
      return
    }

    case "session/approve": {
      const requestId = String(params.requestId ?? params.id ?? "")
      const command: Command = {
        kind: "approve",
        sender: { clientId: "acp", kind: "acp" },
        toolCallId: requestId,
        capability: "ask",
        reason: "acp-approved",
      }
      const result = await deps.face.publish(command)
      writer({ jsonrpc: "2.0", id, result })
      return
    }

    case "shutdown":
      writer({ jsonrpc: "2.0", id, result: { ok: true } })
      return

    default:
      writer({ jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法: ${method}` } })
  }
}
