# Tau — LLM 宿主项目 PLAN

> 项目名:`tau`(τ=2π,寓意"比 pi 完整的圈")。宪法先行,已落地在 `contract` 包与各包 SPEC。

## 0. 一句话定位

> **LLM 是思考者和执行者;agent 的一切是增强 LLM 能力的层;TUI 用户只是命令发布者。**

本项目的全部架构决策由这条宪法推出,验收标准是**双视角不变量**:用户 UI 可见的信息 ⊆ 投影(Context, Events)。

## 1. 素材地图(从哪吸纳)

| 来源 | 形态 | 价值定位 |
|---|---|---|
| `opencode-x`(本地 `/Users/edy/self/opencode-x`) | 你自己的 Effect 系重构版,含 V2 session core | **主矿**:V2 架构思想与代码直接搬迁 |
| `anomalyco/opencode`(上游,193k star) | TS/Bun monorepo,HTTP+SSE server、agent 体系、生态 | 协议形态、插件生态兼容、权限模型参照 |
| `MoonshotAI/kimi-code`(本地已装 0.31.1) | 单二进制、pi-tui、ACP、hooks、子代理、视频输入 | 产品化细节:分发、ACP、信任模型 |
| `openchamber/openchamber` | OpenCode 之上的桌面/Web 壳 | 会话外能力:Goals、Multi-run、Walkthrough |
| `pi`(本地已 clone) | 分层 monorepo、事件流、pi-tui | 组合方式与 TUI 组件(pi-tui 可作依赖) |
| `vercel-labs/scriptc` | TypeScript→原生编译器(零运行时,170KB/2ms 启动) | 借鉴:差分测试方法论、零运行时分发思路(远期评估,不引入) |

## 2. 吸收矩阵(逐项判定:吸纳 / 借鉴 / 不取)

### 2.1 从 opencode-x(主矿,代码级搬迁)

| 特性 | 去向 | 说明 |
|---|---|---|
| V2 Session Core(durable admission / execution 分离、SessionExecution wake、run-coordinator) | `session` 包 | 已是"宿主内核"雏形,搬迁并契约化 |
| context-epoch / projector / context-levels | `session` 包 | 投影管线地基 |
| system-context 代数 + registry + builtins | `session` 包(投影上游) | 契约化为 `ContextProjection` 输入 |
| `llm` 包(AI SDK、providers、route、cache-policy) | `llm` 包 | 原样搬迁,薄内核 |
| `permission/policy/tool-permissions` | `action` 包 | 演进为 capability 门 |
| `subagent/`(runner/limiter/executor) | `orchestrate` 包 | 演进为"子会话生命周期管理器" |
| `memory/`(context/store) | `enhance` 包 | 进化 T2 记忆 syscall |
| `codemode` 解释器 | `enhance` 包 | 第一个"策略"(policy),可插拔 |
| `protocol/schema/server`(Hono) | `surface` 包 | 命令面 HTTP/SSE 基础 |
| `plugin` SDK | `enhance` 包 | 保留 opencode 插件 API 兼容(生态) |
| `store`(effect-drizzle-sqlite) | `store` 包 | 原样 |
| MCP 客户端(patch 版 sdk) | `action` 包 | 原样 |

### 2.2 从 kimi-code(借鉴产品化模式,不搬代码)

| 特性 | 去向 | 说明 |
|---|---|---|
| **单二进制 + 毫秒级启动** | `app` 包(Bun `--compile`) | 高价值,直接采用 |
| **ACP 支持**(`kimi acp`) | `surface` 包 | **高价值差异点**:editors 可直接驱动会话,无需 TUI |
| **AI-native MCP 配置**(`/mcp-config` 对话式) | `action` 包 + tui | 借鉴:让 LLM 自己配置自己的工具 |
| **插件信任分级**(安装时前置展示 trust level) | `enhance` 包 | 借鉴:信任模型先于安装 |
| **生命周期 hooks**(门禁危险工具/审计) | `action` 包 | 与我们的 capability 门同构,补充 hook 位 |
| 子代理内置三件套(coder/explore/plan) | `enhance` 包(policies) | 借鉴为默认 policy 集 |
| TUI 基于 pi-tui | `tui` 包(决策点 ↓) | 直接依赖 `@earendil-works/pi-tui`(MIT) |
| Git Bash shell 环境处理 | `action`/bash 工具 | Windows 细节,低优先 |

### 2.3 从 openchamber(借鉴会话外能力)

| 特性 | 去向 | 说明 |
|---|---|---|
| **Session Goals**(每 turn 后校验目标,未完成继续) | `orchestrate` 包 | **高价值**:goal 成为一等概念,注入 Context + turn 后判定,天然契合"LLM 是执行者" |
| **Multi-run**(一任务 N 模型并行 + worktree)+ Fusion | `orchestrate` + `action` | 借鉴:surface 命令 → 编排层 spawn N 子会话;Fusion = 汇总子会话 diff 生成新会话 |
| **Changes Walkthrough**(diff → 分步讲解) | `enhance` 包(skill) | 低成本,一个 skill 即可 |
| **Preview**(运行中应用截图/样式/报错回传) | `action` 包(browser syscall) | 中价值,后置 |
| **定时任务 + Goals**(cron 驱动目标完成) | `orchestrate` 包 | 中价值,queue + store 即可 |
| **Private Relay / 多端同步** | 不取(基础设施) | 验证了 surface 必须网络可达,仅采纳结论 |
| 桌面 App / PWA / VS Code / 移动端 | 不取(后期) | 后续 surface 的免费赠品 |

### 2.4 明确不吸收(防坑)

- **不学 pi 自研 pi-ai**(用 AI SDK);不学 pi 的 lockstep 版本、declaration merging 跨包类型、巨型 interactive-mode
- **不搬 kimi 的 Moonshot 服务绑定**(只要模式,不绑供应商)
- **不吸收 opencode 的遥测/账户/SST 基础设施**;隐私第一
- **不吸收 kimi 视频输入**(录屏→帧序列):当前主流模型视觉支持率低,性价比差,明确不做
- **不把 scriptc 当运行时/沙箱**:它是 TS→原生编译器(不是执行沙箱),依赖重、需 clang、平台受限;核心栈(Effect/AI SDK/drizzle)静态覆盖率低,现阶段不引入
- **不引入 opencode-proxy**(针对 opencode 免费模型的 IP 自切换私有网关):绑定私有渠道,核心栈不依赖;llm 走标准 OpenAI 兼容 baseURL,自有网关按需自配
- **不吸收 openchamber 的桌面壳与隧道基础设施**(第一版不做)
- **不吸收 opencode 上游的巨型 `packages/opencode` 单体**

## 3. 目标架构(与前文设计一致)

```
packages/(依赖单向向下)
├── contract/    四契约:Context(投影)/SystemCall/Event/Command + 元数据 schema(Model/Goal/Config 等)
├── llm/         宿主内核(薄):AI SDK、providers、route、cache,标准 baseURL 端点
├── session/     记忆:durable session、投影管线(唯一)、epoch、retrieve 分页
├── action/      手脚:syscall 注册表、执行运行时、capability 门、审计、MCP、pty
├── orchestrate/ 时钟:turn 调度、steer/followup、goals、子会话、cron
├── enhance/     外设:skills/AGENTS.md/memory/policies(codemode)/plugins/摘要策略,全声明式(依赖 llm/session/action)
├── surface/     命令面:Command API、HTTP/SSE、RPC、ACP
├── store/       sqlite/memory 双实现
├── tui/         命令发布器
├── app/         单二进制入口(Bun compile)+ CLI 命令
└── eval/        行为评测
```

技术栈(沿用你已验证的):**Bun + Effect + AI SDK + drizzle/sqlite**,TUI 已定 pi-tui(见 D2)。

### 3.1 横切原则:性能与多语言

**性能/算法**(每个包 SPEC 必须含"性能与算法"节):
- 热路径优先:每 turn 必经的 `project()`/`stream()`/`execute()` 是热点,缓存与增量是默认答案
- 大数据不进内存:历史/输出/资源走流式与分页;预算检查 O(1)
- 算法选择显式声明(如 edit 用 Myers 差分、retrieve 用 FTS5 索引),不靠暴力

**多语言**(TS 只是第一种实现宿主):
- `contract` 语言中立:JSON Schema + 封闭联合 wire 格式,任何语言可直用
- `surface` 协议是跨语言桥:HTTP/SSE/ACP/JSONL 全语言中立,协议文档 = 正式规范
- 每个包把"行为规范"(状态机/投影顺序/调度语义)文档化,供其他语言重实现
- 包内设计不得依赖 TS 专属运行时特性(tui/app 除外)

### 3.2 运行时与构建策略

**运行时决策**:主运行时 **Bun**(opencode-x 已验证;Effect/drizzle/AI SDK 原生支持)。
- Deno 不换,但**权限模型**(`deno run --allow-*`)是 capability 门的设计参照
- Node 不跑,仅保证产物可被 Node 生态消费(纯 ESM、无运行时专属 API;tui/app 除外)
- **配合包模式**:Bun 内置能力优先——`bun:sqlite`(drizzle 驱动,省原生编译)、`Bun.serve`、`Bun.build`/`--compile`、`bunx`;外部依赖只在各包 SPEC"开源依赖"节声明

**构建与性能**:
- 分发:Bun `--compile` 单二进制(毫秒启动)+ 子命令懒加载(交互面不 import TUI)
- 静态检查:oxlint(比 eslint 快数量级)+ `tsc --noEmit`(仅类型,零产物)
- 构建缓存:依赖不变不重建;产物 `--minify` + tree-shaking
- CI:每提交 oxlint + typecheck + eval 全绿才可合并

**远期选项(不承诺)**:scriptc 零运行时原生二进制(170KB/~2ms 启动)适合 `tau eval`/`tau doctor` 这类轻 CLI;核心 agent 栈依赖太重不引入。其**差分测试方法论**(同代码双宿主跑、输出字节级对比)已借鉴进 eval 包。

## 4. 里程碑

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M0 骨架** | monorepo、contract 包、AGENTS.md、CI(oxlint+typecheck+单测) | `bun install` 零错误 |
| **M1 契约** | 四契约 + Goal/pendingSyscalls/Clock/usage/ErrorCode/sender + FauxLlm + 双视角/重放一致性检查器 | contract 单测全绿 |
| **M2 最小回路** | llm(迁)+ session(迁投影,内存;self 含 cwd/clock/权限/注入防护条款)+ action(read/bash/write 3 工具)+ orchestrate(极简 turn + 死循环防护)+ surface(print 模式) | `echo "读 package.json" \| tau -p` 跑通 |
| **M3 评测先行** | eval:10 个行为断言(契约级,含重放一致性/性能回归)+ FauxLlm | eval 全绿 |
| **M4 持久化** | store/sqlite、durable session、崩溃恢复 | 断点续跑测试通过 |
| **M5 TUI** | 命令发布器:发布/观察/打断/批准 四交互 | 手工冒烟 |
| **M6 增强层** | skills/AGENTS.md/memory/policies 声明式装载 → 进 Context | `/skill:name` 可用 |
| **M7 网络面** | surface HTTP/SSE + **ACP**(editor 驱动)+ 远程会话 | Zed 能连 |
| **M8 高级特性** | Goals、Multi-run+worktree、生命周期 hooks、插件市场 | 每项有 eval |

**进度(已完成)**
- M0 骨架 ✅(monorepo/CI/AGENTS.md)
- M1 契约 ✅(contract 包全量实现:四契约 + Goal/pendingSyscalls/Clock/usage/ErrorCode/sender + 双视角/预算/重放/配对检查器 + JSON Schema 导出 + 跨语言语义文档;单测 20 例全绿,FauxLlm 归入 M3 eval)
- M2 最小回路 ✅(llm/store 搬迁 + session 投影 + action 3 工具 + orchestrate turn/死循环防护 + surface print + app CLI;单测 81 例全绿;出口验收 `echo "读 package.json" | tau -p` 真实模型跑通,模型调 read 工具并回传结果作答)
- M2 经验锁定:ai@6 工具 schema 必须走 `inputSchema: jsonSchema(...)`(核心读 inputSchema 而非 parameters);stream part 工具参数字段是 `input` 而非 `args`
- M3 评测先行 ✅(eval 包:FauxLlm 脚本化 LLM + 13 个行为断言(双视角/投影纯函数/先落盘后响应/命令纪律/副作用纪律/重放一致性/性能回归/消息配对/预算纪律/恢复告知/命令级安全/原子写/真相源)+ 套件运行器 + runs.jsonl 报告 + `tau eval` CLI;fixture harness 修正:session/action/scheduler 各源独立收集事件防递归;单测 2 例全绿,`tau eval` 13/13 passed)
- M3 经验锁定:fixture 事件收集三源(session/action/scheduler)必须独立 push 到 events[],不能互相转发(否则 session.onEvent -> schedulerBridge -> scheduler.notify -> scheduler.onEvent -> schedulerBridge 无限递归);bash 工具依赖 Bun.spawn,vitest(node 环境)不可用,eval 套件以 `bun test` 为准
- M4 持久化 ✅(store/sqlite.ts:WAL + 索引 + JSON blob + 预处理语句;migrate.ts:版本化幂等迁移;createStore("sqlite", path) 可用;compose/cli 支持 --store <path>;断点续跑测试 4 场景全绿:崩溃恢复消息+epoch+recovery 告警/正常 close 不告警/多会话隔离/usage 跨重启;audit 归档(audit_archive 表,不删历史);单测 126 例全绿,eval 13/13 passed)
- M4 经验锁定:bun:sqlite AUTOINCREMENT 列不能手动赋值(传 NULL 让 SQLite 自增);SQLite named parameter(@name)在 Bun 中绑定不稳定,改用位置参数 + excluded;vitest(node)无法 import bun:sqlite,SQLite 测试以 `bun test` 为准;store.ts 接口加 `close?` 可选方法(memory 无操作)
- M5 TUI ✅(face.ts 全 Command 分发:prompt/steer/abort/approve/answer/select/observe;action/runtime.ts 加 onPermission 回调 + setPermissionHandler(运行期注入);cli.ts 三模式路由:tau(交互)/tau -p(print)/tau eval;TUI askPermission 弹窗 -> Promise<boolean> -> action 继续/拒绝;Ctrl+C 打断;权限弹窗批准/拒绝;21 原有 TUI 单测全绿,126 总测试全绿,eval 13/13 passed)
- M5 经验锁定:onPermission 回调优于事件驱动权限流(避免 suspend/resume 复杂性);action 发 permission 事件只发 granted/denied 不发 requested(弹窗由回调直接驱动,事件仅供观察);exactOptionalPropertyTypes 下条件赋值需用中间变量带完整类型;CLI 路由:sub===undefined||sub.startsWith("--") -> TUI 模式
- M6 增强层 ✅(enhance 包:frontmatter.ts(YAML 解析)+ skills.ts(目录扫描+两级装载)+ memory.ts(remember/recall/forget via store.kv)+ summarize.ts(规则摘要)+ enhancer.ts(聚合);compose.ts 接入 enhancer -> extraSystemBlocks(AGENTS.md constitution 块 + skill catalog context 块)+ self.skills.names;skill:load syscall(T0 allow,按名取全文);TUI /skill:name -> prompt 展开为"请用 skill:load 加载技能";单测 145 例全绿,eval 13/13 passed)
- M6 经验锁定:/skill:name 不需新 Command 变体(TUI 层展开为 prompt,LLM 经 skill:load syscall 取全文);enhancer.apply() 产出 SystemBlock[] + skillNames,compose 注入 session extraSystemBlocks + skills;AGENTS.md 作 constitution 块注入(skill catalog 作 context 块);memory 用 store.kv 前缀隔离(sessionId:key)
- M7 网络面 ✅(surface 包:http.ts(Hono HTTP/SSE 服务器 + Last-Event-ID 重放 + 心跳保活)+ acp.ts(JSON-RPC over stdio,editor 驱动)+ serveHttp/runAcpServer 入口;app CLI 加 tau serve [--port N] + tau acp 命令;hono 依赖加入 surface;单测 152 例全绿,eval 13/13 passed)
- M7 经验锁定:Hono streamSSE 保持连接开放,单元测试需 AbortController 超时验证端点存在性而非读完整流;ACP 协议用 JSON-RPC 2.0 标准(id/method/params),editor 经 stdin 发请求 stdout 收响应 + 事件通知;serveHttp 用 Bun.serve 启动,支持 SIGINT/SIGTERM 优雅停止
- M8 高级特性 ✅(orchestrate/goals.ts:GoalJudge 启发式判定 + 每 turn 后校验 + goal 事件;action/hooks.ts:生命周期 hooks(before/after/error 三阶段)+ createHookRegistry + 内置 auditHook/dangerousToolGate/rateLimitHook;orchestrate/multirun.ts:多模型并行 runMultiRun + selectBestRun + fuseRunResults;enhance/plugins.ts:插件市场 createPluginRegistry + createTrustedPluginRegistry + TrustLevel 信任分级;contract/event.ts 加 GoalEvent 变体;eval 加 4 个新断言(#14 Goals 判定/#15 生命周期 hooks/#16 Multi-run/#17 插件市场);单测 152 例全绿,eval 17/17 passed)
- M8 后消费方 LLM 视角重审计(audit7.md)✅:骨架稳健(依赖方向/IO 边界/SPEC 章节全过;Event 联合 13 变体完整;投影唯一入口自字段齐全 + 注入守卫);发现并逐项修复 3 P1 + 3 P2(Command.deny 分支/Message.thinking+artifact 块/RecentActivity 统一回收压缩/ enhance 装载期只读声明/face 补 input_accepted 回执与 sender 契约意图),eval 现 18/18 passed
- M8 经验锁定:Goal 判定必须在工具调用循环外部(否则纯文本回复跳过判定);hooks 测试需创建真实文件(否则 read 失败触发 error hook 而非 after);Multi-run 共享 session/action 但各模型独立 scheduler;插件信任分级(official/verified/community/untrusted)为后续市场做准备

## 5. 需要你拍板的决策点

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 项目名 / npm scope | **已定** | `tau` / `@tau/*` |
| D2 | TUI 底座 | ① pi-tui(依赖,零维护,kimi 同款) ② opentui(自 opencode 系,你 fork 里已用) | **① pi-tui**:已是最强 agent TUI,直接当依赖;省出时间做契约层 |
| D3 | 代码复用程度 | ① 全量搬迁 opencode-x 代码再契约化 ② 只搬架构思想,契约重写 | **混合**:V2 core/llm/store/plugin 直接搬;session 投影与 action 按契约重写 |
| D4 | 插件生态兼容 | 是否兼容 opencode plugin API | **兼容**(生态是 opencode 最大的资产,零成本保留) |
| D5 | 分发形态 | ① 单二进制(Bun compile,类 kimi) ② npm 包 ③ 双发 | ③ 双发,二进制优先 |
| D6 | 首个真实验收场景 | ① 自举:tau 开发 tau ② 重构一个本地项目 | ① 自举,最诚实 |

## 6. 风险清单

| 风险 | 缓解 |
|---|---|
| opencode-x V2 core 与契约层冲突(搬迁成本) | M2 先跑通最小回路再全面搬迁,分步验收 |
| pi-tui 主动维护性(作者精力在 pi) | fork 或提 PR;组件薄封装在 tui 包内,可换 |
| 契约过早冻结导致实现绑手 | M1 契约 + M2 实现同步演化,不假想需求 |
| 范围膨胀(Goals/ACP 都想做) | 严格按里程碑,M8 之前不碰高级特性 |
| 生态依赖(plugin/MCP 兼容面) | M6/M8 再接入,前期不依赖 |

## 7. 宪法验收清单(每阶段对照)

- [ ] 用户 UI 显示的任何信息都能从 Context 或 Events 推出(双视角不变量)
- [ ] LLM 能感知自己的一切能力与资源(内省 syscall)
- [ ] 所有副作用只经 action/syscall 路径
- [ ] 依赖方向单向,无循环 import
- [ ] 每个包可脱离整个项目单独测试
