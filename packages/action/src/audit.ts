// @tau/action — audit.ts:副作用审计日志(写入 + 查询)。
// 审计记录本身也是事件,进入 LLM 可查空间;敏感字段落盘脱敏。

import type { Store } from "@tau/store"
import type { AuditEntry, AuditQuery } from "@tau/store"

export type AuditRecord = {
  toolName: string
  argsSummary: string
  outcome: "ok" | "error" | "denied" | "pending" | "approved" | "rejected"
  durationMs: number
  approvedBy?: string
}

export function recordAudit(store: Store, sessionId: string, record: AuditRecord): void {
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    actor: record.approvedBy ?? "model",
    action: `${record.toolName}:${record.outcome}`,
    detail: record.argsSummary,
  }
  store.audit.append(entry)
}

export function queryAudit(store: Store, sessionId: string, query: AuditQuery = {}): readonly AuditEntry[] {
  return store.audit.query({ ...query, sessionId })
}
