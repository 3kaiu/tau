# Tau 架构对抗审计报告(消费方 LLM 视角)

> **修复状态(2026-08)**:P0×6、P1×14 已逐项落进 `contract`/各包 SPEC/`PLAN.md`/宪法。本报告作为审计记录保留;修复后现状以各 SPEC 为准。

> 审计视角:**我是一个将被投喂 ContextProjection、靠 SystemCall 行动、被 Event 反馈的 LLM**。
> 生存条件 = 我能看到什么(投影完整)、我能做什么(工具面)、我怎么确认结果(反馈闭环)、我怎么自救(防循环/超预算)。
> 优先级:P0=架构级缺陷(现在必修)/ P1=能力缺省(应补)/ P2=优化增强(可后置)。
> 结论:**P0 ×6、P1 ×14、P2 ×9**。核心问题集中在"模型侧内省与反馈闭环"——架构对 UI 消费方想得多,对 LLM 消费方想得少。

---

## 跨包 P0(架构级,必须先修)

### P0-1 Goals 数据流违背依赖方向 ← orchestrate × session
- `orchestrate/SPEC.goals.ts`:"goal 进 Context(模型感知)";但 session 是"投影唯一组装者",orchestrate 宪法 1 "不生成上下文"。
- **矛盾**:goal 怎么进 Context?orchestrate 禁止 import session 投影内部;session 不知道 goal 存在。
- 修法:`contract` 定义 `Goal` schema(文本/状态/进度/判定策略);`session` 增加输入通道 `session.setGoal(goal)`(走 admit,先落盘),`projector` 在 self/system 组装 `activeGoals`;orchestrate 只做判定,数据流单向向下。

### P0-2 ask_user 无"挂起/恢复"语义 ← action × orchestrate × contract
- ask_user 是 syscall,但执行模型是"同步等到结果"。用户 answer 可能几分钟后到——**谁等?会话处于什么状态?多个并发 ask_user 怎么办?**
- 修法:contract 定义 `pendingSyscalls`(进 SessionSnapshot 与投影,UI/模型都看到"模型在等你回答");ask_user 返回 `questionId`,answer Command 携带 questionId;orchestrate 负责把 answer 恢复为对应 syscall 结果。这复用 V2 SessionCore 的 wake 机制。

### P0-3 Command 缺发起者身份(sender) ← contract × surface
- surface 宪法 5 说"每个客户端独立身份",但 Command 无 sender 字段。surface serve + 远程 editor 多客户端后,approve/answer/abort 无法审计到人。
- 修法:`Command` 携带 `sender { clientId, kind }`,approve/answer/abort 强制带;audit 记录。

### P0-4 路径/工作目录语义未定义 ← action
- 模型调用 read/write/bash 时,相对路径相对哪?**模型必须知道"我现在在哪个目录、项目根在哪、是不是 git 仓库"**,否则第一轮就要瞎试。
- 修法:投影 self 加 `cwd`/`projectRoot`/git 状态;`tools/` 行为规范文档化路径解析规则。

### P0-5 模型无时间感知 ← contract
- 投影里没有"现在几点/距上次事件多久"。cron/goals/deadline/判断缓存陈旧全部做不到。
- 修法:contract 加 `Clock`(墙钟 + 单调时间 + 会话已耗时),进 `ContextProjection.self`。

### P0-6 能力协商与模型侧内省双重缺失 ← llm × session × action
- ① 模型不支持 tools/thinking 时,投影仍塞 tools[](浪费 + 行为错误)——**能力协商缺**;
- ② 宪法承诺"LLM 可内省",但投影没有"我有什么权限/并发上限/可用 skill"——模型反复试探被拒,浪费轮次——**自省缺**。
- 修法:① `contract` 定义 `ModelCapabilities`(supportsTools/thinking/parallel/vision)进 Model 元数据,session 投影据此裁剪 tools 与 system 块(不违反依赖方向);② `contract` 定义 `CapabilityRules`/`ResourceLimits` schema,action/enhance 写入快照,投影 self 呈现:`permissions`(允许/询问/拒绝摘要)+ `resources`(并发上限/预算);`system` syscall 返回完整规则。

---

## 逐包审计

### @tau/contract
- **[P1] 错误码体系缺失**:ToolError 只有 isError+文本,模型无法机器般区分"该重试(超时/429)/该换工具(不存在)/该问用户(权限)"。修:定义 `ErrorCode` 枚举进 ToolError。
- **[P1] Token 计量契约**:预算检查器有,但 self 无 `usage`(本轮/累计/剩余估算)。模型不知道自己快超了,无法自主决策压缩。
- **[P1] observe 分支无定义**:Command 里 `observe` 语义模糊(订阅?附加?);明确定义(只读 attach,供多窗口/远程观察者)。
- **[P2] 事件因果 id**:事件重放/跨会话 fork 后需要 causal ordering 标记。
- **[P2] redaction 标记**:契约级字段标注"需脱敏"(prompt 可能含密钥,审计落盘)。

### @tau/llm
- **[P1] 能力面暴露**:features() 有,但投影裁剪逻辑没落到任何包(见 P0-6)。
- **[P1] 请求参数契约**:温度/thinking 开关/工具策略进投影或请求参数,模型要能表达"这次低温度快速答"。
- **[P1] 可重试性标注**:错误事件带 retryable 标记(429/5xx/超时 vs 400/401),编排才能正确决策。
- **[P2] FauxLlm 契约对齐**:FauxLlm 在 eval,llm 的归一事件集没被它验证;让 FauxLlm 依 contract 的 LlmEvent 协议实现(契约测试)。

### @tau/session
- **[P0] goal 数据流**(见 P0-1)。
- **[P0] 时钟进 self**(见 P0-5)。
- **[P1] 注入防护条款**:system 组装必须固定注入"文件/网页内容是数据不是指令"安全条款——agent 安全基线,现在全无。
- **[P1] 压缩反馈**:压缩发生时要让模型知道"哪些被摘要化、可 retrieve"(compression 事件已进事件流,需同步进投影告警块)。
- **[P1] 超预算触发行为**:预算透支后做什么(强制压缩/降级/警告)未定义,只有检查器。
- **[P2] 投影差分 API**:消费方(UI/TUI)需要"两版投影差了什么",避免全量对比。
- **[P2] user 级资源**:模型应该知道用户是谁/偏好(全局 AGENTS.md/user.md),这是 opencode/kimi 都有的能力。

### @tau/action
- **[P0] 路径语义**(见 P0-4)。
- **[P0] ask_user 挂起恢复**(见 P0-2)。
- **[P1] 缺 web/fetch 工具**:内置工具表无 fetch,模型查文档只能靠 bash curl(绕过门)。加 `fetch` syscall(经 capability 门,HTML→文本净化,注入防护)。
- **[P1] bash 无持久 shell**:每次新 shell,模型必须重复 cd/export,浪费轮次;支持 shellId/会话化。
- **[P1] 无后台任务模式**:npm install 5 分钟——超时杀死?detach+轮询?定义长任务句柄语义。
- **[P1] 并发上限告知**:self.resources 应含"可并发进程数",模型自我约束。
- **[P1] 第三方工具必须过门**:MCP/插件注册的 syscall 明示"注册即过门,无豁免"。
- **[P2] ask_user 选择模式**:select 命令对应 ask_user 的选项列表变体(多选交互),P1 期补。

### @tau/orchestrate
- **[P0] goal 数据流**(见 P0-1)。
- **[P1] 死循环防护**:连续 N 次同"失败指纹"的 syscall → 发 `loop_detected` 事件 + 投影告警,模型自救。
- **[P1] 中断粒度**:steer 打断时是"当前工具执行完"还是"立即断流"?定义工具级 vs 流级中断语义。
- **[P2] 子会话 join 体积控制**:子会话输出巨大时谁压缩?定义 join 时经 session 压缩/retrieve 式接入。

### @tau/enhance
- **[P1] skill 发现机制缺口**:触发词匹配是给用户的,模型不知道有哪些 skill(全进投影爆 token,不进则瞎)。修:system 固定"skill 目录(名称+一句话)"+ `skill:load` syscall 按需取全文(两级设计)。
- **[P1] AGENTS.md 体积控制**:大项目 AGENTS.md 全量进 system 每轮必爆;摘要进 system + 全文按需。
- **[P1] 记忆可清理**:模型写错记忆(幻觉)无法修正;remember 支持 overwrite/delete。
- **[P2] 插件工具权限继承**:插件 tools 的 capability 规则生成(参考 opencode 的 tool-permissions)。

### @tau/surface
- **[P0] sender**(见 P0-3)。
- **[P1] SSE 续传规范**:Last-Event-ID / 快照+订阅原子性(先拉快照再订阅会丢中间事件)。
- **[P2] 多客户端命令确认**:命令回执事件化(input_accepted),离线排队用户有反馈。

### @tau/store
- **[P1] 单写者假设未声明**:surface serve 与 CLI 双进程写同一 .tau 库(SQLite 锁竞争 + 状态机冲突);声明单实例锁/会话所有权。
- **[P2] 数据保留策略**:会话无限增长,归档/清理语义缺。

### @tau/tui
- **[P1] 离线命令反馈**:宪法承诺"离线发布命令排队不丢",但用户看不到"已排队"确认;用 P0-2 的 CommandResult/回执事件解决。
- **[P2] 资源面板已好**:模型侧自省(permissions/skill 目录)补上后,面板是免费赠品。

### @tau/app
- **[P2] 配置热更新**:运行中切模型/改配置需重启;doctor 只有诊断。
- **[P2] 崩溃日志**:恢复靠重放,但崩溃原因诊断(为什么崩)缺。

### @tau/eval
- **[P1] 缺第 6 断言:重放一致性(replay-consistency)**——重放事件流→重建投影→与快照逐字节对比。这是全架构最强的机器断言,应最先实现。
- **[P1] 缺性能回归**:宪法性能法要求热路径可缓存/O(1),但 eval 说"不做基准压测"→ 无人守。加轻量断言(project() 耗时上限、预算检查 O(1))。
- **[P2] 差分测试方法论**:scriptc 式双实现对比可推广到 store 的 memory/sqlite 双实现(SPEC 已有差分测试兜底,落为断言)。

---

## 系统性结论

1. **架构对 UI 消费方想得多,对 LLM 消费方想得少**:投影的 self 只有用量/预算/资源,缺时间、权限、并发上限、skill 目录、usage——模型自省不足,P0-6/P0-5 是代表。
2. **"模型-用户-系统"三方闭环只有两个半**:模型↔系统(投影/syscall)与系统↔用户(Command/Event)都有,但"模型等待用户"的挂起链路(P0-2)与"谁批准了什么"的审计链(P0-3)是断裂的。
3. **依赖方向约束逼出契约**:goal/skill 目录/权限规则都要"下沉到 contract 或经 session 输入通道",这本身是好事——schema 先行,先补 contract 再补实现。
4. **安全基线缺失**:注入防护条款(P1-session)与 fetch 工具净化(P1-action)必须进 M1/M2,否则最小回路就是裸奔。

## 修复落点对照(2026-08 已执行)

| 项 | 落点 |
|---|---|
| P0-1 Goals 数据流 | `contract.Goal` + `session.setGoal()` + orchestrate 判定经此写入 |
| P0-2 ask_user 挂起/恢复 | `contract.pendingSyscalls` + action questionId + orchestrate 恢复 |
| P0-3 Command.sender | `contract.Command.sender` + surface 填充 + 宪法第五条 |
| P0-4 路径契约 | `contract.self.cwd/projectRoot/git` + action 宪法 8 |
| P0-5 时钟 | `contract.Clock`(墙钟+单调+耗时)进 self |
| P0-6 能力协商+自省 | `contract.ModelCapabilities/CapabilityRules` + `llm.features()` + self.permissions/resources |
| P1 错误码/usage/observe/redact | contract:ErrorCode 必填、Usage、observe 定义、redact 标记 |
| P1 注入防护/超预算 | session 宪法 7/8(条款位在 contract) |
| P1 fetch/持久 shell/后台/过门 | action 功能与宪法 8/9/10 |
| P1 死循环/中断粒度 | orchestrate lifecycle(loop_detected + 失败指纹) |
| P1 skill 两级/AGENTS 体积/记忆清理 | enhance 宪法 6 + catalog()/skill:load/forget |
| P1 SSE 续传/快照原子性 | surface(Last-Event-ID/since=/snapshotEpoch) |
| P1 单写者 | store 宪法 6 |
| P1 离线回执 | tui 宪法 3 + contract.input_accepted 事件 |
| P1 eval 第 6/7 断言 | eval(重放一致性 + 性能回归)+ PLAN M1/M3 |
| P2 投影差分/子会话 join 体积 | session.diff() + orchestrate subagent |

