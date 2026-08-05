// @tau/tui - 单测:斜杠命令解析 + print/JSONL 渲染 + transcript/tool 面板。

import { describe, expect, it } from "vitest"
import { parseInput, formatHelp, SLASH_COMMANDS } from "../src/prompt.ts"
import { renderEventLine, renderEventJson } from "../src/print.ts"
import { TranscriptView } from "../src/views/transcript.ts"
import { ToolPanelView } from "../src/views/tool-panel.ts"
import type { Event, Sender } from "@tau/contract"

const sender: Sender = { clientId: "tui", kind: "tui" }

function ev(event: Omit<Event, "id" | "timestamp" | "redact">): Event {
  return { id: `e${Math.random()}`, timestamp: "t", redact: [], ...event } as Event
}

describe("prompt:parseInput", () => {
  it("普通文本 -> prompt", () => {
    const r = parseInput("hello world", sender)
    expect(r.kind).toBe("prompt")
    if (r.kind === "prompt") {
      expect(r.command.kind).toBe("prompt")
      expect(r.command.text).toBe("hello world")
      expect(r.command.sender).toEqual(sender)
    }
  })

  it("/steer <text> -> steer", () => {
    const r = parseInput("/steer 改用 python", sender)
    expect(r.kind).toBe("steer")
    if (r.kind === "steer") {
      expect(r.command.kind).toBe("steer")
      expect(r.command.text).toBe("改用 python")
    }
  })

  it("/abort -> abort", () => {
    const r = parseInput("/abort", sender)
    expect(r.kind).toBe("abort")
    if (r.kind === "abort") {
      expect(r.command.kind).toBe("abort")
    }
  })

  it("/stop 别名 -> abort", () => {
    const r = parseInput("/stop", sender)
    expect(r.kind).toBe("abort")
  })

  it("/approve <id> -> approve", () => {
    const r = parseInput("/approve req-123", sender)
    expect(r.kind).toBe("approve")
    if (r.kind === "approve") {
      expect(r.command.kind).toBe("approve")
      expect(r.requestId).toBe("req-123")
    }
  })

  it("/deny <id> -> deny", () => {
    const r = parseInput("/deny req-456", sender)
    expect(r.kind).toBe("deny")
    if (r.kind === "deny") {
      expect(r.requestId).toBe("req-456")
    }
  })

  it("/help -> help", () => {
    expect(parseInput("/help", sender).kind).toBe("help")
  })

  it("空输入 -> empty", () => {
    expect(parseInput("  ", sender).kind).toBe("empty")
  })

  it("未知命令 -> unknown", () => {
    const r = parseInput("/foobar", sender)
    expect(r.kind).toBe("unknown")
    if (r.kind === "unknown") {
      expect(r.name).toBe("foobar")
    }
  })

  it("/steer 缺文本 -> unknown", () => {
    const r = parseInput("/steer", sender)
    expect(r.kind).toBe("unknown")
  })

  it("/model <id> -> set_model;无参 -> list_models", () => {
    const withId = parseInput("/model deepseek-v4-flash-free", sender)
    expect(withId.kind).toBe("set_model")
    if (withId.kind === "set_model") {
      expect(withId.modelId).toBe("deepseek-v4-flash-free")
      expect(withId.command).toMatchObject({ kind: "set_model", model: "deepseek-v4-flash-free" })
    }
    expect(parseInput("/model", sender).kind).toBe("list_models")
  })

  it("formatHelp 包含所有命令", () => {
    const help = formatHelp()
    for (const cmd of SLASH_COMMANDS) {
      expect(help).toContain(cmd.name)
    }
  })

  it("/skill <name> -> skill 命令(展开为 prompt)", () => {
    const r = parseInput("/skill greet", sender)
    expect(r.kind).toBe("skill")
    if (r.kind === "skill") {
      expect(r.skillName).toBe("greet")
      expect(r.command.kind).toBe("prompt")
      if (r.command.kind === "prompt") {
        expect(r.command.text).toContain("greet")
        expect(r.command.text).toContain("skill_load")
      }
    }
  })

  it("/skill 缺名 -> unknown", () => {
    const r = parseInput("/skill", sender)
    expect(r.kind).toBe("unknown")
  })
})

describe("print:renderEventLine", () => {
  it("用户消息带 > 前缀", () => {
    const e = ev({
      kind: "transcript",
      message: {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        toolCalls: [],
        toolResults: [],
        interrupted: false,
        source: "cli",
        retention: "high",
        createdAt: "t",
      },
    })
    expect(renderEventLine(e, true)).toEqual(["> hi"])
  })

  it("助手消息 + 工具调用", () => {
    const e = ev({
      kind: "transcript",
      message: {
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "reading" }],
        toolCalls: [{ id: "t1", name: "read", arguments: { path: "pkg.json" } }],
        toolResults: [],
        interrupted: false,
        source: "model",
        retention: "normal",
        createdAt: "t",
      },
    })
    const lines = renderEventLine(e, true)
    expect(lines).toContain("reading")
    expect(lines.some((l) => l.includes("-> read"))).toBe(true)
  })

  it("工具结果带 ↳ 前缀", () => {
    const e = ev({
      kind: "transcript",
      message: {
        id: "m3",
        role: "tool",
        content: [],
        toolCalls: [],
        toolResults: [{ callId: "t1", result: { exitCode: 0, stdout: "ok", stderr: null, truncated: false, totalPages: 1, page: 0 } }],
        interrupted: false,
        source: "read",
        retention: "low",
        createdAt: "t",
      },
    })
    const lines = renderEventLine(e, true)
    expect(lines.some((l) => l.startsWith("↳"))).toBe(true)
  })

  it("告警类事件可见", () => {
    expect(renderEventLine(ev({ kind: "retry", cause: "429", attempts: 2 }), true)[0]).toContain("retry")
    expect(renderEventLine(ev({ kind: "interrupted", targetId: "llm" }), true)[0]).toContain("interrupted")
    expect(renderEventLine(ev({ kind: "budget_exceeded", metric: "maxTurns", used: 6, limit: 6 }), true)[0]).toContain("budget")
  })
})

describe("print:renderEventJson", () => {
  it("输出合法 JSON 且 kind 保留", () => {
    const e = ev({ kind: "interrupted", targetId: "llm" })
    const json = renderEventJson(e)
    const parsed = JSON.parse(json) as Event
    expect(parsed.kind).toBe("interrupted")
    expect(parsed.id).toBe(e.id)
  })
})

describe("TranscriptView", () => {
  it("消费 transcript 事件后渲染可见", () => {
    const view = new TranscriptView()
    view.consume(
      ev({
        kind: "transcript",
        message: {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          toolCalls: [],
          toolResults: [],
          interrupted: false,
          source: "cli",
          retention: "high",
          createdAt: "t",
        },
      }),
    )
    const lines = view.render(80)
    expect(lines.some((l) => l.includes("hello"))).toBe(true)
  })

  it("消费告警事件渲染行", () => {
    const view = new TranscriptView()
    view.consume(ev({ kind: "loop_detected", turn: 3, pattern: "read:{}" }))
    const lines = view.render(80)
    expect(lines.some((l) => l.includes("loop"))).toBe(true)
  })

  it("maxRenderLines 截断旧行", () => {
    const view = new TranscriptView({ maxLines: 1000 })
    view.setMaxRenderLines(3)
    for (let i = 0; i < 10; i++) {
      view.consume(
        ev({
          kind: "transcript",
          message: {
            id: `m${i}`,
            role: "user",
            content: [{ type: "text", text: `line-${i}` }],
            toolCalls: [],
            toolResults: [],
            interrupted: false,
            source: "cli",
            retention: "high",
            createdAt: "t",
          },
        }),
      )
    }
    const lines = view.render(80)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines[lines.length - 1]).toContain("line-9")
  })
})

describe("ToolPanelView", () => {
  it("started -> completed 状态流转", () => {
    const view = new ToolPanelView()
    view.consume(ev({ kind: "tool", toolCallId: "t1", name: "read", state: "started", args: { path: "a.txt" } }))
    expect(view.getActiveCount()).toBe(1)
    expect(view.hasActivity()).toBe(true)

    view.consume(
      ev({
        kind: "tool",
        toolCallId: "t1",
        name: "read",
        state: "completed",
        result: { exitCode: 0, stdout: "content", stderr: null, truncated: false, totalPages: 1, page: 0 },
      }),
    )
    expect(view.getActiveCount()).toBe(0)
    expect(view.hasActivity()).toBe(false)

    const lines = view.render(80)
    expect(lines.some((l) => l.includes("read"))).toBe(true)
  })

  it("failed 状态带错误信息", () => {
    const view = new ToolPanelView()
    view.consume(ev({ kind: "tool", toolCallId: "t2", name: "bash", state: "failed", error: { code: "timeout", message: "too slow" } }))
    const lines = view.render(80)
    expect(lines.some((l) => l.includes("timeout"))).toBe(true)
  })
})
