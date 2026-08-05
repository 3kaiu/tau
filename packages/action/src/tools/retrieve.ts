// @tau/action — tools/retrieve.ts:retrieve 工具。检索本会话已产生的工具输出
// (pageStore 暂存的截断结果全文),子串过滤;用途:模型回查"之前某命令输出过什么"。

import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { ResultPageStore } from "./common.ts"

const MAX_HITS = 20

export function makeRetrieveTool(pages: ResultPageStore) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const query = String(req.args.query ?? "")
    if (query === "") throw new ToolErrorException(toolError("rejected", "retrieve:缺 query 参数"))
    const needle = query.toLowerCase()

    const hits: string[] = []
    for (const entry of pages.all()) {
      const text = entry.text.toLowerCase()
      if (!text.includes(needle)) continue
      const snippet = entry.text.slice(0, 200).replace(/\n/g, " ")
      hits.push(`call:${entry.callId}(${entry.text.length} chars): ${snippet}...`)
      if (hits.length >= MAX_HITS) break
    }
    return toolResult({
      stdout: hits.length === 0 ? `无命中:${query}(当前暂存 ${pages.size()} 段输出)` : `${hits.length} 命中\n${hits.join("\n")}`,
      stderr: null,
    })
  }
}
