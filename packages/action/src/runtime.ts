// @tau/action — runtime.ts:执行运行时(并发/取消/超时/截断/互斥/越界检查/挂起恢复)。
// 权限双轨:询问先广播 permission(requested) 事件,再经回调/挂起队列决议,决议后发 granted/denied/timeout;
// ask_user 挂起经 questionId 恢复;detach 后台任务可轮询/取消;危险命令强制询问(不走静默允许)。

import type { Store } from "@tau/store"
import { createEventIdGenerator, isDangerousCommand, maskSecretText, SECRET_PATTERNS, toolError } from "@tau/contract"
import type { Event, ToolError, ToolEvent, ToolResult } from "@tau/contract"
import { ToolRegistry } from "./registry.ts"
import { CapabilityGate } from "./capability.ts"
import { recordAudit } from "./audit.ts"
import { createHookRegistry, type Hook, type HookContext } from "./hooks.ts"

const gen = createEventIdGenerator()

/** 权限决议竞速:回调/挂起二选一,超时或中断 → undefined(调用方按拒绝收尾)。
 * 回调后至 Promise 落定期间可被多个调用方等待;结果只取首达者。 */
function raceApproval(promise: Promise<boolean>, timeoutMs: number, signal?: AbortSignal): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(undefined)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then((value) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(value)
    })
  })
}

const BINARY_NUL = "\u0000"
const MAX_RESULT_BYTES = 64 * 1024
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000

export type PermissionRequest = {
  toolCallId: string
  toolName: string
  summary: string
}

/** 挂起中的 ask_user:UI 凭 questionId 回答,resolve 在回答到达后由注册方执行(会话记账清理)。 */
export type PendingAsk = {
  questionId: string
  toolName: string
  summary: string
  resolve: () => void
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
  /** 权限询问挂起超时(缺省 5 分钟;超时发 permission(timeout) 并以超时拒绝)。 */
  permissionTimeoutMs?: number
  /** ask_user 挂起超时(缺省 10 分钟;超时以 timeout 错误返回)。 */
  askTimeoutMs?: number
}

export type ExecuteRequest = {
  sessionId: string
  toolCallId: string
  name: string
  args: Record<string, unknown>
  cwd?: string
  /** 所属 turn(orchestrate 生成;落审计,recovery 悬置判定输入)。 */
  turnId?: string
  /** 中断信号(steer 立即断流/取消):中止挂起询问、终止在飞工具、拦截未执行调用。 */
  signal?: AbortSignal
  /** ask_user 挂起时通知(登记 pendingSyscalls 的落点)。 */
  onPending?: (ask: PendingAsk) => void
}

export type ExecuteOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; error: ToolError }

/** 后台任务注册表:detach 的 bash 可凭 taskId 轮询/取消(SPEC:20,18)。 */
export class BackgroundTaskStore {
  private readonly tasks = new Map<string, { proc: Bun.Subprocess<"ignore" | "pipe" | "inherit"> | null; started: number }>()

  put(taskId: string, proc: Bun.Subprocess): void {
    this.tasks.set(taskId, { proc, started: Date.now() })
  }

  get(taskId: string): { proc: Bun.Subprocess | null; started: number } | null {
    const t = this.tasks.get(taskId)
    if (t === undefined) return null
    if (t.proc !== null && t.proc.exitCode !== null) {
      const exited = { ...t, proc: null }
      this.tasks.set(taskId, exited)
      return exited
    }
    return t
  }

  /** 取消后台任务:终止主进程(子进程清理受平台限制,macOS 无进程组)。 */
  async cancel(taskId: string): Promise<boolean> {
    const t = this.tasks.get(taskId)
    if (t === undefined || t.proc === null) return false
    t.proc.kill("SIGTERM")
    setTimeout(() => t.proc?.kill("SIGKILL"), 3_000)
    return true
  }
}

type EventInput = {
  [K in Event["kind"]]: Extract<Event, { kind: K }> extends infer E extends { kind: K }
    ? Omit<E, "id" | "timestamp" | "redact">
    : never
}[Event["kind"]]

export class ActionPlane {
  readonly registry = new ToolRegistry()
  readonly gate = new CapabilityGate()
  readonly tasks = new BackgroundTaskStore()
  private readonly store: Store
  private readonly opts: ActionPlaneOptions
  private readonly executors = new Map<string, (req: ExecuteRequest) => Promise<ToolResult>>()
  private readonly hooks = createHookRegistry()
  private writeQueue = Promise.resolve()
  private readonly pendingRequests = new Map<string, { sessionId: string; requestId: string; toolCallId: string; toolName: string; summary: string; started: number; turnId?: string | undefined; timer: ReturnType<typeof setTimeout>; resolve: (approved: boolean) => void }>()
  private readonly pendingQuestions = new Map<string, { questionId: string; toolName: string; summary: string; timer: ReturnType<typeof setTimeout>; resolve: (value: unknown) => void }>()

  constructor(store: Store, opts: ActionPlaneOptions = {}) {
    this.store = store
    this.opts = opts
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

  /** 挂起中的权限请求(远程客户端/观察者凭 requestId 定位)。 */
  permissionRequest(): readonly PermissionRequest[] {
    return [...this.pendingRequests.values()].map(({ requestId, toolCallId, toolName, summary }) => ({ toolCallId, toolName, summary, requestId }))
  }

  /** 挂起中的 ask_user(UI 回答列表)。 */
  listPendingQuestions(): readonly { questionId: string; toolName: string; summary: string }[] {
    return [...this.pendingQuestions.values()].map(({ questionId, toolName, summary }) => ({ questionId, toolName, summary }))
  }

  /** 批准挂起权限请求(approve 命令的 toolCallId 承载 requestId)。 */
  grant(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (pending === undefined) return false
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    this.emitTool({ kind: "permission", requestId, toolName: pending.toolName, summary: pending.summary, state: "granted" })
    recordAudit(this.store, pending.sessionId, { toolName: pending.toolName, argsSummary: pending.summary, outcome: "approved", durationMs: Date.now() - pending.started, turnId: pending.turnId })
    pending.resolve(true)
    return true
  }

  /** 作用域预授权(一次批准 N 次,SPEC 授权流):caps 为工具名或通配;范围 maxUses/durationMs。
   * 危险命令不经此豁免(命中模式表仍强制询问,宪法 16)。 */
  grantScope(caps: readonly string[], scope: { maxUses?: number; durationMs?: number; sessionId?: string } = {}): void {
    for (const cap of caps) {
      this.gate.grant(cap, {
        ...(scope.maxUses === undefined ? {} : { maxUses: scope.maxUses }),
        ...(scope.durationMs === undefined ? {} : { durationMs: scope.durationMs }),
      })
      recordAudit(this.store, scope.sessionId ?? "system", {
        toolName: `grant:${cap}`,
        argsSummary: `scope=${JSON.stringify(scope)}`,
        outcome: "approved",
        durationMs: 0,
      })
    }
  }

  /** 拒绝挂起权限请求(deny 命令凭 requestId 定位)。 */
  deny(requestId: string, reason = ""): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (pending === undefined) return false
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    this.emitTool({ kind: "permission", requestId, toolName: pending.toolName, summary: pending.summary, state: "denied" })
    recordAudit(this.store, pending.sessionId, { toolName: pending.toolName, argsSummary: pending.summary, outcome: "rejected", durationMs: Date.now() - pending.started, turnId: pending.turnId })
    void reason
    pending.resolve(false)
    return true
  }

  /** 回答挂起的 ask_user(Command.answer 路由落点)。 */
  answer(questionId: string, answer: unknown): boolean {
    const pending = this.pendingQuestions.get(questionId)
    if (pending === undefined) return false
    clearTimeout(pending.timer)
    this.pendingQuestions.delete(questionId)
    pending.resolve(answer)
    return true
  }

  /** 等待 ask_user 回答(executor 内部挂起点)。 */
  waitAnswer(questionId: string, toolName: string, summary: string): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(questionId)
        resolve({ __tau_timeout: true })
      }, this.opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS)
      this.pendingQuestions.set(questionId, { questionId, toolName, summary, timer, resolve })
    })
  }

  /** 权限询问决策流:requested 事件 → 决议(requested 事件先于回调,双轨不互斥)。 */
  private async resolveApproval(
    req: ExecuteRequest,
    syscall: { name: string; description: string },
    started: number,
    emit: (event: EventInput) => void,
    forcedAsk = false,
  ): Promise<boolean> {
    const summary = brief(argsOf(req))
    const requestId = req.toolCallId
    emit({ kind: "permission", requestId, toolName: req.name, summary, state: "requested" })

    if (this.opts.onPermission !== undefined) {
      // 回调路径同样受超时约束(P1-2):无人应答不得永久挂起,超时 = 拒绝(与挂起路径同语义)
      const approved = await raceApproval(this.opts.onPermission({ toolCallId: req.toolCallId, toolName: req.name, summary }), this.opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS, req.signal)
      if (approved === undefined) {
        emit({ kind: "permission", requestId, toolName: req.name, summary, state: "expired" })
        recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: summary, outcome: "rejected", durationMs: Date.now() - started, turnId: req.turnId })
        return false
      }
      emit({ kind: "permission", requestId, toolName: req.name, summary, state: approved ? "granted" : "denied" })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: summary, outcome: approved ? "approved" : "rejected", durationMs: Date.now() - started, turnId: req.turnId })
      return approved
    }

    // 危险命令强制询问:autoApprove 不豁免(命中模式表必须真实决策,静默放行 = 违宪 16)
    if (this.opts.autoApprove === true && !forcedAsk) {
      emit({ kind: "permission", requestId, toolName: req.name, summary, state: "granted" })
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: summary, outcome: "approved", durationMs: Date.now() - started, turnId: req.turnId })
      return true
    }

    // 双轨第二轨:挂起等待 grant/deny(远程客户端经事件流可见 requested,凭 requestId 决议)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        emit({ kind: "permission", requestId, toolName: req.name, summary, state: "expired" })
        recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: summary, outcome: "rejected", durationMs: Date.now() - started, turnId: req.turnId })
        resolve(false)
      }, this.opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS)
      const onAbort = () => {
        // 中断信号(steer 立即断流):清理挂起项;决议结果由调用侧 withAbort 竞速以 cancelled 收尾
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        resolve(false)
      }
      req.signal?.addEventListener("abort", onAbort, { once: true })
      this.pendingRequests.set(requestId, { sessionId: req.sessionId, requestId, toolCallId: req.toolCallId, toolName: req.name, summary, started, turnId: req.turnId, timer, resolve })
    })
  }

  /**
   * 流式执行面:每调用产出 tool 生命周期事件(started → completed/failed,结果/错误在终态事件)。
   * 权限询问/挂起/截断等旁路事件仍走 onEvent 双轨(不进本流);execute() 是它的结果收口。
   */
  async *executeStream(req: ExecuteRequest, opts: { timeoutMs?: number; bypassQueue?: boolean } = {}): AsyncGenerator<ToolEvent, void, void> {
    const started = Date.now()
    const emit = (event: EventInput): Event => {
      const full = { id: gen(), timestamp: new Date().toISOString(), redact: [], ...event } as Event
      this.opts.onEvent?.(full)
      return full
    }

    const syscall = this.registry.get(req.name)
    if (syscall === null) {
      const error = toolError("not_found", `未知工具:${req.name};可用:${this.registry.all().map((t) => t.name).join(", ")}`)
      yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error }) as ToolEvent
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "error", durationMs: Date.now() - started, turnId: req.turnId })
      return
    }

    // 危险命令强制询问:命中模式表无条件升级为 ask(含 autoApprove 场景,静默放行 = 违宪 16)
    const forcedAsk = req.name === "bash" && typeof req.args.command === "string" && isDangerousCommand(req.args.command)
    const decision = forcedAsk ? ({ rule: "ask" } as const) : this.gate.decide(req.name, syscall.dangerous, syscall.defaultRule?.pattern)
    if (decision.rule === "deny") {
      const error = toolError("permission_denied", `${req.name}:${decision.reason}`)
      yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", args: req.args, error }) as ToolEvent
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "denied", durationMs: Date.now() - started, turnId: req.turnId })
      return
    }
    if (decision.rule === "ask") {
      let approved = false
      try {
        const approval = this.resolveApproval(req, syscall, started, emit, forcedAsk)
        approved = req.signal === undefined ? await approval : await withAbort(approval, req.signal)
      } catch (err) {
        // 中断(steer 立即断流):挂起询问未决即中止,以 aborted 错误收尾(非 rejected)
        const error = normalizeError(err)
        yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", args: req.args, error }) as ToolEvent
        recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "error", durationMs: Date.now() - started, turnId: req.turnId })
        return
      }
      if (!approved) {
        // 决议(拒绝/超时)落点:permission 事件已发,补发 tool failed 让调度层记录 reject 结果
        const error = toolError("rejected", `${req.name} 权限被拒绝`)
        yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error }) as ToolEvent
        return
      }
    }

    const executor = this.executors.get(req.name)
    if (executor === undefined) {
      const error = toolError("internal", `工具 ${req.name} 已注册元数据但无执行器`)
      yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error }) as ToolEvent
      return
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
      yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", args: req.args, error }) as ToolEvent
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "rejected", durationMs: Date.now() - started, turnId: req.turnId })
      return
    }

    yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "started", args: req.args }) as ToolEvent
    try {
      const exec = opts.bypassQueue === true || syscall.tier !== "T0" ? executor(req) : this.enqueue(() => executor(req))
      const raced = req.signal === undefined ? exec : withAbort(exec, req.signal)
      const result = opts.timeoutMs === undefined ? await raced : await withTimeoutMs(raced, opts.timeoutMs)
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

      yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "completed", result: marked.result }) as ToolEvent
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "ok", durationMs: Date.now() - started, turnId: req.turnId })
      return
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
      yield emit({ kind: "tool", toolCallId: req.toolCallId, name: req.name, state: "failed", error }) as ToolEvent
      recordAudit(this.store, req.sessionId, { toolName: req.name, argsSummary: brief(argsOf(req)), outcome: "error", durationMs: Date.now() - started, turnId: req.turnId })
      return
    }
  }

  /** 结果收口:executeStream 的 Promise 形态(终态事件 → ExecuteOutcome;消费方只要最终结果时用它)。 */
  async execute(req: ExecuteRequest, opts: { timeoutMs?: number; bypassQueue?: boolean } = {}): Promise<ExecuteOutcome> {
    let outcome: ExecuteOutcome = { ok: false, error: toolError("internal", "无工具事件产出") }
    for await (const event of this.executeStream(req, opts)) {
      if (event.state === "completed" && event.result !== undefined) {
        outcome = { ok: true, result: event.result }
      } else if (event.state === "failed" && event.error !== undefined) {
        outcome = { ok: false, error: event.error }
      }
    }
    return outcome
  }

  private emitTool(event: EventInput): void {
    this.opts.onEvent?.({ id: gen(), timestamp: new Date().toISOString(), redact: [], ...event } as Event)
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

/** 中断竞速:signal 触发 → 以 aborted 错误中止(在飞执行体自身继续,结果被丢弃;bash 由工具侧监听 signal 杀进程树)。 */
function withAbort<T>(exec: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolErrorException(toolError("cancelled", "执行已中断")))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(new ToolErrorException(toolError("cancelled", "执行已中断")))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    exec.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
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
    if (/中断|aborted/.test(msg)) return toolError("cancelled", msg)
    if (/权限|denied|越界/.test(msg)) return toolError("permission_denied", msg)
    if (/不存在|not found|ENOENT/.test(msg)) return toolError("not_found", msg)
    return toolError("internal", msg)
  }
  return toolError("internal", String(err))
}

/** 工具结果过 secret 模式检测:命中 → 替换 + 事件告警(不阻断,提示模型)。模式表与落盘脱敏同源(contract)。 */
function markSecrets(result: ToolResult): { result: ToolResult; hasSecret: boolean } {
  const probe = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (probe.length === 0 || !SECRET_PATTERNS.some((re) => re.test(probe))) {
    return { result, hasSecret: false }
  }
  const masked = (text: string | null): string | null => (text === null ? null : maskSecretText(text))
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
