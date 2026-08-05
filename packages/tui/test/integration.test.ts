// @tau/tui - 集成测试:模拟 Event 流驱动 transcript + tool-panel 渲染。
// 验证:增量刷新(缓存失效/命中)、状态流转(started->completed/failed)、跨视图事件过滤、完整 turn 场景。

import { describe, expect, it } from "vitest"
import { TranscriptView } from "../src/views/transcript.ts"
import { ToolPanelView } from "../src/views/tool-panel.ts"
import { PermissionPopup } from "../src/views/permission.ts"
import { InfoDialog } from "../src/views/info-dialog.ts"
import { FooterComponent } from "../src/views/footer.ts"
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

  it("跨视图事件过滤:transcript 消费 tool(进行中可见),tool-panel 消费 tool 但忽略 transcript", () => {
    const tc = new TranscriptView()
    const tp = new ToolPanelView()

    // tool 事件 -> transcript 显示进行中/结果行,tool-panel 也增长
    tc.consume(toolStarted("c1", "read", { path: "a" }))
    tp.consume(toolStarted("c1", "read", { path: "a" }))
    expect(tc.isStreaming()).toBe(true)
    expect(tc.render(80).some((l) => l.includes("read"))).toBe(true)
    expect(tp.render(80).length).toBeGreaterThanOrEqual(1)

    // 工具完成 -> transcript 更新为 ✓,且不再 busy
    tc.consume(toolCompleted("c1", "read", "content-a"))
    expect(tc.isStreaming()).toBe(false)
    expect(tc.render(80).some((l) => l.includes("✓"))).toBe(true)

    // transcript 事件 -> transcript 增长,tool-panel 不变
    const tpBefore = tp.render(80)
    tc.consume(transcript(userMsg("hello")))
    tp.consume(transcript(userMsg("hello")))
    expect(tc.render(80).some((l) => l.includes("hello"))).toBe(true)
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

  it("流式:text_delta 累计为进行中行,终态 transcript 清空替换", () => {
    const tc = new TranscriptView()
    const first = tc.render(80)
    expect(first).toEqual([])

    // 思考增量(thinking 通道):独立 spinner 行 + 内容行
    tc.consume(ev({ kind: "text_delta", text: "先看目录", thinking: true }))
    const t1 = tc.render(80)
    expect(tc.isStreaming()).toBe(true)
    expect(stripAnsi(t1[t1.length - 2]!)).toContain("thinking...")
    expect(stripAnsi(t1[t1.length - 1]!)).toContain("先看目录")

    // 正文增量(text 通道)
    tc.consume(ev({ kind: "text_delta", text: "读了", thinking: false }))
    tc.consume(ev({ kind: "text_delta", text: "三个文件", thinking: false }))
    const t2 = tc.render(80)
    expect(stripAnsi(t2[t2.length - 1]!)).toContain("读了三个文件")

    // spinner 帧推进:同内容不同引用(有流式行时不污染缓存)
    tc.tick()
    const t3 = tc.render(80)
    expect(t3).not.toBe(t2)
    expect(stripAnsi(t3[t3.length - 1]!)).toContain("读了三个文件")

    // 终态 transcript 到达 → 进行中行清空,落定稿行
    tc.consume(transcript(assistantMsg("读了三个文件")))
    expect(tc.isStreaming()).toBe(false)
    const final = tc.render(80)
    expect(stripAnsi(final.join("\n"))).toContain("读了三个文件")
    expect(final.some((l) => l.includes("⠋") || l.includes("⠙"))).toBe(false)
  })

  it("物理行截断:wrap 后总行数不超 maxRenderLines(防止顶出底部固定区)", () => {
    const tc = new TranscriptView({ maxLines: 1000 })
    tc.setMaxRenderLines(5)

    // 一条超长消息,宽度 40 下 wrap 成多行
    for (let i = 0; i < 10; i++) {
      tc.consume(transcript(assistantMsg(`第${i}条 ` + "中文很长".repeat(20))))
    }

    const lines = tc.render(40)
    // 逻辑行 10 条远超 5;wrap 后物理行也必须 ≤ 5
    expect(lines.length).toBeLessThanOrEqual(5)
    // 最近的内容应保留(末尾附近含第9条)
    expect(stripAnsi(lines.join("\n"))).toContain("第9条")
  })

  it("thinking 折叠单行可展开:toggle 切换摘要/全文", () => {
    const tc = new TranscriptView()
    const thinkingText = "第一步先阅读文件结构\n第二步再定位问题根因\n第三步给出修复建议,这是一段很长的推理,用于验证多行展开。"
    const msg = assistantMsg("", [{ id: "c1", name: "read", args: {} }])
    const withThinking: Message = {
      ...msg,
      content: [{ type: "thinking", text: thinkingText }],
      toolCalls: [],
    }
    tc.consume(transcript(withThinking))

    // 默认折叠:预览前 2 行 + 折叠提示,不含第 3 段
    const collapsed = tc.render(80)
    expect(collapsed.length).toBe(3)
    const collapsedText = stripAnsi(collapsed.join("\n"))
    expect(collapsedText).toContain("第一步")
    expect(collapsedText).toContain("第二步")
    expect(collapsedText).toContain("展开")
    expect(collapsedText).not.toContain("第三步")

    // 展开:多行,含全文
    tc.toggleThinking()
    const expanded = tc.render(80)
    expect(stripAnsi(expanded.join("\n"))).toContain("第三步")

    // 再 toggle:全展开 → 收起
    tc.toggleThinking()
    const recollapsed = tc.render(80)
    expect(stripAnsi(recollapsed.join("\n"))).not.toContain("第三步")
  })

  it("权限弹窗:所有行严格同宽(边框不错位)", () => {
    const popup = new PermissionPopup()
    const permissionEv = ev({
      kind: "permission",
      requestId: "req1",
      toolName: "bash",
      summary: "执行命令 ls -la,查看当前目录文件列表",
      state: "requested",
    })
    popup.show(permissionEv, () => {})

    const lines = popup.render(60)
    expect(lines.length).toBeGreaterThan(3)
    // 去 ANSI 后所有行可见宽度一致(边框与内容严格对齐)
    const widths = lines.map((l) => visibleWidthOf(stripAnsi(l)))
    const first = widths[0]!
    for (const w of widths) {
      expect(w).toBe(first)
    }
  })
})

function visibleWidthOf(s: string): number {
  let n = 0
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

describe("集成:底部状态栏(footer)", () => {
  it("usage 事件累计 context 用量;budget 事件给出上下文百分比", () => {
    const f = new FooterComponent()
    f.update({ model: "deepseek-v4-flash-free", cwd: "/tmp" })

    f.consume(ev({ kind: "usage", cumulativeTokens: 500, turnTokens: 300, turn: 1 }))
    const lines1 = f.render(80)
    expect(stripAnsi(lines1.join("\n"))).toContain("deepseek-v4-flash-free")
    expect(stripAnsi(lines1.join("\n"))).toContain("500 tok")

    // budget 事件给出上限 → context 百分比(cumulative 保持 500,上限 1000 → 50%)
    f.consume(ev({ kind: "budget_exceeded", metric: "cumulativeTokens", used: 800, limit: 1000 }))
    const lines2 = f.render(80)
    expect(stripAnsi(lines2.join("\n"))).toContain("context: 50%")
    expect(stripAnsi(lines2.join("\n"))).toContain("超限")
  })

  it("permission 事件累计 pending;busy 指示", () => {
    const f = new FooterComponent()
    f.consume(ev({ kind: "permission", requestId: "r1", toolName: "bash", summary: "ls", state: "requested" }))
    expect(stripAnsi(f.render(80).join("\n"))).toContain("pending 1")

    f.consume(ev({ kind: "permission", requestId: "r1", toolName: "bash", summary: "ls", state: "granted" }))
    expect(stripAnsi(f.render(80).join("\n"))).not.toContain("pending")

    f.setBusy(true)
    expect(stripAnsi(f.render(80).join("\n"))).toContain("●")
  })

  it("注入 git/mode/thinking effort → footer 显示", () => {
    const f = new FooterComponent()
    f.update({
      model: "deepseek-v4-flash-free",
      thinkingEffort: "high",
      cwd: "/a/b/c/d",
      mode: "auto",
      git: { branch: "main", commit: "abc123", dirty: true },
    })
    const out = stripAnsi(f.render(120).join("\n"))
    expect(out).toContain("auto")
    expect(out).toContain("deepseek-v4-flash-free thinking: high")
    expect(out).toContain("git: main")
  })

  it("工具结果折叠:toggleTool 展开/收起长结果", () => {
    const tc = new TranscriptView()
    const longOut = "第一行\n" + "x".repeat(200)
    tc.consume(toolStarted("c1", "bash", { command: "ls" }))
    tc.consume(toolCompleted("c1", "bash", longOut))

    // 折叠:首行预览 + 展开提示,不含第二行
    const collapsed = tc.render(80)
    const collapsedText = stripAnsi(collapsed.join("\n"))
    expect(collapsedText).toContain("✓ bash")
    expect(collapsedText).toContain("第一行")
    expect(collapsedText).toContain("ctrl+o 展开")
    expect(collapsedText).not.toContain("x".repeat(200))

    // 展开:全文可见(经 wrap 分行)
    tc.toggleTool()
    const expanded = tc.render(80)
    expect(stripAnsi(expanded.join("\n"))).toContain("x".repeat(40))
  })

  it("子代理运行实时进度:子代理工具 + 转发 text_delta 可见", () => {
    const tc = new TranscriptView()

    // 父容器发起 subagent_run(工具 started) + 子代理实时 text_delta(经 onEvent 转发)
    tc.consume(toolStarted("c1", "subagent_run", { task: "探索" }))
    tc.consume(ev({ kind: "text_delta", text: "正在读目录", thinking: false }))
    expect(tc.isStreaming()).toBe(true)
    const running = stripAnsi(tc.render(80).join("\n"))
    expect(running).toContain("subagent_run")
    expect(running).toContain("正在读目录")

    // 子代理完成:转发的 assistant 消息 + 父工具 completed
    tc.consume(transcript(assistantMsg("探索完成")))
    tc.consume(toolCompleted("c1", "subagent_run", "[子代理 s1] completed"))
    expect(tc.isStreaming()).toBe(false)
    const done = stripAnsi(tc.render(80).join("\n"))
    expect(done).toContain("✓ subagent_run")
    expect(done).toContain("探索完成")
  })

  it("信息弹窗:show/dismiss,任意键关闭,宽度一致", () => {    const d = new InfoDialog()
    expect(d.isActive()).toBe(false)
    d.show("斜杠命令", ["  /help 帮助", "  /abort 打断"], () => {})
    expect(d.isActive()).toBe(true)

    const lines = d.render(50)
    // 边框 + 内容行严格同宽;最后一行是框外提示(任意键关闭),不参与比较
    const boxLines = lines.slice(0, lines.length - 1)
    const widths = boxLines.map((l) => visibleWidthOf(stripAnsi(l)))
    const first = widths[0]!
    for (const w of widths) expect(w).toBe(first)

    d.handleInput("x")
    expect(d.isActive()).toBe(false)
  })

  it("按轮裁剪:保留最近 maxTurns 轮,单条超长不挤掉多轮", () => {
    const tc = new TranscriptView({ maxTurns: 3 })

    // 灌入 5 轮多轮对话,每轮含一条超长 assistant 尾
    for (let i = 0; i < 5; i++) {
      tc.consume(transcript(userMsg(`第${i}轮问题`)))
      tc.consume(transcript(assistantMsg(`回答${i}  ` + "长".repeat(50))))
    }

    const out = stripAnsi(tc.render(80).join("\n"))
    // 只保留最近 3 轮(第 0、1 轮被裁剪)
    expect(out).not.toContain("第0轮问题")
    expect(out).not.toContain("第1轮问题")
    expect(out).toContain("第2轮问题")
    expect(out).toContain("第4轮问题")
  })
})
