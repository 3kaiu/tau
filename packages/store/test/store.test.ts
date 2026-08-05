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

describe("store: messages.search 全文检索(双驱动对齐,AND 语义)", () => {
  forDrivers((store) => {
    const m1 = MessageSchema.parse({ id: "m1", role: "user", content: [{ type: "text", text: "什么是 FTS5 全文索引" }], createdAt: "t" })
    const m2 = MessageSchema.parse({ id: "m2", role: "assistant", content: [{ type: "text", text: "SQLite 的全文索引用于检索" }], createdAt: "t" })
    const m3 = MessageSchema.parse({ id: "m3", role: "assistant", content: [{ type: "text", text: "无关话题" }], createdAt: "t" })
    const m4 = MessageSchema.parse({ id: "m4", role: "assistant", toolCalls: [{ id: "c1", name: "bash", arguments: {} }], content: [], createdAt: "t" })
    store.messages.append("s1", m1)
    store.messages.append("s1", m2)
    store.messages.append("s1", m3)
    store.messages.append("s1", m4)
    expect(store.messages.search("s1", "全文").messages.map((m) => m.id)).toEqual(["m1", "m2"])
    expect(store.messages.search("s1", "全文 检索").messages.map((m) => m.id)).toEqual(["m2"])
    expect(store.messages.search("s1", "bash").messages.map((m) => m.id)).toEqual(["m4"])
    expect(store.messages.search("s1", "不存在词").messages).toHaveLength(0)
    const page = store.messages.search("s1", "全文", 1, 1)
    expect(page.messages.map((m) => m.id)).toEqual(["m2"])
    expect(page.total).toBe(2)
    // 删除后索引同步
    store.messages.delete("s1", ["m2"])
    expect(store.messages.search("s1", "全文").messages.map((m) => m.id)).toEqual(["m1"])
    // 会话隔离
    expect(store.messages.search("s2", "全文").messages).toHaveLength(0)
  })
})

describe("store: audit.query 排序对齐(timestamp DESC,最新在前)", () => {
  forDrivers((store) => {
    store.audit.append({ id: "a1", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", actor: "model", action: "bash:ok", detail: "ls" })
    store.audit.append({ id: "a2", sessionId: "s1", timestamp: "2026-03-01T00:00:00Z", actor: "model", action: "bash:ok", detail: "pwd" })
    store.audit.append({ id: "a3", sessionId: "s1", timestamp: "2026-02-01T00:00:00Z", actor: "cli", action: "prompt:ok", detail: "hi" })
    // 乱序插入也要按 timestamp DESC
    expect(store.audit.query({ sessionId: "s1" }).map((a) => a.id)).toEqual(["a2", "a3", "a1"])
    expect(store.audit.query({ sessionId: "s1", limit: 2 }).map((a) => a.id)).toEqual(["a2", "a3"])
  })
})

describe("store: audit turnId 往返(双驱动,recovery 悬置判定输入)", () => {
  forDrivers((store) => {
    store.audit.append({ id: "a1", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z", actor: "model", action: "read:ok", detail: "{}", turnId: "t5" })
    store.audit.append({ id: "a2", sessionId: "s1", timestamp: "2026-02-01T00:00:00Z", actor: "model", action: "write:ok", detail: "{}" })
    const rows = store.audit.query({ sessionId: "s1" })
    expect(rows.find((a) => a.id === "a1")?.turnId).toBe("t5")
    expect(rows.find((a) => a.id === "a2")?.turnId).toBeUndefined()
  })
})

describe("store: sqlite 慢查询日志按阈值输出", () => {
  it("超阈值的语句触发 logger,不超阈值不触发", () => {
    if (!isBun) return
    const logs: { sql: string; ms: number }[] = []
    const store = new SqliteStore(":memory:", {
      slowQueryThresholdMs: 0,
      slowQueryLogger: (sql, ms) => logs.push({ sql, ms }),
    })
    store.kv.set("k", "v")
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]?.sql).toContain("kv")
    // 无阈值选项时默认不包
    const plain = new SqliteStore(":memory:")
    expect(() => plain.kv.set("k2", "v2")).not.toThrow()
    plain.close?.()
  })

  it("搜索在持久化文件上可用(迁移 v3)", () => {
    if (!isBun) return
    const tmp = `/tmp/tau-fts-${Date.now()}.sqlite`
    {
      const store = new SqliteStore(tmp)
      store.messages.append("s1", MessageSchema.parse({ id: "m1", role: "user", content: [{ type: "text", text: "第一轮对话" }], createdAt: "t" }))
      store.close?.()
    }
    {
      const store = new SqliteStore(tmp)
      expect(store.messages.search("s1", "第一轮").messages.map((m) => m.id)).toEqual(["m1"])
      store.close?.()
    }
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

  it("单写者锁:第二写者明确错误;close 后释放;崩溃残留接管", () => {
    if (!isBun) return
    const tmp = `/tmp/tau-store-lock-${Date.now()}.sqlite`
    const first = createStore("sqlite", tmp)
    expect(() => createStore("sqlite", tmp)).toThrow(/独占|持有/)
    expect(() => createStore("sqlite", tmp, { readonly: true })).not.toThrow()
    first.close?.()
    const reopened = createStore("sqlite", tmp)
    expect(reopened).toBeInstanceOf(SqliteStore)
    reopened.close?.()
    const store = createStore("sqlite", tmp)
    store.close?.()
    // 崩溃残留:锁文件含已死 pid → 接管成功
    const { writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs")
    writeFileSync(`${tmp}.lock`, "99999999")
    const store2 = createStore("sqlite", tmp)
    expect(store2).toBeInstanceOf(SqliteStore)
    store2.close?.()
    rmSync(`${tmp}.lock`, { force: true })
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

describe("store: artifacts 大载荷表(双驱动对齐)", () => {
  forDrivers((store) => {
    store.artifacts.put({ ref: "art-1", sessionId: "s1", size: 5, hash: "h1", body: "hello", createdAt: "t1" })
    store.artifacts.put({ ref: "art-2", sessionId: "s1", mime: "text/plain", size: 3, hash: "h2", body: "big", createdAt: "t2" })
    store.artifacts.put({ ref: "art-3", sessionId: "s2", size: 1, hash: "h3", body: "x", createdAt: "t3" })

    const got = store.artifacts.get("art-1")
    expect(got).not.toBeNull()
    expect(got?.body).toBe("hello")
    expect(got?.hash).toBe("h1")
    expect(got?.mime).toBeUndefined()
    expect(store.artifacts.get("art-2")?.mime).toBe("text/plain")

    // 覆盖写(同 ref 更新)
    store.artifacts.put({ ref: "art-1", sessionId: "s1", size: 11, hash: "h1b", body: "hello world", createdAt: "t4" })
    expect(store.artifacts.get("art-1")?.body).toBe("hello world")

    // 会话内枚举不含正文(引用级),ref 升序
    const metas = store.artifacts.list("s1")
    expect(metas.map((m) => m.ref)).toEqual(["art-1", "art-2"])
    expect(metas[0]?.size).toBe(11)
    expect(metas[0]?.mime).toBeUndefined()
    expect(metas[1]?.mime).toBe("text/plain")

    // delete
    store.artifacts.delete("art-2")
    expect(store.artifacts.get("art-2")).toBeNull()
  })
})

describe("store: artifacts sqlite 持久化(文件)", () => {
  it("写库后重开可读回", () => {
    if (!isBun) return
    const tmp = `/tmp/tau-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    const store = createStore("sqlite", tmp)
    store.artifacts.put({ ref: "art-p", sessionId: "s1", size: 4, hash: "h", body: "persist", createdAt: "t" })
    store.close?.()

    const reopened = createStore("sqlite", tmp)
    expect(reopened.artifacts.get("art-p")?.body).toBe("persist")
    expect(reopened.artifacts.list("s1").map((m) => m.ref)).toEqual(["art-p"])
    reopened.close?.()
    // 清理临时库
    try { Bun.file(tmp).delete(); Bun.file(`${tmp}-wal`).delete(); Bun.file(`${tmp}-shm`).delete() } catch { /* ignore */ }
  })
})
