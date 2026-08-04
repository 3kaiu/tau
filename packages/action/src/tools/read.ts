// @tau/action — tools/read.ts:read 工具。range{from,to}/preview 参数 + 行数报告;
// 二进制/编码检测命中 → 拒绝(不吐乱码);大文件不整读。

import { readFileSync } from "node:fs"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { isBinary } from "../runtime.ts"
import { PathBoundary } from "./common.ts"

export function makeReadTool(boundary: PathBoundary, opts: { binaryToleranceBytes?: number } = {}) {
  const tolerance = opts.binaryToleranceBytes ?? 8192
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const pathIn = String(req.args.path ?? "")
    const cwd = req.cwd ?? process.cwd()
    if (pathIn === "") throw new ToolErrorException(toolError("rejected", "read:缺 path 参数"))
    const path = boundary.resolve(cwd, pathIn)

    let raw: Buffer
    try {
      raw = readFileSync(path)
    } catch {
      throw new ToolErrorException(toolError("not_found", `read:${pathIn} 不存在`))
    }
    if (raw.length > tolerance && isBinary(raw)) {
      throw new ToolErrorException(toolError("rejected", `read:${pathIn} 疑似二进制/非 UTF-8,拒绝读取(避免乱码烧 token)`))
    }
    const text = raw.toString("utf8")
    if (text.includes("\u0000")) {
      throw new ToolErrorException(toolError("rejected", `read:${pathIn} 含 NUL 字节,疑似二进制,拒绝读取`))
    }

    const lines = text.split("\n")
    const totalLines = lines.length
    const from = num(req.args.from, 1)
    const to = num(req.args.to, totalLines)
    const preview = num(req.args.preview, 0)
    if (preview > 0) {
      const head = lines.slice(0, preview).join("\n")
      return toolResult({
        stdout: `总行数 ${totalLines}${lines[totalLines - 1]?.trim() === "" ? "(+1 空尾行)" : ""}\n--- 前 ${preview} 行 ---\n${head}${totalLines > preview ? `\n... 其余 ${totalLines - preview} 行省略(用 range 续读)` : ""}`,
        truncated: totalLines > preview,
      })
    }
    const slice = lines.slice(Math.max(0, from - 1), to)
    const numbered = slice.map((line, i) => `${String(from + i).padStart(5)} | ${line}`).join("\n")
    const rangeNote = `--- ${pathIn} 行 ${from}-${Math.min(to, totalLines)}(共 ${totalLines}) ---`
    return toolResult({ stdout: numbered === "" ? `${rangeNote}\n(空区间)` : `${rangeNote}\n${numbered}`, truncated: false })
  }
}

function num(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}
