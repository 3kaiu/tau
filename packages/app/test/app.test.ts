// @tau/app — compose 端到端(注入 fake llm,跑真实回路:face → orchestrate → action)。

import { describe, expect, it } from "vitest"
import type { LlmCollectResult, LlmKernel } from "@tau/llm"
import { compose } from "../src/compose.ts"
import { createPrintRenderer } from "@tau/surface"

function fakeLlm(): LlmKernel {
  let calls = 0
  const complete = async (): Promise<LlmCollectResult> => {
    calls++
    if (calls === 1) {
      return { text: "", thinking: "", toolCalls: [{ id: "t1", name: "read", args: { path: "pkg.json" } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "tool-calls", error: undefined, aborted: false }
    }
    return { text: "版本是 0.0.1", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false }
  }
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

describe("app:compose 端到端回路", () => {
  it("prompt → 工具调用 → 总结 → print 输出", async () => {
    const runtime = compose({ llm: fakeLlm(), cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const renderer = createPrintRenderer({ showToolCalls: true })
    const chunks: string[] = []
    runtime.scheduler.subscribe((event) => {
      renderer.consume(event)
      const chunk = renderer.flush()
      if (chunk !== "") chunks.push(chunk)
    })
    const result = await runtime.face.publish({ kind: "prompt", sender: { clientId: "cli", kind: "cli" }, text: "读 pkg.json" })
    expect(result.accepted).toBe(true)
    const tail = renderer.flush()
    if (tail !== "") chunks.push(tail)
    const rendered = chunks.join("\n")
    expect(rendered).toContain("→ read")
    expect(rendered).toContain("版本是 0.0.1")
    // 会话快照可见:消息与用量已落盘
    const snap = runtime.session.snapshot()
    expect(snap.transcriptCount).toBeGreaterThanOrEqual(4)
  })

  it("print 渲染:interrupted/retry 标记可见", async () => {
    const renderer = createPrintRenderer({ showToolCalls: true })
    const ev: LlmCollectResult = { text: "x", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false }
    void ev
    renderer.consume({ id: "e1", timestamp: "t", redact: [], kind: "retry", cause: "429", attempts: 2 })
    renderer.consume({ id: "e2", timestamp: "t", redact: [], kind: "interrupted", targetId: "llm" })
    const out = renderer.flush()
    expect(out).toContain("重试 2")
    expect(out).toContain("打断")
  })
})
