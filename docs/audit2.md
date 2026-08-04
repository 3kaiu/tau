# Tau 架构对抗审计报告 · 第二轮(修复后复审)

> **修复状态(2026-08)**:P0×4、P1×7、P2×5 已逐项落进 contract/各包 SPEC/AGENTS.md。
> 落点:retry 事件 + wake + Message + tool tier + 分页 + system 优先级 + usage 误差(contract);最近活动块 + 痕迹可见 + 归档双轨(session);read range + result:page + shell 统一 + system 内省 + tool:catalog(action);wake/retry 产出 + user_steer(orchestrate);model_switched + thinking 策略(llm);skill 记忆提示(enhance);observe 可见范围(surface);FauxLlm 虚拟时钟/错误注入 + 断言 8(eval);SPEC 交叉自查(AGENTS.md)。

> 视角:同第一轮——我是被投喂 ContextProjection 的 LLM。本轮从"架构正确性"下沉到**操作层摩擦**:每天 100 轮循环里,哪些东西让我低效、困惑、断片。
> 结论:**P0×4、P1×7(含 1 处 SPEC 内部矛盾)、P2×5**。上一轮修复引入 1 处自相矛盾,另有两项新 P0 是"修复方案的副作用"。

---

## 跨包 P0

### P0-1 自动重试 = 隐藏命令,违宪(修复副作用)
- llm 宪法 3:"重试策略是 orchestrate 的职责";orchestrate lifecycle 有 retry;但宪法第七条"隐藏命令 = 违宪"要求模型感知一切自动操作。
- **矛盾**:编排对 LLM 请求失败重试 2 次,被重试方(我)完全不知道——我看到的是"响应很慢"或"莫名其妙多等了几秒",无法判断网络状况、无法决策"是不是该降级模型"。
- 修法:`retry` 事件进 Event 流,且进投影"最近活动"块(或历史):"上轮请求 429 失败,重试 2 次后成功"。

### P0-2 唤醒原因缺失(wake reason)
- 我被 cron 定时唤醒 / steer 打断续跑 / answer 恢复 / goal 判定后自动续跑——投影里没有任何"为什么现在醒"的信息。长会话里我会困惑"我刚在干嘛?这是谁的输入?"
- 修法:`ContextProjection` 加 `wake { reason: prompt|steer|answer|goal_continue|cron|retry|resume, source }`。这是 Goals/cron/多客户端的最小可生存条件。

### P0-3 工具结果的"一次性截断" + read 无 range(token 经济学)
- bash 长输出被截断后,中间段**永久不可见**(只有截断标记,无续读协议)——我永远看不到被我截掉的那 30 行日志。
- read 大文件(5000 行)无 range 参数:一次 read = 全量进历史 = 一轮烧掉 1/4 上下文。
- 修法:① `read` 支持 `range{from,to}` + `preview`(前 N 行 + 总行数报告);② `ToolResult` 带 `truncated + totalPages`,新增 `result:page` 协议——按页续读工具结果,不整段重灌。

### P0-4 工具集每轮全量进投影
- 10 内置 + 30 MCP 工具 × 200 token 描述 ≈ 8k token/轮固定开销,而我每轮只用 3-5 个。
- 修法:与 skill 两级装载对称——**工具也分两级**:T0 常用工具常驻;冷工具经 `tool:catalog` 查询后按需注入本 turn。tools[] 带 `tier` 标记。

---

## 逐包审计

### @tau/contract
- **[P1] 历史消息结构未定义**:`Message`(role/content 块/toolCalls[]/toolResults[] 关联 id/interrupted 标记/来源标注)是模型连续性的地基,现在无 schema。部分模型要求 tool_call 与 result 严格配对,契约必须兜住。
- **[P1] system[] 无优先级规则**:注入防护/AGENTS.md/skill 目录/策略块并存,顺序与覆盖未定义。修:system 块带 `kind + priority`,防护条款永远最高。
- **[P1] wake 块**(见 P0-2)。
- **[P2] 并行工具结果顺序契约**:并行 N 调用,结果按调用顺序稳定进历史(按 callId 归位)。
- **[P2] usage 估算误差声明**:跨 provider 无 tokenizer 时的估算精度标注(±x%),我不至于把估算当精确值。

### @tau/llm
- **[P1] 模型切换无感知**:故障转移/手动切换 provider 后,历史与能力面突变,我毫无察觉。修:切换发事件 + 投影告警("模型已切换为 X")。
- **[P2] thinking 块策略**:thinking 进历史与否、体积上限——决定长会话里我"能不能接住自己的思路"。定策略(默认进,设上限)。

### @tau/session
- **[P0] 截断/中断的模型可见性**:我的上一条回复被 abort,下轮投影无标记 → 我接着往下说,语气与内容全断。修:`Message.interrupted` + abort 事件进历史(见 contract P1-1)。
- **[P1] 重试可见性**(见 P0-1,历史/最近活动)。
- **[P2] 事件表归档**:重放一致性断言对大会话 O(n) 全扫——快照+增量事件双轨,断言与恢复都 O(1) 起跳。

### @tau/action
- **[矛盾] bash 持久 shell 语义自相矛盾**:功能面写"缺省一次性"(line 14),模块要点写"默认持久 shell"(line 46)。修:统一缺省(建议:会话级持久,`new_shell: true` 显式重置)+ 定义 shellId 生命周期(会话级 vs turn 级)。
- **[P0] read range/结果分页**(见 P0-3)。
- **[P1] fetch 结果无来源引用**:抓取 URL/时间/净化标记缺失,我无法判断信息陈旧度。修:结果带 `url + fetchedAt + truncated`。
- **[P1] system syscall 未定义**:内置工具表有 system,功能面无职责。修:system = 内省 syscall(完整权限规则/队列状态/pendingSyscalls 计数/工具目录)。

### @tau/orchestrate
- **[P0] 重试可见性**(见 P0-1)。
- **[P1] cron/goal 唤醒要带 wake.reason**(见 P0-2,orchestrate 是 wake 的产出方)。
- **[P2] steer 的模型侧体验**:steer 内容进历史时标 `user_steer` 标记,我才能区分"用户新指令"和"打断插话"。

### @tau/enhance
- **[P2] skill:load 进历史的持久性**:加载的 skill 全文进历史,长会话压缩后丢失——我该重新 load 还是从摘要推断?给"skill 记忆提示"(压缩告警块里提醒)。

### @tau/surface
- **[P2] observe 观察者可见范围**:远程只读观察者默认看不到审计/权限明细(敏感),定义 filter 默认值。

### @tau/store / @tau/tui / @tau/app
- **[P2·store] 事件与消息表膨胀**:长会话事件表巨大,重放慢(与 session P2 归档合并)。
- **[P2·app] 首次运行引导**:无凭据时 doctor 应给"可操作的一步"(配 key 还是选免费模型)。
- 其余无新发现(单写者/回执/续传已就位)。

### @tau/eval
- **[P1] FauxLlm 能力不足**:断言 7(性能回归)需要可控时钟;挂起/恢复(ask_user)、cron 唤醒、错误注入(重试可见性)都要 FauxLlm 支持。修:FauxLlm 增加**虚拟时钟 + 脚本化错误注入 + 挂起/回答模拟**。
- **[P2] 消息结构断言**:tool_call/result 配对、interrupted 标记进"命令纪律"断言族。

---

## 系统性结论

1. **第二轮的主题是"token 经济学"**:P0-3/P0-4 合计——工具描述 + 大结果 + 大文件 read 三处都是"一次全量"思维,没有分级/分页/续读。模型 100 轮会话里,这三处决定能不能撑住,而不是特性多不多。
2. **模型连续性依赖"痕迹"**:重试/中断/唤醒/模型切换都是"我感知不到的自动事件"。宪法第七条(隐藏命令违宪)执行得不够彻底——**所有自动行为要么事件化、要么进投影告警,没有例外**。
3. **修复引入的矛盾要专门查**:bash shell 缺省策略自相矛盾,说明跨 SPEC 修改需要一致性校验(建议 AGENTS.md 加一条:改 SPEC 后自查与相关包 SPEC 的交叉引用)。

## 修复建议

1. M1 契约期:Message 结构、wake、system 优先级、retry 事件、ToolResult 分页标记——一次定型;
2. M2:read range/result 续读协议、tool 两级(tier)、bash shell 缺省统一、interrupted 标记;
3. M3:eval FauxLlm 虚拟时钟/错误注入;断言的"感知痕迹"族。
