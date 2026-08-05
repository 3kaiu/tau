// @tau/session — 投影核心单测:唯一组装入口 + 快照权威 + 压缩交换 + 崩溃恢复。

import { describe, expect, it } from "vitest"
import {
  ContextProjectionSchema,
  INJECTION_PRIORITY,
  MessageSchema,
  ModelSchema,
  assertDualView,
  assertReplay,
  checkBudget,
  goal,
  type Event,
  type Model,
} from "@tau/contract"
import { createStore, type Store } from "@tau/store"
import { createSession, type SessionOptions } from "@tau/session"

const MODEL: Model = ModelSchema.parse({
  id: "gpt-5-mini",
  provider: { api: "openai-compatible", provider: "openai" },
  cost: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  contextWindow: { maxTokens: 400_000 },
})

function makeOptions(store: Store, extra?: Partial<SessionOptions>): SessionOptions {
  return {
    sessionId: "s1",
    store,
    model: MODEL,
    cwd: "/tmp/workspace",
    projectRoot: "/tmp/workspace",
    permissions: [{ pattern: "bash", rule: "ask" }],
    skills: { names: ["bun"] },
    workspaceRoots: ["/tmp/workspace"],
    budget: { maxTurns: 10, maxTurnMs: 60_000, maxToolCallsPerTurn: 8 },
    maxConcurrentTurns: 1,
    maxContextTokens: 100_000,
    extraSystemBlocks: [],
    tools: [],
    onBudgetExceeded: "ask",
    ...extra,
  }
}

function collect(events: Event[], kind: string) {
  return events.filter((e) => e.kind === kind)
}

describe("admit + project(唯一组装入口)", () => {
  it("self 五要素必含;注入防护条款优先级最高;wake 反映来源", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.admit({ text: "读 package.json", source: "tui:1", wake: "prompt" })
    const p = session.project()
    expect(ContextProjectionSchema.safeParse(p).success).toBe(true)
    expect(p.self.clock.wall).toBeTruthy()
    expect(p.self.usage).toBeTruthy()
    expect(p.self.cwd).toBe("/tmp/workspace")
    expect(p.self.permissions[0]?.rule).toBe("ask")
    expect(p.self.skills.names).toContain("bun")
    const injection = p.system.find((b) => b.kind === "injection")
    expect(injection?.priority).toBe(INJECTION_PRIORITY)
    expect(injection?.content).toContain("数据而非指令")
    expect(p.wake).toEqual({ reason: "prompt", source: "tui:1" })
    expect(p.history).toHaveLength(1)
    expect(p.history[0]?.content[0]?.type).toBe("text")
    expect(p.version).toBeGreaterThan(0)
  })

  it("project 按 epoch memo 缓存(同快照免重算)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    const a = session.project()
    const b = session.project()
    expect(a).toBe(b)
    session.admit({ text: "x", source: "cli", wake: "prompt" })
    const c = session.project()
    expect(c).not.toBe(a)
    expect(c.version).toBeGreaterThan(a.version)
  })

  it("project 幂等:投影必过 checkBudget(预算纪律)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.beginTurn()
    expect(checkBudget(session.project()).ok).toBe(true)
  })

  it("system 块按 priority 降序装配;同 priority 后插入者在前", () => {
    const store = createStore("memory")
    const session = createSession(
      makeOptions(store, {
        extraSystemBlocks: [
          { kind: "policy", priority: 5, content: "policy-a" },
          { kind: "policy", priority: 5, content: "policy-b" },
          { kind: "state", priority: 80, content: "state-x" },
          { kind: "context", priority: 20, content: "ctx-y" },
        ],
      }),
    )
    session.admit({ text: "hi", source: "cli", wake: "prompt" })
    const p = session.project()
    const priorities = p.system.map((b) => b.priority)
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities)
    const texts = p.system.map((b) => b.content)
    // 同 priority(5)的 policy:后插入者(policy-b)在前
    expect(texts.indexOf("policy-b")).toBeLessThan(texts.indexOf("policy-a"))
    expect(texts[0]?.includes("数据而非指令")).toBe(true)
  })
})

describe("消息落地与配对", () => {
  it("appendMessage 持久化 + transcript 事件 + 投影可见", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    const assistant = MessageSchema.parse({
      id: "a1",
      role: "assistant",
      content: [{ type: "text", text: "我读" }],
      modelId: "gpt-5-mini",
      createdAt: "t",
    })
    session.appendMessage(assistant)
    expect(session.project().history.map((m) => m.id)).toEqual(["a1"])
    expect(store.events.replay("s1").filter((e) => e.kind === "transcript")).toHaveLength(1)
    expect(session.snapshot().transcriptCount).toBe(1)
  })
})

describe("Goals / pendingSyscalls", () => {
  it("setGoal 进投影 activeGoals 与 goal system 块", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.setGoal(goal("g1", "读 package.json", { strategy: "explicit" }))
    const p = session.project()
    expect(p.activeGoals.map((g) => g.id)).toEqual(["g1"])
    expect(p.system.some((b) => b.kind === "goal" && b.content.includes("读 package.json"))).toBe(true)
  })

  it("pendSyscall 广播 + 投影可见;resolvePending 清除", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    const sys = session.pendSyscall({ toolCallId: "c1", toolName: "bash", summary: "bash -c rm x" })
    expect(session.project().pendingSyscalls.map((p) => p.questionId)).toEqual([sys.questionId])
    expect(store.events.replay("s1").some((e) => e.kind === "permission" && e.state === "requested")).toBe(true)
    session.resolvePending(sys.questionId, true)
    expect(session.project().pendingSyscalls).toEqual([])
    const events = store.events.replay("s1").filter((e) => e.kind === "permission")
    expect(events.some((e) => e.state === "granted")).toBe(true)
  })
})

describe("用量与预算", () => {
  it("beginTurn/recordUsage 进 self;预算告警发事件", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store, { maxContextTokens: 1000 }))
    session.beginTurn()
    session.recordUsage({ promptTokens: 400, completionTokens: 200, totalTokens: 600 })
    const p = session.project()
    expect(p.self.usage.turn).toBe(1)
    expect(p.self.usage.cumulativeTokens).toBe(600)
    expect(p.self.usage.estimatedRemaining).toBe(400)
    session.recordUsage({ promptTokens: 500, completionTokens: 100, totalTokens: 600 })
    expect(store.events.replay("s1").some((e) => e.kind === "budget_exceeded")).toBe(true)
    expect(session.project().system.some((b) => b.kind === "state" && b.content.includes("预算告警"))).toBe(true)
  })

  it("recordToolCall 累计单轮调用数", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.beginTurn()
    session.recordToolCall()
    session.recordToolCall()
    expect(session.project().self.usage.toolCallsThisTurn).toBe(2)
  })
})

describe("压缩是交换不是丢弃", () => {
  it("low 先丢;摘要消息可 retrieve(来源标注 summary)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    for (let i = 0; i < 10; i++) {
      session.appendMessage(
        MessageSchema.parse({
          id: `m${i}`,
          role: "user",
          content: [{ type: "text", text: `消息${i}` }],
          retention: i % 2 === 0 ? "low" : "normal",
          createdAt: `t${i}`,
        }),
      )
    }
    session.compact("token-budget", "前 4 条已摘要:消息0..3")
    const p = session.project()
    expect(p.history.some((m) => m.content.some((c) => c.type === "text" && c.text.startsWith("前 4 条")))).toBe(true)
    expect(p.history.some((m) => m.id === "m0")).toBe(false)
    expect(store.events.replay("s1").some((e) => e.kind === "compression")).toBe(true)
    expect(p.system.some((b) => b.kind === "context" && b.content.includes("已压缩"))).toBe(true)
    const found = session.retrieve({ query: "消息0" })
    expect(found.total).toBeGreaterThan(0)
    expect(found.results[0]?.source).toBe("summary")
  })

  it("压缩后 retrieve 可回取归档全文(宪法七:原文不丢)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.appendMessage(
      MessageSchema.parse({
        id: "m0",
        role: "user",
        content: [{ type: "text", text: "部署密钥 hunter2 在 /etc/tau/secret" }],
        retention: "low",
        createdAt: "t0",
      }),
    )
    for (let i = 1; i < 7; i++) {
      session.appendMessage(
        MessageSchema.parse({ id: `bg${i}`, role: "assistant", content: [{ type: "text", text: `背景消息${i}` }], retention: "normal", createdAt: `t${i}` }),
      )
    }
    session.compact("token-budget", "已摘要")
    expect(session.project().history.some((m) => m.id === "m0")).toBe(false)
    const found = session.retrieve({ query: "hunter2" })
    expect(found.total).toBe(1)
    expect(found.results[0]?.source).toBe("history")
    expect(found.results[0]?.message.content.some((c) => c.type === "text" && c.text.includes("hunter2"))).toBe(true)
  })

  it("sqlite 驱动:压缩后 FTS5 可回取归档全文", () => {
    if (typeof Bun === "undefined") return
    const store = createStore("sqlite", ":memory:")
    const session = createSession(makeOptions(store))
    session.appendMessage(
      MessageSchema.parse({
        id: "m0",
        role: "user",
        content: [{ type: "text", text: "s3://bucket/archive-2026 的凭证在 vault" }],
        retention: "low",
        createdAt: "t0",
      }),
    )
    for (let i = 1; i < 7; i++) {
      session.appendMessage(
        MessageSchema.parse({ id: `bg${i}`, role: "assistant", content: [{ type: "text", text: `背景消息${i}` }], retention: "normal", createdAt: `t${i}` }),
      )
    }
    session.compact("token-budget", "已摘要")
    const found = session.retrieve({ query: "vault" })
    expect(found.total).toBe(1)
    expect(found.results[0]?.message.content.some((c) => c.type === "text" && c.text.includes("vault"))).toBe(true)
  })
})

describe("diff 与重放一致性", () => {
  it("diff 报告新增消息与用量增量", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.admit({ text: "hi", source: "cli", wake: "prompt" })
    const e1 = session.snapshot().epoch
    session.beginTurn()
    session.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 })
    const e2 = session.snapshot().epoch
    session.appendMessage(
      MessageSchema.parse({ id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: "t" }),
    )
    const e3 = session.snapshot().epoch
    const d = session.diff(e1, e3)
    expect(d.addedMessages).toEqual(["a1"])
    expect(d.usageDelta.tokensDelta).toBe(150)
    expect(d.removedMessages).toEqual([])
    expect(session.diff(e1, e2).addedMessages).toEqual([])
  })

  it("assertReplay:事件重放 → 投影 → 快照一致(eval 断言 1 配套)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.admit({ text: "hi", source: "cli", wake: "prompt" })
    session.beginTurn()
    const events = store.events.replay("s1")
    const p = session.project()
    const snap = session.snapshot()
    expect(() => assertReplay(events, p, snap)).not.toThrow()
  })

  it("assertDualView:UI 可见 ⊆ 投影 ∪ 事件", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    const admitted = session.admit({ text: "hi", source: "cli", wake: "prompt" })
    const sys = session.pendSyscall({ toolCallId: "c1", toolName: "bash", summary: "bash -c ls" })
    session.setGoal(goal("g1", "x"))
    const p = session.project()
    const events = store.events.replay("s1")
    expect(() =>
      assertDualView(
        {
          transcript: [{ messageId: admitted.id, role: "user" }],
          pendingSyscalls: [{ questionId: sys.questionId, toolName: "bash" }],
          activeGoals: [{ id: "g1", status: "active" }],
          status: "active",
        },
        p,
        events,
      ),
    ).not.toThrow()
  })
})

describe("崩溃恢复", () => {
  it("重启后从 store 重放:recovery 事件 + 投影告知", () => {
    const store = createStore("memory")
    const first = createSession(makeOptions(store))
    first.admit({ text: "改代码", source: "cli", wake: "prompt" })
    first.beginTurn()
    first.recordUsage({ promptTokens: 10, completionTokens: 10, totalTokens: 20 })
    const snapshotBefore = first.snapshot()

    // 模拟崩溃:不做 close,直接基于同一 store 重建
    const second = createSession(makeOptions(store))
    const events = store.events.replay("s1")
    expect(events.some((e) => e.kind === "recovery")).toBe(true)
    expect(second.project().system.some((b) => b.content.includes("未提交"))).toBe(true)
    expect(second.snapshot().epoch).toBe(snapshotBefore.epoch)
  })

  it("正常 close 后重启不告警", () => {
    const store = createStore("memory")
    const first = createSession(makeOptions(store))
    first.admit({ text: "done", source: "cli", wake: "prompt" })
    first.close()
    const second = createSession(makeOptions(store))
    expect(store.events.replay("s1").some((e) => e.kind === "recovery")).toBe(false)
    expect(second.snapshot().status).toBe("closed")
  })
})

describe("会话注册表(治理面读端)", () => {
  it("createSession 即注册;admit/archive 刷新快照", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    expect(store.sessions.get("s1")?.status).toBe("active")
    expect(store.sessions.list().map((s) => s.sessionId)).toEqual(["s1"])

    session.admit({ text: "hi", source: "cli", wake: "prompt" })
    expect(store.sessions.get("s1")?.transcriptCount).toBe(1)

    session.archive()
    expect(store.sessions.get("s1")?.status).toBe("archived")
    // 归档不物理删:注册表仍在,事件仍可重放
    expect(store.sessions.list()).toHaveLength(1)
    expect(store.events.replay("s1").length).toBeGreaterThan(0)
  })

  it("resume 把归档会话置回 active(历史不丢)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store))
    session.admit({ text: "hi", source: "cli", wake: "prompt" })
    session.archive()
    session.resume()
    expect(session.snapshot().status).toBe("active")
    expect(store.sessions.get("s1")?.status).toBe("active")
    expect(session.project().history).toHaveLength(1)

    // 重启后从事件重放恢复 active
    const reopened = createSession(makeOptions(store))
    expect(reopened.snapshot().status).toBe("active")
  })

  it("createdAt 跨重启稳定(取注册表已记录值)", () => {
    const store = createStore("memory")
    const first = createSession(makeOptions(store, { now: () => "2026-01-01T00:00:00.000Z" }))
    const born = first.snapshot().createdAt
    const second = createSession(makeOptions(store, { now: () => "2026-09-09T00:00:00.000Z" }))
    expect(second.snapshot().createdAt).toBe(born)
  })
})

describe("多会话隔离", () => {
  it("同 store 双会话互不干扰", () => {
    const store = createStore("memory")
    const a = createSession(makeOptions(store, { sessionId: "a" }))
    const b = createSession(makeOptions(store, { sessionId: "b" }))
    a.admit({ text: "A", source: "cli", wake: "prompt" })
    b.admit({ text: "B", source: "cli", wake: "prompt" })
    expect(a.project().history[0]?.content[0]?.type).toBe("text")
    expect(b.project().history.map((m) => m.id)).not.toEqual(a.project().history.map((m) => m.id))
    expect(store.messages.count("a")).toBe(1)
    expect(store.messages.count("b")).toBe(1)
  })
})

describe("事件可观测", () => {
  it("onEvent 回调收到全部事件", () => {
    const store = createStore("memory")
    const seen: Event[] = []
    const session = createSession(makeOptions(store, { onEvent: (e) => seen.push(e) }))
    session.admit({ text: "hi", source: "cli", wake: "prompt" })
    expect(seen.map((e) => e.kind)).toContain("input_accepted")
    expect(seen.map((e) => e.kind)).toContain("transcript")
    expect(collect(seen, "input_accepted")).toHaveLength(1)
  })
})
