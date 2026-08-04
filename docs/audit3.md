# Tau 架构对抗审计报告 · 第三轮(生命周期与信息保真)

> **修复状态(2026-08)**:P0×2、P1×6、P2×8 已逐项落进 contract/各包 SPEC。
> 落点:turnBudget + workspaceRoots + Message.modelId/retention + usage.cost + maxOutputTokens + recovery 事件(contract);recovery 告警 + retention 压缩(session);行为指纹 + turn 预算 + recovery 产出(orchestrate);二进制/secret 检测 + 工作区边界(action);permission 广播 + 多会话路由(surface);checkpoint(store);断言 9/10 + crash 模拟(eval);serve --sessions(app)。

> 视角:同前两轮——我是 LLM。前两轮覆盖了"架构正确性"与"操作层摩擦";本轮聚焦**生命周期边界**(crash/恢复/turn 预算/副作用)与**信息保真**(溯源/压缩分级/敏感内容)。
> 结论:**P0×2、P1×6、P2×8**。

---

## 跨包 P0

### P0-1 turn 级预算缺失:成功但不推进的失控循环
- 现有防护只有 `loop_detected`(同"失败指纹"连续 N 次)。但**失败循环之外有更常见的失控**:我"成功"地原地踏步——连续 read 同一个文件、重复 ls、改一个文件后又改回去——每次都成功,指纹不同,永远不会触发 loop_detected。
- 修法:`scheduler.turnBudget { maxTurns, maxTurnMs, maxToolCallsPerTurn }`;超限 → `budget_exceeded` 事件 + 投影告警("已跑 N 轮未推进,建议改策略或问用户");预算进 self.resources,模型开跑前就知道上限。eval 加"预算断言"。

### P0-2 副作用与 turn 提交的原子性缺口(crash 恢复陷阱)
- 宪法:"turn 是原子单位"、"恢复靠重放"。但**工具的副作用(写文件)在 turn 内即时生效、不可回滚**——若进程在 turn 中途 crash:
  - 重放恢复到上次提交点 → 我看到的工具结果不存在(我以为"没改过文件")
  - 但磁盘上文件已经改了一半 → 我再 apply 同一 edit:文件与预期不符,失败或重复修改
- **这是真实系统里最阴的状态错乱**。
- 修法:恢复时发 `recovery` 事件 + 投影告警块:"上次 turn 未提交完成,期间可能已有工具副作用落盘且无法回滚——先 `git status`/检查文件再继续"。`Message.interrupted` 复用标记未完成 turn。

---

## 逐包审计

### @tau/contract
- **[P1] Message 无溯源(modelId)**:模型切换/多模型评测(Multi-run)后,历史里"哪条消息是谁说的"不可辨。修:Message 带 `modelId`(UI 亦可显示)。
- **[P1] Message 无 retention 分级**:压缩策略不知道哪些消息不可丢。修:Message 带 `retention: high(用户指令/Goal)|normal(模型输出)|low(工具输出)`,压缩先丢 low,用户指令永不先丢。
- **[P2] cost 字段**:self.usage 无成本累计,我无法决策"该不该换便宜模型"。加 `cost`。
- **[P2] 工具 schema 无输出上限声明**:调用前我不知道 bash 会吐多大。schema 加 `maxOutputTokens`,与截断语义对齐。

### @tau/session
- **[P1] 压缩的 retention 顺序**(见 contract P1-2,compaction 执行)。
- **[P2] turn 内实时预算反馈**:每次 ToolResult 附 usage 增量(本次调用烧了多少)——长任务里我知道"每步的代价"。累计已有,增量补上。

### @tau/action
- **[P1] read 无二进制/编码检测**:read 二进制或非 UTF-8 文件 → 乱码进历史,一轮烧几千 token。修:检测 NUL 字节/解码失败 → 拒绝 + 报告"二进制文件,大小 X,建议用 file/xxd 或跳过"。
- **[P1] 密钥/敏感内容无检测**:bash cat .env 或模型 read 出密钥 → 进历史 + 审计。修:工具结果过敏感模式检测(-----BEGIN/KEY= 等),命中 → 事件告警 + 结果带 redact 标记(不阻断,提示模型)。
- **[P2] 工作区边界**:self.resources 加 `workspaceRoots`(允许读写的路径范围),read/write 越界直接拒绝——防 ../ 逃逸到用户主目录。
- **[P2] 成功但无效循环指纹**:loop_detected 从"失败指纹"扩展为"行为指纹"(同工具同参数无论成败 N 次)。

### @tau/orchestrate
- **[P0] turn 预算**(见 P0-1)。
- **[P0] 恢复的副作用悬置告知**(见 P0-2,orchestrate 是恢复的发起方)。
- **[P2] turn 提交点语义明确化**:interrupt(steer)时已完成的工具结果进历史(提交);crash 时未提交。两类都让模型可感知(interrupted 标记 + recovery 事件)。

### @tau/surface
- **[P1] permission_request 无跨客户端广播语义**:`tau serve` 多客户端时,模型要批准,弹窗出现在哪个客户端?修:permission_request 事件广播到所有客户端,任一 approve/answer(sender 审计)即生效;首个回复生效,后续忽略。
- **[P1] 无多会话路由**:M7 远程会话前置——`GET /sessions`、`POST /sessions/:id/command`。当前 API 只服务单会话。
- **[P2] observe 的粒度选择**:按类型/会话过滤已够,不做全量。

### @tau/store
- **[P2] 快照边界未定义**:归档双轨(快照+增量)打了,但"何时打快照"没定义。修:checkpoint 策略(每 N 事件或每 turn 提交打快照,断言/恢复 O(1) 起跳的兑现条件)。

### @tau/eval
- **[P1] 缺预算断言**:turn 预算(P0-1)与副作用悬置(P0-2)都应成为断言:
  - 9. **预算纪律**:turn 超限即中断 + 投影告警,无失控循环
  - 10. **恢复告知**:模拟 crash,断言恢复后模型可见 recovery 告警
- **[P2] FauxLlm 模拟 crash**:错误注入扩展为"turn 中途终止"(进程级模拟)。

### @tau/llm / @tau/tui / @tau/app / @tau/enhance
- llm:无新发现(thinking 策略、model_switched 已就位)。
- tui:模型切换已事件化,资源面板可显示当前 modelId(免费赠品)。
- app:`tau serve` 支持 `--sessions` 多会话(与 surface P1-2 配套)。
- enhance:无新发现(skill 记忆提示已就位)。

---

## 系统性结论

1. **第三轮主题是"生命周期的诚实"**:架构对"正常运行"想得很细,对"中途死掉"(crash/中断/预算耗尽)的模型侧体验是空白的——而 agent 的日常就是各种中断。P0-2(副作用 vs 提交原子性)是其中最危险的一条,必须在 M4 持久化阶段前定型。
2. **信息保真是 token 经济学的另一半**:第二轮的"分级"只做了工具与 skill;本轮的 retention 分级(压缩不丢用户意图)与 modelId 溯源是消息层的对偶。
3. **安全从"过门"走向"内容"**:前两轮的 capability 门管"能不能调";本轮的 secret 检测管"结果里有什么"——密钥进历史比调工具更常见。

## 修复建议

1. **M4 前(P0)**:turn 预算(scheduler + contract + eval 断言)、恢复的副作用悬置(recovery 事件 + 投影告警);
2. **M1/M2 顺手(P1)**:Message.modelId/retention、read 二进制检测、secret 检测、permission 广播语义;
3. **M7 前置(P1)**:surface 多会话路由。
