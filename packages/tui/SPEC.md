# @tau/tui — 命令发布器

## 使命
主界面。用户通过 TUI 发布 Command、观察 Event、打断、批准。TUI 是**外设**,不是核心;离线也能发布(命令先排队)。

## 功能(公开 API 面)
- `createTui(deps: { surface })` → `Tui`
- `tui.run()` / `tui.stop()`
- 交互:prompt 输入、steer、abort、approve(权限弹窗)、select(多选)
- 视图:transcript 流、工具执行面板、资源面板(模型/能力/预算)
- 输出模式:`-p`(print 非交互,脚本友好)、`-j`(JSONL,机器消费)

## 宪法
1. **一切经 surface**:TUI 只 publish Command + subscribe Event,直接调内核 = 违宪
2. **渲染与状态分离**:TUI 只渲染,状态在 session;刷新走 epoch 对比;**artifact 渲染只经事件流(引用/事件正文),不得直读 store 的 artifact 表——双视角不变量对 UI 的约束:UI 可见 ⊆ 投影(Context, Events)**
3. **可离线发布**:无网络/内核忙时,命令排队不丢;排队即反馈(`input_accepted` 回执事件),用户不误以为丢失
4. **不生成内容**:TUI 不拼 prompt、不改上下文
5. **打断是命令**:abort 是显式 Command,不是渲染层技巧

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/tui.ts` | 应用聚合(pi-tui 装载 + 生命周期) |
| `src/views/` | transcript/tool 面板/资源面板 |
| `src/print.ts` | 非交互模式(print/JSONL) |
| `src/prompt.ts` | 输入绑定与斜杠命令 |
| `src/theme.ts` | 主题(配色/风格) |
| `src/index.ts` | 汇总导出 |

## 模块宪法要点
- `views/`:只读投影驱动渲染,事件驱动增量刷新;批准弹窗渲染 permission(requested) 事件的**参数摘要**(命令全文/目标路径/理由),用户批准前看到"模型要跑什么";工具执行面板显示参数摘要(非全文,扫一眼即知模型在干嘛)
- `print.ts`:输出格式稳定(脚本依赖),与 TUI 走同一条 Event 流
- `prompt.ts`:斜杠命令只映射为 Command,不旁路逻辑

## 开源依赖
`@earendil-works/pi-tui`(已是最强 agent TUI,当依赖零维护)、`chalk`。

## 性能与算法
- 差分渲染:事件节流合并成渲染帧(高频工具输出不逐帧刷屏)
- 长输出虚拟化:transcript 只渲染可视窗口,不 DOM 全量重建
- 事件订阅按视图裁剪,未订阅的事件不进渲染管线

## 多语言
- 仅 TS(终端 UI 平台相关,不作为独立 SDK 发布)
- 但输出模式(print/JSONL)格式稳定 = 其他语言脚本可直接消费
- `-j` 输出严格对齐 contract 事件 wire 格式

## 边界(明确不做)
不做业务逻辑、不做状态管理(那是内核)、不做认证。
