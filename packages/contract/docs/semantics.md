# @tau/contract — 跨语言语义文档

wire 表示 = JSON;JSON Schema 由 `jsonSchemas()` 导出(draft 2020-12)。任何语言按本文件语义重实现契约。

## ErrorCode(工具错误码,必填)

| 取值 | 语义 | 模型应做的 |
|---|---|---|
| `retryable` | 瞬态失败,重试可能成功 | 重试(受预算约束) |
| `not_found` | 资源不存在 | 换工具或改参数 |
| `permission_denied` | 权限规则拒绝(deny) | 停止,问用户 |
| `timeout` | 超时 | 按预算重试或放弃 |
| `cancelled` | 被取消(用户 abort) | 停止 |
| `rejected` | 用户拒绝(ask 规则) | 停止,不自动换路径 |
| `insufficient_funds` | 余额不足(402) | 停止,不可重试 |
| `overloaded` | 服务过载(429/资源紧张) | 错峰重试 |
| `internal` | 内部错误 | 上报,不重试 |

`ToolResult`:exitCode 为 null 表示无进程语义;stdout/stderr 分离。`truncated=true` 时按 `totalPages` 分页,续读经工具 `result` 参数 `page`(`RESULT_PAGE_TOOL_NAME`/`RESULT_PAGE_PARAM`),不得整段重灌。

## Goal 状态机

```
active ⇄ paused
active → completed | failed | cancelled
```

- `progress` ∈ [0,1],由判定策略决定更新者。
- `strategy`: `explicit`(系统显式置完成)、`llm_judged`(模型自评,默认)、`checklist`(全项满足即完成)。
- 目标经 `session.setGoal` 进入投影 `activeGoals` 与快照,双向同步(见重放不变量)。

## Command(封闭联合)

| kind | 必带 | 语义 |
|---|---|---|
| `prompt` | sender, text | 新指令,触发 turn |
| `steer` | sender, text, ref? | 转向已发布内容 |
| `approve` | sender, toolCallId, capability, reason | 批准权限,capability 为被批准的权限模式 |
| `answer` | sender, questionId, answer | 回答挂起问题,与 `pendingSyscalls.questionId` 配对 |
| `abort` | sender, targetId? | 打断目标(缺省=当前 turn) |
| `select` | sender, questionId, selected, multiple | 多选回答 |
| `observe` | sender, subscribe, streams | 只读 attach,无写语义 |

任何分支不携带 secrets;敏感参数只以摘要/reference 出现。sender.kind ∈ cli/tui/http/sse/acp/remote/system。

## Event(封闭联合)

基础字段:`id`(全局唯一,因果/幂等/重放)、`timestamp`(ISO)、`causeId?`(前因)、`redact[]`(落盘脱敏字段路径)。

| kind | 语义 |
|---|---|
| `input_accepted` | 输入回执(Command 被接受) |
| `transcript` | 消息落地(Message 全文) |
| `tool` | 工具调用 started/completed/failed |
| `permission` | 权限请求广播 + params 摘要(不带原始参数) |
| `compression` | 历史压缩,`droppedIds` 为被丢弃消息 |
| `lifecycle` | created/active/closed/archived/checkpointed |
| `budget_exceeded` | 预算超限(metric/used/limit) |
| `loop_detected` | 死循环防护触发 |
| `retry` | 重试(cause/attempts) |
| `model_switched` | 换模型(from/to/reason) |
| `interrupted` | 打断(targetId) |
| `recovery` | 崩溃恢复告知(from/detail) |

`retry`/`interrupted`/`model_switched` 必须同步进投影 `recent`(最近活动块)。`recovery` 事件是"恢复告知"断言(eval)的存在性依据。

## Message 与 retention

- `retention`: `high`(用户指令/Goal,压缩时永不先丢)> `normal`(模型输出)> `low`(工具输出,先丢)。
- `modelId`:溯源"谁说的",换模型后历史可见。
- toolCalls/toolResults 按 `callId` 一一配对(`checkToolPairing` 强制),顺序稳定。
- content 块:`text`(正文,超阈值自动外置为 artifact 引用)/ `image`(引用+元数据)/ `thinking`(模型思路链,默认进历史,超限截断+标记)/ `artifact`(大载荷引用,正文存 store)。
- 压缩交换:全文移入归档区仍可 retrieve,摘要进历史;摘要只重述已发生事实,不臆造新结论。

## ApprovalState 状态机

- 状态:`active`(挂起询问)→ `approved` / `denied` / `expired`(超时)/ `revoked`(会话 abort 清理残留挂起)。
- 挂起经 `pendingSyscalls` 进投影与 UI(questionId/工具/发起时刻);`approve` 经 requestId 定位、`deny` 与 denied 一一对应。
- 作用域预授权(`grantScope`)一次批准 N 次/限时,不豁免危险命令。
- 孤儿挂起有归宿:abort 后残留 pending → revoked;审批链可审计(permission 事件 granted/denied/timeout 序列)。

## DangerousCommandPatterns

契约级危险命令模式清单(`rm -rf /`、`git push --force`、`sudo`、`curl | sh` 等):action 的 bash 检测与 eval 断言共用同一清单——危险命令强制询问,不随 autoApprove 静默放行。

## 不变量检查器(eval 断言配套)

- `checkDualView`(双视角):UI 可见 ⊆ 投影 ∪ 事件。UI 消息必须能由投影 history 或 transcript 事件推出;挂起请求由 `pendingSyscalls` 或 requested permission 事件推出;目标由 `activeGoals` 推出;状态由生命周期事件推导。
- `checkBudget`:turn ≤ maxTurns、toolCallsThisTurn ≤ maxToolCallsPerTurn、totalTokens ≤ contextWindow.maxTokens。maxTurnMs 由 orchestrate 执行期强制。
- `checkReplay`:投影 version = 快照 epoch;transcript 事件序列 = 投影 history;快照 transcriptCount = history 长度;pendingSyscalls/activeGoals/status 双向一致。

## 边界情形

- 空 `workspaceRoots`:不允许任何路径写;`cwd` 不在根内时越界拒绝。
- `totalPages=0`:无输出页,不应发起续读。
- 投影 `self` 五要素(clock/usage/cwd/permissions/skills)缺一即违宪——模型对自身处境的了解 ≥ UI。
