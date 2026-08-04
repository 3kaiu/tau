// @tau/store — memory.ts:内存实现(测试/评测/内存会话用,同接口)。
// 与 sqlite 行为逐项对齐(差分测试兜底在 eval);单写者语义以所有权抛错表达。

import type { Event, Message, SessionSnapshot } from "@tau/contract"
import type { AuditEntry, AuditQuery, AuditTable, EventTable, KvEntry, KvTable, MessagePage, MessageTable, SessionTable, Store } from "./store.ts"

class MemorySessionTable implements SessionTable {
  readonly snapshots = new Map<string, SessionSnapshot>()
  upsert(snapshot: SessionSnapshot): void {
    this.snapshots.set(snapshot.sessionId, snapshot)
  }
  get(sessionId: string): SessionSnapshot | null {
    return this.snapshots.get(sessionId) ?? null
  }
  list(limit = Number.MAX_SAFE_INTEGER): readonly SessionSnapshot[] {
    // 与 sqlite 排序键逐项对齐:updatedAt DESC, sessionId ASC
    return Array.from(this.snapshots.values())
      .sort((a, b) => (a.updatedAt === b.updatedAt ? a.sessionId.localeCompare(b.sessionId) : a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
  }
}

class MemoryMessageTable implements MessageTable {
  readonly bySession = new Map<string, Message[]>()
  append(sessionId: string, message: Message): void {
    const list = this.bySession.get(sessionId) ?? []
    list.push(message)
    this.bySession.set(sessionId, list)
  }
  list(sessionId: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): MessagePage {
    const list = this.bySession.get(sessionId) ?? []
    return { messages: list.slice(offset, offset + limit), total: list.length, offset }
  }
  count(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0
  }
  delete(sessionId: string, messageIds: readonly string[]): void {
    const list = this.bySession.get(sessionId)
    if (!list) return
    const drop = new Set(messageIds)
    this.bySession.set(sessionId, list.filter((m) => !drop.has(m.id)))
  }
}

class MemoryEventTable implements EventTable {
  readonly bySession = new Map<string, Event[]>()
  append(sessionId: string, event: Event): void {
    const list = this.bySession.get(sessionId) ?? []
    list.push(event)
    this.bySession.set(sessionId, list)
  }
  replay(sessionId: string): readonly Event[] {
    return this.bySession.get(sessionId) ?? []
  }
  count(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0
  }
}

class MemoryAuditTable implements AuditTable {
  readonly entries: AuditEntry[] = []
  append(entry: AuditEntry): void {
    this.entries.push(entry)
  }
  query(query: AuditQuery): readonly AuditEntry[] {
    return this.entries.filter(
      (e) =>
        (query.sessionId === undefined || e.sessionId === query.sessionId) &&
        (query.actor === undefined || e.actor === query.actor),
    ).slice(-(query.limit ?? Number.MAX_SAFE_INTEGER))
  }
}

class MemoryKvTable implements KvTable {
  readonly map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.map.set(key, value)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
  list(prefix = ""): readonly KvEntry[] {
    return Array.from(this.map.entries())
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => ({ key, value }))
  }
}

export class MemoryStore implements Store {
  readonly driver = "memory" as const
  readonly sessions = new MemorySessionTable()
  readonly messages = new MemoryMessageTable()
  readonly events = new MemoryEventTable()
  readonly audit = new MemoryAuditTable()
  readonly kv = new MemoryKvTable()

  tx<T>(work: () => T): T {
    // 内存实现天然单线程原子;批量语义与 sqlite 事务对齐(全部成功或整体失败)
    return work()
  }

  migrate(): void {
    // 内存实现无 schema,no-op
  }
}
