// @tau/store - migrate.ts:版本化 schema 迁移。
// 迁移幂等(多次执行结果一致);版本号记在 kv 表;forward-only(不回滚)。

import type { Database } from "bun:sqlite"

export type Db = Database

export const SCHEMA_VERSION = "1"

export function migrate(db: Db): void {
  // kv 表最先建(版本追踪依赖它)
  db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)

  const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string } | null
  if (row?.value === SCHEMA_VERSION) return

  if (row?.value === undefined || row?.value === null) {
    // 首次迁移:建全量表
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        epoch       INTEGER NOT NULL DEFAULT 0,
        status      TEXT    NOT NULL DEFAULT 'active',
        payload     TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        id          TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        UNIQUE (session_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        id          TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        timestamp   TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        UNIQUE (session_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

      CREATE TABLE IF NOT EXISTS audit (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        detail      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id, timestamp);

      CREATE TABLE IF NOT EXISTS audit_archive (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        detail      TEXT NOT NULL
      );
    `)
  }

  // 未来版本迁移:v1 -> v2 -> ... 每步检查 kv 中的 version
  // if (row?.value === "1") { /* migrate 1 -> 2 */ }

  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
}
