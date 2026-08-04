// @tau/action — index.ts:createActionPlane。注册内置工具与 SystemCall 元数据,
// 挂 capability 门(缺省规则:read/result/tool:catalog allow,write/bash ask)。

import type { Store } from "@tau/store"
import { SystemCallSchema } from "@tau/contract"
import { ActionPlane, type ActionPlaneOptions } from "./runtime.ts"
import { ResultPageStore } from "./tools/common.ts"
import { makeReadTool } from "./tools/read.ts"
import { makeWriteTool } from "./tools/write.ts"
import { makeBashTool, makeResultTool } from "./tools/bash.ts"
import { PathBoundary } from "./tools/common.ts"

export type { ActionPlane, ActionPlaneOptions, ExecuteRequest, ExecuteOutcome } from "./runtime.ts"
export { ToolRegistry } from "./registry.ts"
export { CapabilityGate, DEFAULT_RULES } from "./capability.ts"
export { queryAudit, recordAudit } from "./audit.ts"
export { PathBoundary, ResultPageStore } from "./tools/common.ts"

export function createActionPlane(store: Store, opts: ActionPlaneOptions = {}): ActionPlane {
  const plane = new ActionPlane(store, opts)
  const boundary = new PathBoundary(opts.workspaceRoots ?? [process.cwd()])
  const pages = new ResultPageStore()

  const builtins: { syscall: Record<string, unknown>; executor: (req: Parameters<ActionPlane["execute"]>[0]) => Promise<unknown> }[] = [
    {
      syscall: {
        name: "read",
        description: "读取文件。可选 range{from,to}(1 起)与 preview(前 N 行 + 总行数)。大文件请用 preview 或 range,勿整读。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对会话 cwd 或绝对路径;越出 workspaceRoots 会被拒绝" },
            from: { type: "integer", description: "起始行(1 起,含)" },
            to: { type: "integer", description: "结束行(含)" },
            preview: { type: "integer", description: "只读前 N 行" },
          },
          required: ["path"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "read", rule: "allow", scope: "tool" },
      },
      executor: makeReadTool(boundary),
    },
    {
      syscall: {
        name: "write",
        description: "原子写入文件(整文件覆盖)。目录自动创建。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "write", rule: "ask", scope: "tool" },
      },
      executor: makeWriteTool(boundary),
    },
    {
      syscall: {
        name: "bash",
        description: "执行 shell 命令。缺省会话级持久 shell(保留 cwd)。长输出自动截断分页,用 result 续读。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            new_shell: { type: "boolean", description: "true 时重置为会话起始 cwd" },
            shellId: { type: "string", description: "持久 shell 标识,缺省 = 会话级" },
          },
          required: ["command"],
        },
        tier: "T1",
        dangerous: true,
        defaultRule: { pattern: "bash", rule: "ask", scope: "tool" },
      },
      executor: makeBashTool(pages),
    },
    {
      syscall: {
        name: "result",
        description: "续读截断的工具结果。call_id 来自截断提示,page 从 0 起。",
        parameters: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            page: { type: "integer", description: "页号(0 起)" },
          },
          required: ["call_id", "page"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "result", rule: "allow", scope: "tool" },
      },
      executor: makeResultTool(pages),
    },
  ]

  for (const { syscall, executor } of builtins) {
    const parsed = SystemCallSchema.parse(syscall)
    plane.registry.register(parsed)
    plane.registerExecutor(parsed.name, executor as never)
  }
  return plane
}
