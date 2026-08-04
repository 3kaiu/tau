# @tau/llm — 宿主内核(薄)

## 使命
唯一职责:把 `ContextProjection` 变成 LLM 流。薄、可换、不感知上层。

## 功能(公开 API 面)
- `createLlmKernel(opts)` → `LlmKernel`
- `kernel.stream(projection, req)` → `AsyncGenerator<LlmEvent>`(text/thinking/toolCall 增量);`req` 含 temperature/thinking 开关/工具策略(模型可表达"低温度快速答")
- `kernel.complete(projection, req)` → 完整结果
- `kernel.models()` / `kernel.getModel(provider, id)` — 模型目录读取(同步)
- `kernel.features(model)` → `ModelCapabilities` — 能力面(supportsTools/thinking/parallel/vision/streaming),投影裁剪依据
- `kernel.fallbackChain(model)` — **降级链**:模型声明降级备选(同供应商失败优先同门,逐级下探);连续失败熔断阈值(默认 N 次)→ 自动降级 → `model_switched` 事件 + 投影告警(模型知道"我是谁变了、为何降级")
- `kernel.refresh()` — 动态目录刷新
- `kernel.getAuth(model)` — 动态凭据解析(env/存储/OAuth,可过期刷新)
- 错误以事件返回(`error`/`aborted`),不 throw 出流
- **模型切换事件**:provider 故障转移/手动切换 → `model_switched` 事件(模型知道"我是谁变了")

## 宪法
1. **无业务语义**:不懂工具循环、不懂压缩、不懂会话
2. **一次 turn 一次 stream**:编排层每轮恰好调用一次 `stream`,禁止拆包/合并
3. **不隐藏重试**:重试策略是 orchestrate 的职责,llm 只报告失败;错误事件带 `retryable` 标注(429/5xx/超时可重试;400/401 不可)
4. **懒加载**:供应商 SDK 子路径导入,启动零加载
5. **标准端点直连**:支持任意 OpenAI 兼容 baseURL(自有网关/代理经标准配置接入),不绑定任何私有网关;协议面锁定 chat/completions(见"协议决策"节),responses 协议禁止默认启用
6. **不记录任何内容**:上下文与输出不落盘(llm 无存储)
7. **thinking 块策略**:thinking 默认进历史(模型接住思路),设体积上限,超限转摘要

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/kernel.ts` | LlmKernel 聚合(唯一入口) |
| `src/stream.ts` | AI SDK 流 → LlmEvent 归一化 |
| `src/providers/` | 每供应商一文件,子路径懒加载 |
| `src/route.ts` | 模型 → 供应商路由 |
| `src/cache.ts` | prompt cache 策略位(缓存命中率可观测) |
| `src/endpoint.ts` | 端点解析:AI SDK baseURL / 系统 HTTP(S)_PROXY 透传 |
| `src/auth.ts` | 凭据解析(env → 存储 → OAuth) |
| `src/fallback.ts` | 降级链与熔断(阈值/状态/事件化) |
| `src/catalog-remote.ts` | 远程目录(models.opencode.ai/api.json)映射与拉取 |

## 模块宪法要点
- `stream.ts`:所有供应商的输出必须归一为同一事件集,供应商差异封死在适配器内
- `route.ts`:路由决定权在契约(模型声明 api),不做启发式猜测
- `fallback.ts`:降级链由模型元数据声明(不是启发式);熔断状态可观测(连续失败计数进事件);降级必经 `model_switched` 事件,不静默切换
- `cache.ts`:只输出缓存策略与命中率指标,不干预会话

## 开源依赖
- `ai@7.0.51`(Vercel AI SDK):统一流协议,供应商适配持续跟进
- `@ai-sdk/openai-compatible@3.0.22`:OpenAI 兼容端点(模型规格 v4,匹配 ai 7;reasoning part 双向 + reasoningEffort + cacheRead 原生解析)。opencode 官方对 zen 亦走此包(interleaved reasoning_content),是思考流的官方通道(见"协议决策"节)
- 官方国产包(思考语义在包内,不自造适配器):
  - `@ai-sdk/deepseek@3.0.21`:thinking{type: adaptive/enabled/disabled} + reasoningEffort(low~max);V4 模型空 reasoning 自动补 `""` 回传(工具调用 400 防线)
  - `@ai-sdk/alibaba@2.0.24`:enableThinking + thinkingBudget → enable_thinking/thinking_budget;**preserve_thinking(qwen3.8)包不支持**,缺口待官方升包或自研透传
  - `@ai-sdk/moonshotai@3.0.25`:thinking{type, budgetTokens} + reasoningHistory(interleaved/preserved/disabled) + reasoning_tokens usage 拆分
  - `@ai-sdk/minimax@3.0.5`:复用 `@ai-sdk/anthropic`(Anthropic 协议,api.minimax.io/anthropic/v1),thinking{type: adaptive/disabled}
- zai/zhipuai(GLM)无官方包,社区包质量差(≤21 stars):走 openai-compatible + providerOptions.zai 透传 `thinking:{type, clear_thinking:false}`
- 供应商适配包(@ai-sdk/*)按需引入;自有网关经 OpenAI 兼容 baseURL 配置,零绑定
- `@ai-sdk/anthropic@4.0.29`:Anthropic 协议通道(Claude 系 thinking enabled+budgetTokens;kimi-coding 走 adaptive+summarized)

## 通道与端点(zen/go/coding-plan/token-plan)
- **协议二分法**:所有非官方端点 = OpenAI 兼容(zen/zen-go/zai-coding-plan/zhipuai-coding-plan/alibaba-coding-plan/alibaba-token-plan/tencent-coding-plan/tencent-token-plan)或 Anthropic 兼容(kimi-for-coding/minimax-coding-plan);契约声明 baseUrl+envKey 即接入,零新代码
- 已注册 api:`openai-compatible`/`openai`/`deepseek`/`alibaba`/`moonshot`/`minimax`/`zai`/`anthropic`/`kimi-coding`
- 端点清单(官方 models-api 实证):zen `opencode.ai/zen/v1`(OPENCODE_API_KEY)、go `opencode.ai/zen/go/v1`(OPENCODE_API_KEY)、zai-coding-plan `api.z.ai/api/coding/paas/v4`(ZHIPU_API_KEY)、alibaba-coding-plan `coding-intl.dashscope.aliyuncs.com/v1`、tencent-coding-plan `api.lkeap.cloud.tencent.com/coding/v3`、kimi-for-coding `api.kimi.com/coding/v1`(KIMI_API_KEY)、minimax-coding-plan `api.minimax.io/anthropic/v1`
- kimi-coding 通道思考固定 `adaptive+summarized` + `effort: high`(参考 opencode transform.ts;opencode 按 isKimiFamily 判断,tau 按 api 声明——路由决定权在契约)

## 动态目录(models.opencode.ai/api.json)
- 数据源公开(opencode 官方,180+ 供应商,CORS 全开);`fetchRemoteCatalog()` 拉取 → `modelsApiToCatalog()` 映射 → `kernel.refresh(catalog)` 替换
- 只映射已注册通道;opencode 官方数据将 deepseek/moonshot/alibaba 标 openai-compatible,映射时按 provider 名分流到 tau 官方包通道(thinking 语义更完整)
- 映射字段:reasoning→supportsThinking、tool_call→supportsTools、attachment→supportsVision、limit→contextWindow、cost(input/output/cache_read,美元/MTok 与契约同单位)

## ai@7 契约(踩坑锁定,改版本必须先重验)
- 工具 schema 必须经 `inputSchema: jsonSchema(jsonSchemaObject)` 注入:核心只读 `tool.inputSchema`;直接传裸对象会被序列化成空 schema
- fullStream part 契约(v4 规格):`text-delta.text`(非 textDelta)、`reasoning-start|reasoning-end|reasoning-delta`(字段 `text`)、工具参数增量 = `tool-input-start|tool-input-delta|tool-input-end`(字段 `delta`)、`finish.totalUsage`(用量在 `finish-step.usage`)、`start-step`/`finish-step`;step-start/step-finish/tool-call-delta/reasoning 均为旧名,已失效
- 消息 part 契约:tool-call 用 `{ type:"tool-call", toolCallId, toolName, input }`;tool-result 用 `{ type:"tool-result", toolCallId, toolName, output:{ type:"text"|"json", value } }`
- usage 契约(v4):`inputTokens{total,noCache,cacheRead,cacheWrite}` + `outputTokens{total,reasoning,text}` → 归一 LlmUsage(promptTokens/completionTokens/totalTokens/reasoningTokens/cacheReadTokens/cacheWriteTokens)
- 请求级厂商差异经 `providerOptions` 下发,通道映射集中在 route.ts 的 CHAT_OPTIONS_FACTORIES(差异封死适配器内,kernel 不感知)

## 协议决策:Open Reasoning / Responses 调研结论(2026-08-05,实证)

**背景**:评估是否改用 OpenAI Responses 协议(`/v1/responses`,即"Open Reasoning API")获取思考流。

**结论:默认协议锁定 chat/completions + `reasoning_content`,不启用 responses 协议。** 现状(openai-compatible + reasoning→thinking-delta)即 opencode 官方对 zen 的做法,无需切换。

证据链(全部实测/源码核实):
1. **zen(`opencode.ai/zen/v1`)responses 端点残缺**:
   - 实测有 `output_text.delta` 与 `function_call`(`output_item.added` + `function_call_arguments.delta`)事件,但**无任何 reasoning 事件**(无 `reasoning_text.delta`),也无栅栏事件(`response.created` / `content_part.added|done`)。
   - 后果:`@ai-sdk/openai` v6 解析后文本为空(usage 正常、文本零输出);opencode-x 自家 parser(`packages/llm/src/protocols/openai-responses.ts`)可直接消费 `output_text.delta` 而不依赖栅栏,但同样拿不到 reasoning。
2. **opencode 官方对 zen 的连接方式 = chat/completions**:models-api 元数据 `"npm": "@ai-sdk/openai-compatible"`、`interleaved: { field: "reasoning_content" }`;`deepseek-v4-flash-free` 官方标注 reasoning: true(思考经 reasoning_content 内联返回)。
3. **DeepSeek 原生 responses(`api.deepseek.com/responses`)**:有专用 `response.reasoning_text.delta` 通道(为 Codex 兼容而生),但 stateless、无 `[DONE]`(以 `response.completed` 终止)、仅支持付费 `deepseek-v4-flash`(Pro 2026-08 初),zen free 不在其列;裸 SSE 手动适配已验证可行(~60 行,text/工具参数/usage 均可解析)。
4. **国产思考语义由官方包承载(2026-08-05 升级后)**:
   - deepseek:thinking 开关 + reasoningEffort + 空 reasoning 补全(`isDeepSeekV4`)——对应 DeepSeek 官方"思考模式工具调用必须回传 reasoning_content,否则 400"的约束
   - alibaba:enableThinking/thinkingBudget(思考模式下 temperature/top_p 被忽略的语义由厂商文档约束)
   - moonshot:reasoning_history 三态(interleaved 交错回传 / preserved 保序回传 / disabled),kimi 思考模式经预算控制
   - minimax:Anthropic 协议,thinking adaptive/disabled
   - zai:无官方包,providerOptions 透传 `thinking:{type:"enabled"|"disabled", clear_thinking:false}`(GLM 思考块必须回传,clear_thinking 固定 false)

**由此锁定的约束**:
- 思考流只从 chat/completions 的 `reasoning_content` 获取;`reasoning_content` 与 `content` 是两个独立 delta 字段,必须独立累积、独立转发,不得混入文本(stream.ts 现有 `reasoning-delta` → `thinking-delta` 归一即此语义)。
- 若未来要接 DeepSeek 原生 responses(付费)的 thinking delta,须自研裸 SSE 适配器(不用 `@ai-sdk/openai` 的 responses 客户端,其解析器要求 zen/DeepSeek 不提供的栅栏事件),且只对 paid 模型开放。
- 任何供应商若宣称支持 responses 协议,接入前必须实测三条:reasoning 事件存在性、栅栏事件齐全性、`[DONE]`/终止语义;缺任一条按残缺端点降级为 chat/completions 或拒绝接入。
- 错误码:402 = 余额不足(`insufficient_funds`,不可重试);`insufficient_system_resource`/`overloaded` 消息 → `overloaded`(可重试,错峰)。

## 性能与算法
- 流式透传:供应商增量直接转发为事件,禁止缓冲全量(长响应内存恒定)
- 工具参数增量解析:部分 JSON 增量解(AI SDK 原生),工具调用"可达即发"
- 懒加载 + 并发上限:供应商 SDK 子路径按需导入;并发请求走 limiter
- 超时分级可配置:首 token 时间 / 流空闲超时,便于网络面映射
- 缓存意识:usage 归一后 cacheReadTokens/cacheWriteTokens 进 LlmUsage,命中率可观测(DeepSeek 缓存命中价差 50 倍,峰谷 2 倍价)

## 多语言
- LLM HTTP API 是标准协议,本包即"TS 参考实现",适配模式可移植
- 行为规范(归一事件集/错误语义/重试建议)文档化,其他语言可重实现等价适配层
- 供应商差异表(哪些参数/能力不通用)随文档维护,供任何宿主查询;协议级差异(如 responses 端点残缺)见"协议决策"节

## 边界(明确不做)
不做模型目录生成(用 AI SDK 生态)、不做成本记账(那是会话/UI 的投影)、不做供应商 UI。
