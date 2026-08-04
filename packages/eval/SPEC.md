# @tau/eval — 行为评测

## 使命
证明"宪法没被违反"。契约级行为断言 + FauxLlm 注入,全部离线、零网络、零真实模型依赖。

## 功能(公开 API 面)
- `eval.run(suite)` → `EvalResult`(逐断言:通过/失败/原因)
- `FauxLlm` — 脚本化 LLM(注入预设回复序列,验证编排行为);依 contract 的 LlmEvent 协议实现,与 llm 包契约对齐;支持**虚拟时钟**、**脚本化错误注入**(429/超时 → 验证 retry 事件)、**挂起/回答模拟**(ask_user 恢复)、cron 唤醒、**turn 中途终止模拟**(crash → 验证 recovery)
- 行为断言(第一版 10 个):
  1. **双视角不变量**:任意事件流下,UI 可见信息 ⊆ 投影(Context, Events)
  2. **投影纯函数**:同 (快照, epoch) 必得同投影(缓存合法性)
  3. **先落盘后响应**:admit 失败时会话状态回滚
  4. **命令纪律**:所有交互 = Command(带 sender),无旁路
  5. **副作用纪律**:一切副作用经 action,审计齐全
  6. **重放一致性**:重放事件流 → 重建投影 → 与快照逐字节一致(全架构最强机器断言)
  7. **性能回归**:`project()` 耗时上限、预算检查 O(1)(宪法性能法的守门人)
  8. **消息配对**:tool_call/result 按 callId 配对、顺序稳定;interrupted 标记齐全(模型连续性断言)
  9. **预算纪律**:turn 超预算即中断 + 投影告警,无失控循环(成功/失败均算)
  10. **恢复告知**:模拟 crash(进程级终止),断言恢复后投影含 recovery 告警
- 追加断言(audit4 补,实现期落地):
  11. **命令级安全**:危险模式命令强制询问(不静默执行)——配合断言 5
  12. **原子写**(行为断言,豁免宪法 3——测 action 文件系统行为而非契约不变量):write 中途失败不产生损坏文件
  13. **真相源**:进程类工具结果必带 exitCode,stderr 独立
- 追加断言(M8 高级特性 + audit7,audit8 补记):
  14. **Goals 判定**:goal 设定后每 turn 校验,完成发 `goal(completed)` 事件;未完成但预算耗尽 → `budget_exceeded` 而非继续(goal 循环不豁免预算)
  15. **生命周期 hooks**:before/after/error 三阶段按序触发,error hook 收到失败信息
  16. **Multi-run**:一任务 N 模型并行,可 selectBest/fuse,fusion 产出可继续会话(工作区 = 主工作区)
  17. **插件市场**:注册/信任分级/降权运行(TrustLevel 生效)
  18. **命令纪律补强**:deny 分支闭环 + `input_accepted` 回执(命令先回执后执行)
- **M9 出口断言**(#19-#22,见 docs/M9.md):#19 事件导出 JSONL → 重放与快照一致 / #20 doctor 自检覆盖关键不变量 / #21 归档后重放恢复 + recovery 告知 / #22 定时目标到点触发 goal 判定。**已全部落地,eval 22/22 passed(M9 支柱 B/C 出口标准满足)。**
- `eval.inspect(session)` — 重放会话导出分析
- 输出:`runs.jsonl`(标准化,跨版本可对比)

## 宪法
1. **评测先行**:每个里程碑的出口标准 = 对应评测通过,不靠感觉
2. **离线确定性**:FauxLlm 无网络;同输入同输出,可复现可调试
3. **断言测契约不测实现**:断言挂在 contract 不变量上,实现改了断言不变
4. **回归门禁**:CI 必跑 eval,失败即红

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/eval.ts` | 套件运行器(并行 + 汇总) |
| `src/faux.ts` | FauxLlm 脚本化 LLM |
| `src/asserts/` | 行为断言集(每文件一断言) |
| `src/report.ts` | 结果报告(runs.jsonl + 摘要) |
| `src/fixtures/` | 会话夹具(合成事件流) |

## 模块宪法要点
- `faux.ts`:回复序列用声明式脚本(JSON),不带随机性;虚拟时钟与错误注入脚本化,同夹具可复现
- `asserts/`:断言只 import contract,不 import 实现包(防自证)
- `report.ts`:runs.jsonl 追加写,不覆盖历史

## 开源依赖
`vitest`(测试运行器,根级)。

## 性能与算法
- 并行 harness:断言间无共享状态,多 worker 并行
- FauxLlm 零网络零 IO,套件毫秒级完成,可进 CI 每个提交
- 夹具复用:合成事件流共享,不重复构造

## 多语言
- `runs.jsonl` 输出格式标准化 = 任何语言可解析对比
- 会话导出(session dump)格式 = contract wire 格式,跨语言可重放
- 行为断言语义文档化,其他语言实现可移植同套断言

## 边界(明确不做)
不做全量基准压测(性能专项另立;轻量性能回归断言第 7 条属于 eval)。不做真实模型 E2E(那是验收演示)。
