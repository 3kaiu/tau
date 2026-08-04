// @tau/surface — face.ts:CommandFace 聚合(发布/订阅/快照)。
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
      if (command.kind !== "prompt") {
        return { accepted: false, eventId: uuid(), detail: `命令 ${command.kind} 需交互授权,M2 print 模式仅支持 prompt` }
      }
      const result = await deps.orchestrate.prompt({ text: command.text, source: command.sender.kind === "cli" ? "prompt" : "steer" })
      return { accepted: true, eventId: uuid(), detail: result.text }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => deps.session.snapshot(),
  }
}
