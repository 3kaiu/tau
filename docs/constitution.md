# Tau 宪法

> 本项目一切决策的推导原点。宪法违反 = 设计缺陷,不讨论豁免。

## 第一条 角色

LLM 是思考者和执行者;**agent 的一切是增强 LLM 能力的层**;TUI 用户只是命令发布者。

## 第二条 四契约

`Context`(ContextProjection)/ `SystemCall` / `Event` / `Command` 四个封闭联合,只在 `contract` 包定义,全项目唯一版本。

## 第三条 双视角不变量

**用户 UI 可见的信息 ⊆ 投影(Context, Events)**。违反即 bug。
推论:LLM 对自己处境(能力/预算/资源)的了解 ≥ UI 对它的了解。

## 第四条 依赖法

依赖单向向下(精确边):`llm→contract`;`store→contract`;`session/action→contract+store`;`orchestrate→contract+llm+session+action+store`;`surface→contract+orchestrate+session`;`tui→contract+surface`;`enhance→contract+store+session+action`(LLM 摘要 policy 经构造期注入回调接入,不依赖 llm)。禁止循环 import;`app` 是唯一拼装点,包间不得互相 new 依赖。

## 第五条 副作用法

一切副作用(文件/进程/网络)唯一出口 = `action` 包的 SystemCall 执行。capability 门不可绕过(第三方工具无豁免);全量审计,一切 Command 携带发起者身份(sender);**隐藏命令 = 违宪**(凡模型不可感知的自动操作一律禁止)。

## 第六条 调度法

编排层不生成内容(委托 `session.project()`)、不执行工具(委托 `action.execute()`);turn 是原子单位;恢复靠重放不靠内存热态。

## 第七条 记忆法

投影唯一(无旁路拼接);投影是纯函数(同快照同投影);快照权威(无内存/磁盘漂移);先落盘后响应;**压缩是交换不是丢弃**(全文永远可 retrieve)。

## 第八条 宿主薄

`llm` 无业务语义(不懂工具循环/压缩/会话);一次 turn 一次 stream;不隐藏重试(重试是编排的职责)。

## 第九条 性能法

每 turn 必经函数(`project`/`stream`/`execute`)是热路径:必须可缓存、可增量、预算检查 O(1);大数据不进内存(流式/分页);算法选择显式声明(Myers 差分、FTS5 索引…),不靠暴力。**每个包 SPEC 必含"性能与算法"节。**

## 第十条 多语言法

TS 是第一种实现宿主,不是唯一。契约 wire 格式语言中立(JSON Schema);`surface` 协议是跨语言桥(HTTP/SSE/ACP/JSONL,协议文档即正式规范);行为规范(状态机/投影顺序/调度语义)文档化供其他语言重实现;包内设计不得依赖 TS 专属运行时(tui/app 除外)。**每个包 SPEC 必含"多语言"节。**

## 第十一条 发布法

包独立发布、契约先行(下游包 semver 跟随);破坏性变更 minor 起跳;`store/tui/app/eval` 为内部包,`contract/llm/session/action/orchestrate/enhance/surface` 为 SDK 包。

## 宪法验收清单(每阶段对照)

- [ ] 双视角不变量:UI 显示的任何信息都能从 Context 或 Events 推出
- [ ] 模型自省完整:投影 self 含 clock/usage/cwd/权限摘要/skill 目录;system 含注入防护条款
- [ ] LLM 可内省:自我/能力/资源/审计(含 syscall 史)都在投影可达范围内
- [ ] 副作用只经 syscall 路径
- [ ] 依赖方向单向,无循环 import
- [ ] 每个包可脱离整个项目单独测试
- [ ] 每个包 SPEC 含"性能与算法"与"多语言"节,且无 TS 专属运行时依赖(除 tui/app)
