// @tau/action — tools/ls.ts:ls 工具。目录列表(名称+类型+大小),long 模式带 mtime。
// 忽略规则与 find/工作区索引同源(workspace 模型):被忽略条目不显示(模型看到的树一致),
// 但保留直读 stat 的实时 size/mtime(不牺牲目录现状的信息量)。

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import type { WorkspaceIndex } from "../workspace.ts"

const MAX_ENTRIES = 500

export function makeLsTool(index: WorkspaceIndex) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const pathIn = typeof req.args.path === "string" && req.args.path !== "" ? req.args.path : "."
    const long = req.args.long === true
    const cwd = req.cwd ?? process.cwd()
    const path = index.resolveWithin(cwd, pathIn)

    let names: string[]
    try {
      names = readdirSync(path)
    } catch {
      throw new ToolErrorException(toolError("not_found", `ls:${pathIn} 不存在或不可读`))
    }
    names.sort()
    const visible = names.filter((name) => !index.isIgnored(path, name, join(path, name)))
    const shown = visible.slice(0, MAX_ENTRIES)
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
    const truncated = visible.length > MAX_ENTRIES
    return toolResult({
      stdout: `${path}(${visible.length} 条目)\n${rows.join("\n")}${truncated ? `\n...(超过 ${MAX_ENTRIES} 条截断)` : ""}`,
      stderr: null,
    })
  }
}
