// @tau/action — tools/catalog.ts:tool:catalog 工具。返回完整内置目录(含冷工具与注册规则),
// 冷工具 = 未注册执行器或未允许规则的工具,模型据此了解"能用什么、要什么授权"。

import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import type { ToolRegistry } from "../registry.ts"
import { catalogText } from "./system.ts"

export function makeCatalogTool(registry: ToolRegistry) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const detail = req.args.detail === true
    const tools = registry.all()
    if (!detail) {
      return toolResult({ stdout: catalogText(tools), stderr: null })
    }
    const lines = tools.map((t) =>
      `${t.name}: tier=${t.tier} dangerous=${t.dangerous} rule=${t.defaultRule?.rule ?? "?"}\n  ${t.description}\n  params: ${JSON.stringify(t.parameters)}`,
    )
    return toolResult({ stdout: lines.join("\n"), stderr: null })
  }
}

/** 冷工具执行路径:已注册元数据但未注册执行器 → rejected(提示注册)。 */
export function coldToolError(name: string): never {
  throw new ToolErrorException(toolError("rejected", `${name}:冷工具未激活(无执行器),请经配置注册后重试`))
}
