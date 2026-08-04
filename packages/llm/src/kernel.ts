// @tau/llm — kernel.ts:LlmKernel 聚合(唯一入口)。
// 唯一职责:ContextProjection → LLM 流。一次 turn 一次 stream;错误事件化;模型切换可见。

import { jsonSchema, streamText, tool, type LanguageModel, type ModelMessage, type ToolChoice, type ToolSet } from "ai"
import type { ContextProjection, Message, Model, ModelCapabilities, SystemCall } from "@tau/contract"
import { resolveApiKey } from "./auth.ts"
import { promptCache, type CachePolicy } from "./cache.ts"
import { chatOptionsFor, routeProvider } from "./route.ts"
import { collectStream, normalizeStream, type AiStreamPart, type LlmCollectResult, type LlmEvent } from "./stream.ts"

export type LlmRequest = {
  /** 模型 id(缺省用投影 self.model.id)。 */
  model?: string
  temperature?: number
  thinking?: boolean
  /** 思考努力度(deepseek 等支持):low/medium/high/xhigh/max。 */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"
  /** 思考预算 token(kimi 等支持)。 */
  thinkingBudgetTokens?: number
  maxOutputTokens?: number
  toolChoice?: "auto" | "none" | "required" | { name: string }
}

export type LlmKernelOptions = {
  readonly catalog: readonly Model[]
  /** 显式凭据解析(env → 存储 → OAuth 的扩展点);缺省走 env。 */
  getApiKey?: (model: Model) => string | null | undefined
  /** 缺省 API 环境变量名映射,key 为契约 api。 */
  envKeys?: Partial<Record<string, string>>
}

const DEFAULT_ENV_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
}

export interface LlmKernel {
  stream(projection: ContextProjection, req?: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmEvent>
  complete(projection: ContextProjection, req?: LlmRequest, signal?: AbortSignal): Promise<LlmCollectResult>
  models(): readonly Model[]
  getModel(provider: string, id: string): Model | null
  features(model: Model): ModelCapabilities
  getAuth(model: Model): string | null
  cachePolicy(model: Model): CachePolicy
  /** 替换目录(动态目录接入点;不传则视为无操作)。id 冲突静态优先,远程补充新模型。 */
  refresh(catalog?: readonly Model[]): void
}

export function createLlmKernel(options: LlmKernelOptions): LlmKernel {
  let catalog = [...options.catalog]
  let lastModelId: string | undefined

  const envKeys = { ...DEFAULT_ENV_KEYS, ...options.envKeys }

  function findModel(id: string): Model | null {
    return catalog.find((m) => m.id === id) ?? null
  }

  function resolveModel(requested: string | undefined): Model | null {
    if (requested) {
      const exact = findModel(requested)
      if (exact) return exact
      return null
    }
    return catalog[0] ?? null
  }

  function getAuth(model: Model): string | null {
    const explicit = options.getApiKey?.(model)
    return resolveApiKey(explicit ?? null, model.provider.envKey, envKeys[model.provider.api] ?? "")
  }

  function buildProvider(model: Model): LanguageModel | null {
    const factory = routeProvider(model.provider)
    if (!factory) return null
    const apiKey = getAuth(model)
    if (apiKey === null && model.provider.auth !== "none") return null
    return factory(model, apiKey ?? "")
  }

  async function* stream(
    projection: ContextProjection,
    req?: LlmRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmEvent> {
    const model = resolveModel(req?.model ?? projection.self.model.id)
    if (!model) {
      yield { type: "error", code: "not_found", message: `模型 ${req?.model ?? projection.self.model.id} 不在目录`, retryable: false }
      return
    }
    if (lastModelId !== undefined && lastModelId !== model.id) {
      yield { type: "model-switched", from: lastModelId, to: model.id }
    }
    lastModelId = model.id
    const provider = buildProvider(model)
    if (!provider) {
      yield { type: "error", code: "permission_denied", message: `模型 ${model.id} 缺凭据`, retryable: false }
      return
    }
    const system = assembleSystem(projection)
    const messages = toAiMessages(projection.history)
    const tools = projection.tools.length > 0 ? toToolSet(projection.tools) : undefined

    const args: Parameters<typeof streamText>[0] = {
      model: provider,
      system,
      messages: messages as unknown as ModelMessage[],
    }
    if (tools) args.tools = tools
    if (req?.toolChoice) args.toolChoice = req.toolChoice as ToolChoice<ToolSet>
    if (req?.temperature !== undefined) args.temperature = req.temperature
    if (req?.maxOutputTokens !== undefined) args.maxOutputTokens = req.maxOutputTokens
    if (signal) args.abortSignal = signal
    const providerOptions = chatOptionsFor(model.provider, req ?? {})
    if (providerOptions) {
      args.providerOptions = providerOptions as unknown as NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>
    }
    let result: { fullStream: AsyncIterable<unknown> }
    try {
      result = await streamText(args)
    } catch (error) {
      const event = normalizeError(error)
      yield event
      return
    }
    yield* normalizeStream(result.fullStream as AsyncIterable<AiStreamPart>, signal)
  }

  return {
    stream,
    complete: async (projection, req, signal) => {
      const events: LlmEvent[] = []
      for await (const event of stream(projection, req, signal)) events.push(event)
      const { text, thinking, toolCalls, usage, finishReason, error, aborted } = await collectStream(
        async function* () {
          yield* events
        }(),
      )
      return { text, thinking, toolCalls, usage, finishReason, error, aborted }
    },
    models: () => catalog,
    getModel: (provider, id) => {
      const found = catalog.find((m) => m.provider.provider === provider && m.id === id)
      return found ?? null
    },
    features: (model) => model.capabilities,
    getAuth,
    cachePolicy: (model) => promptCache(model.provider.api),
    refresh: (next) => {
      // 合并而非替换:id 冲突静态优先(会话当前模型不因远程缺失而失效),远程补充新模型
      if (next && next.length > 0) {
        const known = new Set(catalog.map((m) => m.id))
        catalog = [...catalog, ...next.filter((m) => !known.has(m.id))]
      }
      lastModelId = undefined
    },
  }
}

/** system[] 按 priority 降序拼接(注入防护条款优先级最高,冲突以后置为准的组装在 session)。 */
export function assembleSystem(projection: ContextProjection): string {
  const ordered = [...projection.system].sort((a, b) => b.priority - a.priority)
  return ordered.map((block) => block.content).join("\n\n")
}

/** 契约 Message → AI SDK 消息。tool 消息 content 为 ToolResult 的 JSON 表示。
 * 未配对的 toolCall(被 interrupted 截断)过滤掉——损坏输入会被供应商拒绝。 */
export function toAiMessages(history: readonly Message[]): Array<Record<string, unknown>> {
  const answered = new Set<string>()
  for (const m of history) for (const ref of m.toolResults) answered.add(ref.callId)
  const messages: Array<Record<string, unknown>> = []
  for (const message of history) {
    const parts: Array<Record<string, unknown>> = []
    for (const block of message.content) {
      if (block.type === "text") {
        if (message.role === "system") {
          parts.push({ type: "text", text: `<system-update>\n${block.text}\n</system-update>` })
        } else {
          parts.push({ type: "text", text: block.text })
        }
      } else if (block.type === "image") {
        if (block.url) parts.push({ type: "image", image: block.url })
        else if (block.base64) parts.push({ type: "image", image: `data:image/png;base64,${block.base64}` })
      }
    }
    for (const call of message.toolCalls) {
      if (!answered.has(call.id)) continue
      parts.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.arguments })
    }
    if (message.role === "tool") {
      for (const ref of message.toolResults) {
        const name = history.find((m) => m.toolCalls.some((c) => c.id === ref.callId))?.toolCalls.find((c) => c.id === ref.callId)?.name ?? ""
        const output = ref.result
          ? { type: "json", value: { exitCode: ref.result.exitCode, stdout: ref.result.stdout, stderr: ref.result.stderr, truncated: ref.result.truncated, totalPages: ref.result.totalPages, page: ref.result.page } }
          : ref.error
            ? { type: "text", value: `${ref.error.code}: ${ref.error.message}` }
            : { type: "json", value: {} }
        parts.push({ type: "tool-result", toolCallId: ref.callId, toolName: name, output })
      }
    }
    messages.push({ role: message.role, content: parts })
  }
  return messages
}

/** 契约 SystemCall(parameters 即 JSON Schema)→ AI SDK ToolSet。 */
export function toToolSet(tools: readonly SystemCall[]): ToolSet {
  const out: ToolSet = {}
  for (const call of tools) {
    out[call.name] = tool({
      description: call.description,
      inputSchema: jsonSchema(call.parameters as never),
      ...(call.maxOutputTokens !== undefined ? { maxOutputTokens: call.maxOutputTokens } : {}),
    })
  }
  return out
}

/** 同步构造错误归一(streamText 构造期抛错不发流)。 */
function normalizeError(error: unknown): Extract<LlmEvent, { type: "error" }> {
  const anyError = error as { name?: string; message?: string }
  if (anyError?.name === "AbortError") return { type: "error", code: "cancelled", message: "已取消", retryable: false }
  return { type: "error", code: "internal", message: anyError?.message ?? String(error), retryable: false }
}
