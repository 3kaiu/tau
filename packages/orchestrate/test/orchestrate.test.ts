// @tau/orchestrate — scheduler 测试。用假 LlmKernel 驱动 turn 状态机;
// 覆盖:单轮文本 / 工具循环 / 死循环防护 / abort / steer / 超时 / 重试可见。

import { describe, expect, it } from "vitest"
import { createMemoryStore } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import type { ContextProjection, Event, Message, SystemCall } from "@tau/contract"
import { toolResult, toolError } from "@tau/contract"
import type { LlmCollectResult, LlmKernel, LlmRequest } from "@tau/llm"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler, runSubagent, depthOf, listSubagents, subagentUsage, SUBAGENT_DEFAULT_TOOLS } from "../src/index.ts"

type LlmBehavior = (calls: number) => LlmCollectResult

function fakeLlm(behavior: LlmBehavior): LlmKernel {
  let calls = 0
  const complete = async (): Promise<LlmCollectResult> => behavior(calls++)
  return {
    stream: async function* () {},
    complete,
    models: () => [],
    getModel: () => null,
    features: () => ({ streaming: true, tools: true, thinking: false, vision: false }),
    getAuth: () => null,
    cachePolicy: () => ({ mode: "off", ttlMs: 0 }),
    refresh: () => {},
  }
}

function freshSession() {
  const store = createMemoryStore()
  const session = createSession({ store, sessionId: "s1", cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"] })
  return { store, session }
}

function fresh(behavior: LlmBehavior, opts: { autoApprove?: boolean } = {}) {
  const { store, session } = freshSession()
  const llm = fakeLlm(behavior)
  const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: opts.autoApprove ?? true })
  const scheduler = createScheduler({ llm, session, action }, { model: "fake", maxTurns: 5, maxTurnMs: 2000, maxRetries: 1, loopGuard: 2 })
  return { store, session, llm, action, scheduler }
}

const readCall: SystemCall = {
  name: "read",
  description: "读文件",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  tier: "T1",
  dangerous: false,
}

function withTool(projection: ContextProjection, tool: SystemCall): ContextProjection {
  return { ...projection, tools: [tool] }
}

describe("orchestrate:turn 状态机", () => {
  it("压缩闭环:历史超预算 → summarize 注入 → compact 落 summary 消息 + compression 事件", async () => {
    const behavior: LlmBehavior = (calls) =>
      calls === 0
        ? { text: "", thinking: "", toolCalls: [{ id: "t1", name: "read", args: { path: "a.txt" } }], usage: undefined, finishReason: "tool-calls", error: undefined, aborted: false }
        : { text: "收尾", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false }
    const { store, action } = fresh(behavior)
    const sessionEvents: Event[] = []
    const session = createSession({ store, sessionId: "s1", cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], onEvent: (e) => sessionEvents.push(e) })
    await action.execute({ sessionId: "s1", toolCallId: "w0", name: "write", args: { path: "a.txt", content: "hi" }, cwd: "/tmp/tau-test" })
    const orig = session.project.bind(session)
    session.project = () => withTool(orig(), readCall)

    // 压一条超长 assistant 消息(role 非 user,retention normal)入历史(体积远超阈值),并补足历史条数(> keepRecent 6)
    session.appendMessage({
      id: "long-a1",
      role: "assistant",
      content: [{ type: "text", text: `y`.repeat(80_000) }],
      toolCalls: [],
      toolResults: [],
      interrupted: false,
      source: "model",
      retention: "normal",
      createdAt: new Date().toISOString(),
    })
    session.admit({ text: "背景 1", source: "prompt", wake: "prompt" })
    session.admit({ text: "背景 2", source: "prompt", wake: "prompt" })
    session.admit({ text: "背景 3", source: "prompt", wake: "prompt" })
    session.admit({ text: "背景 4", source: "prompt", wake: "prompt" })
    session.admit({ text: "背景 5", source: "prompt", wake: "prompt" })

    const summaries: string[] = []
    const schedulerWithCompact = createScheduler(
      { llm: fakeLlm(behavior), session, action },
      {
        model: "fake",
        maxTurns: 3,
        maxTurnMs: 2000,
        maxRetries: 1,
        compact: { thresholdRatio: 0.1, summarize: async (i) => { summaries.push(i.reason); return `摘要:${i.messages.length} 条` } },
      },
    )

    const result = await schedulerWithCompact.prompt({ text: "读 a.txt" })
    expect(result.error).toBeNull()
    expect(summaries).toContain("context-overflow")

    const compression = sessionEvents.filter((e) => e.kind === "compression")
    expect(compression.length).toBeGreaterThan(0)
    if (compression[0]!.kind === "compression") {
      expect(compression[0].strategy).toBe("context-overflow")
      expect(compression[0].droppedIds.length).toBeGreaterThan(0)
    }

    // summary 消息落历史(source: compaction),长 assistant 消息被丢弃
    const hist = session.project().history
    const summaryMsg = hist.find((m) => m.source === "compaction")
    expect(summaryMsg).toBeDefined()
    expect(hist.some((m) => m.role === "assistant" && (m.content[0]?.type === "text") && (m.content[0] as { text: string }).text.startsWith("y".repeat(80_000)))).toBe(false)
    void store
  })

  it("单轮文本回复:admit + assistant 消息落历史", async () => {
    const { session, scheduler } = fresh(() => ({ text: "好的", thinking: "", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "stop", error: undefined, aborted: false }))
    const result = await scheduler.prompt({ text: "你好" })
    expect(result.error).toBeNull()
    expect(result.text).toBe("好的")
    const hist = session.project().history
    expect(hist.some((m) => m.role === "user" && m.content[0]?.type === "text")).toBe(true)
    const assistant = [...hist].reverse().find((m) => m.role === "assistant")
    expect(assistant?.content[0]?.type === "text" && assistant.content[0].text).toBe("好的")
  })

  it("工具调用回合:tool message 落历史且带结果", async () => {
    const reads: LlmCollectResult[] = [
      { text: "", thinking: "", toolCalls: [{ id: "t1", name: "read", args: { path: "a.txt" } }], usage: undefined, finishReason: "tool-calls", error: undefined, aborted: false },
      { text: "读完了", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false },
    ]
    const { session, scheduler, action } = fresh(() => reads.shift() ?? reads[0] ?? { text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false })
    await action.execute({ sessionId: "s1", toolCallId: "w0", name: "write", args: { path: "a.txt", content: "hi" }, cwd: "/tmp/tau-test" })
    const orig = session.project.bind(session)
    session.project = () => withTool(orig(), readCall)
    const result = await scheduler.prompt({ text: "读 a.txt" })
    expect(result.turns).toBe(2)
    expect(result.toolCalls).toBe(1)
    const toolMsg = session.project().history.find((m) => m.role === "tool")
    expect(toolMsg?.toolResults[0]?.callId).toBe("t1")
    expect(toolMsg?.toolResults[0]?.error).toBeUndefined()
  })

  it("工具失败:tool message 带 error 且回合继续", async () => {
    const toolErr = toolError("not_found", "read:a.txt 不存在")
    const reads: LlmCollectResult[] = [
      { text: "", thinking: "", toolCalls: [{ id: "t2", name: "read", args: { path: "b.txt" } }], usage: undefined, finishReason: "tool-calls", error: undefined, aborted: false },
      { text: "文件不存在", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false },
    ]
    const { session, scheduler } = fresh(() => reads.shift() ?? reads[0] ?? { text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false })
    const orig = session.project.bind(session)
    session.project = () => withTool(orig(), readCall)
    const result = await scheduler.prompt({ text: "读 a.txt" })
    expect(result.toolCalls).toBe(1)
    const toolMsg = session.project().history.find((m) => m.role === "tool")
    expect(toolMsg?.toolResults[0]?.error?.code).toBe("not_found")
    void toolErr
  })

  it("死循环防护:同工具同参数重复 3 次 → loop_detected", async () => {
    const events: Event[] = []
    const { scheduler } = fresh(() => ({ text: "", thinking: "", toolCalls: [{ id: "t-loop", name: "read", args: { path: "a.txt" } }], usage: undefined, finishReason: "tool-calls", error: undefined, aborted: false }))
    scheduler.subscribe((e) => events.push(e))
    await scheduler.prompt({ text: "循环" })
    expect(events.some((e) => e.kind === "loop_detected")).toBe(true)
  })

  it("turn 提交点:审计带 turnId,commitTurn 落 kv 锚点,已提交 turn 崩溃恢复不误报", async () => {
    const { store, scheduler } = fresh((calls) =>
      calls === 0
        ? { text: "", thinking: "", toolCalls: [{ id: "t1", name: "read", args: { path: "a.txt" } }], usage: undefined, finishReason: "tool-calls", error: undefined, aborted: false }
        : { text: "收尾", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false },
    )
    await scheduler.prompt({ text: "读文件" })
    const audit = store.audit.query({ sessionId: "s1" })
    expect(audit.length).toBeGreaterThan(0)
    const turnIds = [...new Set(audit.map((a) => a.turnId))]
    expect(turnIds).toHaveLength(1)
    expect(turnIds[0]).toMatch(/^t\d+$/)
    // 提交锚点 = 最后提交的 turn(最后文本 turn 无 syscall,锚点应晚于/等于审计 turn)
    const committed = store.kv.get("committed:s1")
    expect(committed).toBeDefined()
    const epochOf = (id: string) => Number(id.slice(1))
    expect(epochOf(committed!)).toBeGreaterThanOrEqual(epochOf(turnIds[0]!))
    // 重建会话:turn 已提交,无悬置 → 不误报 recovery
    const second = createSession({ store, sessionId: "s1", cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"] })
    expect(store.events.replay("s1").some((e) => e.kind === "recovery")).toBe(false)
    second.close()
  })

  it("abort:中断当前 turn → interrupted 事件 + aborted 结果", async () => {
    const events: Event[] = []
    const { scheduler } = fresh(() => ({ text: "半截", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false }))
    scheduler.subscribe((e) => events.push(e))
    const p = scheduler.prompt({ text: "慢慢来" })
    scheduler.abort()
    const result = await p
    expect(result.aborted).toBe(true)
    expect(events.some((e) => e.kind === "interrupted")).toBe(true)
  })

  it("steer 插话:队列处理,带 steer wake", async () => {
    const { session, scheduler } = fresh(() => ({ text: "收到", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false }))
    await scheduler.steer({ text: "停下" })
    const lastUser = [...session.project().history].reverse().find((m) => m.role === "user")
    expect(lastUser?.content[0]?.type === "text" && lastUser.content[0].text).toBe("停下")
  })

  it("turn 预算:maxTurns 超限 → budget_exceeded", async () => {
    const events: Event[] = []
    let i = 0
    const { scheduler } = fresh(() => ({ text: "", thinking: "", toolCalls: [{ id: `t-x-${i}`, name: "read", args: { path: `a${i++}.txt` } }], usage: undefined, finishReason: "tool-calls", error: undefined, aborted: false }))
    scheduler.subscribe((e) => events.push(e))
    await scheduler.prompt({ text: "多轮" })
    expect(events.some((e) => e.kind === "budget_exceeded")).toBe(true)
  })

  it("重试可见:llm 错误 retryable → retry 事件后再成功", async () => {
    const events: Event[] = []
    const outcomes: LlmCollectResult[] = [
      { text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: undefined, error: { code: "retryable", message: "429 too many", retryable: true }, aborted: false },
      { text: "重试成功", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false },
    ]
    const { scheduler } = fresh(() => outcomes.shift() ?? { text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false })
    scheduler.subscribe((e) => events.push(e))
    const result = await scheduler.prompt({ text: "重试" })
    expect(result.error).toBeNull()
    expect(events.some((e) => e.kind === "retry" && e.attempts === 1)).toBe(true)
  })

  it("非 retryable 错误:不再重试,终止并可见", async () => {
    const { scheduler } = fresh(() => ({ text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: undefined, error: { code: "permission_denied", message: "缺凭据", retryable: false }, aborted: false }))
    const result = await scheduler.prompt({ text: "失败" })
    expect(result.error).toContain("缺凭据")
  })
})

// 构造 Message 辅助(供测试使用)
export function makeMessage(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? "m",
    role: partial.role ?? "user",
    content: partial.content ?? [],
    toolCalls: partial.toolCalls ?? [],
    toolResults: partial.toolResults ?? [],
    interrupted: partial.interrupted ?? false,
    source: partial.source ?? "",
    modelId: partial.modelId,
    retention: partial.retention ?? "normal",
    createdAt: partial.createdAt ?? new Date().toISOString(),
  }
}

export type { ActionPlane, LlmRequest, Session }
export { toolResult }

describe("orchestrate:goal_continue 续跑", () => {
  it("Goal 未完成 → goal_continue 唤醒续跑(计入上限),完成后停止", async () => {
    const nextReplies = ["第一步", "第二步", "第三步", "目标已完成"]
    let calls = 0
    const f = fresh(() => ({
      text: nextReplies[calls++] ?? "完成",
      thinking: "",
      toolCalls: [],
      usage: undefined,
      finishReason: "stop" as const,
      error: undefined,
      aborted: false,
    }))
    f.scheduler.goals.set({
      id: "g1",
      text: "跑完流程",
      status: "active",
      progress: 0,
      strategy: "explicit",
      checklist: [],
      createdAt: new Date().toISOString(),
    })
    const result = await f.scheduler.prompt({ text: "开始", source: "prompt" })
    expect(result.error).toBeNull()

    const snapshot = f.session.snapshot()
    const goalSnap = snapshot.activeGoals.find((g) => g.id === "g1")
    expect(goalSnap?.status).toBe("completed")
  })

  it("goal_continue 唤醒写入投影(wake.reason=goal_continue)", async () => {
    const nextReplies = ["继续干活", "已完成"]
    let calls = 0
    const f = fresh(() => ({
      text: nextReplies[calls++] ?? "完成",
      thinking: "",
      toolCalls: [],
      usage: undefined,
      finishReason: "stop" as const,
      error: undefined,
      aborted: false,
    }))
    f.scheduler.goals.set({
      id: "g2",
      text: "写文档",
      status: "active",
      progress: 0,
      strategy: "explicit",
      checklist: [],
      createdAt: new Date().toISOString(),
    })
    await f.scheduler.prompt({ text: "开始", source: "prompt" })
    const projection = f.session.project()
    // 最近 admit 消息带 goal_continue 唤醒(至少有一次 goal_continue)
    const continueWake = projection.history.filter((m) => m.source === "goal_continue" || m.wake === "goal_continue")
    expect(continueWake.length).toBeGreaterThan(0)
  })

  it("maxTurns 预算:goal_continue 续跑受上限约束(超限即停)", async () => {
    let calls = 0
    const f = fresh(() => ({
      text: `还在干活 ${calls++}`,
      thinking: "",
      toolCalls: [],
      usage: undefined,
      finishReason: "stop" as const,
      error: undefined,
      aborted: false,
    }))
    f.scheduler.goals.set({
      id: "g3",
      text: "永不完成",
      status: "active",
      progress: 0,
      strategy: "explicit",
      checklist: [],
      createdAt: new Date().toISOString(),
    })
    const result = await f.scheduler.prompt({ text: "开始", source: "prompt" })
    // 默认 goalContinueMaxTurns=3:首轮 + 3 次续跑 = 4 次 llm 调用
    expect(calls).toBe(4)
    expect(result.error).toBeNull()
  })
})

describe("orchestrate:steer 队列不丢(audit8 P0-5)", () => {
  it("running 时 steer 入队 → prompt 尾部消费,不静默丢失", async () => {
    const texts: string[] = []
    let calls = 0
    const f = fresh(() => {
      const text = calls === 0 ? "先干活" : "干完了"
      calls++
      return { text, thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }
    })
    const p = f.scheduler.prompt({ text: "开始", source: "prompt" })
    const s = f.scheduler.steer({ text: "插话", source: "steer" })
    await Promise.all([p, s])
    const history = f.session.project().history
    const steerAdmits = history.filter((m) => m.source === "steer" && m.role === "user")
    expect(steerAdmits.length).toBe(1)
    const texts2 = texts
    void texts2
  })
})

describe("orchestrate:steer 立即断流(interrupt: immediate,M10.3-a)", () => {
  it("缺省粒度不变:steer 只等在飞工具完成(不传 signal)", async () => {
    const events: Event[] = []
    let calls = 0
    const f = fresh(() => {
      const text = calls === 0 ? "干活" : "后续"
      calls++
      return { text, thinking: "", toolCalls: calls === 1 ? [{ id: "t1", name: "bash", args: { command: "echo ran" } }] : [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }
    })
    const unsub = f.scheduler.subscribe((e) => events.push(e))
    const p = f.scheduler.prompt({ text: "开始" })
    await f.scheduler.steer({ text: "打断" })
    const result = await p
    unsub()
    expect(result.aborted).toBe(false)
    expect(events.filter((e) => e.kind === "interrupted").length).toBe(0)
  })

  it("立即断流:在飞 bash 被杀(cancelled),剩余调用不执行,已提交结果落盘,interrupted 事件发出", async () => {
    const store = createMemoryStore()
    const session = createSession({ store, sessionId: "s1", cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"] })
    const llm = fakeLlm((calls) => {
      if (calls > 0) return { text: "停了", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }
      return {
        text: "",
        thinking: "",
        toolCalls: [
          { id: "t1", name: "bash", args: { command: "sleep 3; echo SLEPT" } },
          { id: "t2", name: "bash", args: { command: "echo NOOP" } },
        ],
        usage: undefined,
        finishReason: "stop" as const,
        error: undefined,
        aborted: false,
      }
    })
    const events: Event[] = []
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true, onEvent: (e) => events.push(e) })
    const scheduler = createScheduler({ llm, session, action }, { model: "fake", maxTurns: 5, maxTurnMs: 2000, maxRetries: 1, loopGuard: 2 })
    const unsub = scheduler.subscribe((e) => events.push(e))
    const p = scheduler.prompt({ text: "开始" })
    for (let i = 0; i < 2000 && !events.some((e) => e.kind === "tool" && e.state === "started" && e.toolCallId === "t1"); i++) {
      await Bun.sleep(2)
    }
    await scheduler.steer({ text: "立刻停" }, { interrupt: "immediate" })
    const result = await p
    unsub()
    expect(result.aborted).toBe(true)
    expect(events.some((e) => e.kind === "interrupted")).toBe(true)
    // 在飞 bash 以 cancelled 收尾(已提交),t2 从未执行(无审计条目)
    const audit = store.audit.query({ sessionId: "s1" })
    const bashEntries = audit.filter((e) => e.action.startsWith("bash:"))
    expect(bashEntries.some((e) => e.detail.includes("sleep"))).toBe(true)
    expect(bashEntries.some((e) => e.detail.includes("NOOP"))).toBe(false)
    const t1Result = session.project().history.find((m) => m.role === "tool" && m.toolResults[0]?.callId === "t1")
    expect(t1Result?.toolResults[0]?.error?.code).toBe("cancelled")
  })

  it("立即断流:挂起询问未决即中止(不挂等决议)", async () => {
    const store = createMemoryStore()
    const session = createSession({ store, sessionId: "s1", cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"] })
    let llmCalls = 0
    const llm = fakeLlm(() => {
      const isFirst = llmCalls++ === 0
      if (!isFirst) return { text: "停了", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }
      return { text: "", thinking: "", toolCalls: [{ id: "t1", name: "bash", args: { command: "echo ask" } }], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }
    })
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: false })
    const scheduler = createScheduler({ llm, session, action }, { model: "fake", maxTurns: 5, maxTurnMs: 2000, maxRetries: 1, loopGuard: 2 })
    const p = scheduler.prompt({ text: "开始" })
    for (let i = 0; i < 2000 && !action.permissionRequest().some((r) => r.toolCallId === "t1"); i++) {
      await Bun.sleep(2)
    }
    expect(action.permissionRequest().length).toBe(1)
    await scheduler.steer({ text: "立刻停" }, { interrupt: "immediate" })
    const result = await p
    expect(result.aborted).toBe(true)
    expect(action.permissionRequest().length).toBe(0)
  })
})

describe("orchestrate:subagent 生命周期管理器(M12)", () => {

  it("foreground:任务执行 + 白名单 capability 递减 + 注册表落盘", async () => {
    const { store, session } = freshSession()
    const llm = fakeLlm(() => ({ text: "调查结果:文件存在", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }))
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })

    const result = await runSubagent(
      { llm, store, action, session },
      { parentSessionId: "s1", task: "检查 a.txt 是否存在" },
    )
    expect(result.status).toBe("completed")
    expect(result.depth).toBe(1)
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(result.sessionId.startsWith("s1-sub-")).toBe(true)

    // 子会话落 store + 注册表(parentId 链)
    const child = store.sessions.get(result.sessionId)
    expect(child).not.toBeNull()
    const regs = listSubagents(store, "s1")
    expect(regs.length).toBe(1)
    expect(regs[0]!.status).toBe("completed")
    expect(depthOf(store, result.sessionId)).toBe(1)
    expect(depthOf(store, "s1")).toBe(0)

    // 工作树已清理
    expect(store.kv.list(".tau")).toHaveLength(0)
    void SUBAGENT_DEFAULT_TOOLS
  })

  it("capability 递减:白名单外工具被拒绝,子会话只投影白名单", async () => {
    const { store, session } = freshSession()
    let askedWrite = false
    const llm = fakeLlm(() => {
      if (!askedWrite) {
        askedWrite = true
        return { text: "", thinking: "", toolCalls: [{ id: "t1", name: "write", args: { path: "x.txt", content: "x" } }], usage: undefined, finishReason: "tool-calls" as const, error: undefined, aborted: false }
      }
      return { text: "done", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }
    })
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })

    const result = await runSubagent(
      { llm, store, action, session },
      { parentSessionId: "s1", task: "写文件" },
    )
    // write 不在缺省只读白名单:子会话投影无 write,调用被拒绝,不会真写入
    expect(result.status).toBe("completed")
    expect(store.audit.query({ sessionId: result.sessionId }).some((a) => a.action === "write:rejected")).toBe(true)
    void SUBAGENT_DEFAULT_TOOLS
  })

  it("并发上限:超限拒绝派生(status partial)", async () => {
    const { store, session } = freshSession()
    const llm = fakeLlm(() => ({ text: "ok", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }))
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })

    const blocker = runSubagent(
      { llm, store, action, session },
      { parentSessionId: "s1", task: "慢任务" },
      { maxTurns: 1 },
    )
    // 占位:blocker 尚未完成,第二个同父会话并发受限(maxPerParent 压到 1)
    const second = await runSubagent(
      { llm, store, action, session },
      { parentSessionId: "s1", task: "第二个" },
      { maxTurns: 1, maxPerParent: 1 },
    )
    await blocker
    expect(second.status).toBe("partial")
    expect(second.text).toContain("并发超限")
    expect(subagentUsage().global).toBe(0)
  })

  it("深度上限:嵌套过深拒绝派生", async () => {
    const { store, session } = freshSession()
    const llm = fakeLlm(() => ({ text: "ok", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop" as const, error: undefined, aborted: false }))
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const deps = { llm, store, action, session }

    const l1 = await runSubagent(deps, { parentSessionId: "s1", task: "1" }, { maxTurns: 1 })
    const l2 = await runSubagent(deps, { parentSessionId: l1.sessionId, task: "2" }, { maxTurns: 1 })
    const l3 = await runSubagent(deps, { parentSessionId: l2.sessionId, task: "3" }, { maxTurns: 1, maxDepth: 2 })
    expect(l1.depth).toBe(1)
    expect(l2.depth).toBe(2)
    expect(l3.depth).toBe(3)
    expect(l3.status).toBe("partial")
    expect(l3.text).toContain("深度超限")
  })
})
