# Tau 复审计报告(消费方 LLM 视角, M8 之后)

> 审计视角:**我是一个被投喂 `ContextProjection`、靠 `SystemCall` 行动、被 `Event` 反馈的 LLM**。
> 审计基线:docs/audit.md(2026-08 已修复 P0×6/P1×14 并落进各 SPEC)。本报告验证**当前 M8 代码是否真兑现 SPEC**,并查找新漂移。
> 方法:通读 11 个包 SPEC + 宪法;机器化扫描依赖方向与旁路 IO;抽样读取 contract 四契约、session.projector、action.runtime、orchestrate.scheduler、surface.face 等关键实现对照 SPEC。
> 结论:**架构骨架健壮,但契约层有 3 个 P1 缺口 + 若干 P2 漂移**,均围绕"消费方 LLM 的连续性与命令可审计性"。

---

## 一、已达标项(正面确认,可信任)

| 项 | 证据 |
|---|---|
| 依赖方向(宪法第四条) | 依赖图完全单向:`contract` 零依赖、`llm/session/store/orchestrate/surface/tui/enhance/action` 只依赖下方包、`app` 作为唯一拼装点依赖全部,**无循环、无向上依赖** |
| SPEC 节完整性(宪法第九/十条) | 11/11 包 SPEC 均含"性能与算法"+"多语言"节 |
| 副作用唯一出口(宪法第五条) | 直接 IO(`node:fs`/`node:child_process`/`bun:sqlite`)仅出现在 `action`/`store`;**`tui` 不直读 store**(双视角不变量成立) |
| Event 联合完整 | 13 变体齐全:`input_accepted/transcript/tool/permission/compression/lifecycle/budget_exceeded/loop_detected/retry/model_switched/interrupted/recovery/goal`,含 `redact` 脱敏 + recovery 事件 |
| 投影唯一入口 | `session.projector.project()` 装配顺序固定(system→history→tools→self→resources);**self 全字段(clock/usage/cwd/projectRoot/git/permissions/skills)齐全**;注入防护条款以最高优先级注入;压缩/预算/恢复告警均进投影 |
| 行为评测 | `bun run eval` 17/17 全过(含 M8 的 Goals/hooks/multirun/plugins 断言) |

---

## 二、发现清单

### [P1] 契约层缺口

**P1-1 `Command` 联合缺 `deny` 分支** ← contract/command.ts × surface/face.ts
- contract SPEC 功能第 27 行:`Command` 联合含 `deny`;command.ts 模块要点:`deny` 与 `ApprovalState.denied` 一一对应,"用户明确拒绝有命令表达"。
- 实际:`CommandSchema` 只有 `prompt/steer/approve/answer/abort/select/observe`,**无 `deny`**。
- 连锁后果:`surface/face.ts:49-56` 用 `abort + targetId` 重载为"拒绝权限"(`session.resolvePending(targetId, false)`),**污染了 `abort` 语义**(abort 本应是"显式中断会话"命令)。`ApprovalState.denied` 态无对应命令表达。
- 修法:contract 加 `DenyCommandSchema{kind:"deny", sender, requestId, reason}`,face 分流 approve/deny 到 resolvePending(true/false),abort 回归纯中断。

**P1-2 `Message.content` 缺 `thinking` 块** ← contract/context.ts
- contract SPEC 功能第 15 行:`thinking` 块默认进历史(模型接住自己思路),超限转摘要。
- 实际:`ContentBlockSchema = discriminatedUnion([TextBlock, ImageBlock])`,**无 `thinking` 块类型**。
- 后果:模型思路链无法进入历史 → 模型接不住自己的推理连续性;llm SPEC 承诺的"thinking 默认进历史"在契约层无承载位。
- 修法:`ContentBlockSchema` 增加 `ThinkingBlockSchema{type:"thinking", text}`(可带体积上限),projector/history 按 retention=normal 处理。

**P1-3 `Message.content` 缺 `artifact` 块** ← contract/context.ts
- contract SPEC 功能第 17 行:`artifact` 块 = 引用 + 元数据(类型/大小/hash),正文存 store 不进历史。
- 实际:只有内联 `ImageBlock{url, base64}`(内联正文),**无 artifact 引用模式**。
- 后果:大载荷(图片/二进制)要么内联烧 token,要么无法表达"引用+元数据"语义;与 SPEC 的"大载荷不烧上下文"目标相悖。
- 修法:增加 `ArtifactBlockSchema{type:"artifact", ref, mime, size, hash}`,正文存 `store.artifacts`,历史仅引用(session/artifacts.ts 已有此职责)。

### [P2] 漂移/观察项(非阻断)

**P2-1 `RecentActivity` schema 与实际呈现路径不一致** ← contract/event.ts × session/projector.ts
- `RecentActivitySchema.kind` 仅 `{retry, interrupted, model_switched}`;`recentActivityFrom()` 只映射这 3 种。
- 但 `projector.ts:118-120` 把 **recovery/compression 经 `system[]` 的 state 块**注入投影("恢复告知:..."/"历史已压缩...")。
- 结论:模型自省**未受损**(recovery/compression 经 system 块可见,不违宪),但契约定义的"最近活动块"与实际使用路径不统一,文档漂移。建议统一:要么 RecentActivity 扩到含 recovery/compression,要么 SPEC 明确"状态类告警走 system 块、瞬时类走 recent 块"。

**P2-2 `enhance` 直接 `node:fs` 读声明式资源** ← enhance/enhancer.ts:4, skills.ts:4
- SPEC 声明"用 store、不做持久化",开源依赖只列 `yaml`;实际 `enhancer.ts`/`skills.ts` 直接 `readFileSync/readdirSync` 装载 skills/AGENTS.md。
- 判断:读的是 tau 自身资源、装载期而非 LLM 运行期副作用,**不构成宪法第五条的 LLM 副作用旁路**;但 SPEC 文档不精确。建议 SPEC 明确"enhance 装载期可直读自身资源目录(fs 只读),运行期副作用仍唯一经 action"。

**P2-3 `surface/face.ts` 命令回执未事件化 + sender 未由面填充** ← surface/face.ts
- SPEC(surface 宪法5、tui 宪法3)要求:Command 的 `sender` 由面填充、`input_accepted` 回执事件化。
- 实际:face 信任上游带来的 sender(未重填);`publish()` 直接返回 `CommandResult`,未 `emit(input_accepted)`;`emit` 函数定义后 `void emit` 未接线。
- 后果:订阅者拿不到命令回执事件;命令可审计性在 face 层有缺口(上游 TUI/HTTP/ACP 必须正确填 sender,否则审计链断)。建议 face 在 publish 入口统一注入 sender + 发 input_accepted 事件。

---

## 三、跨包一致性小结

- **依赖方向 / SPEC 节 / IO 边界**:三项硬约束全部达标,无违宪。
- **契约 vs 实现漂移集中在 contract 包自身**:3 个 P1 全是 contract 的 schema 落后于 SPEC 承诺(thinking/artifact 块、deny 分支);因 contract 是"唯一真相源",其 schema 落后会向下游传导(face 被迫用 abort 模拟 deny)。
- **历史审计(2026-08)的修复真实落地**:Goal/pendingSyscalls/sender/Clock/ErrorCode/CapabilityRules/fetch/持久 shell/注入防护/死循环防护/单写者/离线回执/eval 第6·7断言 等,在 SPEC 与关键实现中均已确认存在且自洽。

## 四、修复优先级建议

1. **P1-1 deny 分支**:contract 加 DenyCommand + face 分流,消除 abort 语义污染(连带修正 P2-3 的部分动机)。
2. **P1-2 thinking 块**:补 ContentBlock,兑现"模型接住思路"的连续性承诺。
3. **P1-3 artifact 块**:补引用模式,兑现"大载荷不烧上下文"。
4. **P2 三项**:统一 recent/system 呈现路径、修正 enhance SPEC 文档、face 补 sender 注入 + input_accepted 事件。
5. 上述契约变更均触发:contract 类型更新 → 下游包同步 → 补对应 eval 断言(评测先行)。

---

_审计时间:2026-08-04。基于 M8 已提交(HEAD 2584b8e)的代码状态。_
