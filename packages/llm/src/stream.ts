// @tau/llm — stream.ts:AI SDK 流 → LlmEvent 归一化。
// 所有供应商的输出归一为同一事件集,差异封死在适配器内;错误事件化,不 throw。

import type { ErrorCode } from "@tau/contract"

export type LlmUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type LlmEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-delta"; id: string; name: string; argsDelta: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "usage"; usage: LlmUsage }
  | { type: "finish"; finishReason: string; usage: LlmUsage }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean }
  | { type: "aborted" }
  | { type: "model-switched"; from: string; to: string }

/** AI SDK fullStream 部分的宽结构(跨版本兼容:textDelta/argsTextDelta 命名漂移)。
 * ai@7 契约:tool-call 增量 = tool-input-delta(delta);finish 用量 = totalUsage。 */
export type AiStreamPart = {
  type: string
  textDelta?: string
  text?: string
  argsTextDelta?: string
  argsDelta?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  input?: unknown
  finishReason?: string
  usage?: Partial<LlmUsage>
  totalUsage?: Partial<LlmUsage>
  error?: unknown
  value?: unknown
}

/** 错误码映射:429/5xx/超时 → retryable;400/401/404 → 不可重试(换工具/问用户);
 * 402 → insufficient_funds(DeepSeek 等以 402 表余额不足);insufficient_system_resource → overloaded。 */
export function errorCodeOf(error: unknown): { code: ErrorCode; retryable: boolean } {
  const anyError = error as { statusCode?: unknown; status?: unknown; isTimeout?: unknown; name?: unknown; message?: string }
  if (anyError?.isTimeout === true) return { code: "timeout", retryable: true }
  const status = Number(anyError?.statusCode ?? anyError?.status ?? 0)
  if (status === 402) return { code: "insufficient_funds", retryable: false }
  const message = anyError?.message ?? ""
  if (/insufficient_system_resource|overloaded|资源不足|繁忙/i.test(message)) return { code: "overloaded", retryable: true }
  if (status === 429) return { code: "retryable", retryable: true }
  if (status >= 500 && status < 600) return { code: "retryable", retryable: true }
  if (status === 401 || status === 403) return { code: "permission_denied", retryable: false }
  if (status === 404) return { code: "not_found", retryable: false }
  if (status === 408) return { code: "timeout", retryable: true }
  if (anyError?.name === "AbortError") return { code: "cancelled", retryable: false }
  return { code: "internal", retryable: false }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function usageOf(usage: Partial<LlmUsage> | undefined): LlmUsage {
  return {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  }
}

/** ai@7 LanguageModelUsage(inputTokens/outputTokens 嵌套)→ 归一 LlmUsage。 */
export function usageOfV4(usage: { inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number }; outputTokens?: { total?: number; reasoning?: number; text?: number } } | undefined): LlmUsage {
  const input = usage?.inputTokens
  const output = usage?.outputTokens
  return {
    promptTokens: input?.total ?? 0,
    completionTokens: output?.total ?? 0,
    totalTokens: (input?.total ?? 0) + (output?.total ?? 0),
    ...(output?.reasoning !== undefined ? { reasoningTokens: output.reasoning } : {}),
    ...(input?.cacheRead !== undefined ? { cacheReadTokens: input.cacheRead } : {}),
    ...(input?.cacheWrite !== undefined ? { cacheWriteTokens: input.cacheWrite } : {}),
  }
}

/** AI SDK fullStream → LlmEvent 增量流。text 与 tool-call 到达即发,不做整段缓冲。 */
export async function* normalizeStream(parts: AsyncIterable<AiStreamPart>, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
  try {
    for await (const part of parts) {
      if (signal?.aborted) {
        yield { type: "aborted" }
        return
      }
      switch (part.type) {
        case "text-delta": {
          const text = part.text ?? part.textDelta ?? ""
          if (text !== "") yield { type: "text-delta", text }
          break
        }
        case "reasoning-delta": {
          const text = part.text ?? part.textDelta ?? ""
          if (text !== "") yield { type: "thinking-delta", text }
          break
        }
        case "tool-input-delta":
        case "tool-call-delta": {
          const delta = part.delta ?? part.argsTextDelta ?? part.argsDelta ?? ""
          if (delta !== "" && part.toolCallId && part.toolName) {
            yield { type: "tool-call-delta", id: part.toolCallId, name: part.toolName, argsDelta: delta }
          }
          break
        }
        case "tool-call": {
          if (part.toolCallId && part.toolName) {
            yield { type: "tool-call", id: part.toolCallId, name: part.toolName, args: part.input ?? part.args ?? {} }
          }
          break
        }
        case "finish": {
          yield {
            type: "finish",
            finishReason: part.finishReason ?? "unknown",
            usage: part.totalUsage ? usageOfV4(part.totalUsage as Parameters<typeof usageOfV4>[0]) : usageOf(part.usage),
          }
          return
        }
        case "error": {
          const { code, retryable } = errorCodeOf(part.error)
          yield { type: "error", code, message: errorMessage(part.error), retryable }
          return
        }
        case "reasoning-start":
        case "reasoning-end":
        case "tool-input-start":
        case "tool-input-end":
        case "start-step":
        case "finish-step":
        case "abort":
        case "start":
          break
        default:
          break
      }
    }
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === "AbortError") {
      yield { type: "aborted" }
      return
    }
    const { code, retryable } = errorCodeOf(error)
    yield { type: "error", code, message: errorMessage(error), retryable }
  }
}

/** 聚合流为完整结果:文本拼接 + 工具调用 + 用量 + 终态。 */
export async function collectStream(stream: AsyncGenerator<LlmEvent>): Promise<LlmCollectResult> {
  let text = ""
  let thinking = ""
  const toolCalls: Array<{ id: string; name: string; args: unknown }> = []
  let usage: LlmUsage | undefined
  let finishReason: string | undefined
  let error: { code: ErrorCode; message: string; retryable: boolean } | undefined
  let aborted = false
  for await (const event of stream) {
    switch (event.type) {
      case "text-delta":
        text += event.text
        break
      case "thinking-delta":
        thinking += event.text
        break
      case "tool-call":
        toolCalls.push({ id: event.id, name: event.name, args: event.args })
        break
      case "tool-call-delta":
        break
      case "usage":
        usage = event.usage
        break
      case "finish":
        finishReason = event.finishReason
        usage = event.usage
        break
      case "error":
        error = event
        break
      case "aborted":
        aborted = true
        break
      case "model-switched":
        break
      default: {
        const _exhaustive: never = event
        break
      }
    }
  }
  return { text, thinking, toolCalls, usage, finishReason, error, aborted }
}

export type LlmCollectResult = {
  text: string
  thinking: string
  toolCalls: Array<{ id: string; name: string; args: unknown }>
  usage: LlmUsage | undefined
  finishReason: string | undefined
  error: { code: ErrorCode; message: string; retryable: boolean } | undefined
  aborted: boolean
}
