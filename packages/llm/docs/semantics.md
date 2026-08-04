# @tau/llm — 跨语言语义文档

本包是"投影 → LLM 流"的 TS 参考实现;适配模式可移植到任何语言。LLM HTTP API 是标准协议,行为规范如下。

## 归一事件集(LlmEvent)

| type | 语义 | 说明 |
|---|---|---|
| `text-delta` | 文本增量 | 到达即发,禁止缓冲整段 |
| `thinking-delta` | 思考增量 | 供应商 reasoning/reasoning-delta 归一 |
| `tool-call-delta` | 工具参数增量 | 部分 JSON 增量,工具调用"可达即发" |
| `tool-call` | 完整工具调用 | id/name/args(已解析) |
| `usage` | 用量快照 | prompt/completion/total/reasoning tokens |
| `finish` | 完成 | finishReason + 最终 usage,恰一个 |
| `error` | 错误事件 | code + retryable,不 throw 出流 |
| `aborted` | 取消 | abort 信号或供应商取消 |
| `model-switched` | 模型切换 | 本轮有效模型 ≠ 上一轮,首个事件 |

## 错误语义(ErrorCode 对齐契约)

| 情形 | code | retryable |
|---|---|---|
| HTTP 429 / 5xx | `retryable` | true |
| 超时(408/网络超时) | `timeout` | true |
| 401/403 | `permission_denied` | false |
| 404 | `not_found` | false |
| 取消(AbortError) | `cancelled` | false |
| 其余 | `internal` | false |

重试策略是 orchestrate 的职责;llm 只标注"该不该重试"。

## 一次 turn 一次 stream

编排层每轮恰好调用一次 `kernel.stream(projection, req)`。禁止拆包/合并;工具循环的继续由编排层构造下一轮投影。

## 模型路由(契约决定)

- 路由键 = `Model.provider.api`(openai-compatible/openai/anthropic/google…),不做启发式猜测。
- 端点 = `provider.baseUrl` > api 默认端点(`DEFAULT_ENDPOINTS`)。
- 凭据链 = 显式 getApiKey > `provider.envKey` 环境变量 > api 默认环境变量;缺失发 `permission_denied` 事件。
- 任意 OpenAI 兼容 baseURL 均可接入(自有网关/代理零绑定);系统代理透传由运行时(HTTP(S)_PROXY)处理。

## 投影 → 请求

- system[]:按 priority 降序拼接(注入防护条款最高,冲突以后置为准的组装在 session)。
- history:消息内容块 → 供应商消息;未配对 toolCall(interrupted 截断)过滤;chronological system 降级为 `<system-update>` 文本。
- tools:`SystemCall.parameters`(JSON Schema)直接映射供应商工具描述,含 `maxOutputTokens`。

## 供应商差异表(现状)

| 能力 | openai-compatible | anthropic | google |
|---|---|---|---|
| thinking 透传 | 未接(no-op) | 未接 | 未接 |
| prompt cache | none | auto(前缀) | auto(前缀) |
| 工具并行 | 由模型能力面决定 | 同 | 同 |

新增供应商 = 一个 `ProviderFactory`(5-15 行)+ 注册到 `route.ts`,归一事件集不变。
