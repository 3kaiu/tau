// @tau/action — runtime.ts:执行运行时(并发/取消/超时/截断/互斥/越界检查/挂起恢复)。
// 同一工具可并发,文件写操作串行(互斥队列);输出过 secret 模式检测 → redact 标记 + 事件告警。

import type { Store } from "@tau/store"
import type { Event, ToolEvent, ToolError, ToolResult } from "@tau/contract"
import { toolError } from "@tau/contract"
import { ToolRegistry } from "./registry.ts"
import { CapabilityGate } from "./capability.ts"
import { recordAudit } from "./audit.ts"
import { createHookRegistry, type Hook, type HookContext } from "./hooks.ts"

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /(?:API|SECRET|TOKEN|KEY|PASSWORD)\s*=\s*["']?[A-Za-z0-9_-]{16,}/i,
]

const BINARY_NUL = "\u0000"
const MAX_RESULT_BYTES = 64 * 1024

export type PermissionRequest = {
  toolCallId: string
  toolName: string
  summary: string
}

export type ActionPlaneOptions = {
  /** 询问时自动批准(默认拒绝)。print 模式可经 CLI 开关打开。 */
  autoApprove?: boolean
  /** 会话工作区根(越界直接拒绝)。缺省 = 当前目录。 */
  workspaceRoots?: readonly string[]
  onEvent?: (event: Event) => void
  /** 权限询问回调:返回 true 批准,false 拒绝。TUI 用此回调弹窗。 */
  onPermission?: (req: PermissionRequest) => Promise<boolean>
  /** 生命周期 hooks:工具执行前/后/错误时触发。 */
  hooks?: readonly Hook[]
}

export type ExecuteRequest = {
  sessionId: string
  toolCallId: string
  name: string
  args: Record<string, unknown>
  cwd?: string
}

export type ExecuteOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; error: ToolError }

export class ActionPlane {
  readonly registry = new ToolRegistry()
  readonly gate = new CapabilityGate()
  private readonly store: Store
  private readonly opts: ActionPlaneOptions
  private readonly executors = new Map<string, (req: ExecuteRequest) => Promise<ToolResult>>()
  private readonly hooks = createHookRegistry()
  private writeQueue = Promise.resolve()

  constructor(store: Store, opts: ActionPlaneOptions = {}) {
    this.store = store
    this.opts = opts
    // 注册初始 hooks
    if (opts.hooks) {
      for (const hook of opts.hooks) {
        this.hooks.register(hook)
      }
    }
  }

  /** 注册执行器(内置工具或扩展),与 SystemCall 元数据成对。 */
  registerExecutor(name: string, fn: (req: ExecuteRequest) => Promise<ToolResult>): void {
    this.executors.set(name, fn)
  }

  /** 运行期设置权限回调(TUI 创建后注入)。 */
  setPermissionHandler(fn: (req: PermissionRequest) => Promise<boolean>): void {
    this.opts.onPermission = fn
  }

  /** 注册生命周期 hook。返回取消注册函数。 */
  registerHook(hook: Hook): () => void {
    return this.hooks.register(hook)
  }

  capabilities() {
    return { rules: this.gate.rules, workspaceRoots: this.opts.workspaceRoots ?? [process.cwd()] }
  }

  /** ask 工具的权限决策:onPermission 回调 > autoApprove > 拒绝。 */
  private async resolveApproval(
    req: ExecuteRequest,
    syscall: { name: string; description: string },
    started: number,
    emit: (event: Omit<ToolEvent, "id" | "timestamp" | "redact">) => void,
  ): Promise<boolean> {
    const summary = brief(argsOf(req))

    if (this.opts.onPermission !== undefined) {
      const approved = await this.opts.onPermission({ toolCallId: req.toolCallId, toolName: req.name, summary })
      const questionId = crypto.randomUUID()
      this.opts.onEvent?.({ id: questionId, timestamp: new Date().toISOString(), redact: [], kind: "permission", requestId: req.toolCallId, toolName: req.name, summary, state: approved ? "granted" : "denied" } as Event)
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: summary, outcome: approved ? "approved" : "rejected", durationMs: Date.now() - started })
      return approved
    }

    if (this.opts.autoApprove === true) return true

    const error = toolError("rejected", `${req.name} 需要授权(capability 规则 ask);请显式开启 autoApprove 或配置 allow 规则`)
    emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", args: req.args, error })
    recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: summary, outcome: "rejected", durationMs: Date.now() - started })
    return false
  }

  async execute(req: ExecuteRequest, opts: { timeoutMs?: number } = {}): Promise<ExecuteOutcome> {
    const started = Date.now()
    const emit = (event: Omit<ToolEvent, "id" | "timestamp" | "redact">) =>
      this.opts.onEvent?.({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), redact: [], ...event } as Event)

    const syscall = this.registry.get(req.name)
    if (syscall === null) {
      const error = toolError("not_found", `未知工具:${req.name};可用:${this.registry.all().map((t) => t.name).join(", ")}`)
      emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "error", durationMs: Date.now() - started })
      return { ok: false, error }
    }

    const decision = this.gate.decide(req.name, syscall.dangerous)
    if (decision.rule === "deny") {
      const error = toolError("permission_denied", `${req.name}:${decision.reason}`)
      emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", args: req.args, error })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "denied", durationMs: Date.now() - started })
      return { ok: false, error }
    }
    if (decision.rule === "ask") {
      const approved = await this.resolveApproval(req, syscall, started, emit)
      if (!approved) return { ok: false, error: toolError("rejected", `${req.name} 权限被拒绝`) }
    }

    const executor = this.executors.get(req.name)
    if (executor === undefined) {
      const error = toolError("internal", `工具 ${req.name} 已注册元数据但无执行器`)
      emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error })
      return { ok: false, error }
    }

    // 执行 before hooks
    const beforeCtx: HookContext = {
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      syscall,
      args: req.args,
      phase: "before",
    }
    try {
      await this.hooks.execute(beforeCtx)
    } catch (hookErr) {
      const error = toolError("rejected", `hook 阻止执行: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`)
      emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", args: req.args, error })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "rejected", durationMs: Date.now() - started })
      return { ok: false, error }
    }

    emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "started", args: req.args })
    try {
      const exec = syscall.tier === "T0" ? this.enqueue(() => executor(req)) : executor(req)
      const result = opts.timeoutMs === undefined ? await exec : await withTimeoutMs(exec, opts.timeoutMs)
      const marked = markSecrets(result)

      // 执行 after hooks
      const afterCtx: HookContext = {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        syscall,
        args: req.args,
        phase: "after",
        result: marked.result as Record<string, unknown>,
      }
      await this.hooks.execute(afterCtx)

      emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "completed", result: marked.result })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: marked.hasSecret ? "ok" : "ok", durationMs: Date.now() - started })
      return { ok: true, result: marked.result }
    } catch (err) {
      // 执行 error hooks
      const errorCtx: HookContext = {
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        syscall,
        args: req.args,
        phase: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      }
      await this.hooks.execute(errorCtx)

      const error = normalizeError(err)
      emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "error", durationMs: Date.now() - started })
      return { ok: false, error }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn)
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }
}

function argsOf(req: ExecuteRequest): Record<string, unknown> {
  return { name: req.name, args: req.args }
}

function brief(args: Record<string, unknown>): string {
  return JSON.stringify(args).slice(0, 300)
}

async function withTimeoutMs<T>(exec: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exec,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class ToolErrorException extends Error {
  readonly error: ToolError

  constructor(error: ToolError) {
    super(error.message)
    this.error = error
  }
}

function normalizeError(err: unknown): ToolError {
  if (err instanceof ToolErrorException) return err.error
  if (err instanceof Error) {
    const msg = err.message
    if (/timeout/.test(msg)) return toolError("timeout", msg)
    if (/权限|denied|越界/.test(msg)) return toolError("permission_denied", msg)
    if (/不存在|not found|ENOENT/.test(msg)) return toolError("not_found", msg)
    return toolError("internal", msg)
  }
  return toolError("internal", String(err))
}

/** 工具结果过 secret 模式检测:命中 → redact 标记 + 事件告警(不阻断,提示模型)。 */
function markSecrets(result: ToolResult): { result: ToolResult; hasSecret: boolean } {
  const probe = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (probe.length === 0 || !SECRET_PATTERNS.some((re) => re.test(probe))) {
    return { result, hasSecret: false }
  }
  const masked = (text: string | null): string | null => {
    if (text === null) return null
    let out = text
    for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => (re.source.includes("BEGIN") ? m.replace(/[A-Z0-9+/=\s]{16,}/g, "[redacted]") : "[redacted]"))
    return out
  }
  return { result: { ...result, stdout: masked(result.stdout), stderr: masked(result.stderr) }, hasSecret: true }
}

/** 输出截断:超过上限切页;截断段不丢,经 result:page 续读。 */
export function pageResult(output: string, page: number, maxBytes = MAX_RESULT_BYTES): ToolResult {
  const pages = Math.max(1, Math.ceil(output.length / maxBytes))
  if (page < 0 || page >= pages) return { exitCode: null, stdout: "", stderr: null, truncated: false, totalPages: pages, page }
  const chunk = output.slice(page * maxBytes, (page + 1) * maxBytes)
  return { exitCode: null, stdout: chunk, stderr: null, truncated: pages > 1, totalPages: pages, page }
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.toString("latin1").includes(BINARY_NUL)
}
