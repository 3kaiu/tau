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
| MCP 客户端(patch 版 sdk) | `app` 拼装点(经 action registry/execute 通道,第三方工具无豁免) | 用 `@ai-sdk/mcp`(v2),工具注册为 syscall 过能力门/审计 |

### 2.2 从 kimi-code(借鉴产品化模式,不搬代码)

| 特性 | 去向 | 说明 |
|---|---|---|
| **单二进制 + 毫秒级启动** | `app` 包(Bun `--compile`) | 高价值,直接采用 |
| **ACP 支持**(`kimi acp`) | `surface` 包 | **高价值差异点**:editors 可直接驱动会话,无需 TUI |
| **AI-native MCP 配置**(`/mcp-config` 对话式) | `app` + tui(远期) | 借鉴:让 LLM 自己配置自己的工具 |
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
├── action/      手脚:syscall 注册表、执行运行时、capability 门、审计、工作区边界(第三方向工具经此注册/审批/审计,MCP 客户端实现在 app 拼装点)
├── orchestrate/ 时钟:turn 调度、steer/followup、goals、子会话、cron
├── enhance/     外设:skills/AGENTS.md/memory/policies(codemode)/plugins/摘要策略,全声明式(依赖 session/action;LLM 摘要 policy 经 app 构造期注入回调,不 import llm)
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
| **M9 产品化与可观测性** ✅ | 单二进制分发(`bun run build`/`build:all` + `tau --version`/`doctor`/`config`)、可观测性(`tau log`/`replay`/`export`,本地优先)、会话治理(`tau sessions` + `tau schedule` 定时目标) | eval 22/22 + 5 平台二进制产出 |

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
- M5 经验锁定:onPermission 回调优于事件驱动权限流(避免 suspend/resume 复杂性);action 发 permission 事件只发 granted/denied 不发 requested(弹窗由回调直接驱动,事件仅供观察);exactOptionalPropertyTypes 下条件赋值需用中间变量带完整类型;CLI 路由:sub===undefined||sub.startsWith("--") -> TUI 模式。**(audit8 修订:本条"不发 requested"作废——远程 approve 需 requested 事件闭环,已改为"回调 + requested 事件双轨",契约/action/surface SPEC 已同步)**
- M6 增强层 ✅(enhance 包:frontmatter.ts(YAML 解析)+ skills.ts(目录扫描+两级装载)+ memory.ts(remember/recall/forget via store.kv)+ summarize.ts(规则摘要)+ enhancer.ts(聚合);compose.ts 接入 enhancer -> extraSystemBlocks(AGENTS.md constitution 块 + skill catalog context 块)+ self.skills.names;skill:load syscall(T0 allow,按名取全文);TUI /skill:name -> prompt 展开为"请用 skill:load 加载技能";单测 145 例全绿,eval 13/13 passed)
- M6 经验锁定:/skill:name 不需新 Command 变体(TUI 层展开为 prompt,LLM 经 skill:load syscall 取全文);enhancer.apply() 产出 SystemBlock[] + skillNames,compose 注入 session extraSystemBlocks + skills;AGENTS.md 作 constitution 块注入(skill catalog 作 context 块);memory 用 store.kv 前缀隔离(sessionId:key)
- M7 网络面 ✅(surface 包:http.ts(Hono HTTP/SSE 服务器 + Last-Event-ID 重放 + 心跳保活)+ acp.ts(JSON-RPC over stdio,editor 驱动)+ serveHttp/runAcpServer 入口;app CLI 加 tau serve [--port N] + tau acp 命令;hono 依赖加入 surface;单测 152 例全绿,eval 13/13 passed)
- M7 经验锁定:Hono streamSSE 保持连接开放,单元测试需 AbortController 超时验证端点存在性而非读完整流;ACP 协议用 JSON-RPC 2.0 标准(id/method/params),editor 经 stdin 发请求 stdout 收响应 + 事件通知;serveHttp 用 Bun.serve 启动,支持 SIGINT/SIGTERM 优雅停止
- M8 高级特性 ✅(orchestrate/goals.ts:GoalJudge 启发式判定 + 每 turn 后校验 + goal 事件;action/hooks.ts:生命周期 hooks(before/after/error 三阶段)+ createHookRegistry + 内置 auditHook/dangerousToolGate/rateLimitHook;orchestrate/multirun.ts:多模型并行 runMultiRun + selectBestRun + fuseRunResults;enhance/plugins.ts:插件市场 createPluginRegistry + createTrustedPluginRegistry + TrustLevel 信任分级;contract/event.ts 加 GoalEvent 变体;eval 加 4 个新断言(#14 Goals 判定/#15 生命周期 hooks/#16 Multi-run/#17 插件市场);单测 152 例全绿,eval 17/17 passed)
- M8 后消费方 LLM 视角重审计(audit7.md)✅:骨架稳健(依赖方向/IO 边界/SPEC 章节全过;Event 联合 13 变体完整;投影唯一入口自字段齐全 + 注入守卫);发现并逐项修复 3 P1 + 3 P2(Command.deny 分支/Message.thinking+artifact 块/RecentActivity 统一回收压缩/ enhance 装载期只读声明/face 补 input_accepted 回执与 sender 契约意图),eval 现 18/18 passed
- M9 方向提案(docs/M9.md)+ 实施中:`tau doctor` 4 项自检(模型目录/凭据/契约 wire 往返/store 可达+replay/capability 门生效)、`tau log`(事件流 JSONL)、`tau replay`(重放→投影转述)、`tau export`(JSONL/Markdown 本地落盘,含 thinking/artifact 渲染,不外发)——**支柱 B 可观测性 ✅(实现 + 出口断言 #19/#20 落地,eval 22/22 passed)**;**支柱 C 会话治理 ✅(store 加 sessions.list/kv.list + 迁移 v2 + session resume/archive 注册表同步;`tau sessions list/show/resume/archive/delete`;定时目标 orchestrate/cron.ts + `tau schedule list`;出口断言 #21/#22 落地)**;**支柱 A 分发 ✅(`tau --version`;`tau config list/get/set/unset` 落 store.kv、key 命中 secret 模式即拒明文落盘;doctor 5 项自检;`bun run build` → `dist/tau`,`bun run build:all` 交叉编译 darwin/linux x64+arm64 与 windows-x64 共 5 个产物,`tau --version` 实测 38ms 启动,二进制内 `tau eval` 22/22)**;M9 三支柱全部验收。候选 M11 认知与长程记忆 / M12 多代理编排深化(插件市场生态 M10 候选经决策撤销,见下)
- M9 经验锁定:**`@tau/tui` 曾漏在 app 依赖之外**——动态 `import()` 在 dev 态被 bun 的根目录解析兜住,直到 `bun build --compile` 才暴露;交互模式(最主要入口)其实一直起不来,懒加载的模块也必须是声明依赖。观测命令(log/replay/export)严禁 `compose()`,否则"看一眼"就往被观测会话写 recovery 事件;`store.sessions` 注册表若只有测试在写就是死表,写路径必须铺满 session 生命周期;`recover()` 的生命周期还原必须"最后一条 lifecycle 为准",短路顺序判定会让 `archive → resume → 重启` 退回 archived;`sch-${Date.now()}` 这类 id 同毫秒连发会撞,撞了要补序号而非静默覆盖;cron 自实现(五段最小子集 ~120 行)优于引 `croner`——tau 只要分钟粒度本地时区
- M8 经验锁定:Goal 判定必须在工具调用循环外部(否则纯文本回复跳过判定);hooks 测试需创建真实文件(否则 read 失败触发 error hook 而非 after);Multi-run 共享 session/action 但各模型独立 scheduler;插件信任分级(official/verified/community/untrusted)为后续市场做准备
- M10.0 audit8 逐包补齐 ✅:契约六 schema + 事件 id;store 双驱动排序对齐/检索/归档交换/慢查询日志;session 压缩交换 + 投影身份 + questionId;llm fallback 降级链 + cacheStats;action 工具面 13 件(edit/grep/find/ls/ask_user/system/tool:catalog/fetch/retrieve/result)+ 权限双轨(requested/granted/denied/timeout 事件 + onPermission + requestId 定位)+ 后台任务 detach/进程树终止 + env 保留 + fileMeta + 危险命令强制询问;orchestrate goal 续跑(goal_continue 计入 maxTurns)+ steer 队列 drain + multirun 子会话隔离 + fused session + sessionTitle/parentId;enhance policies 三件套(coder/explore/plan + codemode 解释器)+ llmSummarize 注入回调 + search + 插件降权执行 + remember overwrite;surface subscribe filter + observe 可见性(public 面隐藏工具明细)+ http SSE 过滤参数;action grantScope 作用域预授权(一次批准 N 次,危险命令不豁免);SPEC 模块表空壳标注"(规划)/真实落点" + diff 易失性声明 + providers 边界声明;audit8 收尾状态节记录逐项对账;全量 272 测用例 0 fail,`bun run check` 零告警。剩余开放项:P1-21(lifecycle.ts/recovery 侧除悬置判定 + action turnId,SPEC 已标"部分实现/规划")、P2-23 模块表空壳标注(下方 SPEC 收尾)、P2-25(diff 易失性声明)、P2-26(llm providers 边界声明)
- M10.1 P1-21 恢复链收尾 ✅:store v5 迁移(审计带 `turnId`);action 全审计路径透传 turnId;orchestrate turn 提交点(`lifecycle.ts` 落地:行为指纹 `LoopGuard` + `turnIdOf`,scheduler 每 turn 生成 turnId(会话 epoch 锚,跨重启单调)并在 turn 尾部 `session.commitTurn(turnId)`);session 恢复侧悬置判定(纯函数 `uncommittedSyscalls`:审计最新 turn vs 已提交锚点按序比较,未提交 syscall 清单进 recovery 事件 detail + 投影"恢复告知"块,旧数据无 turnId 退回通用告警,已提交 turn 崩溃恢复不误报);SPEC 交叉自查(action/orchestrate/session 三包同步,steer 立即断流标"(规划)");eval #10 重写(已提交不误报)+ 新增 #23 悬置判定;全量 277 测用例 0 fail,`bun run check` 零告警,`bun run eval` 23/23 passed。剩余开放项:P1-22 的 Stream<ToolEvent> API 形态(已标"(规划)")
- M10.2 P1-22 executeStream 落地 ✅:action `executeStream(call)` 为底层原语(AsyncGenerator<ToolEvent>,逐调用产出 `started` → `completed`/`failed`,结果/错误在终态事件;write 原子提交/取消/超时/截断等既有语义原样保留,emit 统一经事件发射器,内联权限流事件也走同一序列);`execute` 改兼容收口(内部 for-await 流消费,外部行为不变,orchestrate/其余调用点零改动);权限询问/挂起/截断旁路事件不进流,仍经 onEvent 双轨——全局桥与流不互斥,同一事件两侧可见;action SPEC 功能面 + 模块宪法更新(去"(规划)");eval 新增 #24(成功/失败终态与 execute 收口一致 + 双轨同序);action 单测 4 例(成功/失败/门拒绝/rejected/双轨);audit8 P1-22 ✅ 收尾,剩余 "(规划)" 均属独立 P2 开放项;全量 281 测用例 0 fail,`bun run check` 零告警,`bun run eval` 24/24 passed
- M10.3-a steer 立即断流 ✅:`ExecuteRequest.signal` 成为 action 中断输入(中止挂起询问并清理挂起项、终止在飞 bash——信号已触发时 spawn 即杀防孤儿、以 `cancelled` 收尾);orchestrate `steer(input, { interrupt: "immediate" })` 可配中断粒度(llm 与工具共享 AbortSignal:在飞工具终止、剩余调用不执行、已提交结果落盘、interrupted 事件 + aborted 返回;缺省粒度行为不变);orchestrate/action 双 SPEC 更新(去"(规划)");eval 新增 #25(在飞 cancelled + 剩余不执行 + 审计落盘 + 队列消费不卡死);orchestrate 单测 3 例(缺省粒度不变/在飞 bash 被杀/挂起询问中止);全量 284 测用例 0 fail,`bun run check` 零告警,`bun run eval` 25/25 passed。剩余开放项:artifacts 大载荷外置 / workspace 文件树增量索引 / loader mtime-hash 缓存 / contract Config schema / compaction 文件拆分
- M10.3-b artifacts 大载荷外置 ✅:store v6 新增 `artifacts` 表(双驱动 `ArtifactTable`:put/get/delete/list 会话内引用枚举,正文不进检索;迁移幂等);session `src/artifacts.ts` 落地(`storeArtifact` sha256 引用/`readArtifact`/`listArtifacts`/`purgeArtifact` + `externalizeContent`):text 块超阈值(缺省 16KB,可配)在 admit/appendMessage 自动外置为引用块(size/hash 保留,正文不进投影与事件流——大载荷不烧上下文,压缩预算按引用 size 计入不因外置漏算);action 新增 `artifact:read` 工具(T0 allow,模型按引用取回正文,内置工具 13→14 件);eval 新增 #26(外置引用 + 投影无正文 + 按引用取回一致 + 工具路径);store/session/action 单测共 8 例;session/action/store 三包 SPEC + 模块表去"(规划)";全量 292 测用例 0 fail,`bun run check` 零告警,`bun run eval` 26/26 passed。剩余开放项:workspace 文件树增量索引 / loader mtime-hash 缓存 / contract Config schema / compaction 文件拆分
- M10.3-c enhance loader 增量装载 ✅:新增 `src/loader.ts` `LoaderCache`——装载键 = (mtime, size),命中不重读文件、不重解析、不重算 hash;未命中重读 + sha256 + 解析;进程内缓存(失效策略显式声明,跨进程由"文件即真相源"兜底);`enhancer.load()` 复用同一缓存装载 skills + AGENTS.md(AGENTS.md 也走 loader,不再裸 readFileSync);`enhancer.loaderStats()` 暴露 loads/hits(增量生效可断言);skills.ts 去重复目录扫描、复用 loader.scanMarkdown;eval 新增 #27(重复装载全命中 + 变化文件重读反映新内容 + 删除后消失 + 统计可观测);enhance 单测 4 例;SPEC 更新(loader.ts 去"(规划)",模块宪法 + 性能节写死缓存语义);全量 296 测用例 0 fail,`bun run check` 零告警,`bun run eval` 27/27 passed。剩余开放项:workspace 文件树增量索引 / contract Config schema / compaction 文件拆分
- M10.3-d action workspace 文件树增量索引 ✅:新增 `src/workspace.ts` `WorkspaceIndex`——目录 mtime = 子条目结构指纹:缓存态递归检查(命中目录零 stat 子条目)、变化目录只重扫一层并递归、全量重扫仅冷启动(fullScans 恒 1);删除目录剪除缓存键(无幽灵条目);跳过集合与 common.ts `SKIP_DIRS` 同源(find 行为不漂移);find 工具接入索引(同工作区多次 find 只冷扫一次,不牺牲新鲜度——新增/删除文件立即可见);`stats()` 暴露 fullScans/dirRescans/dirHits 可断言;eval 新增 #28(首扫命中 + 增量刷新可见新文件 + 删除消失);action 单测 5 例;SPEC 更新(workspace.ts 落地状态 + 增量语义进模块宪法与性能节;根列表/越界迁移/worktree 归属列为待办);全量 301 测用例 0 fail,`bun run check` 零告警,`bun run eval` 28/28 passed。剩余开放项:contract Config schema / compaction 文件拆分
- M10.3-e contract Config schema + tier 注入裁剪 ✅:contract `src/config.ts` 去"(规划)"(ConfigSchema/ToolTierRules 早已实现,SPEC 补齐)——契约兑现位明确;投影工具注入按 tier 裁剪落地(contract SPEC "规划中,当前投影全量注入" → 已实现):session `toolTierRules` 选项 + `requestTools(names)`(T1 用过即注入本 turn,beginTurn 重置;T0/未知名为 no-op;无规则时全量注入兼容旧行为),projector `injectedTools` 纯过滤(T0 常驻 + tool:catalog 恒在 + 本 turn requestedT1,overrides 强制分级);orchestrate 在工具调用落下后请求(自愈,首调缺投影不违契约);eval 新增 #29(常驻/按需/重置三态);session 单测 3 例;contract/session 双 SPEC 更新;全量 304 测用例 0 fail,`bun run check` 零告警,`bun run eval` 29/29 passed。剩余开放项:compaction 文件拆分
- M10.3-f session compaction 文件拆分 ✅(纯重构,行为零漂移):新增 `src/compaction.ts` `runCompact`(交换编排:候选判定委托 history.ts `compactionCandidates` + 摘要进历史/全文移归档 + compression/transcript 事件 + registerSummary/touch 注入);`session.compact` 瘦身为委托;compaction.ts 去"(规划)"(模块表 + 模块宪法更新);runCompact 直测 1 例(无候选 null / 摘要进全文出可回取);全量 305 测用例 0 fail,`bun run check` 零告警,`bun run eval` 29/29 passed。**M10.3 剩余 P2 开放项全部消化完毕(a–f 六项 ✅)**
- M10.4 app 配置装载/合并/消费方 ✅(app 宪法 4"配置即契约"兑现,最后 "(规划)" 标注清除):contract `src/config.ts` 增装载配套(纯 schema 驱动,惯用型同 invariant.ts)——`coerceConfigValue`(对象/数组键 JSON.parse、整型键 Number、坏串与未知键原样透传交校验期报错)+ `parseMergedConfig`(强转 → ConfigSchema 校验 + 缺省填充,非法抛 `ConfigError`)+ `formatConfigError`(键=值 + 期望类型的可操作报错)+ `isConfigKey`;app 新增 `src/config.ts` 装载路径 `loadConfigFromStore`(config:* kv → ConfigSchema,零语义决策);`tau config set` 对已知键落盘前强转 + 校验(非法退出 2 且不落盘,报错含 received 原值);compose 新增 `configStore`/`config` 选项(`resolveConfig`:store.kv 基线 + options.config 程序化覆写,undefined 字段不覆盖,合并不再重合并=单次 parse),`maxContextTokens`/`toolTierRules` 透传 createSession(预算 + tier 注入裁剪即配置消费方,CLI 交互面自动装载随 M9 热更新定案);eval 新增 #30(装载强转 + 缺省填充 + 非法拒绝 + 消费方投影裁剪一体);contract/app 双 SPEC 更新(app SPEC 功能面 + 模块表 + 去"(规划)",contract config.ts 行补装载配套);单测 7 例(contract 3 + cli 2 + compose 2);全量 312 测用例 0 fail,`bun run check` 零告警,`bun run eval` 30/30 passed
- M10.5 action workspace 待办消化 ✅(M10.3-d 遗留三项全清,action SPEC 最后 "(规划)" 清除):**gitignore 忽略树并入**——`WorkspaceIndex` 构造收 `loadIgnore`(ignore 7.0.5 预编译匹配树,只读根 .gitignore,嵌套不支持,注释/空行忽略);指纹 `{mtimeMs,size}` 失效即整根重扫(内容变更即使目录 mtime 未变也生效,不牺牲新鲜度);目录型 pattern(foo/) 对目录本身补查 `rel + "/"`(ignore 包只拦子条目的差异,单测抓到);**越界校验迁移**——`PathBoundary` 删除,`resolveWithin(cwd,pathIn)` 统一判定(roots 空 = 工具侧不设界原样返回,roots 非空 = 越界拒绝),contains 供归属判定;read/write/edit/grep/find/ls 全线接入(带 ignoreRoot 透传,grep/find 走 walkAll 索引快照不再逐文件 stat);**Multi-run worktree 归属**——新增 `worktree.ts`(T2 内部件:create/rm/list,名称契约 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 非法 rejected,`.tau-worktrees` 入 SKIP_DIRS 不进模型检索视野);multirun 子会话迁独立工作树(worktreeName = sessionId slice24 + sha256(childId) 前 8,失败/空 stdout 退回父 cwd,finally 必清),`RunResult` 增 `cwd` 字段;tier 扩展 T0/T1/T2(contract 三 schema 同步,projector 两分支均先排 T2,永不注入);action 单测 5 例(gitignore 树/指纹失效重扫/多根越界+contains/find·ls 与索引同源/worktree 生命周期);eval 扩 #16(子会话 cwd 落工作树 + create/rm 事件 ≥4 + 清理后无残留)+ 新增 #31(T2 不进投影,有/无规则两路径 + 内部调用仍审计);action SPEC 宪法 14 扩全文件工具、新增宪法 20(T2 内部机制不豁免审计)、模块表 + 性能节更新;全量 317 测用例 0 fail,`bun run check` 零告警,`bun run eval` 31/31 passed。剩余开放项:无(PLAN 无 "(规划)" 待办)
- 零散债清扫 ✅(M10.5 后补,文档漂移对齐现实):PLAN 吸收矩阵 MCP 行与架构树 action 行曾标 "MCP/pty 归 action"——实际 MCP 客户端早在 app 拼装点落地(`app/src/mcp.ts`,`@ai-sdk/mcp@^2` 已在 app 依赖,stdio/http 双 transport、工具名转义、defaultRule 注入、callTool 适配,单测覆盖于 app.test.ts);action SPEC `src/mcp/(后期)`/`src/pty.ts(后期)` 空壳行清除(第三方工具接入 = registry/execute 通道,客户端归 app),开源依赖行去 `@modelcontextprotocol/sdk`/`node-pty`,pty 转"边界(明确不做)"(bash 持久 shell 已满足交互,真终端仿真另行设计);PLAN 风险表"生态依赖"标注现状;动作面零代码改动,仅文档对齐;全量 317 测用例 0 fail,`bun run check` 零告警
- M11 认知与长程记忆 ✅:enhance `src/memory.ts` 真实化(store.kv 前缀 `memory:{sessionId}:` 持久,remember 保 createdAt + overwrite 保护(缺省拒绝覆盖)/recall/forget;listMemory 前缀枚举排序确定性(updatedAt→createdAt→key 降序,同毫秒不抖动);searchMemories 打分 key 命中 3 / 内容 1 除以 `1+年龄天数×0.2` 时间衰减,缺省前 5 条,空查询不命中);contract `SystemKindSchema` 增 `"memory"`;`enhancer.apply(sessionId)` 注入记忆索引块(kind memory、priority 30、`MEMORY_INDEX_MAX=20` 条 × `MEMORY_PREVIEW_CHARS=60` 字符预览截断带 `…`,空会话无块;**两级装载快照语义:写入不实时刷新,会话创建/恢复时重建**);Enhancer 接口增 listMemory/searchMemories + index.ts 导出;app compose 注册 memory:write/read/search/list/forget 五个 T0 syscall(缺省 allow,经 action.execute 审计;write 缺省拒绝覆盖,overwrite: true 放行);eval #32(写入/覆盖保护/检索权重/会话隔离/索引块注入与截断/空会话无块/跨进程续用);enhance 单测 5 例 + app 单测 3 例;enhance/app/contract 三包 SPEC 更新(记忆检索实现从 FTS5 声明改为 kv 枚举+打分,索引块体量上限进性能节,两级装载宪法扩记忆索引);全量 317 测用例 0 fail,`bun run check` 零告警,`bun run eval` 32/32 passed
- M12 多代理编排深化 ✅:`orchestrate/src/subagent.ts` 落地(opencode-x subagent 语义):**capability 递减**——能力面白名单缺省只读集 `SUBAGENT_DEFAULT_TOOLS`,白名单外 execute 拒绝且 recordAudit 落审计(递减不留白);**limiter** 全局 maxConcurrent=4 + 每父会话 maxPerParent=8(进程内,`subagentUsage` 可观测);**嵌套深度** maxDepth=10 沿 store.kv `subagent:{sessionId}` 注册表 parentId 链上溯(`depthOf`);子会话独立 durable + 独立审计 + 独立 worktree(经 action.execute worktree:create/rm,失败退回父 cwd/父 workspaceRoots,finally 必清);context 以数据块 admit(非指令);maxTurns=8;结果截断 resultPreviewChars=4000 回传(完整产出留子会话,父可 retrieve 观察);background 立即返回 running 完成落注册表(无推送);**修 T0 写队列死锁**——子代理工具转发走 `bypassQueue`(action 内部逃逸口:subagent:run 占父写队列时子代理工具不排父队列;独立工作树 + 单调度器串行调用并发安全);**修 compose defaultRule 未进 gate**——新增 `registerSyscall` 统一注册(内联 syscall 声明 defaultRule 真实生效,skill_load/memory/subagent 三处收敛,危险工具规则缺失不再静默 deny);app compose 注册 `subagent:run` syscall(T0 危险缺省 ask;task 必填,context/tools/background/maxTurns 可选;元数据 prepare 注册进投影,executor finishRuntime 闭包就绪后覆盖);eval #33(递减拒绝落审计 + 工作树隔离 + 注册表/深度 + 并发上限 + 深度上限 + background 落态 + limiter 归零);orchestrate 单测 5 例 + app 单测 1 例(端到端委派);orchestrate/app/action 三包 SPEC 更新(subagent.ts 去"(规划)"真实落点、app 功能面增记忆与子代理 syscall 面、registerSyscall 宪法);全量 330 测用例 0 fail,`bun run check` 零告警,`bun run eval` 33/33 passed
- M10 插件市场生态决策 **撤销候选 → 明确不做** ✅(M11/M12 后拍板):tau 是自举工具,插件市场(分发/版本/信任网络/发现)只在多作者生态下才有价值;扩展面已闭环 = skills 目录 + AGENTS.md + MCP(第三方工具通道),零仪式。保留项:enhance/plugins.ts 已落地的 opencode plugin API 兼容 + TrustLevel 信任分级基础不删——将来可零成本 import opencode 现成插件(生态红利),但 tau 自己不建市场、不写分发协议、不做 plugin 安装 CLI。PLAN 候选行与风险表同步;enhance SPEC 插件宪法标注"不做市场"决策

## 5. 需要你拍板的决策点

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 项目名 / npm scope | **已定** | `tau` / `@tau/*` |
| D2 | TUI 底座 | ① pi-tui(依赖,零维护,kimi 同款) ② opentui(自 opencode 系,你 fork 里已用) | **① pi-tui**:已是最强 agent TUI,直接当依赖;省出时间做契约层 |
| D3 | 代码复用程度 | ① 全量搬迁 opencode-x 代码再契约化 ② 只搬架构思想,契约重写 | **混合**:V2 core/llm/store/plugin 直接搬;session 投影与 action 按契约重写 |
| D4 | 插件生态兼容 | 是否兼容 opencode plugin API | **兼容但只作 import 红利**(2026-08 决策:tau 自建插件市场已撤销,保留 opencode plugin API 兼容 + 信任分级,可零成本 import 现成插件;不建分发协议/不写安装 CLI) |
| D5 | 分发形态 | ① 单二进制(Bun compile,类 kimi) ② npm 包 ③ 双发 | ③ 双发,二进制优先 |
| D6 | 首个真实验收场景 | ① 自举:tau 开发 tau ② 重构一个本地项目 | ① 自举,最诚实 |

## 6. 风险清单

| 风险 | 缓解 |
|---|---|
| opencode-x V2 core 与契约层冲突(搬迁成本) | M2 先跑通最小回路再全面搬迁,分步验收 |
| pi-tui 主动维护性(作者精力在 pi) | fork 或提 PR;组件薄封装在 tui 包内,可换 |
| 契约过早冻结导致实现绑手 | M1 契约 + M2 实现同步演化,不假想需求 |
| 范围膨胀(Goals/ACP 都想做) | 严格按里程碑,M8 之前不碰高级特性 |
| 生态依赖(plugin/MCP 兼容面) | MCP 客户端已落地(第三方工具通道);插件市场明确不做——扩展面 = skills 目录 + AGENTS.md + MCP 已闭环;opencode plugin 兼容仅保留为 import 红利 |

## 7. 宪法验收清单(每阶段对照)

- [ ] 用户 UI 显示的任何信息都能从 Context 或 Events 推出(双视角不变量)
- [ ] LLM 能感知自己的一切能力与资源(内省 syscall)
- [ ] 所有副作用只经 action/syscall 路径
- [ ] 依赖方向单向,无循环 import
- [ ] 每个包可脱离整个项目单独测试
