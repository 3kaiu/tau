# @tau/surface — 命令面(跨语言桥)

## 使命
世界与宿主之间的门:任何 UI/客户端(终端、editor、脚本、其他语言)通过 surface 发布 Command、订阅 Event。surface 是**跨语言桥**与唯一网络入口。

## 功能(公开 API 面)
- `createCommandFace(deps: { orchestrate, session })` → `CommandFace`
- `face.publish(command)` → `CommandResult`(命令排队 + 回执)
- `face.subscribe(filter)` → `EventStream`(SSE / JSONL / 回调)
- `face.snapshot()` → `SessionSnapshot`(只读,拉模型)
- **HTTP 模式**(Hono,M7 ✅):`POST /command`、`GET /events(SSE, 支持 Last-Event-ID 续传 + 心跳保活)`、`GET /snapshot`、`GET /health`;单会话模式,多会话路由归入 M9 会话治理(与 `tau sessions` list/resume 一并落地)
- **ACP 模式**(M7 ✅):editor 驱动会话(经 JSON-RPC over stdio,`initialize`/`session/prompt`/`session/snapshot`/`session/abort`/`shutdown`)
- **RPC 模式**(JSON-RPC over stdio/HTTP):脚本与外部进程(延后)
- 无状态:状态在 session,命令面不持有会话状态

## 宪法
1. **命令面无状态**:一切状态在 session;命令面崩溃不影响会话
2. **只发布与观察**:命令面无权直接调用 llm/action/session 内部——一切经 Command/Event 契约
3. **连接可重连**:Event 流带 epoch/续传标记(Last-Event-ID / `since=`),断线重连不丢事件;订阅响应携带 `snapshotEpoch`——客户端"先快照后订阅"不丢窗口
4. **不生成内容**:不拼接 prompt、不执行工具;只是协议翻译
5. **权限继承**:命令面的每个客户端拥有独立身份与 capability 前缀;Command 的 `sender{clientId,kind}` 由面填充,approve/answer/abort 强制;权限请求经 `permission(requested)` 事件 **广播到所有客户端**(requestId + 参数摘要,面层原样透传不裁剪——安全链最后一环(tui 渲染)依赖此字段),首个 approve(其 toolCallId 字段承载 requestId)/deny 生效(sender 审计),后续忽略
6. **observe 可见范围**:只读观察者默认不可见审计/权限明细与工具结果原文(敏感);订阅 filter 默认值 = 公开事件,需降级授权才看明细

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/face.ts` | CommandFace 聚合(发布/订阅/快照) |
| `src/print.ts` | print 模式渲染(非交互输出,`-p` 消费) |
| `src/http.ts` | Hono HTTP + SSE 端点 |
| `src/rpc.ts` | JSON-RPC over stdio/HTTP——**(延后)** |
| `src/acp.ts` | ACP 协议适配(editor 驱动) |
| `src/events.ts` | 事件流(SSE 编码/续传/批处理)——实现在 `face.ts`(订阅 filter)与 `http.ts`(SSE 编码/续传/心跳) |

## 模块宪法要点
- `http.ts`:SSE 事件批量 + 心跳;HTTP 错误统一 JSON 结构;续传参数(Last-Event-ID/`since=`)规范化
- `events.ts`:订阅带 filter,未过滤事件不落地给客户端
- `acp.ts`:ACP 只做协议映射,不引入会话逻辑

## 开源依赖
`hono`(HTTP 层,轻量)。ACP 协议按 kimi/官方规范实现,不自造轮子。

## 性能与算法
- SSE 事件批量 + 背压:高吞吐事件合并帧,避免逐事件 syscall
- 连接复用:HTTP keep-alive;订阅按 filter 提前裁剪
- 快照拉取走增量(epoch 比较),客户端可做差分渲染
- 心跳/续传用常量级标记,不增加事件流体积

## 多语言
- **跨语言桥的正式规范**:HTTP/SSE/ACP/JSONL 全语言中立,协议文档 = 官方规范
- 命令/事件 wire 格式 = contract 的 JSON Schema,任何语言客户端可驱动会话
- 官方 client SDK 可从 Go/Rust/Python 参考实现(后续),接口以本包文档为准

## 边界(明确不做)
不做 UI(那是 tui/editor 的事)、不做认证体系(第一版本地信任)、不做协议发明。
