// @tau/llm — 薄内核单测(离线:不触网,供应商差异封死在适配器内)。

import { describe, expect, it } from "vitest"
import {
  ContextProjectionSchema,
  INJECTION_PRIORITY,
  MessageSchema,
  ModelSchema,
  toolResult,
  type ContextProjection,
  type Message,
} from "@tau/contract"
import {
  assembleSystem,
  cacheHitRate,
  chatOptionsFor,
  collectStream,
  createLlmKernel,
  defaultCatalog,
  errorCodeOf,
  modelsApiToCatalog,
  normalizeStream,
  promptCache,
  recordCacheHit,
  toAiMessages,
  toToolSet,
} from "@tau/llm"

const MODEL_A = ModelSchema.parse({
  id: "gpt-5-mini",
  provider: { api: "openai-compatible", provider: "openai", envKey: "TAU_TEST_KEY" },
  cost: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  contextWindow: { maxTokens: 400_000 },
})

const MODEL_B = ModelSchema.parse({
  id: "gpt-5",
  provider: { api: "openai-compatible", provider: "openai", envKey: "TAU_TEST_KEY" },
  cost: { inputPerMillion: 1.25, outputPerMillion: 10 },
  contextWindow: { maxTokens: 400_000 },
})

function projection(history: Message[] = []): ContextProjection {
  return ContextProjectionSchema.parse({
    version: 1,
    wake: { reason: "prompt", source: "test" },
    history,
    self: {
      model: { id: "gpt-5-mini", provider: "openai", contextWindow: { maxTokens: 400_000 } },
      clock: { wall: "2026-08-04T00:00:00.000Z", monotonicMs: 0, sessionElapsedMs: 0 },
      usage: { turn: 0, toolCallsThisTurn: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cumulativeTokens: 0, estimatedRemaining: 400_000, costUsd: 0 },
      cwd: "/tmp",
      permissions: [],
      skills: {},
      session: { id: "test" },
    },
    resources: {
      maxConcurrentTurns: 1,
      budget: { maxTurns: 10, maxTurnMs: 60_000, maxToolCallsPerTurn: 8 },
    },
  })
}

describe("assembleSystem", () => {
  it("按 priority 降序,注入防护最高", () => {
    const p = projection()
    p.system = [
      { kind: "policy", priority: 1, content: "policy" },
      { kind: "injection", priority: INJECTION_PRIORITY, content: "guard" },
      { kind: "context", priority: 5, content: "ctx" },
    ]
    const out = assembleSystem(p)
    expect(out).toContain("policy")
    expect(out).toContain("ctx")
    expect(out.indexOf("guard")).toBeLessThan(out.indexOf("ctx"))
    expect(out.indexOf("ctx")).toBeLessThan(out.indexOf("policy"))
  })

  it("折叠 self/wake/resources/pendingSyscalls/recent 送达模型(宪法5/8 输入面)", () => {
    const p = projection()
    p.pendingSyscalls = [{ questionId: "q1", toolCallId: "c1", toolName: "bash", raisedAt: "t" }]
    p.recent = { kind: "retry", text: "retry after 429 (attempt 2)", eventId: "e1" }
    p.self.permissions = [{ pattern: "read", rule: "allow", scope: "path" }]
    const out = assembleSystem(p)
    expect(out).toContain("唤醒:prompt(来源:test)")
    expect(out).toContain("模型:gpt-5-mini(openai)")
    expect(out).toContain("cwd:/tmp")
    expect(out).toContain("超限=ask")
    expect(out).toContain("挂起询问")
    expect(out).toContain("bash(q1)")
    expect(out).toContain("最近活动:retry retry after 429 (attempt 2)")
    expect(out).toContain("「read」→allow")
  })
})

describe("toAiMessages", () => {
  it("文本/图片块与 role 映射", () => {
    const m = MessageSchema.parse({
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image", url: "https://x/y.png" },
      ],
      createdAt: "t",
    })
    const out = toAiMessages([m])
    expect(out[0]?.role).toBe("user")
    expect(out[0]?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image", image: "https://x/y.png" },
    ])
  })

  it("tool-call 与 tool-result 按 callId 配对;未配对 call 被过滤", () => {
    const assistant = MessageSchema.parse({
      id: "a1",
      role: "assistant",
      toolCalls: [
        { id: "c1", name: "bash", arguments: { command: "ls" } },
        { id: "c2", name: "bash", arguments: { command: "rm" } },
      ],
      createdAt: "t",
    })
    const toolMsg = MessageSchema.parse({
      id: "t1",
      role: "tool",
      toolResults: [{ callId: "c1", result: toolResult({ stdout: "a" }) }],
      createdAt: "t",
    })
    const out = toAiMessages([assistant, toolMsg])
    const assistantParts = out[0]?.content as Array<Record<string, unknown>>
    expect(assistantParts).toHaveLength(1)
    expect(assistantParts[0]).toMatchObject({ type: "tool-call", toolCallId: "c1", toolName: "bash" })
    const toolParts = out[1]?.content as Array<Record<string, unknown>>
    expect(toolParts[0]).toMatchObject({ type: "tool-result", toolCallId: "c1", toolName: "bash" })
    const output = toolParts[0]?.output as { type: string; value: Record<string, unknown> }
    expect(output.value.stdout).toBe("a")
    expect(output.value.truncated).toBe(false)
  })

  it("system role 消息降级为 <system-update> 文本", () => {
    const m = MessageSchema.parse({
      id: "s1",
      role: "system",
      content: [{ type: "text", text: "chrono" }],
      createdAt: "t",
    })
    const out = toAiMessages([m])
    const parts = out[0]?.content
    const first = parts === undefined ? undefined : (parts as Array<Record<string, unknown>>)[0]
    expect(first).toEqual({
      type: "text",
      text: "<system-update>\nchrono\n</system-update>",
    })
  })

  it("artifact 引用块渲染为 [artifact:ref …] 文本(模型按需取回,不烧上下文)", () => {
    const m = MessageSchema.parse({
      id: "a1",
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "artifact", ref: "a-1", size: 1234, hash: "abc123" },
      ],
      createdAt: "t",
    })
    const out = toAiMessages([m])
    const parts = out[0]?.content as Array<Record<string, unknown>>
    expect(parts[1]).toEqual({ type: "text", text: "[artifact:ref a-1 size=1234 hash=abc123]" })
  })

  it("thinking 块渲染为 reasoning part(wire = reasoning_content 回传)", () => {
    const m = MessageSchema.parse({
      id: "t1",
      role: "assistant",
      content: [{ type: "thinking", text: "先读文件" }],
      createdAt: "t",
    })
    const out = toAiMessages([m])
    const parts = out[0]?.content as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: "reasoning", text: "先读文件" })
  })
})

describe("toToolSet", () => {
  it("契约 SystemCall(JSON Schema 参数)→ AI SDK Tool", () => {
    const toolset = toToolSet([
      {
        name: "bash",
        description: "run",
        parameters: { type: "object", properties: { command: { type: "string" } } },
        tier: "T0",
        maxOutputTokens: 8192,
      },
    ])
    expect(toolset["bash"]?.description).toBe("run")
    const input = toolset["bash"]?.inputSchema
    const json = input === undefined ? undefined : (input as { jsonSchema?: unknown }).jsonSchema
    expect(json).toMatchObject({ type: "object", properties: { command: { type: "string" } } })
  })
})

describe("normalizeStream", () => {
  it("text/reasoning/tool-call 增量 → LlmEvent,finish 收尾", async () => {
    const parts = [
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      { type: "reasoning-delta", text: "想" },
      { type: "tool-input-delta", toolCallId: "c1", toolName: "bash", delta: '{"c' },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
      { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: { total: 10, noCache: 6, cacheRead: 4 }, outputTokens: { total: 20, reasoning: 5, text: 15 } } },
    ]
    const events = []
    for await (const e of normalizeStream(parts as AsyncIterable<never>)) events.push(e)
    expect(events).toEqual([
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      { type: "thinking-delta", text: "想" },
      { type: "tool-call-delta", id: "c1", name: "bash", argsDelta: '{"c' },
      { type: "tool-call", id: "c1", name: "bash", args: { command: "ls" } },
      { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 5, cacheReadTokens: 4 } },
    ])
  })

  it("error 事件化:429 可重试,400 不可", async () => {
    const collect = async (status: number) => {
      const events = []
      for await (const e of normalizeStream([{ type: "error", error: { statusCode: status } }] as AsyncIterable<never>)) {
        events.push(e)
      }
      return events
    }
    expect((await collect(429))[0]).toMatchObject({ type: "error", code: "retryable", retryable: true })
    expect((await collect(400))[0]).toMatchObject({ type: "error", code: "internal", retryable: false })
    expect((await collect(401))[0]).toMatchObject({ type: "error", code: "permission_denied" })
  })

  it("abort 信号 → aborted 事件", async () => {
    const controller = new AbortController()
    controller.abort()
    const events = []
    for await (const e of normalizeStream([{ type: "text-delta", textDelta: "x" }] as AsyncIterable<never>, controller.signal)) {
      events.push(e)
    }
    expect(events[0]?.type).toBe("aborted")
  })
})

describe("collectStream", () => {
  it("聚合文本/工具调用/用量/错误", async () => {
    const stream = async function* () {
      yield { type: "text-delta", text: "a" } as const
      yield { type: "tool-call", id: "c1", name: "bash", args: {} } as const
      yield { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } } as const
    }
    const result = await collectStream(stream())
    expect(result.text).toBe("a")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.finishReason).toBe("tool-calls")
    expect(result.error).toBeUndefined()
  })
})

describe("errorCodeOf", () => {
  it("超时/429/5xx → retryable", () => {
    expect(errorCodeOf({ isTimeout: true })).toEqual({ code: "timeout", retryable: true })
    expect(errorCodeOf({ statusCode: 500 })).toEqual({ code: "retryable", retryable: true })
    expect(errorCodeOf({ name: "AbortError" })).toEqual({ code: "cancelled", retryable: false })
  })

  it("402 → insufficient_funds;insufficient_system_resource → overloaded", () => {
    expect(errorCodeOf({ statusCode: 402, message: "balance insufficient" })).toEqual({ code: "insufficient_funds", retryable: false })
    expect(errorCodeOf({ statusCode: 503, message: "insufficient_system_resource" })).toEqual({ code: "overloaded", retryable: true })
  })
})

describe("chatOptionsFor", () => {
  const meta = (api: string) => ({ api, provider: api, auth: "apiKey" as const })

  it("deepseek:thinking + reasoningEffort 映射", () => {
    expect(chatOptionsFor(meta("deepseek"), { thinking: true, reasoningEffort: "high" })).toEqual({
      deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    })
    expect(chatOptionsFor(meta("deepseek"), { thinking: false })).toEqual({ deepseek: { thinking: { type: "disabled" } } })
  })

  it("zai:thinking 透传且 clear_thinking 固定 false", () => {
    expect(chatOptionsFor(meta("zai"), { thinking: true })).toEqual({ zai: { thinking: { type: "enabled", clear_thinking: false } } })
  })

  it("alibaba/moonshot/minimax 各自形状", () => {
    expect(chatOptionsFor(meta("alibaba"), { thinking: true })).toEqual({ alibaba: { enableThinking: true } })
    expect(chatOptionsFor(meta("moonshot"), { thinking: true, thinkingBudgetTokens: 2048 })).toEqual({
      moonshot: { thinking: { type: "enabled", budgetTokens: 2048 } },
    })
    expect(chatOptionsFor(meta("minimax"), { thinking: true })).toEqual({ minimax: { thinking: { type: "adaptive" } } })
  })

  it("anthropic:enabled+budgetTokens;kimi-coding:adaptive+summarized+effort", () => {
    expect(chatOptionsFor(meta("anthropic"), { thinking: true, thinkingBudgetTokens: 8192 })).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
    })
    expect(chatOptionsFor(meta("kimi-coding"), { thinking: true })).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    })
    expect(chatOptionsFor(meta("kimi-coding"), { thinking: false })).toEqual({
      anthropic: { thinking: { type: "disabled", display: "summarized" } },
    })
  })

  it("未声明思考或通道无适配 → undefined", () => {
    expect(chatOptionsFor(meta("deepseek"), {})).toBeUndefined()
    expect(chatOptionsFor(meta("openai-compatible"), { thinking: true })).toBeUndefined()
  })
})

describe("modelsApiToCatalog", () => {
  it("只映射已注册通道;能力/成本/上下文窗口映射", () => {
    const catalog = modelsApiToCatalog({
      deepseek: {
        id: "deepseek",
        env: ["DEEPSEEK_API_KEY"],
        npm: "@ai-sdk/deepseek",
        api: "https://api.deepseek.com",
        models: {
          "deepseek-v4-flash": {
            id: "deepseek-v4-flash",
            reasoning: true,
            reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }],
            tool_call: true,
            attachment: false,
            limit: { context: 1_000_000, output: 384_000 },
            cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
          },
        },
      },
      "kimi-for-coding": {
        id: "kimi-for-coding",
        env: ["KIMI_API_KEY"],
        npm: "@ai-sdk/anthropic",
        api: "https://api.kimi.com/coding/v1",
        models: { "kimi-for-coding": { id: "kimi-for-coding", reasoning: true, tool_call: true, limit: { context: 262144, output: 32768 } } },
      },
      "zai-coding-plan": {
        id: "zai-coding-plan",
        env: ["ZHIPU_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.z.ai/api/coding/paas/v4",
        models: { "glm-5.2": { id: "glm-5.2", reasoning: true, tool_call: true, limit: { context: 204800 } } },
      },
      "unsupported-provider": {
        id: "unsupported-provider",
        npm: "@some-unknown-sdk",
        models: { x: { id: "x" } },
      },
    })
    expect(catalog).toHaveLength(3)
    const ds = catalog.find((m) => m.id === "deepseek-v4-flash")!
    expect(ds.provider).toMatchObject({ api: "deepseek", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY" })
    expect(ds.capabilities.supportsThinking).toBe(true)
    expect(ds.cost).toEqual({ inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028 })
    expect(ds.contextWindow).toEqual({ maxTokens: 1_000_000, maxOutputTokens: 384_000 })
    const kimi = catalog.find((m) => m.id === "kimi-for-coding")!
    expect(kimi.provider.api).toBe("kimi-coding")
    const glm = catalog.find((m) => m.id === "glm-5.2")!
    expect(glm.provider).toMatchObject({ api: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4" })
  })

  it("kernel.refresh 合并目录(静态优先,远程补充)", () => {
    const kernel = createLlmKernel({ catalog: defaultCatalog() })
    const before = kernel.models().length
    const staticId = kernel.models()[0]!.id
    const remote = [
      { ...defaultCatalog()[0]!, id: "remote-new-1" },
      { ...defaultCatalog()[0]!, id: staticId, name: "remote 覆盖版" },
    ]
    kernel.refresh(remote)
    const ids = kernel.models().map((m) => m.id)
    expect(ids).toContain("remote-new-1")
    expect(kernel.models().length).toBe(before + 1)
    expect(kernel.models().find((m) => m.id === staticId)!.name).not.toBe("remote 覆盖版")
  })
})

describe("defaultCatalog", () => {
  it("国产模型在位,thinking 能力校准", () => {
    const catalog = defaultCatalog()
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]))
    expect(byId["deepseek-v4-flash-0731"]?.provider.api).toBe("deepseek")
    expect(byId["deepseek-v4-flash-0731"]?.capabilities.supportsThinking).toBe(true)
    expect(byId["qwen3-max"]?.provider.api).toBe("alibaba")
    expect(byId["glm-5.2"]?.provider.api).toBe("zai")
    expect(byId["kimi-k3"]?.provider.api).toBe("moonshot")
    expect(byId["minimax-m3"]?.provider.api).toBe("minimax")
    expect(byId["deepseek-v4-flash-free"]?.capabilities.supportsThinking).toBe(true)
  })
})

describe("kernel", () => {
  it("models/getModel/features/getAuth/refresh", () => {
    const kernel = createLlmKernel({ catalog: defaultCatalog() })
    expect(kernel.models().length).toBeGreaterThan(0)
    expect(kernel.getModel("openai", "gpt-5-mini")?.id).toBe("gpt-5-mini")
    expect(kernel.getModel("openai", "nope")).toBeNull()
    expect(kernel.features(kernel.models()[0]!).supportsStreaming).toBe(true)
    expect(kernel.getAuth(kernel.models()[0]!)).toBeNull()
    kernel.refresh()
  })

  it("目录外模型 → not_found 错误事件,不 throw", async () => {
    const kernel = createLlmKernel({ catalog: [MODEL_A] })
    const p = projection()
    p.self.model.id = "ghost"
    const events = []
    for await (const e of kernel.stream(p)) events.push(e)
    expect(events).toEqual([{ type: "error", code: "not_found", message: "模型 ghost 不在目录", retryable: false }])
  })

  it("缺凭据 → permission_denied 错误事件", async () => {
    const kernel = createLlmKernel({ catalog: [MODEL_A] })
    const events = []
    for await (const e of kernel.stream(projection())) events.push(e)
    expect(events).toEqual([{ type: "error", code: "permission_denied", message: "模型 gpt-5-mini 缺凭据", retryable: false }])
  })

  it("模型切换 → model-switched 事件(模型自省)", async () => {
    const kernel = createLlmKernel({ catalog: [MODEL_A, MODEL_B] })
    const p = projection()
    p.self.model.id = "gpt-5-mini"
    for await (const _ of kernel.stream(p)) void _
    p.self.model.id = "gpt-5"
    const events = []
    for await (const e of kernel.stream(p)) events.push(e)
    expect(events[0]).toEqual({ type: "model-switched", from: "gpt-5-mini", to: "gpt-5" })
  })

  it("getAuth:显式值 > envKey > api 默认 env", () => {
    const kernel = createLlmKernel({ catalog: [MODEL_A], getApiKey: () => "explicit" })
    expect(kernel.getAuth(MODEL_A)).toBe("explicit")
  })
})

describe("cache", () => {
  it("策略:anthropic auto,openai-compatible none", () => {
    expect(promptCache("anthropic")).toBe("auto")
    expect(promptCache("openai-compatible")).toBe("none")
  })

  it("命中率观测", () => {
    let stats = recordCacheHit({ calls: 0, cachedTokenCandidates: 0, cacheReadTokens: 0 }, { promptTokens: 100, cacheReadTokens: 40 })
    stats = recordCacheHit(stats, { promptTokens: 100, cacheReadTokens: 100 })
    expect(stats.calls).toBe(2)
    expect(cacheHitRate(stats)).toBeCloseTo(0.7)
    expect(cacheHitRate({ calls: 0, cachedTokenCandidates: 0, cacheReadTokens: 0 })).toBe(0)
  })
})
