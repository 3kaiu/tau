// @tau/surface - face.ts:CommandFace 聚合(发布/订阅/快照)。
// 命令面无状态:一切状态在 session;只发布与观察,不生成内容。

import type { Command, Event, InputAcceptedEvent, SessionSnapshot } from "@tau/contract"
import type { Scheduler } from "@tau/orchestrate"
import type { Session } from "@tau/session"
import type { ActionPlane } from "@tau/action"

export type CommandResult = {
  accepted: boolean
  eventId: string
  detail: string
}

export type FaceDeps = {
  orchestrate: Scheduler
  session: Session
  action: ActionPlane
  onEvent?: (event: Event) => void
}

export type EventKind = Event["kind"]

/**
 * 订阅过滤器(SPEC 第 6 条 observe 可见范围)。
 * 缺省 = PUBLIC_EVENT_KINDS + 不含敏感原文;敏感明细为 tool 事件(carry args/result 原文)。
 * permission 事件永远公开(SPEC 第 5 条:广播到所有客户端,approve 落点依赖 requestId)。
 */
export type EventFilter = {
  /** kind 白名单;缺省 = PUBLIC_EVENT_KINDS。 */
  kinds?: readonly EventKind[]
  /** true 才放行 tool 事件(工具参数/结果原文)。 */
  includeSensitive?: boolean
}

/** 公开事件集:observe 默认可见范围(剪掉 tool 原文 = 审计/工具明细)。 */
export const PUBLIC_EVENT_KINDS: readonly EventKind[] = [
  "input_accepted",
  "transcript",
  "permission",
  "compression",
  "lifecycle",
  "budget_exceeded",
  "loop_detected",
  "retry",
  "model_switched",
  "interrupted",
  "recovery",
  "goal",
]

/** 事件过不过滤(纯函数,供订阅分发与 http/acp 复用)。 */
export function matchesFilter(event: Event, filter: EventFilter = {}): boolean {
  if (event.kind === "tool") {
    // 工具明细是敏感面:仅显式 includeSensitive(且 kinds 白名单含 tool,否则显式。)时放行;
    // 未声明 kinds 白名单时 includeSensitive 单独构成放行条件
    return filter.includeSensitive === true && (filter.kinds === undefined || filter.kinds.includes("tool"))
  }
  const kinds = filter.kinds ?? PUBLIC_EVENT_KINDS
  return kinds.includes(event.kind)
}

/** 合并订阅分发:过滤缺省的 public 可见面。 */
export const DEFAULT_FILTER: EventFilter = {}

export interface CommandFace {
  publish(command: Command): Promise<CommandResult>
  subscribe(listener: (event: Event) => void): () => void
  subscribe(filter: EventFilter, listener: (event: Event) => void): () => void
  snapshot(): SessionSnapshot
}

const uuid = () => crypto.randomUUID()

export function createCommandFace(deps: FaceDeps): CommandFace {
  const listeners = new Set<(event: Event) => void>()

  function emit(event: Event): void {
    deps.onEvent?.(event)
    for (const fn of listeners) fn(event)
  }

  return {
    async publish(command) {
      // input_accepted 回执:命令面无状态,sender 由上游发布方(如 tui 的 DEFAULT_SENDER)填好,
      // 此处原样透传供审计溯源——face 不重写 sender,因为 Command 契约已强制 sender 必填。
      emit({
        id: uuid(),
        timestamp: new Date().toISOString(),
        redact: [],
        kind: "input_accepted",
        command,
      } satisfies InputAcceptedEvent)
      switch (command.kind) {
        case "prompt": {
          const result = await deps.orchestrate.prompt({ text: command.text, source: "prompt" })
          return { accepted: true, eventId: uuid(), detail: result.text }
        }
        case "steer": {
          await deps.orchestrate.steer({ text: command.text, source: "steer" })
          return { accepted: true, eventId: uuid(), detail: "steer 已排队" }
        }
        case "abort": {
          deps.orchestrate.abort()
          return { accepted: true, eventId: uuid(), detail: "已中断" }
        }
        case "deny": {
          // 双轨决议:action 定位挂起请求(requestId),session 记账同步
          deps.action.deny(command.requestId, command.reason)
          deps.session.resolvePending(command.requestId, false)
          return { accepted: true, eventId: uuid(), detail: "权限已拒绝" }
        }
        case "approve": {
          // approve 的 toolCallId 字段实际承载 requestId(来自 permission 事件)
          deps.action.grant(command.toolCallId)
          deps.session.resolvePending(command.toolCallId, true)
          return { accepted: true, eventId: uuid(), detail: "权限已批准" }
        }
        case "answer": {
          // ask_user 恢复:action 解析挂起 promise,会话记账同步清理
          deps.action.answer(command.questionId, command.answer)
          deps.session.resolvePending(command.questionId, true)
          return { accepted: true, eventId: uuid(), detail: "已回答" }
        }
        case "select": {
          deps.action.answer(command.questionId, { selected: command.selected, multiple: command.multiple })
          deps.session.resolvePending(command.questionId, true)
          return { accepted: true, eventId: uuid(), detail: "已选择" }
        }
        case "observe": {
          return { accepted: true, eventId: uuid(), detail: "观察模式(public 可见面,需 includeSensitive 才见工具明细)" }
        }
      }
    },
    subscribe(
      first: EventFilter | ((event: Event) => void),
      second?: (event: Event) => void,
    ): () => void {
      // 合并签名(见接口重载):filter 裁剪后分发,缺省 = public 可见面
      const filter: EventFilter = typeof first === "function" ? {} : first
      const listener = typeof first === "function" ? first : second!
      if (typeof listener !== "function") {
        throw new TypeError("subscribe 需要 listener 函数")
      }
      const filtered = (event: Event): void => {
        if (matchesFilter(event, filter)) listener(event)
      }
      listeners.add(filtered)
      return () => listeners.delete(filtered)
    },
    snapshot: () => deps.session.snapshot(),
  }
}
