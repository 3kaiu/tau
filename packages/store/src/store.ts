// @tau/store — Store 接口 + 聚合。
// 会话数据的唯一持久化层;接口不泄漏实现,sqlite/memory 切换对上层零感知。

import type { Event, Message, SessionSnapshot } from "@tau/contract"

export type StoreMessage = Message
export type StoreEvent = Event

export type MessagePage = {
  messages: readonly Message[]
  total: number
  offset: number
}

export type AuditEntry = {
  id: string
  sessionId: string
  timestamp: string
  actor: string
  action: string
  detail: string
  /** 所属 turn(提交点边界由 orchestrate 在 turn 尾部 commitTurn 写入);recovery 悬置判定以此为输入。 */
  turnId?: string
}

export type AuditQuery = {
  sessionId?: string
  actor?: string
  limit?: number
}

export interface SessionTable {
  upsert(snapshot: SessionSnapshot): void
  get(sessionId: string): SessionSnapshot | null
  /** 会话注册表:按 updatedAt 倒序列出(治理面读端;两驱动行为逐项对齐)。 */
  list(limit?: number): readonly SessionSnapshot[]
}

export interface MessageTable {
  append(sessionId: string, message: Message): void
  list(sessionId: string, offset?: number, limit?: number): MessagePage
  count(sessionId: string): number
  delete(sessionId: string, messageIds: readonly string[]): void
  /** 全文检索:query 按空白分词,AND 语义(所有词命中);走 FTS5(sqlite)/线性过滤(memory)。 */
  search(sessionId: string, query: string, offset?: number, limit?: number): MessagePage
  /** 压缩交换:全文移入归档区(仍可检索,不再进投影历史)。宪法七:全文永远可 retrieve 回来。 */
  archive(sessionId: string, messageIds: readonly string[]): void
  /** 只检索归档区(压缩交换的全文回取通道)。 */
  archiveSearch(sessionId: string, query: string, offset?: number, limit?: number): MessagePage
}

/** 查询词规范:与索引文本同规范(CJK 逐字空格化)。 */
export function normalizeSearchQuery(query: string): string {
  return spaceCjk(query.trim())
}

/**
 * CJK 逐字空格化:FTS5 unicode61 把连续 CJK 当单一 token,逐字分词后
 * 单字序列 = token 序列,"全 文" 短语与子串检索语义对齐(memory includes 同规范)。
 * 范围:统一表意 + 扩展 A + 兼容表意。
 */
export function spaceCjk(s: string): string {
  return s.replace(/([\u3400-\u9fff\uf900-\ufaff])/g, " $1 ").replace(/\s+/g, " ").trim()
}

/** 检索索引文本:提取 message 中可检索的纯文本(FTS5 与 memory 过滤共用同一提取)。 */
export function extractSearchText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === "text" && block.text !== "") parts.push(block.text)
  }
  for (const call of message.toolCalls) {
    parts.push(call.name)
  }
  return spaceCjk(parts.join("\n"))
}

export interface EventTable {
  append(sessionId: string, event: Event): void
  replay(sessionId: string): readonly Event[]
  count(sessionId: string): number
}

export interface AuditTable {
  append(entry: AuditEntry): void
  query(query: AuditQuery): readonly AuditEntry[]
}

export type KvEntry = { key: string; value: string }

export interface KvTable {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  /** 按前缀枚举(key 升序)。配置面读端;前缀为空即全表。 */
  list(prefix?: string): readonly KvEntry[]
}

/** artifact 记录:正文存 store,历史仅引用(大载荷不烧上下文)。 */
export type ArtifactRecord = {
  ref: string
  sessionId: string
  mime?: string
  size: number
  hash: string
  body: string
  createdAt: string
}

/** artifact 目录条目(引用枚举,不含正文)。 */
export type ArtifactMeta = {
  ref: string
  mime?: string
  size: number
  hash: string
}

export interface ArtifactTable {
  put(record: ArtifactRecord): void
  get(ref: string): ArtifactRecord | null
  delete(ref: string): void
  /** 会话内引用枚举(ref 升序)。 */
  list(sessionId: string): readonly ArtifactMeta[]
}

export interface Store {
  readonly driver: "sqlite" | "memory"
  sessions: SessionTable
  messages: MessageTable
  events: EventTable
  audit: AuditTable
  kv: KvTable
  artifacts: ArtifactTable
  tx<T>(work: () => T): T
  migrate(): void
  /** 关闭底层连接(memory 无操作;sqlite 释放文件句柄)。 */
  close?: () => void
}
