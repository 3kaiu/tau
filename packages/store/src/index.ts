// @tau/store - 汇总出口。memory 与 sqlite 双驱动,接口一致,可热切换。

import type { Store } from "./store.ts"
import { MemoryStore } from "./memory.ts"
import { SqliteStore } from "./sqlite.ts"

export const version = "0.0.1"

export type { Store, StoreMessage, StoreEvent, MessagePage, AuditEntry, AuditQuery, SessionTable, MessageTable, EventTable, AuditTable, KvTable, KvEntry, ArtifactTable, ArtifactRecord, ArtifactMeta } from "./store.ts"
export { extractSearchText } from "./store.ts"
export { MemoryStore } from "./memory.ts"
export { SqliteStore } from "./sqlite.ts"
export { migrate, SCHEMA_VERSION } from "./migrate.ts"

export function createMemoryStore() {
  return new MemoryStore()
}

export function createSqliteStore(path: string) {
  return new SqliteStore(path)
}

/** path 仅 sqlite 用;缺省 ":memory:"(SQLite 内存库,与 MemoryStore 行为对齐但走真实 SQL)。 */
export function createStore(driver: "sqlite" | "memory", path?: string): Store {
  if (driver === "memory") return new MemoryStore()
  if (driver === "sqlite") return new SqliteStore(path ?? ":memory:")
  throw new Error(`未知驱动:${driver}`)
}
