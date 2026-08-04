// @tau/surface - face.ts:CommandFace 聚合(发布/订阅/快照)。
// 命令面无状态:一切状态在 session;只发布与观察,不生成内容。

import type { Command, Event, SessionSnapshot } from "@tau/contract"
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

  void emit

  return {
    async publish(command) {
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
          if (command.targetId !== undefined) {
            // deny 权限请求:targetId = questionId
            deps.session.resolvePending(command.targetId, false)
            return { accepted: true, eventId: uuid(), detail: "权限已拒绝" }
          }
          deps.orchestrate.abort()
          return { accepted: true, eventId: uuid(), detail: "已中断" }
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
