// @tau/llm — fallback 降级链单测(离线:mock ai.streamText 按模型 id 分派)。

import { describe, expect, it, beforeEach, vi } from "vitest"
import { streamText } from "ai"
import { ContextProjectionSchema, ModelSchema, type ContextProjection } from "@tau/contract"
import { createLlmKernel, registerProvider } from "@tau/llm"

vi.mock("ai", () => ({
  streamText: vi.fn(),
  // 兼容形状:ai 的 tool 把 inputSchema 包装为 {jsonSchema};jsonSchema 对 plain JSON Schema 透传
  jsonSchema: (s: unknown) => s,
  tool: (t: { inputSchema?: unknown } & Record<string, unknown>) => ({ ...t, inputSchema: { jsonSchema: t.inputSchema } }),
}))

const mockStream = streamText as unknown as {
  mockImplementation: (fn: (args: { model: { id: string } }) => Promise<unknown>) => void
  mockClear: () => void
  mock: { calls: { args: unknown }[] }
}

const FAIL_STATUS = { name: "APIError", statusCode: 429, message: "rate limited" }

function model(id: string, fallback: string[] = [], envKey?: string) {
  return ModelSchema.parse({
    id,
    provider: { api: "test-chain", provider: "test", auth: "none", ...(envKey ? { envKey } : {}) },
    cost: { inputPerMillion: 0, outputPerMillion: 0 },
    contextWindow: { maxTokens: 1000 },
    fallback,
  })
}

function projection(modelId: string): ContextProjection {
  return ContextProjectionSchema.parse({
    version: 1,
    wake: { reason: "prompt", source: "test" },
    history: [],
    self: {
      model: { id: modelId, provider: "test", contextWindow: { maxTokens: 1000 } },
      clock: { wall: "t", monotonicMs: 0, sessionElapsedMs: 0 },
      usage: { turn: 0, toolCallsThisTurn: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cumulativeTokens: 0, estimatedRemaining: 1000, costUsd: 0 },
      cwd: "/tmp",
      permissions: [],
      skills: {},
      session: { id: "t" },
    },
    resources: { maxConcurrentTurns: 1, budget: { maxTurns: 3, maxTurnMs: 1000, maxToolCallsPerTurn: 4 } },
  })
}

function fakeFinish() {
  return {
    fullStream: (async function* () {
      yield { type: "finish", finishReason: "stop", totalUsage: { inputTokens: { total: 100, cacheRead: 40 }, outputTokens: { total: 20 } } }
    })(),
  }
}

registerProvider("test-chain", (m) => ({ id: m.id, name: `provider-${m.id}` }) as never)

describe("fallback 降级链", () => {
  beforeEach(() => {
    mockStream.mockClear()
  })
  it("A 失败(429)→ 沿 fallback 链切到 B,发 model-switched 且成功收尾", async () => {
    mockStream.mockImplementation(async (args: { model: { id: string } }) => {
      if (args.model.id === "A") throw FAIL_STATUS
      return fakeFinish()
    })
    const kernel = createLlmKernel({ catalog: [model("A", ["B"]), model("B")] })
    const events: Array<{ type: string; from?: string; to?: string }> = []
    for await (const e of kernel.stream(projection("A"))) events.push(e as { type: string })
    expect(events.map((e) => e.type)).toEqual(["model-switched", "finish"])
    expect(events[0]).toMatchObject({ type: "model-switched", from: "A", to: "B" })
    expect(mockStream).toHaveBeenCalledTimes(2)
  })

  it("链上全部失败 → 最后一个错误事件(降级耗尽)", async () => {
    mockStream.mockImplementation(async () => {
      throw FAIL_STATUS
    })
    const kernel = createLlmKernel({ catalog: [model("A", ["B"]), model("B")] })
    const events: Array<{ type: string; code?: string }> = []
    for await (const e of kernel.stream(projection("A"))) events.push(e as { type: string; code?: string })
    expect(events.map((e) => e.type)).toEqual(["model-switched", "error"])
    expect(events[1]).toMatchObject({ code: "retryable", retryable: true })
    expect(mockStream).toHaveBeenCalledTimes(2)
  })

  it("cancelled 不降级(中断即止)", async () => {
    mockStream.mockImplementation(async () => {
      throw { name: "AbortError" }
    })
    const kernel = createLlmKernel({ catalog: [model("A", ["B"]), model("B")] })
    const events: Array<{ type: string; code?: string }> = []
    for await (const e of kernel.stream(projection("A"))) events.push(e as { type: string; code?: string })
    expect(events).toEqual([{ type: "error", code: "cancelled", message: "已取消", retryable: false }])
    expect(mockStream).toHaveBeenCalledTimes(1)
  })

  it("成功不降级(finish 即收尾,不探测链上其余模型)", async () => {
    mockStream.mockImplementation(async () => fakeFinish())
    const kernel = createLlmKernel({ catalog: [model("A", ["B"]), model("B")] })
    const events: Array<{ type: string }> = []
    for await (const e of kernel.stream(projection("A"))) events.push(e as { type: string })
    expect(events.map((e) => e.type)).toEqual(["finish"])
    expect(mockStream).toHaveBeenCalledTimes(1)
  })

  it("成功调用后 cacheStats 累计命中(token/缓存读入)", async () => {
    mockStream.mockImplementation(async () => fakeFinish())
    const kernel = createLlmKernel({ catalog: [model("A")] })
    for await (const _ of kernel.stream(projection("A"))) void _
    const stats = kernel.cacheStats()
    expect(stats.calls).toBe(1)
    expect(stats.cachedTokenCandidates).toBe(100)
    expect(stats.cacheReadTokens).toBe(40)
  })

  it("kernel 显式传静默 onError(防 AI SDK 默认 console.error 整坨 dump)", async () => {
    mockStream.mockImplementation(async () => fakeFinish())
    const kernel = createLlmKernel({ catalog: [model("A")] })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    for await (const _ of kernel.stream(projection("A"))) void _
    // 传给 streamText 的 args 携带 onError,且是函数(静默回调)
    const calledArgs = mockStream.mock.calls[0]?.[0] as { onError?: (...a: unknown[]) => void }
    expect(typeof calledArgs.onError).toBe("function")
    errSpy.mockRestore()
  })
})
