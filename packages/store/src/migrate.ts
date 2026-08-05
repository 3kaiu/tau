// @tau/store - migrate.ts:版本化 schema 迁移。
// 迁移幂等(多次执行结果一致);版本号记在 kv 表;forward-only(不回滚)。

import type { Database } from "bun:sqlite"

export type Db = Database

export const SCHEMA_VERSION = "4"

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

  // v1 -> v2:会话注册表读端(sessions.list 按 updated_at 倒序);语句幂等,新旧库同路径
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC, session_id ASC)`)

  // v2 -> v3:消息全文检索(FTS5 external-content 表 + search_text 冗余列 + 同步触发器)
  // ALTER ADD COLUMN 无 IF NOT EXISTS,以 PRAGMA table_info 探测保证幂等
  const messageCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
  if (!messageCols.some((c) => c.name === "search_text")) {
    db.exec(`ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''`)
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      search_text,
      content='messages',
      content_rowid='seq'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, search_text) VALUES (new.seq, new.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, search_text)
        VALUES ('delete', old.seq, old.search_text);
    END;
  `)
  // 存量回填:external-content 表从 messages.search_text 全量重建(幂等)
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`)

  // v3 -> v4:压缩交换——消息归档位(archived=1 的消息不进投影,检索仍可达)
  if (!messageCols.some((c) => c.name === "archived")) {
    db.exec(`ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_archived ON messages(session_id, archived, seq)`)

  // 未来版本迁移:v4 -> v5 -> ... 每步检查 kv 中的 version

  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
}
