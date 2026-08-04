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
5. **标准端点直连**:支持任意 OpenAI 兼容 baseURL(自有网关/代理经标准配置接入),不绑定任何私有网关
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
- `@ai-sdk/openai-compatible@^2`:OpenAI 兼容端点;固定 2.x(模型规格 v3,匹配 ai 6;3.x 发 v4 不兼容)
- 供应商适配包(@ai-sdk/*)按需引入;自有网关经 OpenAI 兼容 baseURL 配置,零绑定

## ai@6 契约(踩坑锁定,改版本必须先重验)
- 工具 schema 必须经 `inputSchema: jsonSchema(jsonSchemaObject)` 注入:ai 6 核心只读 `tool.inputSchema`;直接传 `parameters` 或裸对象会被序列化成空 schema(`{"properties":{}}`),模型只能发空参数工具调用
- fullStream 工具调用 part 的参数字段是 `input`,不是 `args`(v5 命名);增量 part 是 `tool-input-delta`(`inputTextDelta`),不是 `tool-call-delta`
- 消息 part 契约:tool-call 用 `{ type:"tool-call", toolCallId, toolName, input }`;tool-result 用 `{ type:"tool-result", toolCallId, toolName, output:{ type:"text"|"json", value } }`

## 性能与算法
- 流式透传:供应商增量直接转发为事件,禁止缓冲全量(长响应内存恒定)
- 工具参数增量解析:部分 JSON 增量解(AI SDK 原生),工具调用"可达即发"
- 懒加载 + 并发上限:供应商 SDK 子路径按需导入;并发请求走 limiter
- 超时分级可配置:首 token 时间 / 流空闲超时,便于网络面映射

## 多语言
- LLM HTTP API 是标准协议,本包即"TS 参考实现",适配模式可移植
- 行为规范(归一事件集/错误语义/重试建议)文档化,其他语言可重实现等价适配层
- 供应商差异表(哪些参数/能力不通用)随文档维护,供任何宿主查询

## 边界(明确不做)
不做模型目录生成(用 AI SDK 生态)、不做成本记账(那是会话/UI 的投影)、不做供应商 UI。
