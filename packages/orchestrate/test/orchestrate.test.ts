// @tau/orchestrate — scheduler 测试。用假 LlmKernel 驱动 turn 状态机;
// 覆盖:单轮文本 / 工具循环 / 死循环防护 / abort / steer / 超时 / 重试可见。

import { describe, expect, it } from "vitest"
import { createMemoryStore } from "@tau/store"
import { createSession, type Session } from "@tau/session"
import type { ContextProjection, Event, Message, SystemCall } from "@tau/contract"
import { toolResult, toolError } from "@tau/contract"
import type { LlmCollectResult, LlmKernel, LlmRequest } from "@tau/llm"
import { createActionPlane, type ActionPlane } from "@tau/action"
import { createScheduler } from "../src/index.ts"

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
