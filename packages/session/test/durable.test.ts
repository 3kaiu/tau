// @tau/session - 断点续跑测试:SQLite 文件持久化 + 崩溃恢复。
// M4 出口标准:进程"崩溃"后重启,从同一 SQLite 文件恢复会话状态。

import { describe, expect, it } from "vitest"
import { MessageSchema, type Message } from "@tau/contract"
import { createSession, type Session } from "../src/index.ts"
import { createStore, type Store } from "@tau/store"

const isBun = typeof Bun !== "undefined"

function makeMessage(id: string, role: "user" | "assistant" = "user", text = id): Message {
  return MessageSchema.parse({
    id, role,
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  })
}

function createSessionWith(store: Store, sessionId: string): Session {
  return createSession({
    sessionId,
    store,
    cwd: "/tmp",
    now: () => new Date().toISOString(),
    monotonic: () => Date.now(),
  })
}

describe.skipIf(!isBun)("断点续跑:SQLite 持久化 + 崩溃恢复", () => {
  it("写入消息后重启,消息与 epoch 恢复", () => {
    const tmp = `/tmp/tau-durable-${Date.now()}.sqlite`
    const sessionId = "test-resume"

    // 第一次启动:写入数据后模拟崩溃(不 close session,只关 store)
    {
      const store = createStore("sqlite", tmp)
      const session = createSessionWith(store, sessionId)

      session.admit({ text: "hello", source: "test", wake: "prompt" })
      session.appendMessage(makeMessage("a1", "assistant", "hi there"))
      session.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 })
      // 模拟崩溃前已执行但未提交的 syscall(审计带 turnId,无 commitTurn)
      store.audit.append({
        id: "aud-crash",
        sessionId,
        timestamp: new Date().toISOString(),
        actor: "model",
        action: "write:ok",
        detail: "{\"name\":\"write\",\"args\":{\"path\":\"out.txt\"}}",
        turnId: "t5",
      })

      store.close?.()
    }

    // 第二次启动:从同一文件恢复
    {
      const store = createStore("sqlite", tmp)
      const session = createSessionWith(store, sessionId)

      // 消息恢复
      const history = session.project().history
      expect(history.length).toBeGreaterThanOrEqual(2)
      expect(history.map((m) => m.id)).toContain("a1")

      // recovery 事件发出(模型可见),detail 带未提交 syscall 清单(turnId 判定,非瞎猜)
      const events = store.events.replay(sessionId)
      const recovery = events.find((e) => e.kind === "recovery")
      expect(recovery).toBeDefined()
      expect(recovery?.kind === "recovery" && recovery.detail?.includes("write")).toBe(true)

      // 投影含 recovery 告警
      const proj = session.project()
      const hasRecoveryBlock = proj.system.some(
        (b) => b.kind === "state" && b.content.includes("恢复告知"),
      )
      expect(hasRecoveryBlock).toBe(true)

      // epoch 恢复(非 0)
      expect(proj.version).toBeGreaterThan(0)

      store.close?.()
    }
  })

  it("正常 close 后重启不告警", () => {
    const tmp = `/tmp/tau-durable-close-${Date.now()}.sqlite`
    const sessionId = "test-close"

    {
      const store = createStore("sqlite", tmp)
      const session = createSessionWith(store, sessionId)
      session.admit({ text: "work", source: "test", wake: "prompt" })
      session.close()
      store.close?.()
    }

    {
      const store = createStore("sqlite", tmp)
      createSessionWith(store, sessionId)

      const events = store.events.replay(sessionId)
      const hasRecovery = events.some((e) => e.kind === "recovery")
      expect(hasRecovery).toBe(false)

      store.close?.()
    }
  })

  it("多会话隔离:同一 SQLite 文件,两会话互不干扰", () => {
    const tmp = `/tmp/tau-durable-multi-${Date.now()}.sqlite`

    {
      const store = createStore("sqlite", tmp)
      const s1 = createSessionWith(store, "multi-1")
      const s2 = createSessionWith(store, "multi-2")

      s1.admit({ text: "session 1", source: "test", wake: "prompt" })
      s2.admit({ text: "session 2", source: "test", wake: "prompt" })
      s1.appendMessage(makeMessage("s1-a", "assistant", "reply 1"))
      s2.appendMessage(makeMessage("s2-a", "assistant", "reply 2"))

      store.close?.()
    }

    {
      const store = createStore("sqlite", tmp)
      const s1 = createSessionWith(store, "multi-1")
      const s2 = createSessionWith(store, "multi-2")

      expect(s1.project().history.map((m) => m.id)).toContain("s1-a")
      expect(s2.project().history.map((m) => m.id)).toContain("s2-a")
      expect(s1.project().history.map((m) => m.id)).not.toContain("s2-a")
      expect(s2.project().history.map((m) => m.id)).not.toContain("s1-a")

      store.close?.()
    }
  })

  it("kv 持久化:usage 跨重启恢复", () => {
    const tmp = `/tmp/tau-durable-kv-${Date.now()}.sqlite`
    const sessionId = "test-kv"

    {
      const store = createStore("sqlite", tmp)
      const session = createSessionWith(store, sessionId)

      session.admit({ text: "track usage", source: "test", wake: "prompt" })
      session.beginTurn()
      session.recordUsage({ promptTokens: 500, completionTokens: 200, totalTokens: 700 })
      session.recordToolCall()

      store.close?.()
    }

    {
      const store = createStore("sqlite", tmp)
      const session = createSessionWith(store, sessionId)

      const proj = session.project()
      expect(proj.self.usage.promptTokens).toBe(500)
      expect(proj.self.usage.completionTokens).toBe(200)
      expect(proj.self.usage.turn).toBeGreaterThanOrEqual(1)

      store.close?.()
    }
  })
})
