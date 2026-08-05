# @tau/orchestrate — 时钟(调度器)

## 使命
决定"下一轮何时跑、跑什么、何时停"。调度器不是大脑,不生成内容,只做状态机。

## 功能(公开 API 面)
- `createScheduler(deps: { llm, session, action })` → `Scheduler`
- `scheduler.prompt(input)` / `steer(input)` / `followUp(input)` / `abort()`
- `scheduler.subscribe(listener)` — 事件订阅(Event 流)
- **挂起恢复**:ask_user 挂起会话(awaiting_input),answer(带 questionId)到达 → 恢复对应 syscall 结果,继续 turn
- `scheduler.waitForIdle()`
- **Session Goals**:`scheduler.goals.set(goal)` — 每 turn 后判定,未完成继续,超限停止;**判定结果经 `session.setGoal()` 写入投影**(编排不拼 Context,依赖单向向下)
- **子会话**:`fork(manifest)` → 子 session 句柄(降级 capability,durable,可 join/abort)
- **Multi-run**:`multiRun(manifest)` — 一任务 N 模型并行 spawn 子会话(各带独立 worktree,经 action 创建,隔离于主工作区);`fusion(runs)` — 汇总各子会话 diff 生成新会话(Fusion 语义:diff 并集 + 冲突标注,产出物为可继续对话的新会话)
- **定时唤醒**:纯判定 `parseCron` / `cronMatches` / `nextAfter` / `isDue` / `dueEntries`(五段 cron 最小子集 + `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly` 别名,分钟粒度,本地时区);调度表持久化 `loadSchedules` / `saveSchedules` / `upsertSchedule` / `removeSchedule` / `markRan`(落 `store.kv`,不新建表)。到点后由调用方(app CLI)`goals.set(goal)` + 唤醒——**编排给判定与调度表,不起常驻守护进程**(由系统 cron 驱动 `tau schedule run`)
- 崩溃恢复:重放 store 决定续跑点
- **wake 产出**:每次唤醒(steer/answer/goal 续跑/cron/retry/resume)附 `wake.reason + source`,模型永远知道"为什么现在醒"
- **重试可见**:重试发 `retry` 事件(次数/原因)进投影最近活动——自动行为不隐藏
- **turn 预算**:`turnBudget{ maxTurns, maxTurnMs, maxToolCallsPerTurn }` 进投影 self.resources;超限 → `budget_exceeded` 事件 + 告警(防"成功但原地踏步"的失控循环)
- **恢复悬置告知**:crash 恢复发 `recovery` 事件 + 投影告警("上次 turn 未提交,副作用可能已落盘且无法回滚——先检查文件再继续")

## 宪法
1. **不生成上下文**:委托 `session.project()`;调度器永远不直接拼 prompt
2. **不执行工具**:委托 `action.execute()`;调度器只观察结果事件
3. **turn 是原子单位**:一次 `llm.stream` + 相关工具执行;任何中断是状态机输入,不打断流程中间态
4. **无隐藏分支**:steer/abort/批准全部作为显式队列/信号处理,可审计
5. **恢复靠重放,不靠内存**:进程崩溃后从 store 恢复,不保存魔法内存态
6. **子会话也是会话**:子会话有独立 durable 存储、独立审计、可被父会话 retrieve 观察

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/scheduler.ts` | turn 状态机(唯一时钟) |
| `src/queues.ts` | steer/follow-up 队列(prompt 语义:立即/完成后/空闲后)——实现在 `scheduler.ts`(steerEpoch 入队 + turn 尾部 drain) |
| `src/goals.ts` | Goal 判定(每 turn 后:完成/继续/阻塞/超限) |
| `src/subagent.ts` | 子会话生命周期(fork/join/abort/观察)——简化实现在 `multirun.ts`(子会话隔离 + join 摘要接入) |
| `src/multirun.ts` | Multi-run 编排(spawn N 子会话 + worktree)与 Fusion 汇总 |
| `src/cron.ts` | 定时唤醒(cron 判定 + 调度表持久化) |
| `src/lifecycle.ts` | abort/retry/故障转移/恢复——**(规划)** 未实现;loop 指纹在 `scheduler.ts`,recovery 事件在 session 恢复路径产出 |

## 模块宪法要点
- `scheduler.ts`:turn 边界是唯一提交点(promote 后重算 continuation);执行 turn 预算(maxTurns/maxTurnMs/maxToolCallsPerTurn),超限中断 + 告警
- `queues.ts`:steer 优先于 follow-up;同批 steer 只重置一次 allowance
- `goals.ts`:goal 经 `session.setGoal()` 进投影(模型感知),判定独立于模型(启发式 + 可选 judge),数据流单向向下;**goal_continue 唤醒计入 turnBudget.maxTurns(goal 循环不豁免预算)**:预算超限即停,与 goal 判定无冲突——goal 未完成但预算耗尽 = 发 budget_exceeded,模型被告知"未达标但预算止"
- `subagent.ts`:capability 递减继承,结果必须可 join 回父会话上下文;join 体积:子会话大结果经压缩/retrieve 式接入,不整包注入
- `multirun.ts`:manifest 声明模型集/工作区/预算,各 run 独立 durable、独立审计;fusion 汇总经 session 输入通道(依赖单向向下),冲突标注后交模型裁决;worktree 由 action 创建与清理,失败清理不残留;**fusion 产出的新会话 manifest 继承主 run 的模型/能力,工作区 = 主工作区(非任一子 run 的 worktree)**
- `lifecycle.ts`:**(规划,未实现)** 同"失败指纹"扩展为**行为指纹**(同工具同参数无论成败 N 次)→ `loop_detected` + 投影告警;steer 中断粒度:缺省"当前工具执行完 + 本 turn 结束",可配"立即断流"(已完成的工具结果提交,未完成部分带 interrupted);重试带 `retry` 事件;crash 恢复发 `recovery` 事件 + **副作用悬置判定**(从审计日志判定上次 turn 已提交/未提交的 syscall 清单,告警带清单,模型据此检查文件而非瞎猜)
- `cron.ts`/`queues.ts`:唤醒时产出 `wake.reason`(cron/steer/goal_continue/answer);steer 进历史带 `user_steer` 标记(模型区分"新指令"与"打断插话")
- `cron.ts`:判定全为纯函数(离线可断言);**`lastRunAt` 是幂等锚点**——`isDue` 从"上次运行(或创建)之后的下一个命中"起算,同一命中不会因重复调用 `run` 而重复触发;`dom` 与 `dow` 同时受限时取"或"(标准 cron 语义);非法表达式返回 `null` 交调用方给可操作报错,不静默当成"永不触发"
- `scheduler.ts` 压缩闭环:turn 尾部(tool 循环后、下一轮 complete 前)检查投影历史体积(字符/4 ≈ token),超模型 contextWindow × thresholdRatio(缺省 0.7)时经注入的 `compact.summarize` 生成摘要,`session.compact("context-overflow", ...)` 落 summary 消息;摘要策略经构造期注入(enhance.summarize / LLM policy),scheduler 不 import enhance;**用户输入(admit,retention high)永不丢**,low/normal 先丢,最近 keepRecent 条兜底

## 开源依赖
零新增(契约+llm+session+action+store 组合)。**cron 表达式自实现**(`src/cron.ts`,五段最小子集 ~120 行):`croner` 等库带完整时区/秒级/L-W 语法,而 tau 只需分钟粒度本地时区——引依赖的成本高于收益,且违背"不引入新依赖"。

## 性能与算法
- turn 状态机单线程无锁,事件队列摊销 O(1);不引入全局锁
- goal 判定默认常量级启发式(不调 LLM);可选 judge 模型走异步降级,不阻塞主 turn
- 子会话并发上限(limiter),防子代理风暴
- 恢复:从 store 重放,不依赖内存热态(避免 O(n) 重建)
- cron `nextAfter` 逐日/逐时跳跃而非逐分扫描:最坏 366+24+60 步,不做全年分钟遍历;366 天无命中即返回 `null`(防 `0 0 30 2 *` 这类永不命中的表达式死循环)

## 多语言
- 调度语义(提交点/promote 规则/队列优先级/中断处理)写成 `docs/scheduler.md` 规范
- 事件序列可离线重放(JSONL),任何语言可消费并实现等价调度器
- surface 远程会话即跨语言调度入口(HTTP 发命令、SSE 收事件)

## 边界(明确不做)
不做 UI、不做持久化(用 store)、不做工具实现。
**Watchdog 显式决策**:不做进程级 watchdog(第一版);turn 内挂死由 `turnBudget.maxTurnMs` + llm 流空闲超时覆盖,事件流停滞由 surface 心跳/续传覆盖——防线已声明,不默认"有监督者"。
