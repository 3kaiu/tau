# Tau(τ)

LLM 宿主。**LLM 是思考者和执行者;agent 的一切是增强 LLM 能力的层;TUI 用户只是命令发布者。**

τ = 2π:比 pi 完整一圈。见 `PLAN.md` 的完整立项依据与吸收矩阵。

## 宪法

[`docs/constitution.md`](docs/constitution.md) — 一切决策的推导原点(角色 / 四契约 / 双视角不变量 / 依赖法 / 性能法 / 多语言法 …)。

## 包

| 包 | 角色 | 一句话 |
|---|---|---|
| `contract` | 宪法之首 | 四契约 schema + 双视角不变量检查器,语言中立 |
| `llm` | 宿主内核(薄) | 把 ContextProjection 变成 LLM 流,可换、无业务语义 |
| `session` | 记忆(MMU) | `project()` 是唯一把状态变成 LLM 输入的地方 |
| `action` | 手脚 | 唯一副作用出口:syscall 执行 + capability 门 + 全量审计 |
| `orchestrate` | 时钟 | turn 调度、steer/follow-up、goals、子会话 |
| `enhance` | 外设 | skills / AGENTS.md / memory / policies / plugins,全声明式 |
| `surface` | 命令面 | 跨语言桥:HTTP/SSE / ACP / JSON-RPC |
| `store` | 存储 | sqlite/memory 双实现,单一数据源 |
| `tui` | 命令发布器 | 发布 / 观察 / 打断 / 批准(pi-tui 底座) |
| `app` | 组装点 | 唯一拼装点 + CLI 入口,单二进制,毫秒级启动 |
| `eval` | 行为评测 | 契约级断言 + FauxLlm,离线确定性,评测先行 |

每个包的职责边界见 `packages/*/SPEC.md`。

## 快速开始

```sh
bun install
bun run check      # oxlint + typecheck
bun test           # vitest
tau -p "读 package.json"
```

## 文档索引

- `PLAN.md` — 立项依据、吸收矩阵、里程碑 M0–M8、决策点、风险
- `docs/constitution.md` — 宪法十一条 + 验收清单
- `packages/*/SPEC.md` — 每包:使命 / 功能 / 宪法 / 内部模块 / 性能与算法 / 多语言 / 边界

## License

MIT
