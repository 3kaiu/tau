// @tau/tui - 集成测试:模拟 Event 流驱动 transcript + tool-panel 渲染。
// 验证:增量刷新(缓存失效/命中)、状态流转(started->completed/failed)、跨视图事件过滤、完整 turn 场景。

import { describe, expect, it } from "vitest"
import { TranscriptView } from "../src/views/transcript.ts"
import { ToolPanelView } from "../src/views/tool-panel.ts"
import type { Event, Message } from "@tau/contract"

// ---------- 事件/消息构造器 ----------

let seq = 0
function eid(): string {
  return `e${++seq}`
}

function ev(event: Omit<Event, "id" | "timestamp" | "redact">): Event {
  return { id: eid(), timestamp: "2026-01-01T00:00:00Z", redact: [], ...event } as Event
}

function userMsg(text: string): Message {
  return {
    id: eid(),
    role: "user",
    content: [{ type: "text", text }],
    toolCalls: [],
    toolResults: [],
    interrupted: false,
    source: "cli",
    retention: "high",
    createdAt: "t",
  }
}

function assistantMsg(text: string, toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]): Message {
  return {
    id: eid(),
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    toolCalls: (toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
    toolResults: [],
    interrupted: false,
    source: "model",
    retention: "normal",
    createdAt: "t",
  }
}

function toolMsg(callId: string, result: { stdout?: string; exitCode?: number }): Message {
  return {
    id: eid(),
    role: "tool",
    content: [],
    toolCalls: [],
    toolResults: [{
      callId,
      result: {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? null,
        stderr: null,
        truncated: false,
        totalPages: 1,
        page: 0,
      },
    }],
    interrupted: false,
    source: "tool",
    retention: "low",
    createdAt: "t",
  }
}

function toolStarted(toolCallId: string, name: string, args: Record<string, unknown>): Event {
  return ev({ kind: "tool", toolCallId, name, state: "started", args })
}

function toolCompleted(toolCallId: string, name: string, stdout: string): Event {
  return ev({
    kind: "tool",
    toolCallId,
    name,
    state: "completed",
    result: { exitCode: 0, stdout, stderr: null, truncated: false, totalPages: 1, page: 0 },
  })
}

function toolFailed(toolCallId: string, name: string, code: string, message: string): Event {
  return ev({ kind: "tool", toolCallId, name, state: "failed", error: { code: code as never, message } })
}

function transcript(message: Message): Event {
  return ev({ kind: "transcript", message })
}

// 用于检查渲染行是否包含 ANSI 码(颜色)后的纯文本
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "")
}

// ---------- 测试 ----------

describe("集成:Event 流驱动 transcript + tool-panel", () => {
  it("完整 turn:user -> assistant(read) -> tool started -> completed -> tool msg -> assistant final", () => {
    const tc = new TranscriptView({ maxLines: 500 })
    const tp = new ToolPanelView()

    // 1. input_accepted(两视图都应忽略)
    const inputEvent = ev({
      kind: "input_accepted",
      command: { kind: "prompt" as const, sender: { clientId: "cli", kind: "cli" as const }, text: "读 package.json" },
    })
    tc.consume(inputEvent)
    tp.consume(inputEvent)
    expect(tc.render(80)).toEqual([])
    expect(tp.render(80)).toEqual([])
    expect(tp.getActiveCount()).toBe(0)

    // 2. user transcript
    tc.consume(transcript(userMsg("读 package.json")))
    const tcLines1 = tc.render(80)
    expect(tcLines1.length).toBe(1)
    expect(stripAnsi(tcLines1[0]!)).toContain("读 package.json")

    // 3. assistant with toolCalls
    tc.consume(transcript(assistantMsg("", [{ id: "c1", name: "read", args: { path: "package.json" } }])))
    const tcLines2 = tc.render(80)
    expect(tcLines2.length).toBe(2)
    expect(stripAnsi(tcLines2[1]!)).toContain("read")
    expect(stripAnsi(tcLines2[1]!)).toContain("package.json")

    // 4. tool started
    tp.consume(toolStarted("c1", "read", { path: "package.json" }))
    expect(tp.getActiveCount()).toBe(1)
    expect(tp.hasActivity()).toBe(true)
    const tpLines1 = tp.render(80)
    expect(tpLines1.length).toBeGreaterThanOrEqual(1)
    expect(stripAnsi(tpLines1[0]!)).toContain("read")
    expect(tpLines1[0]!).toContain("⟳")

    // 5. tool completed
    tp.consume(toolCompleted("c1", "read", '{"name":"tau"}'))
    expect(tp.getActiveCount()).toBe(0)
    expect(tp.hasActivity()).toBe(false)
    const tpLines2 = tp.render(80)
    const completedLine = tpLines2.find((l) => l.includes("✓"))
    expect(completedLine).toBeDefined()
    const resultLine = tpLines2.find((l) => stripAnsi(l).includes("↳"))
    expect(resultLine).toBeDefined()
    expect(stripAnsi(resultLine!)).toContain('{"name":"tau"}')

    // 6. tool transcript(transcript 视图消费)
    tc.consume(transcript(toolMsg("c1", { stdout: '{"name":"tau"}' })))
    const tcLines3 = tc.render(80)
    expect(tcLines3.length).toBe(3)
    expect(stripAnsi(tcLines3[2]!)).toContain("↳")

    // 7. assistant final
    tc.consume(transcript(assistantMsg("这是 tau 项目")))
    const tcLines4 = tc.render(80)
    expect(tcLines4.length).toBe(4)
    expect(stripAnsi(tcLines4[3]!)).toContain("这是 tau 项目")
  })

  it("增量刷新:consume 后缓存失效,render 重建;无 consume 时缓存命中(同引用)", () => {
    const tc = new TranscriptView()
    const tp = new ToolPanelView()

    // 初始 render -> 空数组
    const tc0 = tc.render(80)
    const tp0 = tp.render(80)
    expect(tc0).toEqual([])
    expect(tp0).toEqual([])

    // 无 consume,重复 render -> 同引用(缓存命中)
    expect(tc.render(80)).toBe(tc0)
    expect(tp.render(80)).toBe(tp0)

    // consume 后 -> 缓存失效,render 返回新引用
    tc.consume(transcript(userMsg("hello")))
    tp.consume(toolStarted("c1", "read", { path: "a" }))

    const tc1 = tc.render(80)
    const tp1 = tp.render(80)
    expect(tc1).not.toBe(tc0)
    expect(tp1).not.toBe(tp0)
    expect(tc1.length).toBe(1)
    expect(tp1.length).toBeGreaterThanOrEqual(1)

    // 再次重复 render -> 同引用
    expect(tc.render(80)).toBe(tc1)
    expect(tp.render(80)).toBe(tp1)

    // 再 consume -> 再次失效
    tc.consume(transcript(assistantMsg("world")))
    tp.consume(toolCompleted("c1", "read", "ok"))

    const tc2 = tc.render(80)
    const tp2 = tp.render(80)
    expect(tc2).not.toBe(tc1)
    expect(tp2).not.toBe(tp1)
    expect(tc2.length).toBe(2)
  })

  it("tool-panel 状态流转:started -> failed,activeCount 归零,render 显示 ✗", () => {
    const tp = new ToolPanelView()

    tp.consume(toolStarted("c1", "bash", { command: "rm -rf /tmp/tau-test" }))
    expect(tp.getActiveCount()).toBe(1)
    expect(tp.hasActivity()).toBe(true)

    const linesStarted = tp.render(80)
    expect(linesStarted[0]!).toContain("⟳")

    tp.consume(toolFailed("c1", "bash", "permission_denied", "危险命令被拒绝"))
    expect(tp.getActiveCount()).toBe(0)
    expect(tp.hasActivity()).toBe(false)

    const linesFailed = tp.render(80)
    const failLine = linesFailed.find((l) => l.includes("✗"))
    expect(failLine).toBeDefined()
    const errLine = linesFailed.find((l) => stripAnsi(l).includes("permission_denied"))
    expect(errLine).toBeDefined()
    expect(stripAnsi(errLine!)).toContain("危险命令被拒绝")
  })

  it("多工具并发:两个 started,activeCount=2;逐个 completed 递减", () => {
    const tp = new ToolPanelView()

    tp.consume(toolStarted("c1", "read", { path: "a.txt" }))
    expect(tp.getActiveCount()).toBe(1)

    tp.consume(toolStarted("c2", "read", { path: "b.txt" }))
    expect(tp.getActiveCount()).toBe(2)
    expect(tp.hasActivity()).toBe(true)

    const linesBoth = tp.render(80)
    const startedLines = linesBoth.filter((l) => l.includes("⟳"))
    expect(startedLines.length).toBe(2)

    tp.consume(toolCompleted("c1", "read", "content-a"))
    expect(tp.getActiveCount()).toBe(1)
    expect(tp.hasActivity()).toBe(true)

    tp.consume(toolCompleted("c2", "read", "content-b"))
    expect(tp.getActiveCount()).toBe(0)
    expect(tp.hasActivity()).toBe(false)

    const linesDone = tp.render(80)
    const completedLines = linesDone.filter((l) => l.includes("✓"))
    expect(completedLines.length).toBe(2)
  })

  it("跨视图事件过滤:transcript 忽略 tool 事件,tool-panel 忽略 transcript 事件", () => {
    const tc = new TranscriptView()
    const tp = new ToolPanelView()

    // tool 事件 -> transcript 不增长,tool-panel 增长
    tc.consume(toolStarted("c1", "read", { path: "a" }))
    tp.consume(toolStarted("c1", "read", { path: "a" }))
    expect(tc.render(80)).toEqual([])
    expect(tp.render(80).length).toBeGreaterThanOrEqual(1)

    // transcript 事件 -> transcript 增长,tool-panel 不变
    const tpBefore = tp.render(80)
    tc.consume(transcript(userMsg("hello")))
    tp.consume(transcript(userMsg("hello")))
    expect(tc.render(80).length).toBe(1)
    expect(tp.render(80)).toBe(tpBefore)
  })

  it("告警类事件:interrupted/retry/loop_detected/budget_exceeded 进 transcript,不进 tool-panel", () => {
    const tc = new TranscriptView()
    const tp = new ToolPanelView()

    const alerts: Event[] = [
      ev({ kind: "retry", cause: "429 rate limit", attempts: 2 }),
      ev({ kind: "interrupted", targetId: "turn-3" }),
      ev({ kind: "loop_detected", turn: 4, pattern: "read:{path:pkg.json}" }),
      ev({ kind: "budget_exceeded", metric: "maxTurns", used: 6, limit: 6 }),
      ev({ kind: "model_switched", from: "gpt-4o", to: "gpt-4o-mini", reason: "cost" }),
    ]

    for (const e of alerts) {
      tc.consume(e)
      tp.consume(e)
    }

    const tcLines = tc.render(80)
    expect(tcLines.length).toBe(alerts.length)
    const tcText = tcLines.map(stripAnsi).join("\n")
    expect(tcText).toContain("retry")
    expect(tcText).toContain("interrupted")
    expect(tcText).toContain("loop")
    expect(tcText).toContain("budget")
    expect(tcText).toContain("model")

    // tool-panel 不受告警事件影响
    expect(tp.render(80)).toEqual([])
    expect(tp.getActiveCount()).toBe(0)
  })

  it("多 turn 场景:成功 turn -> 失败 turn -> retry -> 恢复", () => {
    const tc = new TranscriptView({ maxLines: 1000 })
    const tp = new ToolPanelView()

    const stream: Event[] = [
      // turn 1: read 成功
      transcript(userMsg("读 config")),
      transcript(assistantMsg("", [{ id: "c1", name: "read", args: { path: "config.json" } }])),
      toolStarted("c1", "read", { path: "config.json" }),
      toolCompleted("c1", "read", '{"port":3000}'),
      transcript(toolMsg("c1", { stdout: '{"port":3000}' })),
      transcript(assistantMsg("端口是 3000")),

      // turn 2: bash 失败
      transcript(userMsg("跑测试")),
      transcript(assistantMsg("", [{ id: "c2", name: "bash", args: { command: "npm test" } }])),
      toolStarted("c2", "bash", { command: "npm test" }),
      toolFailed("c2", "bash", "timeout", "命令超时 120s"),
      ev({ kind: "retry", cause: "bash timeout", attempts: 1 }),

      // turn 3: 恢复,换 read
      transcript(assistantMsg("测试超时了,我先看看测试文件", [{ id: "c3", name: "read", args: { path: "test/index.test.ts" } }])),
      toolStarted("c3", "read", { path: "test/index.test.ts" }),
      toolCompleted("c3", "read", "describe('app', () => {"),
      transcript(toolMsg("c3", { stdout: "describe('app', () => {" })),
      transcript(assistantMsg("测试文件看起来正常,可能是环境问题")),
    ]

    let prevTcCount = 0
    let prevTpActive = 0

    for (const event of stream) {
      tc.consume(event)
      tp.consume(event)

      // transcript 行数单调递增(或持平,如 tool 事件)
      const tcCount = tc.render(80).length
      expect(tcCount).toBeGreaterThanOrEqual(prevTcCount)
      prevTcCount = tcCount

      // tool-panel activeCount 非负
      expect(tp.getActiveCount()).toBeGreaterThanOrEqual(0)
      prevTpActive = tp.getActiveCount()
    }
    void prevTpActive

    // 最终:transcript 包含所有对话内容
    const finalLines = tc.render(80).map(stripAnsi)
    const finalText = finalLines.join("\n")
    expect(finalText).toContain("读 config")
    expect(finalText).toContain("端口是 3000")
    expect(finalText).toContain("跑测试")
    expect(finalText).toContain("retry")
    expect(finalText).toContain("测试超时了")
    expect(finalText).toContain("环境问题")

    // 最终:tool-panel 三个工具都完成/失败,无活跃
    expect(tp.getActiveCount()).toBe(0)
    const tpLines = tp.render(80)
    const okLines = tpLines.filter((l) => l.includes("✓"))
    const failLines = tpLines.filter((l) => l.includes("✗"))
    expect(okLines.length).toBe(2)
    expect(failLines.length).toBe(1)
  })

  it("transcript maxRenderLines 虚拟化:大量事件后只渲染最近 N 行", () => {
    const tc = new TranscriptView({ maxLines: 10000 })
    tc.setMaxRenderLines(5)

    for (let i = 0; i < 20; i++) {
      tc.consume(transcript(userMsg(`msg-${i}`)))
    }

    const lines = tc.render(80)
    expect(lines.length).toBe(5)
    const text = lines.map(stripAnsi).join("\n")
    // 旧的丢弃
    expect(text).not.toContain("msg-0")
    expect(text).not.toContain("msg-14")
    // 最近 5 条保留
    expect(text).toContain("msg-15")
    expect(text).toContain("msg-19")

    // 内部存储仍保留全部(getLineCount 不受 maxRenderLines 影响)
    expect(tc.getLineCount()).toBe(20)
  })

  it("invalidate 手动失效缓存,下次 render 重建", () => {
    const tc = new TranscriptView()
    const tp = new ToolPanelView()

    tc.consume(transcript(userMsg("a")))
    tp.consume(toolStarted("c1", "read", { path: "x" }))

    const tc1 = tc.render(80)
    const tp1 = tp.render(80)

    // 无 consume,invalidate 后 render 返回新引用
    tc.invalidate()
    tp.invalidate()

    const tc2 = tc.render(80)
    const tp2 = tp.render(80)
    expect(tc2).not.toBe(tc1)
    expect(tp2).not.toBe(tp1)
    // 内容相同
    expect(tc2).toEqual(tc1)
    expect(tp2).toEqual(tp1)
  })

  it("宽度变化触发缓存重建:transcript 和 tool-panel 都按 width 缓存", () => {
    const tc = new TranscriptView()
    const tp = new ToolPanelView()

    tc.consume(transcript(userMsg("hello world this is a long line")))
    tp.consume(toolStarted("c1", "read", { path: "a" }))

    const tc80 = tc.render(80)
    const tp80 = tp.render(80)

    // 宽度不变 -> 同引用(缓存命中)
    expect(tc.render(80)).toBe(tc80)
    expect(tp.render(80)).toBe(tp80)

    // 宽度变化 -> 两者都重建(不同引用)
    const tc40 = tc.render(40)
    const tp40 = tp.render(40)
    expect(tc40).not.toBe(tc80)
    expect(tp40).not.toBe(tp80)

    // 宽度不变(40) -> 同引用(新缓存命中)
    expect(tc.render(40)).toBe(tc40)
    expect(tp.render(40)).toBe(tp40)
  })
})
