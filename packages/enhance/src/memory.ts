// @tau/enhance - memory.ts:T2 记忆(syscall 后端)。
// 记忆是辅助不是主存:权威状态永远在 session;记忆只做检索增强。
// 存储 = store.kv(前缀 memory:{sessionId}:),量级小(十到百级),线性扫描 + 时间衰减排序足够,不引 FTS。

import type { Store } from "@tau/store"

const MEM_PREFIX = (sessionId: string) => `memory:${sessionId}:`

export type MemoryEntry = {
  key: string
  content: string
  createdAt: string
  updatedAt: string
}

export type MemoryScope = "session"

/** 写入/覆盖记忆。overwrite 缺省 false:已存在 key 拒绝覆盖(返回 false),防模型误覆盖;overwrite: true 才允许。 */
export function remember(store: Store, sessionId: string, key: string, content: string, opts: { overwrite?: boolean } = {}): boolean {
  const prefix = MEM_PREFIX(sessionId)
  const existing = store.kv.get(`${prefix}${key}`)
  if (existing !== null && opts.overwrite !== true) return false
  const now = new Date().toISOString()
  const entry: MemoryEntry = existing === null
    ? { key, content, createdAt: now, updatedAt: now }
    : { key, content, createdAt: (JSON.parse(existing) as MemoryEntry).createdAt, updatedAt: now }
  store.kv.set(`${prefix}${key}`, JSON.stringify(entry))
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

/** 列举会话所有记忆 key(按更新序倒序,最新在前;同刻按 key 倒序保持确定性)。 */
export function listMemory(store: Store, sessionId: string): readonly MemoryEntry[] {
  const prefix = MEM_PREFIX(sessionId)
  return store.kv
    .list(prefix)
    .map((e) => {
      try {
        return JSON.parse(e.value) as MemoryEntry
      } catch {
        return null
      }
    })
    .filter((e): e is MemoryEntry => e !== null)
    .sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.createdAt === b.createdAt
          ? b.key.localeCompare(a.key)
          : a.createdAt < b.createdAt
            ? 1
            : -1
        : a.updatedAt < b.updatedAt
          ? 1
          : -1,
    )
}

/**
 * 记忆检索:key/content 命中打分(key 命中权重高)+ 时间衰减(越新越靠前)。
 * 缺省上限 5 条(检索是辅助,不整包灌入);全量线性扫描,量级小可接受。
 */
export function searchMemories(
  store: Store,
  sessionId: string,
  query: string,
  opts: { limit?: number } = {},
): readonly MemoryEntry[] {
  const limit = opts.limit ?? 5
  const q = query.trim().toLowerCase()
  if (q === "") return []
  const now = Date.now()
  const hits: Array<{ entry: MemoryEntry; score: number }> = []
  for (const entry of listMemory(store, sessionId)) {
    const key = entry.key.toLowerCase()
    const content = entry.content.toLowerCase()
    let match = 0
    if (key.includes(q)) match += 3
    if (content.includes(q)) match += 1
    if (match === 0) continue
    const ageDays = Math.max(0, now - Date.parse(entry.updatedAt)) / 86_400_000
    const score = match / (1 + ageDays * 0.2)
    hits.push({ entry, score })
  }
  return hits
    .sort((a, b) => (b.score === a.score ? (a.entry.updatedAt < b.entry.updatedAt ? 1 : -1) : b.score - a.score))
    .slice(0, limit)
    .map((h) => h.entry)
}
