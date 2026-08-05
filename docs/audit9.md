# audit9 — 消费方 LLM 视角全包审计(2026-08-05)

基线:`bun run check` 零告警;`bun test` 332 tests / 1222 expect / 0 fail;`bun run eval` 33/33 passed。
方法:四路并行逐包读码(contract / session / orchestrate+action / app+surface+store+llm+enhance),交叉核对调用点;所有 P0/P1 均已在源码层面逐行复核(非仅文档比对)。

## 元发现(比任何单条都重要)

1. **存在一条未声明的第二输入边界**:`llm/src/kernel.ts` 的 `assembleSystem + toAiMessages + toToolSet` 是投影 → 模型真实输入的唯一转换器,但它只转 `system[] + history + tools` 三块;`wake/self/resources/pendingSyscalls/recent` 全部静默丢弃。宪法 5(模型自省 ≥ UI)、8(唤醒原因/最近活动/自动行为进投影)在模型真实输入面整体落空,而 session 层字段齐全——**审计 8 次全绿的根源**:`eval/src/faux.ts:74` 是 `void projection`,评测从不经过这个转换器,契约面再完美也不被验证。
2. **事件流半途断裂**:唯一拼装点把事件接到 scheduler 的内存 listeners,没接 face,也没接 action.onEvent。TUI/serve/acp 三种模式的 UI 只收得到 `input_accepted`;scheduler 自产事件(retry/interrupted/loop_detected/budget_exceeded/goal)只发内存;`model_switched` 全仓零构造点(被 collectStream 吞掉);tool 事件零落库。recent 最近活动块实际只可能显示 compression/recovery。
3. **压缩/记忆/thinking 三条承诺是"加了但没接通"**:retrieve syscall ≠ session.retrieve(检索的是进程内截断暂存区)、thinking 块 producer/consumer 双端都丢、记忆索引块构造期快照不刷新——模型侧全是死路径。

## P0(违宪:消费方按 SPEC 行事会踩空)

- **P0-1 大输入对模型不可见** — `kernel.ts:231-243`(toAiMessages 只处理 text/image)+ `session.ts:253,296`(admit/appendMessage 把 >16KB text 换成 artifact 引用)。外置后用户消息在模型侧变成**空内容消息**:ref/size/hash 全不可见,`artifact:read` 无从使用;大指令=宪法 1"模型输入唯一路径"被静默截断。且无 `artifact:list` 工具。
- **P0-2 self 自省块到达不了模型,且生产拼装缺料** — `kernel.ts:115-118`(丢弃 self/wake/resources/pendingSyscalls/recent)+ `compose.ts:292-305`(不传 permissions/git/projectRoot,投影 `self.permissions=[]`)。模型自认"零权限"(实际 DEFAULT_RULES 允许 read),对 git 现场/权限边界/预算/挂起询问/最近活动完全无知。
- **P0-3 retrieve 工具是错的检索面** — `action/src/tools/retrieve.ts`(扫 ResultPageStore 截断暂存区)+ `session.retrieve` 零生产消费方。projector 系统块还指引"可经 retrieve 工具取回"(projector.ts:129)——指引是错的,压缩全文对模型不可回源,宪法 6"交换可回源"不成立。
- **P0-4 scheduler.prompt() 无 busy 守卫** — `scheduler.ts:339-355`(无 `running !== null` 检查,steer 有)。TUI 双回车 / serve 并发 POST / cron 叠 turn 三处可真实触发双时钟:两个 runTurn 并行跑同一 session,turnId/审计交错。
- **P0-5 face 事件桥缺失** — `compose.ts:358`(createCommandFace 未接事件)+ `face.ts:78-81`(emit 只被 publish 调)。TUI 转录/工具面板全空(仅 input_accepted),serve/acp 客户端看不到 permission requested → **serve/acp 模式权限询问 5 分钟超时无人能批**;printMode 因直接订阅 scheduler 反而正常——同一次拼装两种 UI 事件面不一致。eval 夹具复刻了同一断接,无测试兜底。

## P1(SPEC 与代码语义漂移,行为级)

- **P1-1 事件 id 因果序承诺不可实现**:`event.ts` 无 seq/epoch 字段,生产全 randomUUID;"(epoch,id) 字典序可判定因果"落空;重放按 DB 自增 seq,与承诺无关。
- **P1-2 权限回调无超时**:`runtime.ts:232-237`(onPermission await 无时限;5 分钟超时只作用于 pendingRequests 路径)。弹窗无人应答 = turn 永久挂起(maxTurnMs 只包 llm.complete 不包权限等待);ask_user 10 分钟等待同样不受约束。
- **P1-3 只读探索在缺省配置下全挂**:`capability.ts:63-67` 只做精确名/`*` 匹配;grep/find/ls/retrieve 四个只读工具的 defaultRule pattern 都是 "read"(index.ts:166/184/201/287)→ 规则永不命中 → 兜底 ask → headless/print/cron 无用户场景每次挂 5 分钟超时。eval 全用 autoApprove:true(fixtures.ts:67),CI 抓不到。
- **P1-4 预算无执行侧强制,双阈值打架**:checkBudget 只是 eval 断言,运行路径无人调用;压缩触发 = 模型上下文窗×0.8(scheduler.ts:309),预算告警 = session maxContextTokens(缺省 32K)×0.9(session.ts:402),两把尺子;token 估算 chars/4 对中文低估约 4 倍。`onBudgetExceeded:"abort"` 配置零消费方——模型看到"超限行为:abort"却继续被调度。
- **P1-5 goal 启发式误判 + 预算豁免**:`goals.ts:36-41` "完成"子串命中即 completed(且先于 blocked 检查)——"无法完成"判完成;"goal_continue 不豁免预算"不实:maxTurns 每 runTurn 重置 + goalContinueMaxTurns=3 → 单 prompt 最多 24 turns。
- **P1-6 LoopGuard 永久毒化 + 静默删调**:`lifecycle.ts:15-20` counts 永不清理,换任务后第 4 次合法复用立即被掐;触发后同批剩余调用无结果(assistant 消息含全部 calls 但部分无 toolResults,模型无法区分"被拦截"与"结果丢失");`maxToolCallsPerTurn` 超限 slice 静默删调,模型不知道自己被删。
- **P1-7 压缩近乎失效**:admit 缺省 retention=high(用户消息永不压缩)+ 摘要同样 high(compaction.ts:38)→ 只剩 high 时 runCompact 恒 null 但 summaryIds 无限累积,投影"摘要消息 id: ..."列表无限变长。
- **P1-8 thinking 全链路断**:`scheduler.ts:242-256` appendAssistant 只存 result.text 丢 result.thinking;session 的截断逻辑死代码;契约/session 阈值不一致(32768 vs 32_000);config.thinking 无消费方。
- **P1-9 只读路径假只读**:`sqlite.ts:400-409` readonly 只跳过 StoreLock,仍 `PRAGMA journal_mode=WAL`(写)+ migrate(写,可能 FTS rebuild)+ `new Database(path)` 建文件;`tau log` 在活会话上会 database is locked 或写库;`tau sessions resume/archive/delete` 无锁构造 session 真写。
- **P1-10 subagent 三处**:白名单默认含 retrieve + ResultPageStore 按 plane 实例共享 → 父扫子、子扫父截断输出(进程级隔离名存实亡);`bypassQueue` 无条件绕过(并行子代理 T0 不互斥,降级父 cwd 时父子可并发写);limiter `saveReg` 在 try 外(store 写失败泄漏计数),`depthOf` 无环检测(环 → 深度 100 毒化链)。
- **P1-11 cron 叠 turn**:`cli.ts:751` markRan 在 publish 之后,上一 run 挂起 5-10 分钟时下轮 cron 再起新进程并发执行同一 session(叠加 P0-4)。
- **P1-12 进程树终止未实现**:`bash.ts:62-71` 只杀根进程(SIGTERM→SIGKILL),`sleep 1000 &` 子进程成孤儿;detach 任务取消后仍跑。
- **P1-13 SSE 续传竞态**:`http.ts:46-79` 先重放后订阅,重放期间新事件丢失;lastEventId 找不到全量重放与实时流重复;快照无 epoch 参数无法增量对齐。
- **P1-14 审计/artifact 增长无收口**:archiveAudit/purgeArtifact 零生产调用(仅测试);每次 execute 一行审计、每次大输出一个 artifact,长程会话只增不清;审计 detail 明文落 bash 命令全文(secret 检测只覆盖 stdout/stderr,`curl -u user:pass` 进审计)。
- **P1-15 Config 4/7 键零消费方**:model/turnBudget/capabilityDefaults/thinking 有 schema 能 `tau config set` 但拼装点从不读(compose.ts:301-322 只消费 maxContextTokens/toolTierRules/compaction);未知键静默落盘静默剥掉。
- **P1-16 记忆索引块构造期快照**:`compose.ts:115` apply 仅一次,会话内 memory:write 后索引不刷新,长会话模型无法发现新记忆。

## P2(文字/细节漂移)

- wake.reason 七值仅三值有产出路径(prompt/steer/goal_continue);cron 唤醒标 prompt。
- ApprovalState expired/revoked 无产出路径;permission 事件 "timeout" 与枚举不同词。
- redactFields 死代码(全仓零调用,所有事件 redact:[]);契约级脱敏承诺未启用。
- input_accepted sender.kind 恒 "cli"(TUI/HTTP/cron 来源审计失真)。
- observe Command 纯 ack,streams 字段无人读。
- semantics.md ErrorCode 表缺 insufficient_funds/overloaded 两码。
- lifecycle created/checkpointed 零产出;正常退出不 emit closed → 会话永远 active,治理无法区分正常结束与崩溃。
- edit 工具 defaultRule pattern "write" 永不命中(靠无规则兜底 ask 碰巧正确)。
- artifact 外置阈值按字符非字节(CJK ×3,16K 字符≈48KB 不触发);purge 悬空引用无提示。
- session.diff 进程内非记录 epoch 也返回 epoch-history-missing(与"仅重启后"声称不符)。
- multirun 死模块:零引用;fuseRunResults 死代码;createFusedSession 不用它;清理 finally 无 try/catch,单 run 异常整批覆灭。
- 远程目录增强只在 TUI 生效(serve/acp/print 用静态目录,能力面不一致)。
- `TAU_<PROVIDER>_API_KEY` 对含 "-" 的 provider id 生成非法变量名恒 null。
- frontmatter YAML 解析失败静默降级(坏技能文件整段原文当正文注入)。
- steer immediate 中断后 assistant 消息 interrupted=false(与 llm 阶段中断形态不一致)。
- multirun/MAX 相关 SPEC 声称"diff 并集+冲突标注"与 createFusedSession 实际行为不符。

## 已验证为真的关键承诺(消费方可以依赖)

- 危险命令检测与契约同源(runtime.ts:286 直接调 isDangerousCommand),grants/autoApprove 不豁免 forcedAsk。
- 错误码封闭 9 种必填;executeStream 终态事件与 execute 收口一致。
- Command 8 分支全有消费路径;approve/deny/answer/select 双轨决议(requestId/questionId 精确定位)。
- T2 永不注入投影(projector 双路径过滤);内置工具 14+3 与 SPEC 一致。
- 恢复链:悬置判定按 turnId 按序比较,已提交不误报;abort 后 pendingRequests 清理。
- LoopGuard 触发点之外的配对、write/edit 原子提交、fileMeta 在 read/edit 兑现。
- 依赖方向全绿(无包 import 上游);编译期穷尽靠 zod discriminatedUnion + 无 default switch。

## 修复建议(按消费方痛感排序)

1. **kernel.ts 转换补齐**(P0-1/P0-2/P1-8 的一个根):toAiMessages 增 artifact 引用块(text 渲染 `[artifact:ref size=… hash=…]` 让模型知道可 artifact:read)、thinking 块(text 渲染或按策略降级);assembleSystem 前把 self/wake/pendingSyscalls/recent 折叠进 system 块(或在 LlmRequest 增投影注入面);eval 增加"经 kernel 转换后的模型可见面"断言(禁 FauxLlm void projection)。
2. **事件桥接通**(P0-5/P1-2/部分 P1-1):compose 把 session/scheduler/action 三方事件汇入 face;serve/acp 补 permission 响应通道;onPermission 加超时;model_switched 在 scheduler 侧构造落库。
3. **capability 规则匹配修正**(P1-3):defaultRule 的 read/write/bash 语义改通配("read" 前缀或 DEFAULT_RULES 扩 grep/find/ls/retrieve),headless 模式 grep 立即可用。
4. **prompt() busy 守卫 + cron markRan 前置**(P0-4/P1-11)。
5. **预算强制**(P1-4):scheduler 在估算超窗时硬性截断/强制压缩,onBudgetExceeded=abort 真 abort;token 估算按 CJK 加权;对齐 session/scheduler 双阈值。
6. **retrieve 接 session.retrieve + FTS5**(P0-3),ResultPageStore 保留为 result:page 专用;artifact:list 工具补上。
7. **压缩收口**(P1-7):摘要 retention 降级 + summaryIds 上限 + 压缩候选纳入 high 的早期轮次。
8. **subagent 白名单收紧**(P1-10):retrieve 改查父会话专用页或移除;depthOf 加 visited;saveReg 移入 try。
9. **只读打开真正只读**(P1-9):readonly 跳过 WAL/migrate,只读语句集;或观测命令复用写锁连接。
10. **记账**:以上全部落 eval 断言后再宣布"审计闭环"。

## 流程备注

本审计纯读码 + 运行验证(基线三绿),未改任何代码。P0-1/P0-2/P0-5 是"测试全绿但产品面断裂"的典型:eval 与 TUI 走不同装配,夹具复刻了缺陷装配,导致契约层越完备、断裂越隐蔽。修复应以 eval 断言先行(先把 FauxLlm void projection 换成真 kernel 面断言)。
