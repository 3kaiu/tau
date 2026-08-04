// @tau/session — history.ts:历史窗口与摘要页管理。
// retention 分级(high 永不先丢 → normal → low);窗口规则是投影语义,截断由 session 执行。

import type { Message, Retention } from "@tau/contract"

/** 压缩候选顺序:low → normal → high 最后;同 retention 按时间正序(旧先丢)。 */
export function retentionOrder(messages: readonly Message[]): readonly Message[] {
  const rank: Record<Retention, number> = { low: 0, normal: 1, high: 2 }
  return [...messages].sort(
    (a, b) => rank[a.retention] - rank[b.retention] || a.createdAt.localeCompare(b.createdAt),
  )
}

/** 计算压缩丢弃集:保留 high 全部 + 最近 keepRecent 条;low/normal 先丢。 */
export function compactionCandidates(
  messages: readonly Message[],
  keepRecent: number,
): { drop: Message[]; keep: Message[] } {
  if (messages.length <= keepRecent) return { drop: [], keep: [...messages] }
  const ordered = retentionOrder(messages)
  const drop = new Set<Message>()
  const keep = new Set<Message>()
  for (const m of ordered) {
    if (m.retention === "high" || drop.size + keepRecent >= messages.length) keep.add(m)
    else drop.add(m)
  }
  return {
    drop: [...drop],
    keep: [...keep].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }
}
