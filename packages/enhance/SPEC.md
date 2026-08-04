# @tau/enhance — 外设(全声明式)

## 使命
给 LLM 装外设:skills / AGENTS.md / memory / policies / plugins。全部声明式装载,增强层不写死任何行为。

## 功能(公开 API 面)
- `createEnhancer(store, opts)` → `Enhancer`
- `enhancer.load(resource)` — 装载资源(skill/AGENTS.md/策略),按 mtime/hash 增量
- `enhancer.apply(resource)` → 投影块(注入 session 的 system/self)
- `enhancer.catalog()` → 技能目录(名称+一句话,常驻 system,供模型发现);`skill:load` syscall 按需取全文
- `enhancer.search(query)` — skill 检索(名称/描述/触发词索引)
- `enhancer.remember(sessionId, key, content, { overwrite })` / `enhancer.recall(sessionId, key)` / `enhancer.forget(sessionId, key)` — T2 记忆 syscall 后端(可覆写/清理,模型写错可纠)
- `enhancer.summarize(sessionId, window)` — **摘要策略**(压缩的摘要源):默认规则摘要(按 retention 分级裁剪 + 要点提取),可插拔 LLM 摘要 policy(经 session.project + llm,走唯二出口);session.compact 的摘要文本由此产出
- `enhancer.plugins.register/uninstall` — 插件生命周期(opencode plugin API 兼容)
- 默认 policy 集:codemode 解释器(子代理 coder/explore/plan)

## 宪法
1. **全声明式**:一切资源 = Markdown + frontmatter / JSON / 目录;代码只能注册,不能内联行为
2. **资源也走投影**:增强层产物必须能注入 Context,禁止绕过投影的旁路
3. **插件先信任后安装**:信任分级前置展示(参考 kimi),未信任插件降权运行
4. **插件可禁用**:任何 skill/记忆/策略可一键关闭,不残留在 Context
5. **记忆是辅助不是主存**:记忆只做检索增强,权威状态永远在 session
6. **两级装载**:目录级信息(技能名+一句话、user 级资源摘要)常驻 system;大资源全文(AGENTS.md/skill 正文)按需取(`skill:load`),绝不常驻
7. **skill 记忆提示**:压缩告警块提醒"已加载 skill 的全文已被摘要化,可重新 `skill:load`"——模型不把摘要当全文

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/enhancer.ts` | Enhancer 聚合(装载/应用/查询) |
| `src/loader.ts` | 声明式资源装载(mtime/hash 增量 + 缓存) |
| `src/skills.ts` | skill 注册表与触发匹配 |
| `src/memory.ts` | 记忆读写(syscall 后端) |
| `src/policies.ts` | 策略集(codemode 解释器 + 子代理三件套) |
| `src/summarize.ts` | 摘要策略(规则摘要默认,LLM policy 可插拔) |
| `src/plugins.ts` | 插件生命周期(opencode plugin API 兼容) |
| `src/frontmatter.ts` | frontmatter 解析 |

## 模块宪法要点
- `loader.ts`:装载结果可复现(mtime/hash 决定),缓存失效策略显式声明
- `skills.ts`:触发匹配不进 Context,匹配是内部算法(节省 token)
- `plugins.ts`:插件 API 面保持 opencode 兼容,内部实现自由;**装载形态显式决策(单二进制兼容)**:发布版(Bun `--compile`)插件经外部子进程协议接入(与 MCP 同构),内联 JS 插件仅开发模式可用或随编译内置注册——动态装载与单二进制冲突必须事先声明,不默认都支持
- `summarize.ts`:默认规则摘要不调 LLM(常量级),LLM 摘要 policy 走 session.project + llm 唯二出口;摘要只服务压缩交换,不产生新事实(不臆造历史)
- `frontmatter.ts`:解析失败不崩溃,降级为纯文本(宽容)

## 开源依赖
`yaml`(frontmatter)。插件生态复用 opencode plugin API 约定,不重复发明。

## 性能与算法
- 资源装载按 mtime/hash 缓存,首次加载 O(n)、之后 O(1)
- skill 匹配走名称/描述/触发词倒排索引,不扫描全量正文
- 记忆检索用 FTS5 索引 + 时间衰减排序
- 注入投影的块体量设上限(防止资源撑爆预算)

## 多语言
- 资源格式(Markdown+frontmatter、JSON、目录约定)语言中立,任何语言的宿主可装载同一资源库
- skill 内容是 LLM 消费的文本,天然跨语言
- 插件 API 走 JSON 协议(opencode 兼容),第三方可用任意语言写插件

## 边界(明确不做)
不做调度(委托 orchestrate)、不做持久化(用 store)、不做工具执行。
