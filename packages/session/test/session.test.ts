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
import { createSession, runCompact, type SessionOptions } from "@tau/session"

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

  it("thinking 块超限截断 + 标记(缺省 32KB,可配)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store, { maxThinkingBytes: 50 }))
    const big = MessageSchema.parse({
      id: "t1",
      role: "assistant",
      content: [{ type: "thinking", text: "x".repeat(200) }],
      createdAt: "t",
    })
    session.appendMessage(big)
    const stored = store.messages.list("s1").messages[0]!
    const block = stored.content.find((b) => b.type === "thinking")
    expect(block?.type).toBe("thinking")
    if (block?.type === "thinking") {
      expect(block.text.length).toBeLessThanOrEqual(200)
      expect(block.text).toContain("(thinking 超限截断")
    }
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

  it("runCompact 独立编排:无候选不交换(null),有候选摘要进/全文出", () => {
    const store = createStore("memory")
    const events: Event[] = []
    const summaryIds: string[] = []
    const deps = {
      store,
      sessionId: "s1",
      messages: [],
      keepRecent: 6,
      reason: "token-budget",
      summaryText: "全部摘要",
      clockNow: () => "t",
      emit: (e: Event) => events.push(e),
      registerSummary: (id: string) => summaryIds.push(id),
      touch: () => {},
    }
    const none = runCompact(deps)
    expect(none).toBeNull()
    expect(events).toEqual([])

    for (let i = 0; i < 10; i++) {
      store.messages.append("s1", MessageSchema.parse({
        id: `m${i}`,
        role: "user",
        content: [{ type: "text", text: `消息${i}` }],
        retention: i % 2 === 0 ? "low" : "normal",
        createdAt: `t${i}`,
      }))
    }
    const summary = runCompact({ ...deps, messages: store.messages.list("s1").messages })
    expect(summary).not.toBeNull()
    expect(summary?.content[0]?.type).toBe("text")
    expect(events.some((e) => e.kind === "compression")).toBe(true)
    expect(summaryIds).toEqual([summary?.id])
    const live = store.messages.list("s1").messages
    expect(live.some((m) => m.id === "m0")).toBe(false)
    expect(live.some((m) => m.id === summary?.id)).toBe(true)
    expect(store.messages.archiveSearch("s1", "消息0", 0, 10).total).toBeGreaterThan(0)
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
  it("重启后从 store 重放:recovery 事件 + 投影告知(未提交 turn 的 syscall 清单)", () => {
    const store = createStore("memory")
    const first = createSession(makeOptions(store))
    first.admit({ text: "改代码", source: "cli", wake: "prompt" })
    first.beginTurn()
    first.recordUsage({ promptTokens: 10, completionTokens: 10, totalTokens: 20 })
    // 模拟崩溃前已执行但未提交的 syscall(审计带 turnId,无 commitTurn)
    store.audit.append({
      id: "aud-1",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      actor: "model",
      action: "write:ok",
      detail: "{\"name\":\"write\",\"args\":{\"path\":\"a.txt\"}}",
      turnId: "t7",
    })
    const snapshotBefore = first.snapshot()

    // 模拟崩溃:不做 close,直接基于同一 store 重建
    const second = createSession(makeOptions(store))
    const events = store.events.replay("s1")
    const recovery = events.find((e) => e.kind === "recovery")
    expect(recovery).toBeDefined()
    expect(recovery?.kind === "recovery" && recovery.detail?.includes("write")).toBe(true)
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

  it("已提交 turn 崩溃不误报(提交点锚定后无悬置)", () => {
    const store = createStore("memory")
    const first = createSession(makeOptions(store))
    first.admit({ text: "改代码", source: "cli", wake: "prompt" })
    store.audit.append({
      id: "aud-2",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      actor: "model",
      action: "write:ok",
      detail: "{\"name\":\"write\",\"args\":{\"path\":\"a.txt\"}}",
      turnId: "t9",
    })
    first.commitTurn("t9")

    const second = createSession(makeOptions(store))
    expect(store.events.replay("s1").some((e) => e.kind === "recovery")).toBe(false)
    expect(second.project().system.some((b) => b.content.includes("恢复告知"))).toBe(false)
  })

  it("旧数据(审计无 turnId)退回通用告警", () => {
    const store = createStore("memory")
    const first = createSession(makeOptions(store))
    first.admit({ text: "改代码", source: "cli", wake: "prompt" })
    store.audit.append({
      id: "aud-3",
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      actor: "model",
      action: "bash:ok",
      detail: "{\"name\":\"bash\",\"args\":{\"command\":\"make\"}}",
    })

    const second = createSession(makeOptions(store))
    const recovery = store.events.replay("s1").find((e) => e.kind === "recovery")
    expect(recovery).toBeDefined()
    expect(recovery?.kind === "recovery" && recovery.detail?.includes("未提交")).toBe(true)
    void second
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

describe("artifacts 大载荷外置(M10.3-b)", () => {
  it("appendMessage:text 块超阈值 → artifact 引用,正文存 store,投影与事件流只含引用", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store, { artifactThresholdBytes: 100 }))
    const big = "y".repeat(5_000)
    session.appendMessage({
      id: "m-art",
      role: "assistant",
      content: [
        { type: "text", text: "short" },
        { type: "text", text: big },
      ],
      toolCalls: [],
      toolResults: [],
      interrupted: false,
      source: "model",
      retention: "normal",
      createdAt: new Date().toISOString(),
    })

    const history = session.project().history
    const msg = history.find((m) => m.id === "m-art")
    expect(msg).toBeDefined()
    const blocks = msg?.content ?? []
    expect(blocks[0]?.type).toBe("text")
    expect(blocks[1]?.type).toBe("artifact")
    if (blocks[1]?.type === "artifact") {
      // 引用带 size/hash,正文不烧上下文
      expect(blocks[1].size).toBe(5_000)
      expect(blocks[1].hash).toBeDefined()
      const body = session.readArtifact(blocks[1].ref)
      expect(body?.body).toBe(big)
      expect(body?.hash).toBe(blocks[1].hash)
    }
    // 投影历史不含大载荷正文
    const serialized = JSON.stringify(history)
    expect(serialized).not.toContain(big)
    // 会话内引用枚举(不含正文)
    const metas = session.listArtifacts()
    expect(metas.length).toBe(1)
    expect(metas[0]?.size).toBe(5_000)
  })

  it("admit:用户输入超阈值同样外置(先落盘后响应,返回消息带引用)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store, { artifactThresholdBytes: 50 }))
    const big = "x".repeat(200)
    const admitted = session.admit({ text: big, source: "prompt", wake: "prompt" })
    expect(admitted.content[0]?.type).toBe("artifact")
    if (admitted.content[0]?.type === "artifact") {
      expect(session.readArtifact(admitted.content[0].ref)?.body).toBe(big)
    }
  })

  it("小文本块不外置(阈值内保持 inline)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store, { artifactThresholdBytes: 100 }))
    const small = "hello".repeat(10)
    session.appendMessage({
      id: "m-inline",
      role: "user",
      content: [{ type: "text", text: small }],
      toolCalls: [],
      toolResults: [],
      interrupted: false,
      source: "prompt",
      retention: "high",
      createdAt: new Date().toISOString(),
    })
    const msg = session.project().history.find((m) => m.id === "m-inline")
    expect(msg?.content[0]?.type).toBe("text")
    expect(session.listArtifacts().length).toBe(0)
  })

  it("purgeArtifact 删除正文(引用失效,读回 null)", () => {
    const store = createStore("memory")
    const session = createSession(makeOptions(store, { artifactThresholdBytes: 10 }))
    session.appendMessage({
      id: "m-purge",
      role: "assistant",
      content: [{ type: "text", text: "p".repeat(200) }],
      toolCalls: [],
      toolResults: [],
      interrupted: false,
      source: "model",
      retention: "normal",
      createdAt: new Date().toISOString(),
    })
    const ref = session.listArtifacts()[0]?.ref
    expect(ref).toBeDefined()
    expect(session.readArtifact(ref!)).not.toBeNull()
    session.purgeArtifact(ref!)
    expect(session.readArtifact(ref!)).toBeNull()
  })
})

describe("tier 规则工具注入裁剪(M10.3-e)", () => {
  const tools = [
    { name: "read", description: "r", parameters: {}, tier: "T0" as const, dangerous: false },
    { name: "grep", description: "g", parameters: {}, tier: "T1" as const, dangerous: false },
    { name: "find", description: "f", parameters: {}, tier: "T1" as const, dangerous: false },
    { name: "tool:catalog", description: "c", parameters: {}, tier: "T0" as const, dangerous: false },
  ]

  function sessionWithRules(rules: { overrides?: Record<string, "T0" | "T1">; defaultTier?: "T0" | "T1" }) {
    const store = createStore("memory")
    return createSession(
      makeOptions(store, {
        tools,
        toolTierRules: { defaultTier: rules.defaultTier ?? "T1", overrides: rules.overrides ?? {} },
      }),
    )
  }

  it("提供 tier 规则时:T0 常驻,T1 缺省不进投影,override 可强制提升", () => {
    const session = sessionWithRules({ overrides: { read: "T0" } })
    const names = session.project().tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("tool:catalog")
    expect(names).not.toContain("grep")
    expect(names).not.toContain("find")
  })

  it("requestTools 按需注入 T1(本 turn 生效);beginTurn 重置", () => {
    const session = sessionWithRules({})
    expect(session.project().tools.map((t) => t.name)).not.toContain("grep")

    session.requestTools(["grep"])
    const after = session.project().tools.map((t) => t.name)
    expect(after).toContain("grep")
    expect(after).not.toContain("find")

    session.beginTurn()
    expect(session.project().tools.map((t) => t.name)).not.toContain("grep")
  })

  it("requestTools 对 T0 与未知名是 no-op;无 tier 规则时 requestTools 无副作用", () => {
    const session = sessionWithRules({})
    session.requestTools(["read", "nonexistent", "tool:catalog"])
    const names = session.project().tools.map((t) => t.name)
    expect(names.filter((n) => !["read", "tool:catalog"].includes(n))).toEqual([])

    const store = createStore("memory")
    const plain = createSession(makeOptions(store, { tools }))
    plain.requestTools(["grep"])
    const all = plain.project().tools.map((t) => t.name)
    expect(all).toContain("grep")
    expect(all.length).toBe(4)
  })
})
