# @tau/enhance — 外设(全声明式)

## 使命
给 LLM 装外设:skills / AGENTS.md / memory / policies / plugins。全部声明式装载,增强层不写死任何行为。

## 功能(公开 API 面)
- `createEnhancer(store, opts)` → `Enhancer`
- `enhancer.load()` — 装载资源(skill/AGENTS.md/策略),按 mtime/hash 增量(未变文件命中进程内缓存,不重读不重解析)
- `enhancer.loaderStats()` — 装载缓存统计(loads/hits/paths,增量装载生效的观测点)
- `enhancer.apply(sessionId)` → 投影块(注入 session 的 system/self;记忆索引块 kind=memory 在此生成:构造期快照,≤20 条 × 60 字符预览,空会话无块)
- `enhancer.catalog()` → 技能目录(名称+一句话,常驻 system,供模型发现);`skill:load` syscall 按需取全文
- `enhancer.search(query)` — skill 检索(名称/描述/触发词索引)
- `enhancer.remember(sessionId, key, content, { overwrite })` / `enhancer.recall(sessionId, key)` / `enhancer.forget(sessionId, key)` — 记忆后端(store.kv 前缀 `memory:{sessionId}:`;覆盖缺省拒绝,`overwrite: true` 放行,可清理)
- `enhancer.listMemory(sessionId)` / `enhancer.searchMemories(sessionId, query, { limit })` — 记忆枚举(updatedAt 降序确定性排序)与检索(key 命中权重 3 > 内容 1,除以 `1 + 年龄×0.2` 时间衰减,缺省前 5 条)
- `enhancer.summarize(sessionId, window)` — **摘要策略**(压缩的摘要源):默认规则摘要(按 retention 分级裁剪 + 要点提取);可插拔 LLM 摘要 policy,经**构造期注入回调** `opts.llmSummarize` 接入(app 在拼装点注入带 llm 访问的实现;enhance 不 import llm,同 session 摘要回调模式,不违反依赖方向);不注入则回退纯规则摘要;session.compact 的摘要文本由此产出
- `enhancer.plugins.register/uninstall` — 插件生命周期(opencode plugin API 兼容;**明确不做市场**:插件 = skills/policies/hooks 的本地打包分发单元,tau 自己不建 registry/分发协议/安装 CLI——扩展面 = skills 目录 + AGENTS.md + MCP 已闭环;opencode 兼容保留为 import 现成插件的零成本红利,TrustLevel 信任分级基础保留)
- 默认 policy 集:codemode 解释器(子代理 coder/explore/plan)

## 宪法
1. **全声明式**:一切资源 = Markdown + frontmatter / JSON / 目录;代码只能注册,不能内联行为
2. **资源也走投影**:增强层产物必须能注入 Context,禁止绕过投影的旁路
3. **插件先信任后安装**:信任分级前置展示(参考 kimi),未信任插件降权运行;**信任分级是 import 生态时的治理面,不代表要建设市场**
4. **插件可禁用**:任何 skill/记忆/策略可一键关闭,不残留在 Context
5. **记忆是辅助不是主存**:记忆只做检索增强,权威状态永远在 session
6. **两级装载**:目录级信息(技能名+一句话、user 级资源摘要、记忆索引)常驻 system;大资源全文(AGENTS.md/skill 正文/记忆全文)按需取(`skill:load`/`memory:read`/`memory:search`),绝不常驻。记忆索引是**构造期快照**(写入后不实时刷新,会话创建/恢复时经 `apply(sessionId)` 重建)
7. **skill 记忆提示**:压缩告警块提醒"已加载 skill 的全文已被摘要化,可重新 `skill:load`"——模型不把摘要当全文

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/enhancer.ts` | Enhancer 聚合(装载/应用/查询) |
| `src/loader.ts` | 声明式资源装载(mtime/hash 增量 + 进程内缓存;未变文件不重读不重解析) |
| `src/skills.ts` | skill 注册表与触发匹配 |
| `src/memory.ts` | 记忆读写后端(listMemory/searchMemories 枚举+检索,store.kv 持久,可跨会话/进程续用) |
| `src/policies.ts` | 策略集(codemode 解释器 + 子代理三件套) |
| `src/summarize.ts` | 摘要策略(规则摘要默认,LLM policy 可插拔) |
| `src/plugins.ts` | 插件生命周期(opencode plugin API 兼容) |
| `src/frontmatter.ts` | frontmatter 解析 |

## 模块宪法要点
- `loader.ts`:装载结果可复现(mtime/hash 决定);进程内缓存,命中键 (mtime, size)——未变文件不重读不重解析;缓存失效策略显式声明(进程内,跨进程一致性由"文件即真相源"兜底:文件变化必然改变 mtime/size 触发重读);装载统计(loads/hits)可观测,增量生效与否可断言
- `skills.ts`:触发匹配不进 Context,匹配是内部算法(节省 token)
- `plugins.ts`:插件 API 面保持 opencode 兼容,内部实现自由;**明确不做市场(2026-08 决策)**:不建分发协议/registry/安装 CLI——单作者场景下市场是负资产,扩展面由 skills 目录 + AGENTS.md + MCP 闭环;opencode 兼容 + TrustLevel 仅作为 import 现成插件的红利保留;**装载形态显式决策(单二进制兼容)**:发布版(Bun `--compile`)插件经外部子进程协议接入(与 MCP 同构),内联 JS 插件仅开发模式可用或随编译内置注册——动态装载与单二进制冲突必须事先声明,不默认都支持
- `summarize.ts`:默认规则摘要不调 LLM(常量级);LLM 摘要 policy 只经构造期注入回调(`opts.llmSummarize`,app 拼装点注入,回调内部走 session.project + llm 唯二出口),**enhance 本体不 import llm**;摘要只服务压缩交换,不产生新事实(不臆造历史)
- `frontmatter.ts`:解析失败不崩溃,降级为纯文本(宽容)

## 开源依赖
`yaml`(frontmatter)。插件生态复用 opencode plugin API 约定,不重复发明。

## 性能与算法
- 资源装载按 mtime/hash 缓存,首次加载 O(n)、之后 O(1)(命中键 mtime+size,stat 级开销)
- skill 匹配走名称/描述/触发词倒排索引,不扫描全量正文
- 记忆检索:store.kv 前缀枚举 + 打分排序(key 命中 3 / 内容命中 1,除以 `1 + 年龄天数×0.2` 时间衰减),O(会话记忆数)线性;枚举排序确定性(updatedAt→createdAt→key 降序,同毫秒不抖动)
- 注入投影的块体量设上限(索引块 ≤20 条 × 60 字符预览,防止资源撑爆预算;全文不常驻)

## 多语言
- 资源格式(Markdown+frontmatter、JSON、目录约定)语言中立,任何语言的宿主可装载同一资源库
- skill 内容是 LLM 消费的文本,天然跨语言
- 插件 API 走 JSON 协议(opencode 兼容),第三方可用任意语言写插件

## 边界(明确不做)
- 不做调度(委托 orchestrate)、不做工具执行。
- 不做持久化写入:运行期状态(记忆、装载缓存元数据等)写入经 `store`;增强层不持有写权威。
- **装载期只读例外**:`enhancer.ts`/`skills.ts` 在装载自身声明式资源(AGENTS.md、skill 目录与文件)时,允许以 `node:fs` 只读方式(`readFileSync`/`readdirSync`/`existsSync`/`statSync`)读取本包/配置约定的资源目录。**这是"声明式装载"的必要实现,不是持久化,也不写盘。** 任何写盘操作仍唯一经 `store` 与 `action` 出口。
