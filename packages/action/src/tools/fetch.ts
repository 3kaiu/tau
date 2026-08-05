// @tau/action — tools/fetch.ts:fetch 工具。网络唯一出口(经 capability 门);
// HTML→文本净化 + 大小上限 + 注入防护(文本数据非指令);拒绝 file:// 与本地协议(工作区边界)。

import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"

const MAX_BYTES = 1024 * 1024
const MAX_TEXT = 32 * 1024

export function makeFetchTool() {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const url = String(req.args.url ?? "")
    if (url === "") throw new ToolErrorException(toolError("rejected", "fetch:缺 url 参数"))
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ToolErrorException(toolError("rejected", `fetch:非法 URL ${url}`))
    }
    if (parsed.protocol === "file:" || parsed.protocol === "ftp:") {
      throw new ToolErrorException(toolError("permission_denied", `fetch:拒绝 ${parsed.protocol} 协议(工作区边界,本地文件请用 read)`))
    }

    const fetchedAt = new Date().toISOString()
    let raw: ArrayBuffer
    try {
      const res = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(30_000) })
      if (!res.ok) {
        return toolResult({ stdout: `fetch:${url} HTTP ${res.status}`, stderr: null, exitCode: res.status })
      }
      raw = await res.arrayBuffer()
    } catch (err) {
      throw new ToolErrorException(toolError("retryable", `fetch:${url} 网络失败(${err instanceof Error ? err.message : String(err)})`))
    }
    if (raw.byteLength > MAX_BYTES) {
      throw new ToolErrorException(toolError("rejected", `fetch:${url} 超过 ${MAX_BYTES} 字节上限,拒绝`))
    }
    const html = Buffer.from(raw).toString("utf8")
    const text = stripHtml(html)
    const truncated = text.length > MAX_TEXT
    const body = truncated ? text.slice(0, MAX_TEXT) + `\n...(截断,共 ${text.length} chars)` : text
    return toolResult({
      stdout: `url:${url}\nfetchedAt:${fetchedAt}\ntruncated:${truncated}\n\n${body}`,
      stderr: null,
    })
  }
}

/** 极简 HTML→文本:剥 script/style 与标签,实体解码,压缩空白。数据非指令,无执行路径。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
}
