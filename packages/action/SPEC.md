# @tau/action — 手脚(Syscall 层)

## 使命
LLM 的手脚。唯一副作用出口:安全、可审计、可中断地执行 SystemCall。

## 功能(公开 API 面)
- `createActionPlane(store, opts)` → `ActionPlane`
- `plane.register(syscall)` — 注册工具(内置/扩展/MCP)
- `plane.execute(call)` → `Promise<ExecuteOutcome>`(结果 + 错误封闭;兼容收口,内部即 executeStream 流消费)
- `plane.executeStream(call)` → `AsyncIterable<ToolEvent>`(逐调用流式事件:`started` → `completed`/`failed`,结果/错误在终态事件;权限询问/挂起/截断等旁路事件不进流,仍经 onEvent 双轨——全局桥与流不互斥,同一事件两侧可见)
- `plane.capabilities()` — capability 门(默认拒绝/允许/询问三态规则表)
- `plane.permissionRequest()`(挂起请求列表,远程凭 requestId 决议)/ `plane.grant(requestId)`(单次决议)/ `plane.grantScope(caps, scope)` — 授权流(**作用域预授权:一次批准 N 次**,maxUses/durationMs;危险命令不经豁免);`grant(caps, scope)` 的旧签名已并入 grantScope
- **权限事件双轨**:询问时同时发 `permission(requested)` 事件(requestId + 参数摘要)与调用 `onPermission` 回调(本地弹窗);决议后发 `granted/denied/timeout` 事件——**requested 事件供远程客户端/观察者经 Event 流可见(approve/deny 凭 requestId 定位),回调供本地 UI 即时决策,双轨不互斥**
- `plane.audit.query(filter)` — 副作用审计日志查询(LLM 可查自己的 syscall 史)
- 内置工具:read/write/edit/bash/grep/find/ls/ask_user/retrieve/fetch/system/tool:catalog(工具目录查询,冷工具按需注入)/result(截断续读+后台轮询)/**artifact:read(按引用取回大载荷正文,session 外置 artifact 的模型检索路径)**/**worktree:create/rm/list(T2 内部机制,仅编排层调用,不注入模型投影)**
- read 支持 `range{from,to}` / `preview`(前 N 行 + 总行数报告)——大文件不整读;结果带 `fileMeta { mtime, size, hash? }`(模型判断文件是否已被改动)
- 进程类结果带 **`exitCode` + stdout/stderr 分离**:`isError` 之外有真相源,模型区分"警告"与"错误"
- bash 参数过**危险命令模式检测**(`rm -rf /`/`git push --force`/`sudo`/`curl | sh` 等),命中强制询问(与 capability 门叠加,不走静默允许)
- 结果续读:`result:page` 协议——截断结果按页取(truncated/totalPages),中间段不永久丢失
- bash 持久 shell:bash 调用带 `shellId`(缺省**会话级持久**,保留 cwd/env;`new_shell: true` 显式重置;可配置 turn 级)
- 后台任务:长任务 detach(返回 `taskId`,可轮询/取消)
- ask_user:返回 `questionId` 后挂起(会话进 awaiting_input,`pendingSyscalls` 可见),answer 到达恢复;支持选择模式(选项列表,经 select 命令多选)
- 执行运行时:并发、超时、取消、输出截断、挂起恢复

## 宪法
1. **唯一副作用出口**:任何文件/进程/网络操作必须经 action;绕过 = 违宪
2. **capability 门不可绕过**:未授权 syscall 直接拒绝,审计记录
3. **全量审计**:每个 syscall 记录 入参/结果/耗时/批准链(模型可查)
4. **失败 = isError 结果**:不 throw 到编排层,错误文本回模型供重试
5. **工具看不见内核**:工具无 session 引用,只能通过契约参数与返回
6. **ask_user 是普通 syscall**:用户是外设,提问与工具调用同构;发出即挂起(`questionId` + pendingSyscalls),answer 路由恢复
7. **隐藏命令 = 违宪**:凡模型不可感知的自动操作一律禁止
8. **路径契约**:相对路径相对会话 cwd(投影 self 可见);`cwd`/`projectRoot`/git 状态随投影提供——模型永远知道自己在哪
9. **第三方工具无豁免**:MCP/插件注册的 syscall 一律过 capability 门
10. **fetch 净化**:网页 HTML→文本净化 + 大小上限 + 注入防护(数据非指令),经 capability 门;结果带 `url + fetchedAt + truncated`(模型可判断信息陈旧度);**拒绝 `file://` 与本地文件协议**(防网络工具绕过宪法 14 的 workspace 边界)
11. **工具结果可续读**:truncated 结果按页可取(`result:page`),截断不丢段
12. **二进制/编码检测**:read 命中 NUL 字节/解码失败 → 拒绝并报告(不吐乱码烧 token)
13. **敏感内容检测**:工具结果过 secret 模式检测(`-----BEGIN`/`*_KEY=` 等),命中 → redact 标记 + 事件告警(不阻断,提示模型)
14. **工作区边界**:文件工具(read/write/edit/grep/find/ls)路径经 `WorkspaceIndex.resolveWithin` 解析,越出 `workspaceRoots` 直接拒绝(防 `../` 逃逸);roots 为空 = 不设界(工具侧原样返回),roots 非空 = 严格拒绝
15. **真相源**:进程类工具结果必带 exitCode,stdout/stderr 独立——"成功但无效"的判定有可靠依据
16. **危险命令检测**:bash 参数过危险命令模式检测(模式表为契约级清单),命中强制询问,不走"允许"静默;**定位声明:检测是防线不是安全边界(与宪法 19 沙箱不做的定位一致)——降低误执行率,不承诺对抗绕过(全路径/变量展开/分步组合),对抗面由用户审查 + 审计兜底**
17. **原子写**:write/edit 走临时文件 + rename 原子提交,失败不留半写文件(crash 恢复后文件要么旧版要么新版,无中间态)
18. **进程树终止**:取消/超时/abort 传播到整棵进程树(detach 的后台任务取消 taskId 时清理其子进程),防孤儿进程泄漏
19. **物理沙箱显式不做**:第一版无 OS 级进程隔离(容器/沙箱运行时);防线 = capability 门 + 危险命令检测 + 审计 + 工作区边界,替代防线已声明,不默认"有沙箱"
20. **内部机制工具(T2)**:编排层内部件(如 worktree:create/rm/list)注册为 tier T2,永不注入模型投影(有/无 tier 规则均排除);但调用仍走 `execute` + capability 门 + 全量审计——内部件不豁免审计,不是"隐藏命令"(宪法 7)

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/registry.ts` | SystemCall 注册表(内置+扩展+MCP) |
| `src/runtime.ts` | 执行运行时(并发/取消/超时/流式/截断/后台任务/挂起恢复/进程树终止) |
| `src/capability.ts` | 能力门(规则表 + 授权流) |
| `src/audit.ts` | 审计日志(写入 + 查询) |
| `src/workspace.ts` | 工作区模型(`WorkspaceIndex`)——**根列表 + 越界校验 + gitignore 忽略树全部落地**:目录 mtime = 子条目结构指纹,未变目录零 stat 复用、变化目录只重扫一层并递归检查,全量重扫仅冷启动;`resolveWithin` 统一越界判定(roots 空 = 不设界,roots 非空 = 严格拒绝),find/grep/ls 与 read/write/edit 同源不漂移;**gitignore 只读根 `.gitignore`(ignore 预编译匹配树)**,指纹 `{mtimeMs,size}` 失效——内容变更即使目录 mtime 未变也整根重扫(不牺牲新鲜度);删除目录剪除缓存键(无幽灵条目);`.tau-worktrees` 入 SKIP_DIRS(工作树不进模型检索视野) |
| `src/worktree.ts` | 工作树(T2 内部件):`WORKTREE_DIR=".tau-worktrees"` 下 mkdir -p 创建/rmSync 清理/枚举;名称契约 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`(非法名 rejected,防越界);orchestrate 子会话隔离归属的唯一出口(经 execute 审计) |
| `src/tools/` | 内置工具:read/write/edit/bash/grep/find/ls/ask_user/retrieve/fetch/system/tool:catalog/result/artifact:read |
| MCP 客户端 | **不在本包**(原 `src/mcp/` 空壳已清):第三方工具经 `registry` + `execute` 通道接入(宪法 9 无豁免),客户端实现在 app 拼装点 `app/src/mcp.ts`(工具名转义 + defaultRule 注入 + callTool 适配,见 app SPEC) |

## 模块宪法要点
- `runtime.ts`:同一工具可并发,文件写操作串行(互斥队列);**执行并发按 tier 分级(T0 互斥串行 / T1 并行,与契约 tier 语义一致)**;write/edit 走临时文件 + rename 原子提交;取消/超时终止整棵进程树,后台任务取消时清理孤儿;**`executeStream` 是底层原语**(逐调用产出 `started` → `completed`/`failed` 终态事件),`execute` 是兼容收口(内部即 for-await 流消费);权限询问/挂起等旁路事件只进 onEvent 双轨不进流;**`ExecuteRequest.signal` 是中断输入**(steer 立即断流/取消):中止挂起询问(清理挂起项,不挂等决议)、终止在飞 bash(信号已触发时 spawn 即杀,无孤儿)、以 `cancelled` 错误收尾,未执行调用由调度层拦截
- `capability.ts`:询问时发 `permission(requested)` 事件(requestId/工具名/能力/理由 + **参数摘要**:bash 命令全文、write 目标路径)并同步调 `onPermission` 回调——用户批准前看到"模型要跑什么",不只是"要不要放行";决议后发 `granted/denied/timeout` 事件,approve(经 toolCallId 承载 requestId)/deny 定位到挂起请求
- `audit.ts`:审计记录本身也是事件,进入 LLM 可查空间;审计记录带 **`turnId`**(提交点边界由 orchestrate 在 turn 尾部 `commitTurn` 写入,经 `ExecuteRequest.turnId` 透传)——recovery 悬置判定("上次 turn 已提交/未提交的 syscall")以 turnId 为判定输入(判定实现在 session 恢复路径)
- `workspace.ts`:`WorkspaceIndex` 增量语义——目录 mtime 命中(含缓存态递归检查)不 stat 子条目、miss 只重扫该目录一层;文件内容编辑不改目录 mtime(树结构查询不关心内容,代价是 find 结果不携带实时 size/mtime);`stats()` 暴露 fullScans/dirRescans/dirHits(增量生效可断言);忽略判定以 ignoreRoot 为基准的相对路径(不是进程 cwd),`\` → `/`(Windows);gitignore 指纹失效 → clearSubtree + 整根重扫;`SKIP_DIRS` 与工具 ls/find 过滤同源,find 行为不漂移;**multi-run fork 子会话时持久 shell 初始 cwd = 子会话 worktree 根,工作树创建/清理经 `worktree:create/rm`(execute 审计),crash 残留可经 `worktree:list` 发现**
- `tools/bash.ts`:长输出截断 + 环境注入(session 元数据),受 `PI_` 式环境变量约束;**缺省会话级持久 shell**(shellId 缺省 = 当前会话;`new_shell: true` 重置);结果必带 exitCode,stdout/stderr 分离;危险命令模式检测命中 → 强制询问
- `tools/fetch.ts`:HTML→文本净化 + 大小上限 + 注入防护
- `tools/ask_user.ts`:返回 questionId 挂起;选择模式(选项列表)经 select 命令多选
- `tools/read.ts`:range/preview 参数 + 行数报告 + 二进制/编码检测 + fileMeta(mtime/size/hash);`tools/system.ts`:内省 syscall——完整权限规则/队列状态/pending 计数/工具目录(tool:catalog 后端)
- `runtime.ts`:输出过 secret 模式检测;路径越界检查(workspaceRoots)

## 开源依赖
- `diff`(edit 差分)、`ignore`(gitignore 匹配)、`minimatch`(模式匹配)
- 第三方工具通道经 `@ai-sdk/mcp`(app 依赖,本包不引);后期:`ripgrep`(检索加速)

## 性能与算法
- 热路径:工具执行流——输出流式透传不缓冲,大输出边读边截断
- 并发:每会话一个 executor;同工具限流 + 文件写互斥队列,无进程全局锁
- 差分:edit 用 Myers 差分;忽略规则用 `ignore` 预编译匹配树(一次编译 N 次匹配)
- 截断:bash 长输出按 token 估算在流上截断,不整读
- 文件树查询:find 走 `WorkspaceIndex`,未变目录只 stat 目录 mtime(O(目录数)),重扫只发生在目录结构变化的路径上;gitignore 指纹比对 O(1),内容变更才整根重扫(目录 mtime 不变也不漏新规则)

## 多语言
- syscall 参数/结果契约 = JSON Schema,任何语言可实现同一工具集
- 工具行为规范(read 换行处理/edit 匹配策略/bash 环境注入)文档化在 `tools/`
- MCP 是天然的跨语言工具桥:第三方语言工具一律经 MCP 接入

## 边界(明确不做)
不生成上下文(委托 session)、不决定下一轮(委托 orchestrate)、不做权限弹窗 UI(那是 tui 的投影)。
**不做交互终端 PTY**(原 `src/pty.ts` 计划已撤销):bash 工具持久 shell 已满足交互需求;真终端仿真(ANSI 交互程序)整体方案另行设计,不在本包内嵌。
**不内嵌 MCP 客户端**:第三方工具接入仅经 registry/execute 通道,客户端归 app 拼装点。
