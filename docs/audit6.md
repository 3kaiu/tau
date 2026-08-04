# Tau 架构审计报告 · 第六轮(修复后复审:依赖图与契约闭环)

> **修复状态(2026-08)**:P0×1、P1×7、P2×8 已逐项落进 AGENTS.md/PLAN/各包 SPEC。
> 落点:P0-1 依赖图 `enhance → llm/session/action`(AGENTS.md + PLAN 拓扑);deny 命令分支(contract Command,与 ApprovalState 全态对齐);Event id 逻辑时钟生成规则(contract event 位,权威写入侧 = session);摘要回调构造注入 + 压缩触发缺省 80%(session);审计 turnId(recovery 判定输入,action audit.ts);数据保留策略(store 宪法 7:归档/artifact 配额/审计窗口);fetch 禁 file://(action 宪法 10);危险命令检测定位声明(action 宪法 16);宪法 7 同步 session 身份 + 多语言语义文档覆盖新实体(contract);worktree×shell cwd 初始化(action workspace.ts);goal×turnBudget 交互 + fusion manifest 来源(orchestrate);断言 12 豁免标注(eval);artifact UI 路径声明(tui 宪法 2)。修复后现状以各 SPEC 为准。

> **审计状态(2026-08)**:第五轮修复后的立即复审——以修复后的 PLAN/宪法/11 个包 SPEC/AGENTS.md 为唯一依据,重点检查**修复是否引入新的断链**(第五轮新增概念:thinking/artifact 块、ApprovalState、config、multirun/fusion、fallback、summarize、DangerousCommandPatterns、workspace.ts、watchdog 决策)。
> 结论:**P0×1(依赖图缺口)、P1×7、P2×8**。上轮修复整体自洽,但引入 2 处"承诺了没接上"的新断链(enhance 依赖、approval 状态机),另有 1 项首轮遗留(数据保留)因 artifact 引入而升级。
> P0 判定标准同前:架构级缺陷,现在必修。

---

## 跨包 P0

### P0-1 enhance 依赖方向缺口:LLM 摘要 policy 需要 llm,依赖图未声明 ← enhance × llm × AGENTS.md
- enhance `summarize.ts`:"LLM 摘要 policy 走 session.project + llm 唯二出口"——LLM 摘要必然调 `kernel.stream/complete`,即 enhance **运行时依赖 llm 包**。
- 但 AGENTS.md 依赖图只声明 `enhance → session/action`,未含 llm。规范 3"依赖方向,违反即 CI 失败"——现在这条依赖是事实存在、图上缺失,实现期要么 CI 暴雷、要么实现方被迫绕路(把摘要 policy 塞进别处),两条都错。
- 修法:AGENTS.md 依赖图改 `enhance → llm/session/action`(单向向下不违宪,llm 是底层);PLAN 3 的依赖拓扑图同步。

---

## 逐包 P1

### @tau/contract
- **[P1] ApprovalState 存在不可达态:Command 无 deny/revoke 表达**:状态机有 denied/revoked,但 Command 封闭联合只有 approve/answer/abort/select——用户对 permission_request 只能批准、忽略或中止会话,**"明确拒绝"没有命令分支**。denied 状态不可达(仅 expired/revoked 可达),"拒绝"三态规则(允许/询问/拒绝)的运行时表达缺一半。修:Command 加 `deny` 分支(或 approve 带 approved:boolean),与 ApprovalState 全态对齐,approve/deny 都带 sender 审计。
- **[P1] Event id 生成与因果排序规范无归属**:event.ts 说"不可变、可重放、按 id 因果排序",但 **id 由谁生成、什么规则**(时间戳+序列?Lamport?UUID+epoch 比较)无归属。单进程内好办;surface serve 多客户端、multi-run 多会话、重放跨进程时,跨源排序需要明确的逻辑时钟规范(第六轮讨论的"逻辑时钟"只落了"Event 带 id + epoch 单调",没落生成规则)。
- **[P2] 宪法 7 未同步 session 身份**:功能面/模块要点已加 session 身份,但宪法 7 仍写"clock/usage/cwd/permissions/skill 目录"——宪法与模块要点漂移(上轮修的功能面,漏了宪法行)。

### @tau/session × @tau/enhance × @tau/orchestrate
- **[P1] 摘要注入机制归属缺失(委托是空的)**:session 边界"摘要生成委托 enhance 的策略",但 session 依赖只有 store(避免与 enhance 循环),`compact(reason, summary)` 的 summary 是传入参数——**谁在压缩时调 enhance.summarize、再把结果传给 session.compact?** orchestrate 依赖图不含 enhance(app 拼装点之外无包能组合这两者);session 宪法 9"缺省先压缩"没有执行方归属。修:session 构造期注入摘要回调(实现可为 enhance.summarize),SPEC 显式声明"摘要源经构造注入,不 import enhance";压缩触发路径(超预算 → 调回调 → compact)归属明确。
- **[P1] recovery 悬置判定无数据支撑**:lifecycle 承诺"从审计日志判定上次 turn 已提交/未提交的 syscall 清单",但 action 审计记录(入参/结果/耗时/批准链)**无 turn/epoch 关联**——日志不知道哪些 syscall 属于已提交的 turn,悬置判定没有判定输入。修:审计记录带 `turnId`(提交点边界在 orchestrate promote,写入审计时携带)。

### @tau/store
- **[P1] 数据保留策略缺(首轮遗留,artifact 使其升级)**:首轮 P2"会话无限增长,归档/清理语义缺"从未落 SPEC;本轮 artifact 块**显式把大载荷(图片/二进制/大文件)存进 store**,无配额、无保留/清理语义——审计表、事件表、artifact 正文三条无限增长线并存。修:store 加保留策略(会话归档/artifact 配额(总量/单块上限)/审计滚动窗口),归入 M4 持久化期。

### @tau/action
- **[P1] fetch 可逃逸 workspace 边界**:fetch 是网络工具,不经 workspaceRoots 检查——`fetch file:///etc/passwd` 或本地文件 URL 可绕过宪法 14 的文件边界。修:fetch 明确拒绝 `file://`/`localhost` 环回以外协议,或显式声明"fetch 不受 workspaceRoots 约束"二选一,不能留白。
- **[P2] 危险命令检测的绕过面定位**:持久 shell 下"先 cd 到根、再 rm -rf"分步绕过、`/bin/rm` 全路径、变量展开——检测是单条参数启发式。修:与宪法 19(沙箱不做)呼应,显式声明"检测是防线不是安全边界,定位 = 降低误执行率,不承诺对抗绕过"。
- **[P2] worktree 与持久 shell 的 cwd 初始化**:multi-run 各 run 独立 worktree,缺省会话级持久 shell 的初始 cwd = 会话 cwd——fork 子会话时 shell cwd 初始化为子会话 worktree 根?SPEC 未定义。

### @tau/orchestrate
- **[P1] 压缩触发无定量缺省**:session 宪法 9"超预算 → 缺省先压缩",但"先压缩"的触发线(历史条数?超预算比例?何时判定压缩已失败需降级?)无缺省值,实现期自行发挥。修:compaction 触发缺省值进 SPEC(如:超预算 80% 触发,压缩后仍超 → 降级)。
- **[P2] goal 循环与 turnBudget 交互未定义**:goals 每 turn 判定"未完成继续",turnBudget 超限停止——goal_continue 唤醒消耗 maxTurns 吗?goal 驱动的长任务会不会把 turn 预算当"每轮额度"误杀?两者交互语义无归属。
- **[P2] fusion 产物的 manifest 来源**:`fusion(runs)` 产出"可继续对话的新会话"——新会话的模型/能力/工作区 manifest 从哪个 run 继承?未定义。

### @tau/eval
- **[P2] 断言 12(原子写)与宪法 3"断言测契约不测实现"张力**:原子写是 action 文件系统行为,不在 contract 不变量上;断言 13(真相源)因 exitCode 已入 ToolResult 契约而合规。修:断言 12 显式标注为"行为断言(豁免),非契约不变量",或改挂"契约位声明存在"。

### @tau/surface + @tau/tui
- **[P2] artifact 的 UI 显示路径(双视角边界)**:投影只有 artifact 引用,UI 若直接展示正文(图片预览/文件视图)则"UI 可见 ⊄ 投影"。修:tui 渲染 artifact 必须经事件流(tool 事件携带的正文或引用),SPEC 声明"UI 不得直读 store artifact 表"。

### @tau/contract(多语言)
- **[P2] 跨语言语义文档未覆盖新实体**:多语言节只点名 ErrorCode/Goal 状态机;thinking/artifact 块、ApprovalState、DangerousCommandPatterns 的语义文档未含——其他语言重实现时这些语义无依据。

---

## 系统性结论

1. **本轮主题是"承诺的接线"**:第五轮把概念都立起来了(状态机、模块、策略),但**接线点**(谁调用谁、数据从哪来、命令怎么表达)有 3 处断:enhance 依赖图(P0)、deny 命令缺失、摘要注入归属——"有机制"和"机制可被触发"之间还差一层。
2. **恢复路径的承诺需要数据支撑**:recovery 悬置判定是上轮亮点,但审计日志没有 turn 边界,判定器将无米下锅——**新承诺必须自检其输入是否存在**。
3. **数据保留是唯一跨五轮未落的旧账**:首轮 P2 至今,artifact 引入后从"膨胀"升级为"大载荷无限存储"——M4 持久化前必须定案。
4. **双视角不变量对新类型(artifact)有隐性要求**:任何新投影实体的 UI 呈现路径都要过"UI 可见 ⊆ 投影"检查,SPEC 应养成"新块类型 → UI 路径声明"的习惯。

## 修复建议

1. **M1/M2 前(P0)**:AGENTS.md + PLAN 依赖图补 `enhance → llm`;Command 补 deny 分支(与 ApprovalState 对齐,改类型+检查器例行闭环);
2. **M2 顺手(P1)**:审计带 turnId(recovery 判定输入)、摘要回调注入归属、压缩触发缺省值、fetch file:// 拒绝或声明;
3. **M4 前(P1)**:store 数据保留策略(会话归档/artifact 配额/审计窗口);
4. **M4 后(P2)**:Event id 逻辑时钟规范、宪法 7 同步、断言 12 豁免标注、artifact UI 路径声明、跨语言语义文档补新实体、worktree/shell cwd、fusion manifest、goal×turnBudget 交互。
