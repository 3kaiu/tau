// @tau/action — tools/bash.ts:bash 工具。持久 shell(缺省会话级持久,保留 cwd);
// 长输出截断 + 分页续读;错误走 stderr,失败返回 isError 结果。

import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { ResultPageStore } from "./common.ts"

const MAX_OUTPUT_BYTES = 64 * 1024
const PWD_MARKER = "\nTAU_PWD:"

export function makeBashTool(pageStore: ResultPageStore, opts: { outputMaxBytes?: number } = {}) {
  const maxBytes = opts.outputMaxBytes ?? MAX_OUTPUT_BYTES
  const shellCwds = new Map<string, string>()

  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const command = String(req.args.command ?? "")
    const newShell = req.args.new_shell === true
    const shellId = typeof req.args.shellId === "string" && req.args.shellId !== "" ? req.args.shellId : "session"
    const cwd0 = newShell ? (req.cwd ?? process.cwd()) : (shellCwds.get(shellId) ?? req.cwd ?? process.cwd())
    if (command.trim() === "") throw new ToolErrorException(toolError("rejected", "bash:空命令"))

    // 同一进程内取最终 pwd(cd 不跨进程);末行 TAU_PWD 标记剥离后才是真实 stdout
    const wrapped = `${command}; printf '${PWD_MARKER}%s' "$PWD"`
    const proc = Bun.spawn({
      cmd: ["/bin/bash", "-lc", wrapped],
      cwd: cwd0,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TAU_SHELL_ID: shellId },
    })
    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ])
    const fullStdout = Buffer.from(stdoutBuf).toString("utf8")
    const stderr = Buffer.from(stderrBuf).toString("utf8")
    const exitCode = await proc.exited

    const markerAt = fullStdout.lastIndexOf(PWD_MARKER)
    const nextCwd = markerAt >= 0 ? fullStdout.slice(markerAt + PWD_MARKER.length).trim() : ""
    const stdout = markerAt >= 0 ? fullStdout.slice(0, markerAt).replace(/\n$/, "") : fullStdout
    if (nextCwd !== "") shellCwds.set(shellId, nextCwd)

    if (stdout.length > maxBytes) {
      pageStore.put(req.toolCallId, stdout, maxBytes)
    }
    const truncated = stdout.length > maxBytes
    const totalPages = Math.max(1, Math.ceil(stdout.length / maxBytes))

    return toolResult({
      exitCode,
      stdout: truncated ? stdout.slice(0, maxBytes) + `\n...(截断,共 ${totalPages} 页,用 result { call_id:"${req.toolCallId}", page:N } 续读)` : stdout,
      stderr: stderr === "" ? null : stderr.slice(0, 8 * 1024),
      truncated,
      totalPages,
      page: 0,
    })
  }
}

export function makeResultTool(pageStore: ResultPageStore) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const callId = String(req.args.call_id ?? "")
    const page = typeof req.args.page === "number" ? Math.max(0, Math.floor(req.args.page)) : 0
    const entry = pageStore.getPage(callId, page)
    if (entry === null) {
      throw new ToolErrorException(toolError("not_found", `result:${callId} 无截断内容(已过期或不存在)`))
    }
    return toolResult({ stdout: entry.text, truncated: false, totalPages: entry.totalPages, page })
  }
}
