# Tau 架构审计报告 · 第五轮(SPEC 现状 × 外部架构讨论对照)

> **修复状态(2026-08)**:P0×6、P1×8、P2×4 已逐项落进 contract/各包 SPEC/PLAN.md。
> 落点:P0-1 thinking 块(contract Message + session history);P0-2 摘要归属(enhance summarize.ts);P0-3 workspace 归属(action workspace.ts);P0-4 幂等/原子写(contract fileMeta/幂等声明 + action 宪法 17 + orchestrate 悬置判定);P0-5 Multi-run/Fusion(orchestrate multirun.ts);P0-6 配置归属(contract config.ts);P1 artifact/Approval 状态机/self.session(contract);P1 熔断降级链(llm fallback.ts);P1 真相源/危险命令/进程树终止/沙箱决策(action 宪法 15/16/18/19);P1 插件×单二进制(enhance plugins.ts);P1 批准详情链(surface 宪法 5 + tui views);P1 watchdog 决策(orchestrate 边界);P2 四契约/断言数统一(PLAN.md)、store M4 标注、eval 追加断言 11-13、audit4 回填状态。修复后现状以各 SPEC 为准。

> 审计状态:本轮是**文档级现状审计**——以 PLAN.md / docs/constitution.md / 11 个包 SPEC.md 为唯一依据(不审实现),与外部 7 轮架构讨论(沙箱/workspace、压缩/WAL/脱敏、CAS/回放、注入防护/幂等、Prompt Cache/Bun compile、编码/Watchdog、GC/自愈)逐项对照,回答"建议是否已入 SPEC、概念是否有归属、SPEC 间是否一致"。
> 结论:**P0×6(硬缺口:概念无归属/SPEC 断链)、P1×8(弱缺口:未声明,建议显式化)、P2×4(文档漂移)**。
> 前四轮审计已修复的机制本次按"已内建"处理,不再重复;P0 判定标准同前:架构级缺陷,现在必修。

---

## 一、已内建机制(Gemini 讨论 → SPEC 落点,约 70%)

| 外部建议(轮次) | SPEC 落点 |
|---|---|
| 注入防护条款(4) | contract 宪法 9(条款模板位)+ session 宪法 7(system 固定注入,priority 最高) |
| 工具分级 T0/T1(4) | contract:tools[] 带 tier + tool:catalog 按需注入;action 内置工具目录查询 |
| secret 脱敏(2) | action 宪法 13(`-----BEGIN`/`*_KEY=` 模式检测 → redact 标记,不阻断) |
| 单写者/文件锁(3) | store 宪法 6(锁文件 + 会话所有权,第二写者明确报错) |
| 长任务 detach(3) | action 后台任务(返回 taskId,可轮询/取消) |
| 重放恢复不靠内存(3) | orchestrate 宪法 5 + eval 断言 6(重放一致性) |
| HITL 竞态·首个生效(4) | surface 宪法 5(permission_request 广播,首个 approve 生效,后续忽略) |
| Prompt Cache 前缀稳定(5) | session projector 装配顺序固定(system→history→tools→self→resources)+ llm cache.ts 策略位 |
| 断线续传(5) | surface 宪法 3(Last-Event-ID / since= / snapshotEpoch,先快照后订阅不丢窗口) |
| 死循环防护·行为指纹(5) | orchestrate lifecycle(同工具同参数无论成败 N 次 → loop_detected) |
| 编码/二进制检测(6) | action 宪法 12(NUL 字节/解码失败 → 拒绝并报告) |
| 逻辑时钟/因果排序(6) | contract Event 带 id(因果/幂等/重放)+ session epoch 单调递增 |
| 虚拟滚动(6) | tui 长输出虚拟化(transcript 只渲染可视窗口) |
| 确定性/虚拟时钟(7) | eval 宪法 2(离线确定性)+ FauxLlm 虚拟时钟 |
| WAL 读不锁写(2/7) | store 宪法 5 |
| ask_user 挂起恢复(2) | contract pendingSyscalls + action 宪法 6(questionId + answer 路由恢复) |
| 子会话 join 体积控制(2) | orchestrate subagent(join 经压缩/retrieve 式接入,不整包注入) |

未入 SPEC 的讨论项(telemetry/账户:PLAN 2.4 明确不吸收;热重载/PTY:app/action 声明后期)不算缺口,其余见下文 P1。

---

## 二、跨包 P0:硬缺口(概念无归属 / SPEC 断链)

### P0-1 thinking 契约断链 ← llm × contract × session
- llm 宪法 7:"thinking 默认进历史(模型接住思路),设体积上限,超限转摘要"。
- 但 contract `Message.content` 块**无 thinking 类型**;session history/compaction **无 thinking 存储与压缩语义**。
- **矛盾**:llm 承诺的契约行为,契约层与记忆层都不知道 thinking 长什么样。超限转摘要又依赖 P0-2 的摘要归属,双重断链。
- 修法:contract 定义 thinking 内容块(体积上限/超限转摘要标记);session 定存储语义(进历史 + retention 分级)。

### P0-2 压缩摘要无归属 ← session × enhance
- session 边界声明"摘要生成委托 enhance 的策略"(session SPEC 边界节)。
- 但 enhance SPEC 功能面与模块表(enhancer/loader/skills/memory/policies/plugins/frontmatter)**无任何摘要/压缩模块**。
- **矛盾**:宪法第七条"压缩是交换不是丢弃"是核心机制,但产出摘要的一方不存在。会话超长时唯一摘要源缺失,交换无法兑现。
- 修法:enhance 增加摘要策略模块(可插拔 policy,默认规则摘要),或回迁 session 并更新边界声明——二选一,必须先定归属。

### P0-3 workspace 概念无包 ← contract × action × enhance
- 路径边界散落三处:contract `self.cwd/projectRoot/git` + `resources.workspaceRoots`;action 宪法 8(路径契约)/14(工作区边界);action 依赖 `ignore`(gitignore 匹配)。
- **缺失**:文件树 / 忽略规则 / 增量索引作为"workspace"统一概念**无包级归属**;多根、忽略语义、索引失效策略无人负责。第 1 轮讨论的 workspace 概念只落地了"路径范围",没落地"工作区模型"。
- 修法:归属判定(建议 action 或 enhance 建 workspace 模块,contract 只定义边界),SPEC 交叉自查同步。

### P0-4 副作用原子性/幂等无契约 ← orchestrate × action
- 调度法:"turn 是原子单位";recovery 告警已内建("上次 turn 未提交,副作用可能已落盘且无法回滚")。
- **缺口**:告警是"告知",不是"修复"。无 Pending→Committed 两阶段、无 IdempotencyKey、无"同一 edit 重复 apply 的判定语义"。crash 恢复后模型重试 edit,文件与预期不符 → 失败或重复修改——第 3/4 轮讨论的幂等性问题未落契约。
- 修法:契约位声明幂等语义(read 结果带 mtime/hash 判陈旧 → 重读;write 原子写);恢复路径给"副作用悬置判定"而非仅告警。

### P0-5 Multi-run / Fusion 无 SPEC 承载 ← PLAN × orchestrate
- PLAN 2.3:"Multi-run(一任务 N 模型并行 + worktree)+ Fusion(汇总子会话 diff 生成新会话)"列为 M8。
- orchestrate SPEC 只有 `fork(manifest)`(子会话生命周期),**无 Multi-run 编排、无 worktree、无 Fusion 汇总语义**。PLAN 承诺的高级特性没有 SPEC 层承载,M8 无从验收。
- 修法:orchestrate SPEC 增加 multi-run 模块要点(spawn N 子会话/manifest 校验/worktree 归属);Fusion 的 diff 汇总算法归属判定。

### P0-6 配置 schema 归属冲突 ← app × contract
- app 宪法 4:"配置即契约:配置 schema 走 contract 校验"。
- contract SPEC 功能面与边界("不做序列化协议之外的任何事")**无配置 schema 模块**。
- **矛盾**:宪法要求 contract 校验,contract 不知道自己拥有配置 schema。属 contract 扩展功能面,还是归还 app(仅引用契约校验器)?须二选一并落 SPEC。
- 修法:建议 contract 增加 `config` 模块(纯 schema,符合"纯 schema 不写语义"),app 只做装载/合并/装载路径。

---

## 三、逐包 P1:弱缺口(未声明,建议显式化)

### @tau/contract
- **[P1] Message 无大载荷块**:图片/二进制/Artifact 无内容块类型(第 3/5 轮:大载荷、CAS、Artifact 均无承接)。修:定义 artifact 块 + 存储引用语义(不进历史正文,引用检索),CAS 是否采用需显式决策。
- **[P1] Approval 无生命周期状态机**:三态规则 + 首个生效已内建,但无 expired / 撤销 / 孤儿挂起(会话 abort 后残留 pending)状态。修:approval 状态机进契约(active/approved/denied/expired/revoked)。

### @tau/llm
- **[P1] 无熔断/降级链**:model_switched + 故障转移已内建,但无熔断阈值(连续 N 次失败)与降级模型链(降级到哪个模型、是否告知)。修:降级路由策略进 llm/route 或 orchestrate lifecycle,事件化可见(第 4 轮)。

### @tau/action
- **[P1] 沙箱物理隔离未声明**:第 1 轮建议的进程隔离(防恶意命令真执行)无 SPEC 表述。修:边界节声明"物理沙箱不做/何时做"(Bun 生态无成熟沙箱,建议显式标注"第一版靠 capability 门 + 危险命令检测,不做物理隔离"——不声明也是一种决策,但要写出来)。
- **[P1] audit4 遗留未落 SPEC**:exitCode/stderr 分离、危险命令内容级检测、write 原子写(临时文件+rename)、read 带 mtime/hash——audit4 列为 P1,但 action SPEC 仅落地了互斥写队列,上述四项未入 SPEC(第 4 轮"真相源"主题的一半仍悬空)。
- **[P1] Abort 无进程组语义**:取消/超时只说"可取消",无"终止整棵进程树(SIGKILL)"与孤儿进程清理(第 4 轮 + audit4 P2)。修:runtime 取消语义显式化,后台任务 detach 后的清理归属。

### @tau/enhance
- **[P1] 动态插件 × 单二进制冲突未声明**:enhance.plugins 支持运行时装载,app 走 Bun `--compile` 单二进制——运行时插件与编译期封装的冲突(第 5 轮)无 SPEC 决策。修:显式声明插件形态(外部进程/动态 import/编译期内置)。

### @tau/surface + @tau/tui
- **[P1] 批准详情渲染链未落**:audit4 已定 permission_request 带参数摘要 → surface 透传 → TUI 弹窗,但 action SPEC 只写"工具名/能力/理由"(无参数摘要),tui SPEC 无批准弹窗细节。修:三处同步补 SPEC。

### @tau/orchestrate
- **[P1] Watchdog/自愈缺位**:第 6/7 轮讨论的死循环之外的"进程挂死/事件流停滞"无监督机制(loop_detected 只管同指纹循环)。修:声明 turn 超时上限已覆盖或补 watchdog 语义——同样,"不做的决策"也要写出来。

---

## 四、P2:文档漂移(前后轮自查未覆盖的 SPEC 间不一致)

- **[P2] "四契约"定义漂移**:宪法第二条 = Context/SystemCall/Event/Command 四个封闭联合;PLAN 3(81 行)"四契约:Model/ContextProjection/SystemCall/Command/Event + Session schema"——Model 被计入四契约且实体数对不上。修:统一表述(宪法为准,PLAN 改为"四契约 + 元数据 schema")。
- **[P2] eval 断言数漂移**:PLAN M3 出口"7 个行为断言";eval SPEC 功能面标题写"第一版 7 个"却列了 10 条(断言 8-10 未标注"追加")。修:统一计数与版本表述。
- **[P2] audit4 修复状态未标注**:audit/audit2/audit3 均带"修复状态(2026-08)"行,audit4 无;且其 P1 多项(见上 P1)实际未落 SPEC。修:回填状态行,或按本报告 P1 逐项补 SPEC。
- **[P2] store SPEC 超前于实现**:模块表已含 sqlite.ts/migrate.ts(WAL/checkpoint/迁移),当前仅 memory 实现(M4 未到)——目标态表述可接受,但建议 SPEC 标注里程碑归属,防"以为已实现"。

---

## 系统性结论

1. **本轮主题是"概念归属"**:前四轮提的机制 70% 已落 SPEC;剩下的缺口不再是没有机制,而是**机制承诺了、却没有模块/契约承接**(thinking、摘要、workspace、Multi-run、配置 schema)——断链比缺失更危险,因为实现期会默认"有人做了"。
2. **两处"委托"是空头支票**:session 把摘要委托给 enhance、app 把配置校验委托给 contract,两个被委托方 SPEC 里都没有对应职责——宪法级机制挂在委托声明上,必须回填。
3. **audit4 的 P1 半数悬空**:exitCode/危险命令/原子写/批准详情链是"真相源与命令级安全"主题的核心,未落 SPEC 意味着 M2 工具实现期无人执行;本轮已并入 P1。
4. **"不做的决策"也是决策**:沙箱/遥测/热重载多数已有明确不做的表述,但沙箱、Watchdog 没有——SPEC 应显式声明"不做"并给替代防线(capability 门 + 危险命令检测),否则 M8 前会反复被讨论。

## 修复建议

1. **M1/M2 前(P0)**:contract 补 thinking 块 + artifact 块 + approval 状态机 + config 模块(并入既有纯 schema 职责);enhance 补摘要策略模块或 session 回迁摘要;orchestrate SPEC 补 Multi-run/Fusion 要点;action 补幂等/原子写语义;
2. **M2 顺手(P1)**:action 落 audit4 四项(exitCode/stderr/危险命令/原子写/mtime)+ Abort 进程组语义;surface/tui 批准详情链;llm 降级链;
3. **M4 前(P2)**:PLAN/宪法"四契约"统一、eval 断言计数统一、store SPEC 标注 M4 归属、audit4 回填修复状态。
