# Tau 架构对抗审计报告 · 第四轮(质量与安全细节)

> **修复状态(2026-08)**:P1×7 已逐项落进 SPEC(落点记录见 audit5.md):exitCode/stderr 分离 + 危险命令检测 + 原子写 + read fileMeta(action 宪法 15-17/capability.ts 参数摘要);self.session 身份(contract self);断言 11-13(eval 追加断言);批准详情渲染链(surface 宪法 5 + tui views);进程树终止(action 宪法 18);孤儿进程清理(orchestrate watchdog 声明)。

> 视角:同前三轮——我是 LLM。前三轮闭环了架构正确性/操作摩擦/生命周期;**本轮无 P0**——三轮迭代后架构进入收敛期,发现集中在"真相源、命令级安全、数据安全"三个细节面。
> 结论:**P0×0、P1×7、P2×5**。

---

## 逐包审计

### @tau/action(本轮重灾区,5 项)

- **[P1] bash 结果缺 exitCode / stderr 分离**:我判断"命令是否真成功"靠 `isError`,但 `rm 不存在的文件` 是 exit 1、`cd 不存在目录` 是 exit 1、成功但无输出的命令是 exit 0——**exitCode 是进程类工具的真相源**。且 stdout/stderr 未分离,错误流与正常输出混在一起,我无法区分"警告"与"错误"。修:`ToolResult` 带 `exitCode`,进程类工具 `stderr` 独立字段(或显式标记)。
- **[P1] 危险命令内容级检测缺失**:capability 门管"能不能调 bash",不管"bash 里跑什么"。`rm -rf /`、`git push --force`、`sudo …`、`curl | sh` 这些内容级危险命令没有防线(kimi/opencode 均有)。修:bash 参数过**危险命令模式检测**,命中 → 强制询问(与 capability 门叠加,不走"允许"静默)。
- **[P1] write 非原子写**:大文件写一半 crash → 文件损坏。修:write 走**临时文件 + rename 原子提交**。
- **[P1] read 结果无 mtime/哈希**:我 read 大文件后,文件被(我自己的 bash)改了,我毫不知情,继续基于旧内容决策。修:read 结果带 `mtime + size`(轻量)或内容哈希(可配),我据此判断"要不要重读"。
- **[P1] permission_request 缺参数摘要**:批准弹窗只给工具名/能力/理由,用户看不到"模型要跑的具体命令"——**批准前必须看到参数**。修:permission_request 事件带 `params 摘要`(bash 命令全文、write 目标路径)。

### @tau/contract
- **[P1] self 缺会话身份**:子会话/多会话场景下,我(子会话模型)不知道"我是谁、父是谁、会话标题"——fork 后自我认知缺失。修:`self.session { id, title, parentId? }`(父会话链可追溯)。
- **[P2] done syscall 契约位**:模型显式声明"任务完成"以优雅终止 goals 循环(替代靠 turn 预算兜底)。列为可选系统工具。
- **[P2] 危险命令模式声明**:模式表(rm -rf /、git push -f、sudo、curl|sh…)作为契约级清单位(与 action 检测共用)。

### @tau/session
- **[P2] prompt cache 布局显式化**:现有装配顺序(system → history → tools → self → resources)已天然 cache 友好(稳定前缀在前);把"高频变化字段(clock/usage)必须位于投影尾部"写成模块要点——防止未来有人把 clock 挪到 system 附近毁掉整条缓存。
- **[P1] 子会话身份的投影组装**(见 contract P1,projector 组装 self.session)。

### @tau/orchestrate
- **[P2] 孤儿进程清理**:后台任务 detach 后,取消 taskId 时须**终止整棵进程树**(detach 的 bash 再起的子进程),防资源泄漏。语义进 subagent/runtime。

### @tau/surface + @tau/tui
- **[P1] 批准详情渲染**:permission_request 的参数摘要必须渲染进 TUI 批准弹窗(用户批准前看到完整命令)——surface 透传、tui 展示,是安全链的最后一环。
- **[P2] 工具调用摘要视图**:模型并行 N 个工具时,TUI 面板显示"参数摘要"(非全文),用户扫一眼就知道模型在干嘛。

### @tau/eval
- **[P1] 新增断言**:
  - 11. **命令级安全**:危险模式命令强制询问(不静默执行)——配合断言 5
  - 12. **原子写**:write 中途失败不产生损坏文件
  - 13. **真相源**:进程类工具结果必带 exitCode,stderr 独立
- **[P2] FauxLlm 危险命令场景夹具**(注入 rm -rf 参数验证询问路径)。

### @tau/llm / @tau/store / @tau/enhance / @tau/app
- llm:无新发现(cache 策略位已与 session 布局配合)。
- store:无新发现(checkpoint/单写者已就位)。
- enhance:无新发现。
- app:无新发现(多会话 serve 已落)。

---

## 系统性结论

1. **收敛期信号**:第四轮 P0=0。架构骨架(四契约/依赖方向/痕迹可见/预算/分级)已稳固,后续审计频率可以降低,把重心移向实现。
2. **本轮三个主题**:
   - **真相源**:exitCode/stderr/mtime——我对世界的判断要有可靠依据,否则"成功但无效"的循环防不住;
   - **命令级安全**:capability 门管"能否调",危险命令检测管"调什么"——两层叠加才有纵深;
   - **数据安全**:原子写 + 进程树清理——副作用要可回退、可终止。
3. **批准链补全最后一环**:参数摘要进 permission_request → surface 透传 → TUI 弹窗,批准前用户看到完整命令。

## 修复建议

P1 七项全部可随 M2(工具实现期)落地:exitCode/stderr/危险命令检测/原子写/read mtime 都在 action 的 tools 层;self.session 与 cache 布局进 session;断言 11-13 进 M3。无阻塞性架构变更。
