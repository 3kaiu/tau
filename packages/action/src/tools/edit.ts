// @tau/action — tools/edit.ts:edit 工具。基于 read + 原子写:old→new 单点替换;
// old 未命中/多命中 → 拒绝(带诊断),不留半改文件;结果带 fileMeta(模型判断陈旧)。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { isBinary } from "../runtime.ts"
import type { WorkspaceIndex } from "../workspace.ts"
import { fileMetaOf } from "./read.ts"

export function makeEditTool(index: WorkspaceIndex) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const pathIn = String(req.args.path ?? "")
    const oldText = String(req.args.old ?? "")
    const newText = String(req.args.new ?? "")
    const cwd = req.cwd ?? process.cwd()
    if (pathIn === "" || oldText === "") throw new ToolErrorException(toolError("rejected", "edit:缺 path/old 参数"))
    const path = index.resolveWithin(cwd, pathIn)
    if (!existsSync(path)) throw new ToolErrorException(toolError("not_found", `edit:${pathIn} 不存在`))

    const raw = readFileSync(path)
    if (isBinary(raw)) throw new ToolErrorException(toolError("rejected", `edit:${pathIn} 疑似二进制,拒绝编辑`))
    const content = raw.toString("utf8")

    let pos = content.indexOf(oldText)
    if (pos === -1) throw new ToolErrorException(toolError("rejected", `edit:${pathIn} 未命中 old 文本(可能已被改动,请先 read 确认)`))
    const next = content.indexOf(oldText, pos + oldText.length)
    if (next !== -1) {
      const line = (content.slice(0, pos).match(/\n/g)?.length ?? 0) + 1
      throw new ToolErrorException(toolError("rejected", `edit:${pathIn} old 文本多命中(首现第 ${line} 行),请加上下文缩小范围`))
    }

    const updated = content.slice(0, pos) + newText + content.slice(pos + oldText.length)
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, updated, "utf8")
      renameSync(tmp, path)
    } catch (err) {
      throw new ToolErrorException(toolError("retryable", `edit:${pathIn} 写入失败(${err instanceof Error ? err.message : String(err)})`))
    }
    return toolResult({ stdout: `edited ${pathIn}(替换 ${oldText.length} → ${newText.length} chars)`, stderr: null, fileMeta: fileMetaOf(path) })
  }
}
