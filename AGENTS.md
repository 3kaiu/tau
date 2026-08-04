# Tau 开发约定(AGENTS.md)

本文件是 tau 项目的宪法落地。开发/重构/加功能前必读。

## 命令

- `bun install` — 安装依赖(monorepo,workspaces)
- `bun run check` — oxlint + tsc 全量类型检查
- `bun test` — vitest(根级,聚合各包)
- `bun run eval` — 行为评测(eval 包,离线 FauxLlm)

## 结构

- `packages/` 依赖单向向下:contract ← llm/store ← session/action ← orchestrate ← surface ← tui;enhance → llm/session/action(LLM 摘要 policy 经 llm);app 是唯一拼装点
- 契约 schema(schema/类型/枚举)只在 `contract` 包;其他包 import `@tau/contract`,禁止自造重复类型
- 每个包的职责边界与宪法在 `packages/*/SPEC.md`;改包前先读自己包和相邻包的 SPEC

## 规范(每条都是硬性)

1. **模型输入唯一路径**:任何给 LLM 的内容必须经 `session.project()`;禁止旁路拼接 Context
2. **副作用唯一出口**:文件/进程/网络操作必须经 `action.execute()` 的 SystemCall;绕过 = 违宪
3. **交互封闭**:用户所有交互 = `Command` 封闭联合;新增分支必须改类型 + 检查器(编译期穷尽)
4. **依赖方向**:任何包不得 import 上游包;违反即 CI 失败
5. **评测先行**:新行为必须带 eval 断言(契约级,离线可跑);M 里程碑的出口标准 = eval 通过
6. **性能/多语言**:新模块落地时对照自己包 SPEC 的"性能与算法"与"多语言"节,写不进的先改 SPEC
7. **注释纪律**:不写解释"怎么做"的注释;代码注释只允许解释"为什么"与契约意图
8. **不引入新依赖**:除非 SPEC"开源依赖"节已声明;新依赖需先更新 SPEC
9. **SPEC 交叉自查**:改动一个包的 SPEC 后,必须核对相邻包(依赖方向上下游)的同名概念——防"功能面与模块要点自相矛盾"这类跨文件漂移

## 文档

- `PLAN.md` — 里程碑 M0–M8,当前进度以"已完成"为准
- `docs/constitution.md` — 宪法十一条,违反即设计缺陷
- `packages/*/SPEC.md` — 包级宪法
