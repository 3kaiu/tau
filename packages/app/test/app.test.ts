// @tau/app — compose 端到端(注入 fake llm,跑真实回路:face → orchestrate → action)。

import { describe, expect, it } from "vitest"
import type { LlmCollectResult, LlmKernel } from "@tau/llm"
import { createMemoryStore } from "@tau/store"
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

  it("compose config:configStore 装载 toolTierRules 裁剪投影,非法配置启动期报错", () => {
    const store = createMemoryStore()
    store.kv.set("config:toolTierRules", JSON.stringify({ defaultTier: "T1", overrides: { read: "T0", ls: "T0" } }))
    store.kv.set("config:maxContextTokens", "64000")
    const runtime = compose({ llm: fakeLlm(), cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], autoApprove: true, store, configStore: store })
    const names = runtime.session.project().tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("ls")
    expect(names).toContain("tool:catalog")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("grep")

    const bad = createMemoryStore()
    bad.kv.set("config:maxContextTokens", "abc")
    expect(() => compose({ llm: fakeLlm(), cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], autoApprove: true, configStore: bad })).toThrow(/配置不合法/)
  })

  it("compose config:options.config 程序化覆写直达投影(tier 裁剪)", () => {
    const runtime = compose({ llm: fakeLlm(), cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], autoApprove: true, config: { toolTierRules: { defaultTier: "T1", overrides: { read: "T0" } }, maxContextTokens: 64000 } })
    const names = runtime.session.project().tools.map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("ls")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("grep")
  })

  it("memory:* syscall 面:记忆读写检索经 execute 闭环,索引块在重建时刷新", async () => {
    const runtime = compose({ llm: fakeLlm(), cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const plane = runtime.action as unknown as { execute: (req: { sessionId: string; toolCallId: string; name: string; args: Record<string, unknown>; cwd?: string }) => Promise<{ ok: boolean; result?: { stdout: string }; error?: { code: string } }> }
    const exec = (name: string, args: Record<string, unknown>, callId: string) =>
      plane.execute({ sessionId: "main", toolCallId: callId, name, args, cwd: "/tmp/tau-test" })

    // 写入记忆(经 execute,审计)
    const wrote = await exec("memory:write", { key: "偏好", content: "简洁回复" }, "m1")
    expect(wrote.ok).toBe(true)

    // 覆盖保护:缺省拒绝,overwrite 放行
    const denied = await exec("memory:write", { key: "偏好", content: "覆盖" }, "m2")
    if (denied.ok) expect(denied.result!.stdout).toContain("拒绝覆盖")
    const forced = await exec("memory:write", { key: "偏好", content: "覆盖后", overwrite: true }, "m2b")
    if (forced.ok) expect(forced.result!.stdout).toContain("已写入")

    // 读全文 + 检索 + 枚举
    const read = await exec("memory:read", { key: "偏好" }, "m3")
    if (read.ok) expect(read.result!.stdout).toBe("覆盖后")
    const search = await exec("memory:search", { query: "覆盖" }, "m4")
    if (search.ok) expect(search.result!.stdout).toContain("[偏好]")
    const list = await exec("memory:list", {}, "m5")
    if (list.ok) expect(list.result!.stdout).toContain("- [偏好]")

    // 审计落盘
    const audit = runtime.store.audit.query({ sessionId: "main" })
    expect(audit.some((a) => a.action.startsWith("memory:write"))).toBe(true)

    // 两级装载:索引块在会话创建/恢复时刷新(写入前创建的投影不含,重建后含)
    expect(runtime.session.project().system.find((b) => b.kind === "memory")).toBeUndefined()
    const refreshed = runtime.enhancer!.apply("main")
    const memBlock = refreshed.systemBlocks.find((b) => b.kind === "memory")
    expect(memBlock).toBeDefined()
    expect(memBlock!.content).toContain("[偏好] 覆盖后")

    runtime.session.close()
  })

  it("subagent:run syscall:委派子代理,结果回传,子会话落 store", async () => {
    const runtime = compose({ llm: fakeLlm(), cwd: "/tmp/tau-test", workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    // 子代理视角的 llm 与父相同(fakeLlm 调用计数独立)
    const plane = runtime.action as unknown as { execute: (req: { sessionId: string; toolCallId: string; name: string; args: Record<string, unknown>; cwd?: string }) => Promise<{ ok: boolean; result?: { stdout: string }; error?: { code: string } }> }

    const outcome = await plane.execute({
      sessionId: "main",
      toolCallId: "s1",
      name: "subagent:run",
      args: { task: "调查文件结构" },
      cwd: "/tmp/tau-test",
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result!.stdout).toContain("[子代理")
      expect(outcome.result!.stdout).toContain("completed")
    }

    // 子会话落 store + 注册表(parentId 链)
    const { listSubagents } = await import("@tau/orchestrate")
    const regs = listSubagents(runtime.store, "main")
    expect(regs.length).toBe(1)
    expect(regs[0]!.status).toBe("completed")
    expect(runtime.store.sessions.get(regs[0]!.sessionId)).not.toBeNull()

    runtime.session.close()
  })
})
