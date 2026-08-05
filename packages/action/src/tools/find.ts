// @tau/action — tools/find.ts:find 工具。按名称子串/glob 匹配工作区文件,上限内返回。

import { relative } from "node:path"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { PathBoundary, walk } from "./common.ts"

const MAX_RESULTS = 200

export function makeFindTool(boundary: PathBoundary) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const name = String(req.args.name ?? "")
    const pathIn = typeof req.args.path === "string" && req.args.path !== "" ? req.args.path : "."
    const cwd = req.cwd ?? process.cwd()
    if (name === "") throw new ToolErrorException(toolError("rejected", "find:缺 name 参数"))
    const root = boundary.resolve(cwd, pathIn)
    const needle = name.toLowerCase()

    const hits: string[] = []
    for (const f of walk(root, { maxDepth: 10 })) {
      if (hits.length >= MAX_RESULTS) break
      const base = f.path.split("/").pop() ?? ""
      if (base.toLowerCase().includes(needle)) {
        hits.push(relative(root, f.path))
      }
    }
    const truncated = hits.length >= MAX_RESULTS
    return toolResult({
      stdout: `${hits.length} 命中\n${hits.join("\n")}${truncated ? `\n...(超过 ${MAX_RESULTS} 条截断)` : ""}`,
      stderr: null,
    })
  }
}
