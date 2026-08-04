// @tau/store — 单测:memory 驱动接口行为(与 sqlite 的差分测试兜底在 eval)。

import { describe, expect, it } from "vitest"
import { MessageSchema, type Event, type Message } from "@tau/contract"
import { createStore, MemoryStore } from "@tau/store"

function message(id: string, role: "user" | "assistant" = "user"): Message {
  return MessageSchema.parse({ id, role, content: [{ type: "text", text: id }], createdAt: "t" })
}

describe("memory store", () => {
  it("createStore 只发布 memory;sqlite 明确报错", () => {
    const store = createStore("memory")
    expect(store.driver).toBe("memory")
    expect(() => createStore("sqlite")).toThrow(/M4/)
    expect(new MemoryStore()).toBeInstanceOf(MemoryStore)
  })

  it("messages:append/list 分页/count", () => {
    const store = createStore("memory")
    store.messages.append("s1", message("m1"))
    store.messages.append("s1", message("m2"))
    store.messages.append("s1", message("m3", "assistant"))
    expect(store.messages.count("s1")).toBe(3)
    const page = store.messages.list("s1", 1, 1)
    expect(page.messages.map((m) => m.id)).toEqual(["m2"])
    expect(page.total).toBe(3)
  })

  it("events:append/replay 按会话隔离、保序", () => {
    const store = createStore("memory")
    const e1: Event = { id: "e1", timestamp: "t", kind: "lifecycle", sessionId: "s1", state: "created" }
    const e2: Event = { id: "e2", timestamp: "t", kind: "lifecycle", sessionId: "s1", state: "active" }
    const other: Event = { id: "e3", timestamp: "t", kind: "lifecycle", sessionId: "s2", state: "created" }
    store.events.append("s1", e1)
    store.events.append("s1", e2)
    store.events.append("s2", other)
    expect(store.events.replay("s1").map((e) => e.id)).toEqual(["e1", "e2"])
    expect(store.events.count("s1")).toBe(2)
  })

  it("sessions:upsert/get;kv:get/set/delete;audit:query 过滤", () => {
    const store = createStore("memory")
    store.sessions.upsert({ sessionId: "s1", epoch: 3, status: "active", transcriptCount: 2, createdAt: "t", updatedAt: "t" })
    expect(store.sessions.get("s1")?.epoch).toBe(3)
    expect(store.sessions.get("s2")).toBeNull()
    store.kv.set("k", "v")
    expect(store.kv.get("k")).toBe("v")
    store.kv.delete("k")
    expect(store.kv.get("k")).toBeNull()
    store.audit.append({ id: "a1", sessionId: "s1", timestamp: "t", actor: "cli", action: "bash", detail: "ls" })
    store.audit.append({ id: "a2", sessionId: "s2", timestamp: "t", actor: "cli", action: "bash", detail: "rm" })
    expect(store.audit.query({ sessionId: "s1" }).map((a) => a.id)).toEqual(["a1"])
    expect(store.audit.query({ actor: "cli" })).toHaveLength(2)
  })

  it("tx 批量语义与 migrate 幂等", () => {
    const store = createStore("memory")
    const result = store.tx(() => {
      store.kv.set("a", "1")
      return 42
    })
    expect(result).toBe(42)
    expect(store.kv.get("a")).toBe("1")
    store.migrate()
    store.migrate()
  })
})
