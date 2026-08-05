// @tau/action — tools/ls.ts:ls 工具。目录列表(名称+类型+大小),long 模式带 mtime。

import { readdirSync, statSync } from "node:fs"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { PathBoundary } from "./common.ts"

const MAX_ENTRIES = 500

export function makeLsTool(boundary: PathBoundary) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const pathIn = typeof req.args.path === "string" && req.args.path !== "" ? req.args.path : "."
    const long = req.args.long === true
    const cwd = req.cwd ?? process.cwd()
    const path = boundary.resolve(cwd, pathIn)

    let names: string[]
    try {
      names = readdirSync(path)
    } catch {
      throw new ToolErrorException(toolError("not_found", `ls:${pathIn} 不存在或不可读`))
    }
    names.sort()
    const shown = names.slice(0, MAX_ENTRIES)
    const rows = shown.map((name) => {
      const full = `${path}/${name}`
      let isDir = false
      let size = 0
      let mtime = ""
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        size = st.size
        mtime = st.mtime.toISOString()
      } catch {
        /* 条目失效则仅列名 */
      }
      const marker = isDir ? "d" : "-"
      return long ? `${marker} ${String(size).padStart(8)} ${mtime} ${name}` : `${marker} ${name}`
    })
    const truncated = names.length > MAX_ENTRIES
    return toolResult({
      stdout: `${path}(${names.length} 条目)\n${rows.join("\n")}${truncated ? `\n...(超过 ${MAX_ENTRIES} 条截断)` : ""}`,
      stderr: null,
    })
  }
}
