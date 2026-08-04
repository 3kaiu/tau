// @tau/surface - face.ts:CommandFace 聚合(发布/订阅/快照)。
// 命令面无状态:一切状态在 session;只发布与观察,不生成内容。

import type { Command, Event, InputAcceptedEvent, SessionSnapshot } from "@tau/contract"
import type { Scheduler } from "@tau/orchestrate"
import type { Session } from "@tau/session"

export type CommandResult = {
  accepted: boolean
  eventId: string
  detail: string
}

export type FaceDeps = {
  orchestrate: Scheduler
  session: Session
  onEvent?: (event: Event) => void
}

export interface CommandFace {
  publish(command: Command): Promise<CommandResult>
  subscribe(listener: (event: Event) => void): () => void
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
          deps.session.resolvePending(command.requestId, false)
          return { accepted: true, eventId: uuid(), detail: "权限已拒绝" }
        }
        case "approve": {
          // approve 的 toolCallId 字段实际承载 questionId(来自 permission 事件 requestId)
          deps.session.resolvePending(command.toolCallId, true)
          return { accepted: true, eventId: uuid(), detail: "权限已批准" }
        }
        case "answer": {
          deps.session.resolvePending(command.questionId, true)
          return { accepted: true, eventId: uuid(), detail: "已回答" }
        }
        case "select": {
          deps.session.resolvePending(command.questionId, true)
          return { accepted: true, eventId: uuid(), detail: "已选择" }
        }
        case "observe": {
          return { accepted: true, eventId: uuid(), detail: "观察模式" }
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => deps.session.snapshot(),
  }
}
