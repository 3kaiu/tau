// @tau/store — 汇总出口。sqlite 驱动与迁移随 M4(持久化)落地;M2 只发布 memory。

import type { Store } from "./store.ts"
import { MemoryStore } from "./memory.ts"

export const version = "0.0.1"

export type { Store, StoreMessage, StoreEvent, MessagePage, AuditEntry, AuditQuery, SessionTable, MessageTable, EventTable, AuditTable, KvTable } from "./store.ts"
export { MemoryStore } from "./memory.ts"

export function createMemoryStore() {
  return new MemoryStore()
}

export function createStore(driver: "sqlite" | "memory"): Store {
  if (driver === "memory") return new MemoryStore()
  throw new Error("sqlite 驱动随 M4(持久化)落地;当前仅 memory")
}
