// @tau/llm — kernel.ts:LlmKernel 聚合(唯一入口)。
// 唯一职责:ContextProjection → LLM 流。一次 turn 一次 stream;错误事件化;模型切换可见;
// 连续失败沿 Model.fallback 降级链下探(model_switched 事件逐级可见)。

import { jsonSchema, streamText, tool, type LanguageModel, type ModelMessage, type ToolChoice, type ToolSet } from "ai"
import type { ContextProjection, Message, Model, ModelCapabilities, SystemBlock, SystemCall } from "@tau/contract"
import { resolveAuth } from "./auth.ts"
import { promptCache, recordCacheHit, type CacheStats } from "./cache.ts"
import { chatOptionsFor, routeProvider } from "./route.ts"
import { collectStream, errorCodeOf, normalizeStream, type AiStreamPart, type LlmCollectResult, type LlmEvent, type LlmUsage } from "./stream.ts"

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
  /** 事件旁听(complete 的流内事件逐条转发,如 model-switched 供调用方落库/播报)。 */
  onEvent?: (event: LlmEvent) => void
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
  cachePolicy(model: Model): ReturnType<typeof promptCache>
  /** 命中率观测:finish 时累计(供 surface 呈现);读端零副作用。 */
  cacheStats(): CacheStats
  /** 替换目录(动态目录接入点;不传则视为无操作)。id 冲突静态优先,远程补充新模型。 */
  refresh(catalog?: readonly Model[]): void
}

export function createLlmKernel(options: LlmKernelOptions): LlmKernel {
  let catalog = [...options.catalog]
  let lastModelId: string | undefined
  let cacheStats: CacheStats = { calls: 0, cachedTokenCandidates: 0, cacheReadTokens: 0 }

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
    const { key } = resolveAuth(options.getApiKey?.(model) ?? null, model.provider.envKey, envKeys[model.provider.api] ?? "")
    return key
  }

  function buildProvider(model: Model): LanguageModel | null {
    const factory = routeProvider(model.provider)
    if (!factory) return null
    const apiKey = getAuth(model)
    if (apiKey === null && model.provider.auth !== "none") return null
    return factory(model, apiKey ?? "")
  }

  /** 降级链:请求模型 + Model.fallback 声明的备选(去重,按声明序)。 */
  function fallbackChain(model: Model): Model[] {
    const chain: Model[] = [model]
    for (const id of model.fallback) {
      const next = findModel(id)
      if (next && !chain.some((m) => m.id === next.id)) chain.push(next)
    }
    return chain
  }

  function markUsage(usage: LlmUsage): void {
    cacheStats = recordCacheHit(cacheStats, {
      promptTokens: usage.promptTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    })
  }

  async function* runOnce(
    model: Model,
    projection: ContextProjection,
    req: LlmRequest | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<LlmEvent> {
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
      yield normalizeError(error)
      return
    }
    yield* normalizeStream(result.fullStream as AsyncIterable<AiStreamPart>, signal)
  }

  async function* stream(
    projection: ContextProjection,
    req?: LlmRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmEvent> {
    const start = resolveModel(req?.model ?? projection.self.model.id)
    if (!start) {
      yield { type: "error", code: "not_found", message: `模型 ${req?.model ?? projection.self.model.id} 不在目录`, retryable: false }
      return
    }
    const chain = fallbackChain(start)
    if (lastModelId !== undefined && lastModelId !== chain[0]?.id) {
      yield { type: "model-switched", from: lastModelId, to: chain[0]!.id }
    }
    lastModelId = chain[0]!.id
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i]!
      if (i > 0) {
        yield { type: "model-switched", from: chain[i - 1]!.id, to: model.id }
        lastModelId = model.id
      }
      let failed: Extract<LlmEvent, { type: "error" }> | null = null
      for await (const event of runOnce(model, projection, req, signal)) {
        if (event.type === "error") {
          failed = event
          break
        }
        if (event.type === "finish") {
          markUsage(event.usage)
          yield event
          return
        }
        yield event
      }
      if (!failed) return
      if (failed.code === "cancelled" || i === chain.length - 1) {
        yield failed
        return
      }
      // 连续失败 → 沿降级链下探(循环顶部发 model-switched)
    }
  }

  return {
    stream,
    complete: async (projection, req, signal) => {
      const events: LlmEvent[] = []
      for await (const event of stream(projection, req, signal)) {
        events.push(event)
        req?.onEvent?.(event)
      }
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
    cacheStats: () => ({ ...cacheStats }),
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

/** 投影隐藏字段折叠:kernel 是投影 → 模型输入的唯一转换器,system[] 之外的
 * self/wake/resources/pendingSyscalls/recent 也必须送达模型(宪法 5/8 于输入面成立)。 */
export function foldProjectionBlocks(projection: ContextProjection): SystemBlock[] {
  const out: SystemBlock[] = []
  const self = projection.self

  out.push({
    kind: "state",
    priority: 120,
    content: `唤醒:${projection.wake.reason}${projection.wake.source ? `(来源:${projection.wake.source})` : ""}`,
  })

  const selfLines = [
    `模型:${self.model.id}(${self.model.provider}) 上下文窗 ${self.model.contextWindow.maxTokens} tokens${self.model.contextWindow.maxOutputTokens ? ` 输出上限 ${self.model.contextWindow.maxOutputTokens}` : ""}`,
    `时钟:${self.clock.wall}`,
    `用量:turn=${self.usage.turn} 本轮工具调用=${self.usage.toolCallsThisTurn} prompt=${self.usage.promptTokens} completion=${self.usage.completionTokens} 累计=${self.usage.cumulativeTokens} 预计剩余=${self.usage.estimatedRemaining} 成本≈$${self.usage.costUsd}`,
    `cwd:${self.cwd}`,
    self.projectRoot ? `projectRoot:${self.projectRoot}` : "",
    self.git ? `git:${self.git.branch ?? "?"}@${(self.git.commit ?? "?").slice(0, 8)}${self.git.dirty ? " (有未提交改动)" : ""}` : "",
    `会话身份:${self.session.id}${self.session.title ? `「${self.session.title}」` : ""}${self.session.parentId ? `(父:${self.session.parentId})` : ""}`,
    `技能目录:${self.skills.dir ?? "(无)"}${self.skills.names.length > 0 ? ` 已加载:[${self.skills.names.join(", ")}]` : ""}`,
  ]
  if (self.permissions.length > 0) {
    selfLines.push("当前权限规则:")
    for (const rule of self.permissions) {
      selfLines.push(`- ${rule.scope}「${rule.pattern}」→${rule.rule}${rule.reason ? `(${rule.reason})` : ""}`)
    }
  }
  out.push({
    kind: "state",
    priority: 110,
    content: selfLines.filter((line) => line !== "").join("\n"),
  })

  out.push({
    kind: "state",
    priority: 100,
    content: `资源:并发上限=${projection.resources.maxConcurrentTurns} 预算 turns=${projection.resources.budget.maxTurns} turnMs=${projection.resources.budget.maxTurnMs} 每轮工具调用=${projection.resources.budget.maxToolCallsPerTurn} 超限=${projection.resources.onBudgetExceeded} workspaceRoots=[${projection.resources.workspaceRoots.join(", ")}]`,
  })

  if (projection.pendingSyscalls.length > 0) {
    out.push({
      kind: "state",
      priority: 90,
      content: `挂起询问(必须立即应答):\n${projection.pendingSyscalls.map((p) => `- ${p.toolName}(${p.questionId}) 于 ${p.raisedAt}`).join("\n")}`,
    })
  }

  if (projection.recent) {
    out.push({ kind: "state", priority: 80, content: `最近活动:${projection.recent.kind} ${projection.recent.text}` })
  }

  return out
}

/** system[] 折叠 → 按 priority 降序拼接(注入防护条款优先级最高,冲突以后置为准的组装在 session)。 */
export function assembleSystem(projection: ContextProjection): string {
  const ordered = [...projection.system, ...foldProjectionBlocks(projection)].sort((a, b) => b.priority - a.priority)
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
      } else if (block.type === "thinking") {
        // 思路链文本渲染:模型接住自己的推理(部分供应商无独立 reasoning 通道,降级为文本保持连续)
        parts.push({ type: "text", text: `<thinking>\n${block.text}\n</thinking>` })
      } else if (block.type === "artifact") {
        // 大载荷引用:正文存 store,模型侧只见引用元数据,按需经 artifact:read 取回
        const meta = `[artifact:ref ${block.ref}${block.size !== undefined ? ` size=${block.size}` : ""}${block.hash !== undefined ? ` hash=${block.hash}` : ""}]`
        parts.push({ type: "text", text: meta })
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

/** 同步构造错误归一(streamText 构造期抛错不发流)。与流中 error 共用错误码映射。 */
function normalizeError(error: unknown): Extract<LlmEvent, { type: "error" }> {
  const anyError = error as { name?: string; message?: string }
  if (anyError?.name === "AbortError") return { type: "error", code: "cancelled", message: "已取消", retryable: false }
  const { code, retryable } = errorCodeOf(error)
  return { type: "error", code, message: anyError?.message ?? String(error), retryable }
}
