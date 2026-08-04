// @tau/store - 单测:memory + sqlite 双驱动差分测试。
// sqlite 以 :memory: 模式运行(Bun 环境);vitest 环境自动跳过 sqlite 部分。

import { describe, expect, it } from "vitest"
import { MessageSchema, type Event, type Message } from "@tau/contract"
import { createStore, MemoryStore, SqliteStore, type Store } from "@tau/store"

const isBun = typeof Bun !== "undefined"

function message(id: string, role: "user" | "assistant" = "user"): Message {
  return MessageSchema.parse({ id, role, content: [{ type: "text", text: id }], createdAt: "t" })
}

/** 两种驱动都跑同一套断言(差分测试)。 */
function forDrivers(fn: (store: Store) => void): void {
  for (const { name, factory } of drivers()) {
    it(`${name}`, () => fn(factory()))
  }
}

function drivers(): { name: string; factory: () => Store }[] {
  const list: { name: string; factory: () => Store }[] = [
    { name: "memory", factory: () => createStore("memory") },
  ]
  if (isBun) {
    list.push({ name: "sqlite", factory: () => createStore("sqlite", ":memory:") })
  }
  return list
}

describe("store: createStore 驱动选择", () => {
  it("memory 驱动正常", () => {
    const store = createStore("memory")
    expect(store.driver).toBe("memory")
    expect(new MemoryStore()).toBeInstanceOf(MemoryStore)
  })

  it("sqlite 驱动可用(:memory:)", () => {
    if (!isBun) return // vitest 跳过
    const store = createStore("sqlite", ":memory:")
    expect(store.driver).toBe("sqlite")
  })

  it("未知驱动报错", () => {
    expect(() => createStore("redis" as never)).toThrow(/未知驱动/)
  })
})

describe("store: messages append/list/count/delete", () => {
  forDrivers((store) => {
    store.messages.append("s1", message("m1"))
    store.messages.append("s1", message("m2"))
    store.messages.append("s1", message("m3", "assistant"))
    expect(store.messages.count("s1")).toBe(3)
    const page = store.messages.list("s1", 1, 1)
    expect(page.messages.map((m) => m.id)).toEqual(["m2"])
    expect(page.total).toBe(3)
    store.messages.delete("s1", ["m2"])
    expect(store.messages.count("s1")).toBe(2)
    expect(store.messages.list("s1").messages.map((m) => m.id)).toEqual(["m1", "m3"])
  })
})

describe("store: events append/replay 隔离保序", () => {
  forDrivers((store) => {
    const e1: Event = { id: "e1", timestamp: "t", kind: "lifecycle", sessionId: "s1", state: "created" }
    const e2: Event = { id: "e2", timestamp: "t", kind: "lifecycle", sessionId: "s1", state: "active" }
    const other: Event = { id: "e3", timestamp: "t", kind: "lifecycle", sessionId: "s2", state: "created" }
    store.events.append("s1", e1)
    store.events.append("s1", e2)
    store.events.append("s2", other)
    expect(store.events.replay("s1").map((e) => e.id)).toEqual(["e1", "e2"])
    expect(store.events.count("s1")).toBe(2)
    expect(store.events.count("s2")).toBe(1)
  })
})

describe("store: sessions/kv/audit", () => {
  forDrivers((store) => {
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
})

describe("store: sessions.list 会话注册表(updatedAt 倒序,双驱动对齐)", () => {
  forDrivers((store) => {
    store.sessions.upsert({ sessionId: "old", epoch: 1, status: "active", transcriptCount: 0, createdAt: "t0", updatedAt: "2026-01-01T00:00:00.000Z" })
    store.sessions.upsert({ sessionId: "new", epoch: 2, status: "archived", transcriptCount: 5, createdAt: "t0", updatedAt: "2026-03-01T00:00:00.000Z" })
    store.sessions.upsert({ sessionId: "mid", epoch: 3, status: "active", transcriptCount: 2, createdAt: "t0", updatedAt: "2026-02-01T00:00:00.000Z" })
    expect(store.sessions.list().map((s) => s.sessionId)).toEqual(["new", "mid", "old"])
    expect(store.sessions.list(2).map((s) => s.sessionId)).toEqual(["new", "mid"])
    // 归档只改状态,不删记录(治理面不物理删)
    expect(store.sessions.list().find((s) => s.sessionId === "new")?.status).toBe("archived")
    // upsert 同 id 覆盖而非追加
    store.sessions.upsert({ sessionId: "old", epoch: 9, status: "closed", transcriptCount: 1, createdAt: "t0", updatedAt: "2026-04-01T00:00:00.000Z" })
    expect(store.sessions.list()).toHaveLength(3)
    expect(store.sessions.list()[0]?.sessionId).toBe("old")
  })
})

describe("store: kv.list 前缀枚举(双驱动对齐)", () => {
  forDrivers((store) => {
    store.kv.set("config:model", "gpt-5-mini")
    store.kv.set("config:autoApprove", "false")
    store.kv.set("usage:main", "{}")
    expect(store.kv.list("config:").map((e) => e.key)).toEqual(["config:autoApprove", "config:model"])
    expect(store.kv.list("config:").map((e) => e.value)).toEqual(["false", "gpt-5-mini"])
    expect(store.kv.list()).toHaveLength(store.driver === "sqlite" ? 4 : 3) // sqlite 多一条 schema_version
    expect(store.kv.list("不存在:")).toEqual([])
    // LIKE 通配符不被当作元字符
    store.kv.set("100%off", "x")
    expect(store.kv.list("100%").map((e) => e.key)).toEqual(["100%off"])
  })
})

describe("store: tx 与 migrate 幂等", () => {
  forDrivers((store) => {
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

describe("store: sqlite 持久化(文件)", () => {
  it("写入文件后重新打开,数据仍在", () => {
    if (!isBun) return
    const tmp = `/tmp/tau-store-test-${Date.now()}.sqlite`
    {
      const store = createStore("sqlite", tmp)
      store.kv.set("persisted", "yes")
      store.messages.append("s1", message("m1"))
      store.close?.()
    }
    {
      const store = createStore("sqlite", tmp)
      expect(store.kv.get("persisted")).toBe("yes")
      expect(store.messages.count("s1")).toBe(1)
      store.close?.()
    }
  })
})

describe("store: audit 归档(保留策略)", () => {
  it("旧审计记录归档不删历史", () => {
    if (!isBun) return
    const tmp = `/tmp/tau-audit-retention-${Date.now()}.sqlite`
    const store = createStore("sqlite", tmp)
    if (!(store instanceof SqliteStore)) return

    store.audit.append({ id: "a1", sessionId: "s1", timestamp: "2024-01-01T00:00:00Z", actor: "cli", action: "bash", detail: "old" })
    store.audit.append({ id: "a2", sessionId: "s1", timestamp: "2024-06-01T00:00:00Z", actor: "cli", action: "bash", detail: "mid" })
    store.audit.append({ id: "a3", sessionId: "s1", timestamp: "2025-01-01T00:00:00Z", actor: "cli", action: "bash", detail: "new" })

    // 归档 2024-06 之前的记录
    const archived = store.archiveAudit("s1", "2024-06-01T00:00:00Z")
    expect(archived).toBe(1)

    // audit 表只剩 2 条(a2, a3)
    const remaining = store.audit.query({ sessionId: "s1" })
    expect(remaining).toHaveLength(2)
    expect(remaining.map((a) => a.id)).not.toContain("a1")

    store.close?.()
  })
})
