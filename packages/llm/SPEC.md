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

## 模块宪法要点
- `stream.ts`:所有供应商的输出必须归一为同一事件集,供应商差异封死在适配器内
- `route.ts`:路由决定权在契约(模型声明 api),不做启发式猜测
- `fallback.ts`:降级链由模型元数据声明(不是启发式);熔断状态可观测(连续失败计数进事件);降级必经 `model_switched` 事件,不静默切换
- `cache.ts`:只输出缓存策略与命中率指标,不干预会话

## 开源依赖
- `ai`(Vercel AI SDK):统一流协议,供应商适配持续跟进
- `@ai-sdk/openai-compatible@^2`:OpenAI 兼容端点;固定 2.x(模型规格 v3,匹配 ai 6;3.x 发 v4 不兼容)。opencode 官方对 zen 亦走此包(interleaved reasoning_content),是思考流的官方通道(见"协议决策"节)
- 供应商适配包(@ai-sdk/*)按需引入;自有网关经 OpenAI 兼容 baseURL 配置,零绑定

## ai@6 契约(踩坑锁定,改版本必须先重验)
- 工具 schema 必须经 `inputSchema: jsonSchema(jsonSchemaObject)` 注入:ai 6 核心只读 `tool.inputSchema`;直接传 `parameters` 或裸对象会被序列化成空 schema(`{"properties":{}}`),模型只能发空参数工具调用
- fullStream 工具调用 part 的参数字段是 `input`,不是 `args`(v5 命名);增量 part 是 `tool-input-delta`(`inputTextDelta`),不是 `tool-call-delta`
- 消息 part 契约:tool-call 用 `{ type:"tool-call", toolCallId, toolName, input }`;tool-result 用 `{ type:"tool-result", toolCallId, toolName, output:{ type:"text"|"json", value } }`

## 协议决策:Open Reasoning / Responses 调研结论(2026-08-05,实证)

**背景**:评估是否改用 OpenAI Responses 协议(`/v1/responses`,即"Open Reasoning API")获取思考流。

**结论:默认协议锁定 chat/completions + `reasoning_content`,不启用 responses 协议。** 现状(openai-compatible + reasoning→thinking-delta)即 opencode 官方对 zen 的做法,无需切换。

证据链(全部实测/源码核实):
1. **zen(`opencode.ai/zen/v1`)responses 端点残缺**:
   - 实测有 `output_text.delta` 与 `function_call`(`output_item.added` + `function_call_arguments.delta`)事件,但**无任何 reasoning 事件**(无 `reasoning_text.delta`),也无栅栏事件(`response.created` / `content_part.added|done`)。
   - 后果:`@ai-sdk/openai` v6 解析后文本为空(usage 正常、文本零输出);opencode-x 自家 parser(`packages/llm/src/protocols/openai-responses.ts`)可直接消费 `output_text.delta` 而不依赖栅栏,但同样拿不到 reasoning。
2. **opencode 官方对 zen 的连接方式 = chat/completions**:models-api 元数据 `"npm": "@ai-sdk/openai-compatible"`、`interleaved: { field: "reasoning_content" }`;`deepseek-v4-flash-free` 官方标注 reasoning: true(思考经 reasoning_content 内联返回)。
3. **DeepSeek 原生 responses(`api.deepseek.com/responses`)**:有专用 `response.reasoning_text.delta` 通道(为 Codex 兼容而生),但 stateless、无 `[DONE]`(以 `response.completed` 终止)、仅支持付费 `deepseek-v4-flash`(Pro 2026-08 初),zen free 不在其列;裸 SSE 手动适配已验证可行(~60 行,text/工具参数/usage 均可解析)。

**由此锁定的约束**:
- 思考流只从 chat/completions 的 `reasoning_content` 获取;`reasoning_content` 与 `content` 是两个独立 delta 字段,必须独立累积、独立转发,不得混入文本(stream.ts 现有 `reasoning`/`reasoning-delta` → `thinking-delta` 归一即此语义)。
- 若未来要接 DeepSeek 原生 responses(付费)的 thinking delta,须自研裸 SSE 适配器(不用 `@ai-sdk/openai` 的 responses 客户端,其解析器要求 zen/DeepSeek 不提供的栅栏事件),且只对 paid 模型开放。
- 任何供应商若宣称支持 responses 协议,接入前必须实测三条:reasoning 事件存在性、栅栏事件齐全性、`[DONE]`/终止语义;缺任一条按残缺端点降级为 chat/completions 或拒绝接入。
- 未决:defaultCatalog() 中 `deepseek-v4-flash-free` 的 `supportsThinking: false` 与"zen free 经 reasoning_content 返回思考"矛盾,待校准为 true(能力面是投影裁剪依据,标错会裁剪掉 thinking 块)。

## 性能与算法
- 流式透传:供应商增量直接转发为事件,禁止缓冲全量(长响应内存恒定)
- 工具参数增量解析:部分 JSON 增量解(AI SDK 原生),工具调用"可达即发"
- 懒加载 + 并发上限:供应商 SDK 子路径按需导入;并发请求走 limiter
- 超时分级可配置:首 token 时间 / 流空闲超时,便于网络面映射

## 多语言
- LLM HTTP API 是标准协议,本包即"TS 参考实现",适配模式可移植
- 行为规范(归一事件集/错误语义/重试建议)文档化,其他语言可重实现等价适配层
- 供应商差异表(哪些参数/能力不通用)随文档维护,供任何宿主查询;协议级差异(如 responses 端点残缺)见"协议决策"节

## 边界(明确不做)
不做模型目录生成(用 AI SDK 生态)、不做成本记账(那是会话/UI 的投影)、不做供应商 UI。
