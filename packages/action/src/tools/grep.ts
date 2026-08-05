// @tau/action — tools/grep.ts:grep 工具。按行正则/子串匹配工作区文件;
// 二进制与超大文件跳过,结果带上下文行号,上限内返回。

import { readFileSync } from "node:fs"
import { relative } from "node:path"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { isBinary } from "../runtime.ts"
import type { WorkspaceIndex } from "../workspace.ts"

const MAX_HITS = 200
const MAX_FILE_BYTES = 1024 * 1024

export function makeGrepTool(index: WorkspaceIndex) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const pattern = String(req.args.pattern ?? "")
    const pathIn = typeof req.args.path === "string" && req.args.path !== "" ? req.args.path : "."
    const cwd = req.cwd ?? process.cwd()
    if (pattern === "") throw new ToolErrorException(toolError("rejected", "grep:缺 pattern 参数"))
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (err) {
      throw new ToolErrorException(toolError("rejected", `grep:非法正则(${err instanceof Error ? err.message : String(err)})`))
    }
    const root = index.resolveWithin(cwd, pathIn)

    let hits = 0
    const lines: string[] = []
    const files = index.walkAll(root)
    for (const f of files) {
      if (hits >= MAX_HITS) break
      if (f.isDir) continue
      if (f.size === 0 || f.size > MAX_FILE_BYTES) continue
      let text: string
      try {
        text = readFileSync(f.path).toString("utf8")
      } catch {
        continue
      }
      if (isBinary(Buffer.from(text))) continue
      const rel = relative(root, f.path)
      const fileLines = text.split("\n")
      for (let i = 0; i < fileLines.length && hits < MAX_HITS; i++) {
        if (regex.test(fileLines[i]!)) {
          hits++
          lines.push(`${rel}:${i + 1}: ${fileLines[i]!.slice(0, 200)}`)
        }
      }
    }
    const truncated = hits >= MAX_HITS
    return toolResult({
      stdout: `${hits} 命中\n${lines.join("\n")}${truncated ? `\n...(超过 ${MAX_HITS} 条截断,请缩小 pattern)` : ""}`,
      stderr: null,
    })
  }
}
