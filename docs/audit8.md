# audit8 — 消费方 LLM 视角全包审计(2026-08-05)

> 视角:我是被宿主增强的那个 LLM。SPEC 向我承诺的能力(我能看到什么、我有什么工具、我醒来时知道什么),代码必须兑现;否则我按 SPEC 行事就会踩空。
> 方法:PLAN + 宪法十一条 + 12 个包 SPEC 全量通读后,逐包对账 src/ 代码;关键发现均已人工复核到行号。
> 基线:`bun run check` 0 错 / `bun test` 200 pass / `bun run eval` 22/22(全绿,但见"元发现")。

## 元发现(比任何单条都重要)

**eval 全绿 ≠ SPEC 兑现。** 22 条断言测的是"当前缩减实现的行为",不是 SPEC 的承诺面。SPEC 普遍写成了目标态(终态宪法),代码停在更早的里程碑深度。三者(PLAN 的 ✅、SPEC 的断言式措辞、代码实际)之间的口径差,是消费方 LLM 最大的误导源。本次审计的 P0/P1 大多是"SPEC 说已实现,代码未实现"。

**骨架仍然干净**:依赖方向与宪法第四条逐边一致(package.json 声明边 + 实际 import 双向核对);contract 零 IO;enhance 不 import llm(fs 只读例外与 SPEC 声明一致);session 不 import action/llm;surface 不碰 action/llm;tui 只经 contract+surface;无未声明依赖(store 的 bun:sqlite 是 PLAN 明确的配合包模式)。投影唯一入口、注入防护最高优先级、装配顺序、注册表全生命周期写路径、cron 幂等语义等核心机制均真实落地。

## P0(违宪 / 消费方按 SPEC 行事会踩空)

1. **压缩是丢弃,不是交换** —— 宪法七"全文永远可 retrieve 回来"被违反。`session.compact()` 直接 `store.messages.delete`(session/src/session.ts:377-380),而 `retrieve()` 只查 `messages.list`(session.ts:396-398),被压缩消息永久丢失。唯一残迹在事件流(transcript 事件),但 retrieve 不读事件。要么 compact 改为"摘要进/全文归档可查",要么 retrieve 增加事件流回源,要么修宪法措辞。
2. **action 内置工具 12 → 4** —— SPEC(action/SPEC.md:14)承诺 read/write/edit/bash/grep/find/ls/ask_user/retrieve/fetch/system/tool:catalog;`action/src/tools/` 只有 bash/common/read/write,index.ts 注册 read/write/bash/result:page。edit 缺失意味着模型连"改文件"都没有(只有整文件 write);ask_user/system/tool:catalog 缺失意味着 pendingSyscalls 挂起恢复、内省 syscall、冷工具按需注入整条链在 action 侧没有落点。
3. **权限双轨未实现** —— SPEC(经 audit7 修订)承诺"询问时同时发 permission(requested) 事件 + onPermission 回调";runtime.ts:98-104 只在回调决议**之后**发 granted/denied,无 requested、无 timeout 态。后果:远程/多客户端经事件流看不到挂起请求,approve/deny 无 requestId 可定位,surface SPEC 的"广播到所有客户端"(surface/SPEC.md:21)随之落空。契约侧 permission 事件 schema 已备好,是 action 未兑现契约。
4. **Goal 未完成不继续** —— orchestrate SPEC"未完成继续"+ goal_continue 唤醒;scheduler.ts:194-204 判定为 active 后什么都不做,goal_continue 在 orchestrate src 中零出现。"goal_continue 计入 maxTurns"的宪法要点无从生效。
5. **steer 队列丢失(真功能 bug)** —— scheduler.ts:280-286:running 时 steer 入队后无任何消费者(runTurn 结束不 drain 队列);且 steer() 不变更 steerEpoch,runTurn:191 的中断检查永不触发。steer 在会话忙时静默丢失,违反宪法"无隐藏分支"。
6. **contract 承诺的六个 schema 缺席** —— self 无 session 身份(id/title/parentId,SPEC 称"缺一即违宪",context.ts:76-86);ApprovalState 状态机整体不存在(command.ts:41 仅注释);DangerousCommandPatterns 清单不存在(bash 危险命令检测因此也不存在,action 宪法 16 落空);Config schema 与 config.ts 不存在(app"配置即契约"无兑现位,`tau config` 实为裸 kv);Model 无 fallback 降级链字段;ToolResult 无 fileMeta(read.ts:40-48 自然也没有)。
7. **llm 降级链整体缺失** —— 无 fallback.ts,kernel 无 fallbackChain/熔断;llm/SPEC.md:12 的"连续失败 → 自动降级 → model_switched"未实现(model_switched 仅手动切换发出,kernel.ts:88-91)。
8. **Multi-run 名不副实** —— multirun.ts 让 N 个模型**共享同一 session 串行**跑,无子会话、无 worktree;fusion 不产出新会话(fuseRunResults 只合并结果 Map);subagent.ts(fork/join/abort)不存在。orchestrate SPEC:13-14,45-46 的承诺与 eval 断言 #16 的通过并存——断言深度不足的典型案例。
9. **enhance policies.ts 不存在** —— codemode 解释器与子代理三件套(coder/explore/plan)零实现(enhance/SPEC.md:15,33)。
10. **ai@6 踩坑锁定未完全落实** —— PLAN M2 经验锁定"增量 part 是 tool-input-delta(inputTextDelta)";stream.ts:24,88-94 只认 v5 命名 tool-call-delta/argsTextDelta,ai 6 下工具参数增量落入 default 分支被吞。inputSchema/input 那半已落实(kernel.ts:176-200),这半没有。SPEC 自己锁定的坑,自己没绕开。

## P1(SPEC 与代码语义漂移)

11. 压缩缺省值未实现:SPEC 定死"80% 触发压缩,仍超降级模型";代码为 90% 置告警、100% 发 budget_exceeded,无自动压缩、无降级(session.ts:329-343)。
12. system 块未按 priority 降序装配(projector.ts 按插入序);契约注释承诺的"冲突以后置为准"无实现。
13. retrieve 是内存线性过滤(retrieve.ts:19-36),非 FTS5;且 session SPEC 声称"走 FTS5 O(log n)"与 store SPEC"FTS5(M5+ 随 retrieve 升级)"互相矛盾——至少一份 SPEC 在撒谎。
14. 事件 id 全部 crypto.randomUUID(),非契约承诺的"进程内单调序列+进程前缀",(epoch,id) 字典序排序语义落空。
15. store 双实现对齐缺口:audit.query 排序方向相反(sqlite timestamp DESC 取最新 N 条 vs memory slice(-limit) 插入序尾部,sqlite.ts:135-141 / memory.ts:65-71)。SPEC 明示"逐项对齐"。
16. turnBudget 未写入投影 self.resources(scheduler 局部常量);wake.reason 实际只有 prompt/steer,goal_continue/cron/retry/resume 四态不产生。
17. surface:subscribe 无 filter 参数,observe 默认隐藏审计/权限明细未实现(face.ts:22,77-85);http.ts 仍单会话——surface SPEC 说"多会话路由归入 M9 会话治理一并落地",M9 已 ✅ 但只落在 CLI(app/cli.ts),surface 侧未落地,SPEC 文字过时。
18. bash 持久 shell 只经 TAU_PWD 保留 cwd,env 不保留,每次新 spawn(bash.ts:24-31);后台任务 detach/taskId/进程树终止未实现(SPEC:20,42)。
19. enhance:opts.llmSummarize 注入回调未接(summarize 直连规则摘要);enhancer.search 缺;插件信任分级只有数据无降权执行(plugins.ts:130-158);remember 无 {overwrite} 选项。
20. llm:cache.recordCacheHit 存在但 kernel 从不调用(命中率指标恒零);auth 的"存储/OAuth"为占位注释;index.ts:40 仍 supportsThinking:false(投影会裁剪 thinking 块,与契约"thinking 默认进历史"矛盾)。
21. orchestrate 恢复链:无 lifecycle.ts、无 recovery 事件产出;action 审计无 turnId 字段,recovery 悬置判定无判定输入(action/SPEC.md:60, orchestrate/SPEC.md:47 双双落空)。
22. action API 面:无 permissionRequest()/grant(caps,scope);execute 返回 Promise 而非 SPEC 的 Stream<ToolEvent>。

## P2(SPEC 文字过时 / 模块表空壳)

23. SPEC 模块表中不存在的文件:session 的 compaction.ts/artifacts.ts、action 的 workspace.ts、orchestrate 的 queues.ts/subagent.ts/lifecycle.ts、surface 的 events.ts/rpc.ts(rpc 已标"延后")、enhance 的 loader.ts/policies.ts、llm 的 fallback.ts、contract 的 config.ts。模块表是消费方的地图,空壳条目应标"规划"或删除。
24. store SPEC"慢查询 SQL 日志按阈值输出"未实现(sqlite.ts 无任何日志)。
25. session.diff 依赖纯内存 epochHistory,重启后恒返回 epoch-history-missing(session.ts:401-406),与"恢复靠重放不靠内存"基调相左——要么 diff 从事件流重建,要么 SPEC 声明其易失性。
26. llm/SPEC.md 开源依赖节写"@ai-sdk/openai-compatible@^2",package.json 锁定 2.0.63,一致;但 llm 模块表 providers/ 目录下供应商文件数量与"每供应商一文件"的对应关系未在 SPEC 声明边界。

## 已验证为真的关键承诺(抽样)

Event 13 变体命名全对(event.ts:118-132);Command 8 变体均强制 sender;wake.reason 七枚举在契约层存在(context.ts:11-19,缺的是 orchestrate 产出);assertDualView/assertBudget/assertReplay 三检查器在;ErrorCode 七值;truncated/totalPages;project() epoch memo;store.sessions 五处生命周期 upsert;WAL/外键/busy_timeout/预处理语句/audit_archive/kv substr 前缀;read range/preview/二进制检测;write 原子写;workspaceRoots 越界拒绝;result:page 续读;secret redact 不阻断;hooks 三阶段接入;T0 串行/T1 并行;HTTP/SSE Last-Event-ID/心跳/health;ACP 五方法;loop_detected 指纹 + retry 事件;cron 全语义(幂等锚点/dom-dow 或/366 天上限);enhancer.apply→extraSystemBlocks 与 skill:load 注册(compose.ts:54-88);memory kv 前缀隔离;规则摘要不调 LLM;MCP/pty 未实现与 SPEC"后期"一致。

## 修复建议(按消费方痛感排序)

1. **先修口径**:每个 P0/P1 二选一——补实现,或在 SPEC 标注"规划/部分实现"。SPEC 的断言式措辞只应描述已验行为(eval 覆盖的行为)。
2. **eval 断言加深**:#16 Multi-run 断言应覆盖"子会话隔离 + worktree + fusion 新会话";Goal 断言应覆盖"active → goal_continue 续跑";新增"压缩后可 retrieve 全文"断言(P0-1 的守门)。
3. **P0-5 steer 丢失是真 bug**,建议最先修(影响面 = 所有忙时打断)。
4. **工具面补齐顺序建议**:edit > ask_user > system/tool:catalog > retrieve 接线 > fetch > grep/find/ls(检索类可缓,MCP 可补)。
5. contract 六个缺席 schema 是下游一切的图纸,补 schema 先于补实现(契约先行,宪法十一)。

## 流程备注

- 审计中首次尝试将 check/test/eval 串行管道后台执行时挂起 15 分钟无输出;拆分独立执行后全部秒级通过。疑似管道 + 后台组合问题,非代码问题,未复现深究。
- PLAN.md:149 已引用"audit8 修订"(权限双轨)但 docs/audit8.md 此前不存在;本文件补上该引用,并确认:SPEC 已按双轨修订,action 代码未跟上(P0-3)。

## 收尾状态(audit8 后续补齐)

本清单逐包补齐已完成一轮,基线:`bun run check` 零告警;`bun test` 全量 269 tests / 928 expect / 0 fail。逐项状态:

- **P0-1 压缩交换** ✅:compact = 摘要进 retrieve 可回源(store 归档交换 + session.retrieve 合并归档)。
- **P0-2 工具面 12→13** ✅:read/write/edit/bash/result/grep/find/ls/ask_user/system/tool:catalog/fetch/retrieve 全部注册。
- **P0-3 权限双轨** ✅:requested/granted/denied/timeout 事件 + onPermission 回调 + requestId(toolCallId)定位 + 危险命令强制询问 + 负载拒绝补 tool failed。
- **P0-4 goal 续跑** ✅:goal_continue 唤醒 + goalContinueMaxTurns(缺省 3,计入 maxTurns)+ goal 事件。
- **P0-5 steer 队列** ✅:steer() 同时 bump steerEpoch/goalEpoch,running 中入队转尾部 drain,不再丢失。
- **P0-6 contract 六 schema** ✅(除 Config schema 为 "规划" 标注):session 身份(id/title/parentId)、ApprovalState、DangerousCommandPatterns、Model.fallback 链字段、ToolResult.fileMeta 均已落地;config.ts 保持 "(规划)"。
- **P0-7 llm 降级链** ✅:fallback.ts 降级链逻辑实现在 kernel.ts(fallbackChain + model_switched + cacheStats)。
- **P0-8 Multi-run 名实相符** ✅:每模型独立子会话(持久化隔离)+ fused session 产物。
- **P0-9 enhance policies.ts** ✅:codemode 解释器 + coder/explore/plan 子代理三件套。
- **P0-10 ai@6 增量 part** ✅:stream.ts 锁定 tool-input-delta 命名(normalizeToolParts 已批改)。
- **P1-15 store 双实现对齐** ✅:audit.query 双驱动排序取证一致 + messages.search 对齐 + withSlowQueryLog。
- **P1-16 turnBudget 进投影 + wake.reason 产出** ✅:投影含 turnBudget;goal_continue 唤醒产生。
- **P1-17 surface filter + observe** ✅:subscribe(filter) + matchesFilter + public 可见面;http SSE 支持 ?kinds / ?includeSensitive。
- **P1-18 bash env 保留 + detach/进程树终止** ✅。
- **P1-19 enhance 四项** ✅:llmSummarize 注入 + search + 插件降权执行 + remember overwrite。
- **P1-20 llm** ✅(cacheStats + supportsThinking):cache 命中率经 cacheStats 面;索引按契约 thinking 语义。
- **P1-21 orchestrate 恢复链** ⏳ 部分:lifecycle.ts "(规划)" 标注;recovery 事件在 session 崩溃恢复路径已产出,审计侧除(turnId,SPEC 已标注"部分实现")与副作用悬置判定未实现。
- **P1-22 action API 形态** ✅ 口径修正:`permissionRequest()`/`grant(requestId)` 已在(权限双轨时落地);新增 `grantScope(caps, scope)` 作用域预授权(一次批准 N 次,maxUses/durationMs,危险命令不豁免,落审计);`Stream<ToolEvent>` 形态 SPEC 标注 "(规划)",流式感知经 onEvent 事件双轨。
- **P2-23 模块表空壳** ✅:各 SPEC 模块表对不存在的文件已标 "(规划)" 或注明真实落点(compaction/artifacts/workspace/queues/subagent/lifecycle/rpc/events/loader/fallback/config)。
- **P2-24 慢查询日志** ✅ 已达成(withSlowQueryLog)。
- **P2-25 session.diff 易失性** ✅:SPEC 已声明(重启 → epoch-history-missing,消费方退化为快照拉取)。
- **P2-26 llm providers 边界** ✅:SPEC 已声明当前 7 个供应商文件。

剩余开放项仅 P1-21 / P1-22(API 形态重构,影响面大,留待独立迭代)。

