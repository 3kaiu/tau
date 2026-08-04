// @tau/session — epoch.ts:版本/上下文层级。
// epoch 单调递增;投影带版本,消费方(UI/评测)可对比;重放一致性断言点。

import type { KvTable } from "@tau/store"

const EPOCH_KEY = (sessionId: string) => `epoch:${sessionId}`

export class Epoch {
  readonly kv: KvTable
  readonly sessionId: string
  value: number

  constructor(kv: KvTable, sessionId: string, value: number) {
    this.kv = kv
    this.sessionId = sessionId
    this.value = value
  }

  static load(kv: KvTable, sessionId: string): Epoch {
    const raw = kv.get(EPOCH_KEY(sessionId))
    const value = raw === null ? 0 : Number(raw)
    return new Epoch(kv, sessionId, Number.isFinite(value) && value >= 0 ? value : 0)
  }

  get current(): number {
    return this.value
  }

  /** 状态变更后递增并落盘;返回新 epoch。 */
  bump(): number {
    const next = this.value + 1
    this.value = next
    this.kv.set(EPOCH_KEY(this.sessionId), String(next))
    return next
  }
}
