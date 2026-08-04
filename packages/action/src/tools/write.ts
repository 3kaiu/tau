// @tau/action — tools/write.ts:write 工具。原子写(tmp + rename),越界拒绝,写串行。

import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { PathBoundary } from "./common.ts"

export function makeWriteTool(boundary: PathBoundary) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const pathIn = String(req.args.path ?? "")
    const content = String(req.args.content ?? "")
    const cwd = req.cwd ?? process.cwd()
    if (pathIn === "") throw new ToolErrorException(toolError("rejected", "write:缺 path 参数"))
    const path = boundary.resolve(cwd, pathIn)

    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, content, "utf8")
      renameSync(tmp, path)
    } catch (err) {
      try {
        renameSync(tmp, path)
      } catch {
        /* 临时文件清理失败不影响结果 */
      }
      throw new ToolErrorException(toolError("retryable", `write:${pathIn} 写入失败(${err instanceof Error ? err.message : String(err)})`))
    }
    return toolResult({ stdout: `written ${pathIn}(${content.length} chars)`, stderr: null })
  }
}
