# @tau/app - 组装点与 CLI

## 使命
唯一拼装点:Effect DI 把所有包接成可运行的 tau。CLI 入口、单二进制、配置解析。

## 功能(公开 API 面)
- `tau [project]` - 交互模式(TUI)
- `tau -p "prompt"` - print 模式(脚本友好,不 TUI);`--store <path>` 启用 SQLite 持久化
- `tau -j "prompt"` - JSONL 模式(机器消费)
- `tau serve [--port]` - surface HTTP/SSE 服务(支持 `--sessions` 多会话路由,M7)
- `tau acp` - ACP 服务(editor 驱动)
- `tau doctor` - 环境自检(模型/凭据/proxy);无凭据时给"可操作的一步"(配置 key / 选择可用模型)
- `tau eval` - 运行行为评测(委托 eval 包)
- 配置:`.tau/config.*`(项目级)+ `~/.tau/config.*`(全局),JSON/YAML
- 持久化:`--store <path>` 指定 SQLite 文件;缺省内存(重启丢失)。compose 支持 `storePath` 选项

## 宪法
1. **app 是唯一拼装点**:除 app 外任何包不得 import 其他包的运行时依赖
2. **启动毫秒级**:子命令懒加载,交互面永不阻塞启动
3. **CLI 稳定**:参数与输出格式是公共契约,变更走文档化流程
4. **配置即契约**:配置 schema 走 contract 校验,非法配置给可操作报错
5. **一切行为可恢复**:崩溃不吞日志,`.tau/` 下可重放

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/main.ts` | 入口(Bun compile 目标) |
| `src/cli.ts` | 参数解析 + 子命令路由 |
| `src/compose.ts` | Effect DI 拼装(唯一) |
| `src/config.ts` | 配置装载/合并/校验 |
| `src/doctor.ts` | 环境自检 |

## 模块宪法要点
- `compose.ts`:依赖图只在此声明,其他包禁止互相 new
- `cli.ts`:解析失败输出统一格式(exit code + 一行原因)
- `config.ts`:项目/全局配置合并,敏感字段不入日志

## 开源依赖
`@tau/*` 全包。CLI 解析用 Bun 内建 `Bun.argv` + 手写路由(保持体积小)。

## 性能与算法
- 毫秒级启动:Bun compile + 子命令懒加载(交互面不 import TUI)
- 拼装一次:Effect 依赖图在进程启动构建一次,不重复实例化
- `doctor` 零等待:凭据检查走缓存,超时即报告不阻塞

## 多语言
- CLI 参数与输出格式文档化 = 其他语言/脚本调用 tau 的规范
- `-j` 输出 = contract 事件 wire 格式,机器可直接消费
- 单二进制无语言运行时依赖,可嵌入任意构建管线

## 边界(明确不做)
不做业务逻辑(那是各包)、不做遥测、不做账户系统。
后期:配置热更新、崩溃诊断日志(当前改配置需重启,重启后从 store 恢复)。
