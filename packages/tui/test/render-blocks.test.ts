// @tau/tui - 单测:内容块渲染(thinking/artifact 为审计7 P1-2/P1-3 新增契约变体)。
// 验证这两类块被显式渲染,而非退回误导性的 [image]。

import { describe, expect, it } from "vitest"
import { renderEventLine } from "../src/print.ts"
import type { Event, Message } from "@tau/contract"

const baseMessage: Message = {
  id: "m1",
  role: "assistant",
  content: [],
  toolCalls: [],
  toolResults: [],
  interrupted: false,
  source: "",
  retention: "normal",
  createdAt: "2026-01-01T00:00:00Z",
}

function transcript(message: Message): Event {
  return { id: "e1", timestamp: "t", redact: [], kind: "transcript", message } as Event
}

describe("renderEventLine: 内容块渲染(thinking/artifact)", () => {
  it("thinking 块渲染为 (thinking) 而非 [image]", () => {
    const lines = renderEventLine(
      transcript({ ...baseMessage, content: [{ type: "thinking", text: "让我想想" }] }),
      false,
    )
    const out = lines.join("\n")
    expect(out).toContain("(thinking) 让我想想")
    expect(out).not.toContain("[image]")
  })

  it("artifact 块渲染引用信息(ref/mime/size)", () => {
    const lines = renderEventLine(
      transcript({ ...baseMessage, content: [{ type: "artifact", ref: "art1", mime: "image/png", size: 2048 }] }),
      false,
    )
    const out = lines.join("\n")
    expect(out).toContain("[artifact")
    expect(out).toContain("image/png")
    expect(out).toContain("2048B")
    expect(out).toContain("ref=art1")
    expect(out).not.toContain("[image]")
  })

  it("text 块仍正常渲染", () => {
    const lines = renderEventLine(
      transcript({ ...baseMessage, content: [{ type: "text", text: "你好" }] }),
      false,
    )
    expect(lines.join("\n")).toContain("你好")
  })
})
