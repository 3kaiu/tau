// @tau/store - sqlite.ts:SQLite 实现(WAL + 索引)。
// 与 memory 行为逐项对齐(差分测试兜底);单写者语义以 SQLite 文件锁表达。

import { Database, type Statement } from "bun:sqlite"
import type { Event, Message, SessionSnapshot } from "@tau/contract"
import type { AuditEntry, AuditQuery, AuditTable, EventTable, KvTable, MessagePage, MessageTable, SessionTable, Store } from "./store.ts"
import { migrate, type Db } from "./migrate.ts"

// ---------- SessionTable ----------

class SqliteSessionTable implements SessionTable {
  private readonly upsertStmt: Statement
  private readonly getStmt: Statement

  constructor(db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO sessions (session_id, epoch, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         epoch = excluded.epoch, status = excluded.status,
         payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    this.getStmt = db.prepare("SELECT payload FROM sessions WHERE session_id = ?")
  }

  upsert(snapshot: SessionSnapshot): void {
    this.upsertStmt.run(
      snapshot.sessionId, snapshot.epoch, snapshot.status,
      JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt,
    )
  }

  get(sessionId: string): SessionSnapshot | null {
    const row = this.getStmt.get(sessionId) as { payload: string } | null
    if (row === null) return null
    return JSON.parse(row.payload) as SessionSnapshot
  }
}

// ---------- MessageTable ----------

class SqliteMessageTable implements MessageTable {
  private readonly appendStmt: Statement
  private readonly listStmt: Statement
  private readonly countStmt: Statement
  private readonly deleteStmt: Statement

  constructor(db: Db) {
    this.appendStmt = db.prepare(
      `INSERT INTO messages (session_id, id, seq, payload, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
    )
    this.listStmt = db.prepare(
      `SELECT payload FROM messages WHERE session_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
    )
    this.countStmt = db.prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = ?")
    this.deleteStmt = db.prepare(
      `DELETE FROM messages WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
  }

  append(sessionId: string, message: Message): void {
    this.appendStmt.run(sessionId, message.id, JSON.stringify(message), message.createdAt)
  }

  list(sessionId: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): MessagePage {
    const rows = this.listStmt.all(sessionId, limit, offset) as { payload: string }[]
    const messages = rows.map((r) => JSON.parse(r.payload) as Message)
    const total = this.count(sessionId)
    return { messages, total, offset }
  }

  count(sessionId: string): number {
    const row = this.countStmt.get(sessionId) as { n: number }
    return row.n
  }

  delete(sessionId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    this.deleteStmt.run(sessionId, JSON.stringify(messageIds))
  }
}

// ---------- EventTable ----------

class SqliteEventTable implements EventTable {
  private readonly appendStmt: Statement
  private readonly replayStmt: Statement
  private readonly countStmt: Statement

  constructor(db: Db) {
    this.appendStmt = db.prepare(
      `INSERT INTO events (session_id, id, seq, kind, timestamp, payload)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
    this.replayStmt = db.prepare("SELECT payload FROM events WHERE session_id = ? ORDER BY seq")
    this.countStmt = db.prepare("SELECT COUNT(*) as n FROM events WHERE session_id = ?")
  }

  append(sessionId: string, event: Event): void {
    this.appendStmt.run(sessionId, event.id, event.kind, event.timestamp, JSON.stringify(event))
  }

  replay(sessionId: string): readonly Event[] {
    const rows = this.replayStmt.all(sessionId) as { payload: string }[]
    return rows.map((r) => JSON.parse(r.payload) as Event)
  }

  count(sessionId: string): number {
    const row = this.countStmt.get(sessionId) as { n: number }
    return row.n
  }
}

// ---------- AuditTable ----------

class SqliteAuditTable implements AuditTable {
  private readonly appendStmt: Statement
  private readonly queryStmt: Statement

  constructor(db: Db) {
    this.appendStmt = db.prepare(
      `INSERT INTO audit (id, session_id, timestamp, actor, action, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    this.queryStmt = db.prepare(
      `SELECT id, session_id, timestamp, actor, action, detail FROM audit
       WHERE (? IS NULL OR session_id = ?)
         AND (? IS NULL OR actor = ?)
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
  }

  append(entry: AuditEntry): void {
    this.appendStmt.run(entry.id, entry.sessionId, entry.timestamp, entry.actor, entry.action, entry.detail)
  }

  query(q: AuditQuery): readonly AuditEntry[] {
    const limit = q.limit ?? Number.MAX_SAFE_INTEGER
    const rows = this.queryStmt.all(
      q.sessionId ?? null, q.sessionId ?? null,
      q.actor ?? null, q.actor ?? null,
      limit,
    ) as AuditEntry[]
    return rows
  }
}

// ---------- KvTable ----------

class SqliteKvTable implements KvTable {
  private readonly getStmt: Statement
  private readonly setStmt: Statement
  private readonly deleteStmt: Statement

  constructor(db: Db) {
    this.getStmt = db.prepare("SELECT value FROM kv WHERE key = ?")
    this.setStmt = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    this.deleteStmt = db.prepare("DELETE FROM kv WHERE key = ?")
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key) as { value: string } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.setStmt.run(key, value, value)
  }

  delete(key: string): void {
    this.deleteStmt.run(key)
  }
}

// ---------- SqliteStore ----------

export class SqliteStore implements Store {
  readonly driver = "sqlite" as const
  readonly sessions: SqliteSessionTable
  readonly messages: SqliteMessageTable
  readonly events: SqliteEventTable
  readonly audit: SqliteAuditTable
  readonly kv: SqliteKvTable
  private readonly db: Database
  private readonly txFn: (fn: () => unknown) => unknown
  private readonly archiveAuditStmt: Statement
  private readonly countArchivedStmt: Statement

  constructor(path: string) {
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.txFn = this.db.transaction((fn: () => unknown) => fn())
    migrate(this.db)
    this.sessions = new SqliteSessionTable(this.db)
    this.messages = new SqliteMessageTable(this.db)
    this.events = new SqliteEventTable(this.db)
    this.audit = new SqliteAuditTable(this.db)
    this.kv = new SqliteKvTable(this.db)
    this.archiveAuditStmt = this.db.prepare(
      `INSERT OR IGNORE INTO audit_archive
       SELECT * FROM audit WHERE session_id = ? AND timestamp < ?
       LIMIT ?`,
    )
    this.countArchivedStmt = this.db.prepare(
      `SELECT changes() as n`,
    )
  }

  tx<T>(work: () => T): T {
    return this.txFn(work) as T
  }

  migrate(): void {
    migrate(this.db)
  }

  close(): void {
    this.db.close()
  }

  /** 归档旧审计记录(移至 audit_archive,不删历史)。返回归档条数。 */
  archiveAudit(sessionId: string, olderThanIso: string, limit = 10000): number {
    this.archiveAuditStmt.run(sessionId, olderThanIso, limit)
    const row = this.countArchivedStmt.get() as { n: number }
    const n = row.n
    if (n > 0) {
      this.db.prepare(
        `DELETE FROM audit WHERE session_id = ? AND id IN (
          SELECT id FROM audit_archive WHERE session_id = ?
        )`,
      ).run(sessionId, sessionId)
    }
    return n
  }
}
