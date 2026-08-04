// @tau/eval - faux.ts:FauxLlm 脚本化 LLM。
// 离线确定性:无网络,同输入同输出;回复序列用声明式脚本,不带随机性。
// 实现 LlmKernel 契约,与 llm 包对齐;支持错误注入(429/超时)、abort 模拟。

import type { ContextProjection, Model, ModelCapabilities } from "@tau/contract"
import type { ErrorCode } from "@tau/contract"
import type { LlmKernel, LlmRequest, LlmCollectResult, LlmEvent, LlmUsage } from "@tau/llm"
import type { CachePolicy } from "@tau/llm"

/** 单条预设回复:映射到 LlmCollectResult 的子集。 */
export type FauxReply = {
  text?: string
  thinking?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  usage?: Partial<LlmUsage>
  finishReason?: string
  error?: { code: ErrorCode; message: string; retryable: boolean }
  aborted?: boolean
}

/** FauxLlm 脚本:按序消费的回复序列。 */
export type FauxScript = {
  replies: FauxReply[]
  model?: Model
}

const FAUX_MODEL: Model = {
  id: "faux-1",
  name: "FauxLlm(测试用)",
  provider: { api: "openai-compatible", provider: "faux", envKey: "", auth: "none" },
  capabilities: { supportsTools: true, supportsThinking: false, supportsParallelCalls: true, supportsVision: false, supportsStreaming: true },
  cost: { inputPerMillion: 0, outputPerMillion: 0 },
  contextWindow: { maxTokens: 128_000 },
  fallback: [],
}

const FAUX_CACHE: CachePolicy = "none"

export function createFauxLlm(script: FauxScript): LlmKernel {
  const model = script.model ?? FAUX_MODEL
  let cursor = 0

  function nextReply(): FauxReply {
    if (cursor >= script.replies.length) {
      return { text: "(FauxLlm 脚本耗尽)", finishReason: "stop" }
    }
    return script.replies[cursor++]!
  }

  function toResult(reply: FauxReply): LlmCollectResult {
    const usage: LlmUsage | undefined = reply.usage
      ? {
          promptTokens: reply.usage.promptTokens ?? 10,
          completionTokens: reply.usage.completionTokens ?? 5,
          totalTokens: reply.usage.totalTokens ?? 15,
          ...(reply.usage.reasoningTokens !== undefined ? { reasoningTokens: reply.usage.reasoningTokens } : {}),
        }
      : undefined

    return {
      text: reply.text ?? "",
      thinking: reply.thinking ?? "",
      toolCalls: reply.toolCalls ?? [],
      usage,
      finishReason: reply.finishReason ?? (reply.error !== undefined ? "error" : reply.aborted ? "aborted" : "stop"),
      error: reply.error,
      aborted: reply.aborted ?? false,
    }
  }

  return {
    async* stream(projection: ContextProjection, req?: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
      void projection
      void req
      if (signal?.aborted) {
        yield { type: "aborted" }
        return
      }
      const reply = nextReply()
      if (reply.error) {
        yield { type: "error", code: reply.error.code, message: reply.error.message, retryable: reply.error.retryable }
        return
      }
      if (reply.aborted) {
        yield { type: "aborted" }
        return
      }
      if (reply.text) {
        yield { type: "text-delta", text: reply.text }
      }
      if (reply.thinking) {
        yield { type: "thinking-delta", text: reply.thinking }
      }
      for (const tc of reply.toolCalls ?? []) {
        yield { type: "tool-call", id: tc.id, name: tc.name, args: tc.args }
      }
      yield {
        type: "finish",
        finishReason: reply.finishReason ?? "stop",
        usage: reply.usage
          ? {
              promptTokens: reply.usage.promptTokens ?? 10,
              completionTokens: reply.usage.completionTokens ?? 5,
              totalTokens: reply.usage.totalTokens ?? 15,
            }
          : { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }
    },

    async complete(projection: ContextProjection, req?: LlmRequest, signal?: AbortSignal): Promise<LlmCollectResult> {
      void projection
      void req
      if (signal?.aborted) {
        return { text: "", thinking: "", toolCalls: [], usage: undefined, finishReason: "aborted", error: undefined, aborted: true }
      }
      return toResult(nextReply())
    },

    models: () => [model],
    getModel: (provider, id) => (provider === model.provider.provider && id === model.id ? model : null),
    features: (_m: Model): ModelCapabilities => model.capabilities,
    getAuth: () => "faux-key",
    cachePolicy: () => FAUX_CACHE,
    refresh: () => {},
  }
}

/** 快捷构造:文本回复。 */
export function textReply(text: string, usage?: Partial<LlmUsage>): FauxReply {
  return usage !== undefined ? { text, usage } : { text }
}

/** 快捷构造:工具调用回复。 */
export function toolReply(toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>, usage?: Partial<LlmUsage>): FauxReply {
  return usage !== undefined ? { toolCalls, usage, finishReason: "tool-calls" } : { toolCalls, finishReason: "tool-calls" }
}

/** 快捷构造:错误回复(用于验证 retry)。 */
export function errorReply(code: ErrorCode, message: string, retryable: boolean): FauxReply {
  return { error: { code, message, retryable } }
}

/** 快捷构造:abort 回复。 */
export function abortedReply(): FauxReply {
  return { aborted: true }
}
