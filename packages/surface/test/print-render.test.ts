// @tau/surface - 单测:print 渲染器内容块(thinking/artifact 来自审计7 P1-2/P1-3)。
// 验证这两类块被显式渲染,而非退回误导性的 [image]。

import { describe, expect, it } from "vitest"
import { createPrintRenderer } from "../src/print.ts"
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

describe("createPrintRenderer: 内容块渲染(thinking/artifact)", () => {
  it("thinking 块渲染为 (思考链) 而非 [image]", () => {
    const r = createPrintRenderer({ showToolCalls: false })
    r.consume(transcript({ ...baseMessage, role: "assistant", content: [{ type: "thinking", text: "推理中" }] }))
    const out = r.flush()
    expect(out).toContain("(思考链) 推理中")
    expect(out).not.toContain("[image]")
  })

  it("artifact 块渲染引用信息(ref/mime/size)", () => {
    const r = createPrintRenderer({ showToolCalls: false })
    r.consume(
      transcript({ ...baseMessage, role: "assistant", content: [{ type: "artifact", ref: "a", mime: "text/markdown", size: 100 }] }),
    )
    const out = r.flush()
    expect(out).toContain("[附件")
    expect(out).toContain("ref=a")
    expect(out).not.toContain("[image]")
  })
})
