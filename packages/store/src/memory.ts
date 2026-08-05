// @tau/store — memory.ts:内存实现(测试/评测/内存会话用,同接口)。
// 与 sqlite 行为逐项对齐(差分测试兜底在 eval);单写者锁由 sqlite 文件驱动承担(跨进程),memory 驱动为进程内实例无跨进程竞争。

import type { Event, Message, SessionSnapshot } from "@tau/contract"
import type { ArtifactMeta, ArtifactRecord, ArtifactTable, AuditEntry, AuditQuery, AuditTable, EventTable, KvEntry, KvTable, MessagePage, MessageTable, SessionTable, Store } from "./store.ts"
import { extractSearchText, normalizeSearchQuery } from "./store.ts"

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
  readonly archivedBySession = new Map<string, Message[]>()
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
  archive(sessionId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    const drop = new Set(messageIds)
    const active = this.bySession.get(sessionId) ?? []
    const moved = active.filter((m) => drop.has(m.id))
    this.bySession.set(sessionId, active.filter((m) => !drop.has(m.id)))
    this.archivedBySession.set(sessionId, [...(this.archivedBySession.get(sessionId) ?? []), ...moved])
  }
  search(sessionId: string, query: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): MessagePage {
    const tokens = normalizeSearchQuery(query).toLowerCase().split(/\s+/).filter((t) => t !== "")
    if (tokens.length === 0) return { messages: [], total: 0, offset }
    const list = this.bySession.get(sessionId) ?? []
    const hits = list.filter((m) => {
      const haystack = extractSearchText(m).toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
    return { messages: hits.slice(offset, offset + limit), total: hits.length, offset }
  }
  archiveSearch(sessionId: string, query: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): MessagePage {
    const tokens = normalizeSearchQuery(query).toLowerCase().split(/\s+/).filter((t) => t !== "")
    if (tokens.length === 0) return { messages: [], total: 0, offset }
    const list = this.archivedBySession.get(sessionId) ?? []
    const hits = list.filter((m) => {
      const haystack = extractSearchText(m).toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
    return { messages: hits.slice(offset, offset + limit), total: hits.length, offset }
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
    // 与 sqlite 逐项对齐:timestamp DESC, 插入序 DESC(最新在前;同 timestamp 后插入者在前)
    return this.entries
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) =>
        (query.sessionId === undefined || e.sessionId === query.sessionId) &&
        (query.actor === undefined || e.actor === query.actor),
      )
      .sort((a, b) => (a.e.timestamp === b.e.timestamp ? b.idx - a.idx : a.e.timestamp < b.e.timestamp ? 1 : -1))
      .slice(0, query.limit ?? Number.MAX_SAFE_INTEGER)
      .map(({ e }) => e)
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

class MemoryArtifactTable implements ArtifactTable {
  readonly map = new Map<string, ArtifactRecord>()
  put(record: ArtifactRecord): void {
    this.map.set(record.ref, record)
  }
  get(ref: string): ArtifactRecord | null {
    return this.map.get(ref) ?? null
  }
  delete(ref: string): void {
    this.map.delete(ref)
  }
  list(sessionId: string): readonly ArtifactMeta[] {
    return Array.from(this.map.values())
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map(({ ref, mime, size, hash }) => ({ ref, ...(mime !== undefined ? { mime } : {}), size, hash }) as ArtifactMeta)
  }
}

export class MemoryStore implements Store {
  readonly driver = "memory" as const
  readonly sessions = new MemorySessionTable()
  readonly messages = new MemoryMessageTable()
  readonly events = new MemoryEventTable()
  readonly audit = new MemoryAuditTable()
  readonly kv = new MemoryKvTable()
  readonly artifacts = new MemoryArtifactTable()

  tx<T>(work: () => T): T {
    // 内存实现天然单线程原子;批量语义与 sqlite 事务对齐(全部成功或整体失败)
    return work()
  }

  migrate(): void {
    // 内存实现无 schema,no-op
  }
}
