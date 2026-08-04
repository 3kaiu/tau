// @tau/app — mcp.ts:Model Context Protocol 客户端接入(surface 层 syscall 化)。
// 宪法对齐:任何 MCP 工具都经 action.execute() 审批/审计/截断后才到达模型;
// 模型只见 mcp_<server>_<tool> syscall,不直接接触 MCP 工具集。

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"
import type { ActionPlane } from "@tau/action"
import type { CapabilityRule, SystemCall } from "@tau/contract"
import { SystemCallSchema } from "@tau/contract"

export type McpServerConfig = {
  /** 前缀(工具名前缀,须经转义;空/重复 → 注册失败)。 */
  id: string
  transport:
    | { type: "stdio"; command: string; args?: string[] }
    | { type: "http"; url: string; headers?: Record<string, string> }
  /** 该 server 全部工具的默认审批规则(缺省 ask)。 */
  defaultRule?: CapabilityRule
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/

function escapeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export async function registerMcpServers(
  plane: ActionPlane,
  servers: readonly McpServerConfig[],
): Promise<{ registered: number; failed: string[]; dispose: () => Promise<void> }> {
  const failed: string[] = []
  let registered = 0
  const clients: MCPClient[] = []
  for (const server of servers) {
    const prefix = escapeName(server.id)
    if (prefix.length === 0 || !TOOL_NAME_RE.test(prefix) || prefix.startsWith("mcp_")) {
      failed.push(`mcp:${server.id} (非法前缀,须以字母/数字开头,不含 mcp_ 保留前缀)`)
      continue
    }
    let client: MCPClient
    try {
      const transport =
        server.transport.type === "stdio"
          ? new Experimental_StdioMCPTransport({ command: server.transport.command, args: server.transport.args ?? [] })
          : ({ type: "http", url: server.transport.url, ...(server.transport.headers !== undefined ? { headers: server.transport.headers } : {}) } as const)
      client = await createMCPClient({ transport })
      clients.push(client)
    } catch (err) {
      failed.push(`mcp:${server.id} (连接失败: ${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    // server 级默认审批规则装载进能力门(pattern 用通配,如 mcp_demo_* 匹配 mcp_demo_echo)
    if (server.defaultRule !== undefined) {
      plane.gate.addRule({ ...server.defaultRule, scope: "tool" })
    }
    const tools = await client.tools().catch((err: unknown) => {
      failed.push(`mcp:${server.id} (工具列表失败: ${err instanceof Error ? err.message : String(err)})`)
      return null
    })
    if (tools === null) continue
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const syscallName = `mcp_${prefix}_${escapeName(toolName)}`
      if (!TOOL_NAME_RE.test(syscallName)) {
        failed.push(`mcp:${server.id} 工具 ${toolName} 名转义后非法`)
        continue
      }
      // inputSchema 是 zod FlexibleSchema({ _type, jsonSchema, validate });契约只要 jsonSchema 部分
      const flexible = toolDef.inputSchema as { jsonSchema?: Record<string, unknown> }
      const inputSchema =
        flexible?.jsonSchema ?? { type: "object", properties: {}, required: [] }
      const syscall = SystemCallSchema.parse({
        name: syscallName,
        description: toolDef.description ?? `MCP 工具 ${toolName}(server: ${server.id})`,
        parameters: inputSchema,
        tier: "T1",
        maxOutputTokens: undefined,
        dangerous: false,
        ...(server.defaultRule !== undefined ? { defaultRule: server.defaultRule } : {}),
      })
      plane.registry.register(syscall)
      plane.registerExecutor(syscallName, async (req) => {
        const result = await client.callTool({ name: toolName, arguments: req.args })
        const content = (result.content ?? []) as Array<{ type?: string; text?: string; resource?: { text?: string } }>
        const text = content
          .map((part) => {
            if (part.type === "text") return part.text ?? ""
            if (part.type === "resource") return part.resource?.text ?? JSON.stringify(part.resource)
            return JSON.stringify(part)
          })
          .join("\n")
        return {
          exitCode: result.isError === true ? 1 : 0,
          stdout: text,
          stderr: null,
          truncated: false,
          totalPages: 1,
          page: 0,
        }
      })
      registered++
    }
  }
  return { registered, failed, dispose: async () => { await Promise.all(clients.map((c) => c.close().catch(() => undefined))) } }
}

export type { SystemCall }
