// @tau/store - sqlite.ts:SQLite 实现(WAL + 索引)。
// 与 memory 行为逐项对齐(差分测试兜底);单写者语义以 SQLite 文件锁表达。

import { Database, type Statement } from "bun:sqlite"
import { redactEventSecrets, type Event, type Message, type SessionSnapshot } from "@tau/contract"
import type { ArtifactMeta, ArtifactRecord, ArtifactTable, AuditEntry, AuditQuery, AuditTable, EventTable, KvEntry, KvTable, MessagePage, MessageTable, SessionTable, Store } from "./store.ts"
import { extractSearchText, normalizeSearchQuery } from "./store.ts"
import { migrate, type Db } from "./migrate.ts"
import { StoreLock } from "./lock.ts"

// ---------- 慢查询日志 ----------

const DEFAULT_SLOW_MS = 50

/** 包装 Database:prepare 出的语句与 exec/transaction 按耗时阈值输出 SQL 日志。 */
export function withSlowQueryLog(
  db: Database,
  thresholdMs = DEFAULT_SLOW_MS,
  log: (sql: string, ms: number) => void = (sql, ms) => console.warn(`[store:slow-query] ${ms.toFixed(1)}ms -- ${sql}`),
): Database {
  const wrapStmt = (stmt: Statement, sql: string): Statement =>
    new Proxy(stmt as unknown as Record<string, unknown>, {
      get(target, prop, recv) {
        if (prop === "run" || prop === "get" || prop === "all") {
          const fn = target[prop] as (...args: unknown[]) => unknown
          return (...args: unknown[]): unknown => {
            const t0 = performance.now()
            try {
              return fn.apply(target, args)
            } finally {
              const ms = performance.now() - t0
              if (ms >= thresholdMs) log(sql, ms)
            }
          }
        }
        const v = Reflect.get(target, prop, recv)
        return typeof v === "function" ? v.bind(target) : v
      },
    }) as unknown as Statement
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "prepare") {
        return (sql: string) => wrapStmt(target.prepare(sql), sql)
      }
      if (prop === "exec") {
        const fn = target.exec.bind(target)
        return (sql: string): unknown => {
          const t0 = performance.now()
          try {
            return fn(sql)
          } finally {
            const ms = performance.now() - t0
            if (ms >= thresholdMs) log(sql, ms)
          }
        }
      }
      if (prop === "transaction") {
        const makeTx = target.transaction.bind(target) as (cb: () => unknown) => (...args: unknown[]) => unknown
        // bun:sqlite 的 transaction(cb) 返回延迟执行函数;包一层保持该语义并计时
        return (cb: () => unknown): unknown => {
          const tx = makeTx(cb)
          return (...args: unknown[]): unknown => {
            const t0 = performance.now()
            try {
              return tx(...args)
            } finally {
              const ms = performance.now() - t0
              if (ms >= thresholdMs) log("transaction", ms)
            }
          }
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === "function" ? v.bind(target) : v
    },
  })
}

// ---------- SessionTable ----------

class SqliteSessionTable implements SessionTable {
  private readonly upsertStmt: Statement
  private readonly getStmt: Statement
  private readonly listStmt: Statement

  constructor(db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO sessions (session_id, epoch, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         epoch = excluded.epoch, status = excluded.status,
         payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    this.getStmt = db.prepare("SELECT payload FROM sessions WHERE session_id = ?")
    this.listStmt = db.prepare(
      "SELECT payload FROM sessions ORDER BY updated_at DESC, session_id ASC LIMIT ?",
    )
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

  list(limit = Number.MAX_SAFE_INTEGER): readonly SessionSnapshot[] {
    const rows = this.listStmt.all(limit) as { payload: string }[]
    return rows.map((r) => JSON.parse(r.payload) as SessionSnapshot)
  }
}

// ---------- MessageTable ----------

class SqliteMessageTable implements MessageTable {
  private readonly appendStmt: Statement
  private readonly listStmt: Statement
  private readonly countStmt: Statement
  private readonly deleteStmt: Statement
  private readonly archiveStmt: Statement
  private readonly searchStmt: Statement
  private readonly countSearchStmt: Statement
  private readonly archiveSearchStmt: Statement
  private readonly countArchiveSearchStmt: Statement

  constructor(db: Db) {
    this.appendStmt = db.prepare(
      `INSERT INTO messages (session_id, id, seq, payload, created_at, search_text)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
    this.listStmt = db.prepare(
      `SELECT payload FROM messages WHERE session_id = ? AND archived = 0 ORDER BY seq LIMIT ? OFFSET ?`,
    )
    this.countStmt = db.prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = ? AND archived = 0")
    this.deleteStmt = db.prepare(
      `DELETE FROM messages WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
    this.archiveStmt = db.prepare(
      `UPDATE messages SET archived = 1 WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
    this.searchStmt = db.prepare(
      `SELECT m.payload FROM messages_fts f JOIN messages m ON m.seq = f.rowid
       WHERE m.session_id = ? AND m.archived = 0 AND messages_fts MATCH ?
       ORDER BY f.rowid LIMIT ? OFFSET ?`,
    )
    this.countSearchStmt = db.prepare(
      `SELECT COUNT(*) as n FROM messages_fts f JOIN messages m ON m.seq = f.rowid
       WHERE m.session_id = ? AND m.archived = 0 AND messages_fts MATCH ?`,
    )
    this.archiveSearchStmt = db.prepare(
      `SELECT m.payload FROM messages_fts f JOIN messages m ON m.seq = f.rowid
       WHERE m.session_id = ? AND m.archived = 1 AND messages_fts MATCH ?
       ORDER BY f.rowid LIMIT ? OFFSET ?`,
    )
    this.countArchiveSearchStmt = db.prepare(
      `SELECT COUNT(*) as n FROM messages_fts f JOIN messages m ON m.seq = f.rowid
       WHERE m.session_id = ? AND m.archived = 1 AND messages_fts MATCH ?`,
    )
  }

  append(sessionId: string, message: Message): void {
    this.appendStmt.run(sessionId, message.id, JSON.stringify(message), message.createdAt, extractSearchText(message))
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

  archive(sessionId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    this.archiveStmt.run(sessionId, JSON.stringify(messageIds))
  }

  search(sessionId: string, query: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): MessagePage {
    const tokens = normalizeSearchQuery(query).split(/\s+/).filter((t) => t !== "")
    if (tokens.length === 0) return { messages: [], total: 0, offset }
    // 词级 AND 语义与 memory 驱动对齐;引号短语 = 相邻 token 序列(memory 侧子串 includes 同规范)
    const match = tokens.map((t) => `"${t.replace(/"/g, " ")}"`).join(" AND ")
    const rows = this.searchStmt.all(sessionId, match, limit, offset) as { payload: string }[]
    const messages = rows.map((r) => JSON.parse(r.payload) as Message)
    const total = this.countSearchStmt.get(sessionId, match) as { n: number }
    return { messages, total: total.n, offset }
  }

  archiveSearch(sessionId: string, query: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): MessagePage {
    const tokens = normalizeSearchQuery(query).split(/\s+/).filter((t) => t !== "")
    if (tokens.length === 0) return { messages: [], total: 0, offset }
    const match = tokens.map((t) => `"${t.replace(/"/g, " ")}"`).join(" AND ")
    const rows = this.archiveSearchStmt.all(sessionId, match, limit, offset) as { payload: string }[]
    const messages = rows.map((r) => JSON.parse(r.payload) as Message)
    const total = this.countArchiveSearchStmt.get(sessionId, match) as { n: number }
    return { messages, total: total.n, offset }
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
    const safe = redactEventSecrets(event)
    this.appendStmt.run(sessionId, safe.id, safe.kind, safe.timestamp, JSON.stringify(safe))
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
      `INSERT INTO audit (id, session_id, timestamp, actor, action, detail, turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    this.queryStmt = db.prepare(
      `SELECT id, session_id, timestamp, actor, action, detail, turn_id FROM audit
       WHERE (? IS NULL OR session_id = ?)
         AND (? IS NULL OR actor = ?)
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ?`,
    )
  }

  append(entry: AuditEntry): void {
    this.appendStmt.run(entry.id, entry.sessionId, entry.timestamp, entry.actor, entry.action, entry.detail, entry.turnId ?? null)
  }

  query(q: AuditQuery): readonly AuditEntry[] {
    const limit = q.limit ?? Number.MAX_SAFE_INTEGER
    const rows = this.queryStmt.all(
      q.sessionId ?? null, q.sessionId ?? null,
      q.actor ?? null, q.actor ?? null,
      limit,
    ) as Record<string, unknown>[]
    return rows.map((r) => ({ ...r, turnId: r.turn_id === null ? undefined : String(r.turn_id) }) as unknown as AuditEntry)
  }
}

// ---------- ArtifactTable ----------

class SqliteArtifactTable implements ArtifactTable {
  private readonly putStmt: Statement
  private readonly getStmt: Statement
  private readonly deleteStmt: Statement
  private readonly listStmt: Statement

  constructor(db: Db) {
    this.putStmt = db.prepare(
      `INSERT INTO artifacts (ref, session_id, mime, size, hash, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         session_id = excluded.session_id, mime = excluded.mime, size = excluded.size,
         hash = excluded.hash, body = excluded.body, created_at = excluded.created_at`,
    )
    this.getStmt = db.prepare("SELECT * FROM artifacts WHERE ref = ?")
    this.deleteStmt = db.prepare("DELETE FROM artifacts WHERE ref = ?")
    this.listStmt = db.prepare(
      "SELECT ref, mime, size, hash FROM artifacts WHERE session_id = ? ORDER BY ref ASC",
    )
  }

  put(record: ArtifactRecord): void {
    this.putStmt.run(record.ref, record.sessionId, record.mime ?? null, record.size, record.hash, record.body, record.createdAt)
  }

  get(ref: string): ArtifactRecord | null {
    const row = this.getStmt.get(ref) as Record<string, unknown> | null
    if (row === null) return null
    return {
      ref: String(row.ref),
      sessionId: String(row.session_id),
      ...(row.mime === null ? {} : { mime: String(row.mime) }),
      size: Number(row.size),
      hash: String(row.hash),
      body: String(row.body),
      createdAt: String(row.created_at),
    } as ArtifactRecord
  }

  delete(ref: string): void {
    this.deleteStmt.run(ref)
  }

  list(sessionId: string): readonly ArtifactMeta[] {
    const rows = this.listStmt.all(sessionId) as { ref: string; mime: string | null; size: number; hash: string }[]
    return rows.map((r) => ({ ref: r.ref, ...(r.mime === null ? {} : { mime: r.mime }), size: r.size, hash: r.hash }) as ArtifactMeta)
  }
}

// ---------- KvTable ----------

class SqliteKvTable implements KvTable {
  private readonly getStmt: Statement
  private readonly setStmt: Statement
  private readonly deleteStmt: Statement
  private readonly listStmt: Statement

  constructor(db: Db) {
    this.getStmt = db.prepare("SELECT value FROM kv WHERE key = ?")
    this.setStmt = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    this.deleteStmt = db.prepare("DELETE FROM kv WHERE key = ?")
    // substr 前缀匹配而非 LIKE:免去 %/_ 转义,语义与 memory 驱动逐字一致
    this.listStmt = db.prepare("SELECT key, value FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key ASC")
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

  list(prefix = ""): readonly KvEntry[] {
    return this.listStmt.all(prefix.length, prefix) as KvEntry[]
  }
}

// ---------- SqliteStore ----------

/** 构造前先拿锁:失败即抛(不创建 Database),避免半初始化泄露。 */
function acquireWithLock(path: string): StoreLock {
  const lock = new StoreLock(path)
  lock.acquire()
  return lock
}

export type SqliteStoreOptions = {
  /** 执行耗时 ≥ 阈值(ms)的 SQL 输出日志;undefined = 关闭。 */
  slowQueryThresholdMs?: number
  /** 慢查询日志输出(缺省 console.warn)。 */
  slowQueryLogger?: (sql: string, ms: number) => void
  /** 只读打开(治理/观测):不拿写锁。 */
  readonly?: boolean
}

export class SqliteStore implements Store {
  readonly driver = "sqlite" as const
  readonly sessions: SqliteSessionTable
  readonly messages: SqliteMessageTable
  readonly events: SqliteEventTable
  readonly audit: SqliteAuditTable
  readonly kv: SqliteKvTable
  readonly artifacts: SqliteArtifactTable
  private readonly db: Database
  private readonly lock: StoreLock | null
  private readonly txFn: (fn: () => unknown) => unknown
  private readonly archiveAuditStmt: Statement
  private readonly countArchivedStmt: Statement

  constructor(path: string, options: SqliteStoreOptions = {}) {
    const readonly = options.readonly === true
    // 单写者锁:文件型路径且非只读 → 独占(第二写者明确错误;`:memory:` 无跨进程竞争不拿锁)
    this.lock = path !== ":memory:" && !readonly ? acquireWithLock(path) : null
    // 真只读:不建文件(fileMustExist 语义)、跳过 WAL/migrate(观测命令绝不因"看一眼"写库)
    const raw = readonly
      ? new Database(path, { readonly: true, create: false })
      : new Database(path)
    if (!readonly) {
      raw.exec("PRAGMA journal_mode = WAL")
      raw.exec("PRAGMA foreign_keys = ON")
      raw.exec("PRAGMA busy_timeout = 5000")
    } else {
      raw.exec("PRAGMA query_only = ON")
    }
    this.db = options.slowQueryThresholdMs !== undefined
      ? withSlowQueryLog(raw, options.slowQueryThresholdMs, options.slowQueryLogger)
      : raw
    this.txFn = this.db.transaction((fn: () => unknown) => fn())
    if (!readonly) migrate(this.db)
    this.sessions = new SqliteSessionTable(this.db)
    this.messages = new SqliteMessageTable(this.db)
    this.events = new SqliteEventTable(this.db)
    this.audit = new SqliteAuditTable(this.db)
    this.kv = new SqliteKvTable(this.db)
    this.artifacts = new SqliteArtifactTable(this.db)
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
    if (this.lock === null) {
      // 只读连接(或 :memory:)不做 schema 变更;只读库要求已迁移
      return
    }
    migrate(this.db)
  }

  close(): void {
    this.db.close()
    this.lock?.release()
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
