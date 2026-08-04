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

  it("applyRemoteCatalog:成功合并 / 拉取失败静默回退", async () => {
    const { applyRemoteCatalog } = await import("../src/compose.ts")
    let catalog: readonly import("@tau/contract").Model[] = []
    const kernel: LlmKernel = {
      stream: async function* () {},
      complete: async () => ({ text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: "stop", error: undefined, aborted: false }),
      models: () => catalog,
      getModel: () => null,
      features: () => ({ streaming: true, tools: true, thinking: false, vision: false }),
      getAuth: () => null,
      cachePolicy: () => ({ mode: "off", ttlMs: 0 }),
      refresh: (next) => {
        if (next) catalog = next
      },
    }

    const fakeFetch = async (url: string, init?: { signal?: AbortSignal }) => {
      void url; void init
      if (init?.signal?.aborted) throw new Error("aborted")
      return new Response(JSON.stringify({
        "deepseek": {
          id: "deepseek",
          env: ["DEEPSEEK_API_KEY"],
          npm: "@ai-sdk/deepseek",
          api: "https://api.deepseek.com/v1",
          models: { "deepseek-test-1": { id: "deepseek-test-1", reasoning: true, tool_call: true, limit: { context: 100000, output: 8000 } } },
        },
      }), { status: 200 })
    }

    const results: [boolean, number][] = []
    const ok = await applyRemoteCatalog(kernel, { onResult: (o, n) => results.push([o, n]), timeoutMs: 2000, fetchImpl: fakeFetch as typeof fetch })
    expect(ok).toBe(true)
    expect(kernel.models()).toHaveLength(1)
    expect(kernel.models()[0]!.id).toBe("deepseek-test-1")
    expect(results[0]).toEqual([true, 1])

    // 拉取失败 -> false + 目录不变
    const catalogBefore = kernel.models().length
    const badFetch = async () => { throw new Error("network down") }
    const fail = await applyRemoteCatalog(kernel, { onResult: (o, n) => results.push([o, n]), timeoutMs: 500, fetchImpl: badFetch as typeof fetch })
    expect(fail).toBe(false)
    expect(results[1][0]).toBe(false)
    expect(kernel.models()).toHaveLength(catalogBefore)
  })

  it("MCP:stdio server 注册为 syscall,调用经 executor 返回", async () => {
    const { registerMcpServers } = await import("../src/mcp.ts")
    const { createActionPlane } = await import("@tau/action")
    const { createMemoryStore } = await import("@tau/store")
    const plane = createActionPlane(createMemoryStore(), { autoApprove: true })

    const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname
    const { registered, failed } = await registerMcpServers(plane, [
      { id: "demo", defaultRule: { pattern: "mcp_demo_*", rule: "allow", scope: "tool" }, transport: { type: "stdio", command: "bun", args: ["run", fixture] } },
    ])
    expect(failed).toEqual([])
    expect(registered).toBe(1)

    // defaultRule 装载进能力门(通配匹配 mcp_demo_echo)
    expect(plane.gate.decide("mcp_demo_echo", false)).toEqual({ rule: "allow" })

    const syscall = plane.registry.get("mcp_demo_echo")
    expect(syscall).not.toBeNull()
    expect(syscall!.description).toContain("回显")

    const outcome = await plane.execute({
      sessionId: "s1",
      toolCallId: "t-mcp",
      name: "mcp_demo_echo",
      args: { message: "你好" },
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.stdout).toBe("echo:你好")
      expect(outcome.result.exitCode).toBe(0)
    }
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
