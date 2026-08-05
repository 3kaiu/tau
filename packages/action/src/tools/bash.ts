// @tau/action — tools/bash.ts:bash 工具。持久 shell(缺省会话级持久,保留 cwd/env,
// new_shell: true 显式重置);长输出截断 + 分页续读;detach 后台任务(返回 taskId,result 轮询/system 取消)。

import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import { ResultPageStore } from "./common.ts"
import type { BackgroundTaskStore } from "../runtime.ts"

const MAX_OUTPUT_BYTES = 64 * 1024
const PWD_MARKER = "\nTAU_PWD:"
const ENV_MARKER = "\nTAU_ENV:"

export function makeBashTool(pageStore: ResultPageStore, tasks: BackgroundTaskStore, opts: { outputMaxBytes?: number } = {}) {
  const maxBytes = opts.outputMaxBytes ?? MAX_OUTPUT_BYTES
  const shells = new Map<string, { cwd: string; env: Record<string, string> }>()

  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const command = String(req.args.command ?? "")
    const newShell = req.args.new_shell === true
    const detach = req.args.detach === true
    const shellId = typeof req.args.shellId === "string" && req.args.shellId !== "" ? req.args.shellId : "session"
    const base = req.cwd ?? process.cwd()
    const state = shells.get(shellId)
    const cwd0 = newShell || state === undefined ? base : state.cwd
    const env = newShell || state === undefined ? process.env : { ...process.env, ...state.env }

    if (command.trim() === "") throw new ToolErrorException(toolError("rejected", "bash:空命令"))

    const wrapped = `${command}; printf '${PWD_MARKER}%s\n${ENV_MARKER}%s' "$PWD" "$(env | base64 | tr -d '\\n')"`
    const spawn = () =>
      Bun.spawn({
        cmd: ["/bin/bash", "-lc", wrapped],
        cwd: cwd0,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...env, TAU_SHELL_ID: shellId },
      })

    // detach:立即返回 taskId,结果后台落 pageStore,可经 result 轮询 / system cancel_task 取消
    if (detach) {
      const taskId = req.toolCallId
      const proc = spawn()
      void (async () => {
        const [stdoutBuf] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(),
          new Response(proc.stderr).arrayBuffer(),
        ])
        const text = Buffer.from(stdoutBuf).toString("utf8")
        pageStore.put(taskId, stripMarkers(text).stdout, maxBytes)
        await proc.exited
      })()
      tasks.put(taskId, proc)
      return toolResult({ stdout: `taskId:${taskId}(后台执行中,用 result { call_id:"${taskId}", page:0 } 轮询)` })
    }

    const proc = spawn()
    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ])
    const fullStdout = Buffer.from(stdoutBuf).toString("utf8")
    const stderr = Buffer.from(stderrBuf).toString("utf8")
    const exitCode = await proc.exited

    const { stdout: cleaned, nextCwd, nextEnv } = stripMarkers(fullStdout)
    const stdout = cleaned.replace(/\n$/, "")
    shells.set(shellId, { cwd: nextCwd !== "" ? nextCwd : cwd0, env: nextEnv })

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

/** 剥离 TAU_PWD/TAU_ENV 尾部标记;env 变化随下一条命令继承(持久 shell 保留 env)。 */
function stripMarkers(full: string): { stdout: string; nextCwd: string; nextEnv: Record<string, string> } {
  const pwdAt = full.lastIndexOf(PWD_MARKER)
  const envAt = full.lastIndexOf(ENV_MARKER)
  const stdout = pwdAt >= 0 ? full.slice(0, pwdAt) : full
  const nextCwd = pwdAt >= 0 ? full.slice(pwdAt + PWD_MARKER.length, envAt >= 0 ? envAt : undefined).trim() : ""
  let nextEnv: Record<string, string> = {}
  if (envAt >= 0) {
    const raw = full.slice(envAt + ENV_MARKER.length).trim()
    try {
      const text = Buffer.from(raw, "base64").toString("utf8")
      for (const line of text.split("\n")) {
        const eq = line.indexOf("=")
        if (eq > 0) nextEnv[line.slice(0, eq)] = line.slice(eq + 1)
      }
    } catch {
      /* env dump 解析失败则忽略(下条命令继续用父 env) */
    }
  }
  return { stdout, nextCwd, nextEnv }
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
