// @tau/store — Store 接口 + 聚合。
// 会话数据的唯一持久化层;接口不泄漏实现,sqlite/memory 切换对上层零感知。

import type { Event, Message, SessionSnapshot } from "@tau/contract"

export type StoreMessage = Message
export type StoreEvent = Event

export type MessagePage = {
  messages: readonly Message[]
  total: number
  offset: number
}

export type AuditEntry = {
  id: string
  sessionId: string
  timestamp: string
  actor: string
  action: string
  detail: string
}

export type AuditQuery = {
  sessionId?: string
  actor?: string
  limit?: number
}

export interface SessionTable {
  upsert(snapshot: SessionSnapshot): void
  get(sessionId: string): SessionSnapshot | null
}

export interface MessageTable {
  append(sessionId: string, message: Message): void
  list(sessionId: string, offset?: number, limit?: number): MessagePage
  count(sessionId: string): number
  delete(sessionId: string, messageIds: readonly string[]): void
}

export interface EventTable {
  append(sessionId: string, event: Event): void
  replay(sessionId: string): readonly Event[]
  count(sessionId: string): number
}

export interface AuditTable {
  append(entry: AuditEntry): void
  query(query: AuditQuery): readonly AuditEntry[]
}

export interface KvTable {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

export interface Store {
  readonly driver: "sqlite" | "memory"
  sessions: SessionTable
  messages: MessageTable
  events: EventTable
  audit: AuditTable
  kv: KvTable
  tx<T>(work: () => T): T
  migrate(): void
}
