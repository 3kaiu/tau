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
  collectStream,
  createLlmKernel,
  defaultCatalog,
  errorCodeOf,
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
    expect(assembleSystem(p)).toBe("guard\n\nctx\n\npolicy")
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
      { type: "text-delta", textDelta: "你" },
      { type: "text-delta", textDelta: "好" },
      { type: "reasoning", textDelta: "想" },
      { type: "tool-call-delta", toolCallId: "c1", toolName: "bash", argsTextDelta: "{\"c" },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
    ]
    const events = []
    for await (const e of normalizeStream(parts as AsyncIterable<never>)) events.push(e)
    expect(events).toEqual([
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      { type: "thinking-delta", text: "想" },
      { type: "tool-call-delta", id: "c1", name: "bash", argsDelta: '{"c' },
      { type: "tool-call", id: "c1", name: "bash", args: { command: "ls" } },
      { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
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
