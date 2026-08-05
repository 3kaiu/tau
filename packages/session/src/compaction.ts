// @tau/session — compaction.ts:交换策略(触发候选 + 摘要交换执行)。
// 交换 = "摘要进历史、全文移归档";不删用户意图、不裁工具定义。摘要文本由调用方
// (enhance 策略)产出,本文件只做交换编排。

import type { Event, Message } from "@tau/contract"
import type { Store } from "@tau/store"
import { compactionCandidates } from "./history.ts"

export type CompactDeps = {
  store: Store
  sessionId: string
  messages: readonly Message[]
  keepRecent: number
  reason: string
  summaryText: string
  clockNow: () => string
  emit: (event: Event) => void
  /** 记录摘要 id(摘要化消息清单,投影告警块据此生成)。 */
  registerSummary: (summaryId: string) => void
  touch: () => void
}

/**
 * 执行压缩交换:预算内无丢弃 → 返回 null;否则摘要进历史、全文移归档,
 * 发 compression + transcript 事件并 touch。不抛错。
 */
export function runCompact(deps: CompactDeps): Message | null {
  const { drop, keep } = compactionCandidates(deps.messages, deps.keepRecent)
  void keep
  if (drop.length === 0) return null
  const summary: Message = {
    id: crypto.randomUUID(),
    role: "system",
    content: [{ type: "text", text: deps.summaryText }],
    toolCalls: [],
    toolResults: [],
    interrupted: false,
    retention: "high",
    source: "compaction",
    createdAt: deps.clockNow(),
  }
  const droppedIds = drop.map((m) => m.id)
  // 压缩交换:全文移入归档区(仍可经 retrieve 检索回取),摘要进历史——宪法七不破坏
  deps.store.messages.archive(deps.sessionId, droppedIds)
  deps.registerSummary(summary.id)
  deps.store.messages.append(deps.sessionId, summary)
  deps.emit({
    id: crypto.randomUUID(),
    timestamp: deps.clockNow(),
    redact: [],
    kind: "compression",
    droppedIds,
    strategy: deps.reason,
  })
  deps.emit({ id: crypto.randomUUID(), timestamp: deps.clockNow(), redact: [], kind: "transcript", message: summary })
  deps.touch()
  return summary
}