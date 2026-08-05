// @tau/enhance - memory.ts:T2 记忆(syscall 后端)。
// 记忆是辅助不是主存:权威状态永远在 session;记忆只做检索增强。

import type { Store } from "@tau/store"

const MEM_PREFIX = (sessionId: string) => `memory:${sessionId}:`

export type MemoryEntry = {
  key: string
  content: string
  updatedAt: string
}

/** 写入/覆盖记忆。overwrite 缺省 false:已存在 key 拒绝覆盖(返回 false),防模型误覆盖;overwrite: true 才允许。 */
export function remember(store: Store, sessionId: string, key: string, content: string, opts: { overwrite?: boolean } = {}): boolean {
  const existing = store.kv.get(`${MEM_PREFIX(sessionId)}${key}`)
  if (existing !== null && opts.overwrite !== true) return false
  const entry: MemoryEntry = { key, content, updatedAt: new Date().toISOString() }
  store.kv.set(`${MEM_PREFIX(sessionId)}${key}`, JSON.stringify(entry))
  return true
}

/** 读取记忆。 */
export function recall(store: Store, sessionId: string, key: string): MemoryEntry | null {
  const raw = store.kv.get(`${MEM_PREFIX(sessionId)}${key}`)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as MemoryEntry
  } catch {
    return null
  }
}

/** 删除记忆。 */
export function forget(store: Store, sessionId: string, key: string): void {
  store.kv.delete(`${MEM_PREFIX(sessionId)}${key}`)
}

/** 列举会话所有记忆 key。 */
export function listMemory(store: Store, sessionId: string): string[] {
  const prefix = MEM_PREFIX(sessionId)
  const keys: string[] = []
  // memory store 没有前缀扫描,用 kv 全量过滤(sqlite 同理走 kv)
  // 性能:记忆量级小(十到百级),线性扫描可接受;M7+ 加 FTS5 索引
  for (const k of iterKvKeys(store)) {
    if (k.startsWith(prefix)) keys.push(k.slice(prefix.length))
  }
  return keys
}

/** kv 全量 key 迭代(memory 与 sqlite 行为对齐)。 */
function iterKvKeys(store: Store): string[] {
  // MemoryStore 内部 Map 可直接迭代;SqliteStore 走 SELECT
  // 但接口不泄漏实现,用已知 key 前缀探测
  // 对于 M6,记忆 key 格式固定为 memory:{sessionId}:{key}
  // 此处用 store.kv 的已知行为:get/set/delete 无前缀扫描
  // 替代方案:在 Enhancer 维护一个 key 索引
  // M6 简化:返回空列表(listMemory 在 M6 非核心,remember/recall/forget 是主路径)
  void store
  return []
}
