# @tau/app - 组装点与 CLI

## 使命
唯一拼装点:Effect DI 把所有包接成可运行的 tau。CLI 入口、单二进制、配置解析。

## 功能(公开 API 面)
- `tau [project]` - 交互模式(TUI)
- `tau -p "prompt"` - print 模式(脚本友好,不 TUI);`--store <path>` 启用 SQLite 持久化
- `tau -j "prompt"` - JSONL 模式(机器消费)
- `tau serve [--port]` - surface HTTP/SSE 服务(单会话模式;多会话路由随 M9 会话治理落地)
- `tau acp` - ACP 服务(editor 驱动)
- `tau doctor` - 环境自检(模型目录/凭据解析/契约 wire 往返/store 可达+迁移+replay+kv 前缀枚举/capability 门生效);无凭据时给"可操作的一步"(配置 key / 选择可用模型)
- `tau log|replay|export <sessionId>` - 观测(M9 支柱 B);`export --format jsonl|markdown [--out <path>]`
- `tau sessions list|show|resume|archive|delete` - 会话治理(M9 支柱 C;delete = archive,不物理删;需 `--store` 才有持久记录)
- `tau config list|get <k>|set <k> <v>|unset <k>` - 配置读写(落 store.kv,拒明文 secrets)
- `tau schedule list|add <cron> <目标>|rm <id>|run [--dry-run]` - 定时目标(orchestrate cron 治理面;`run` 是一次性检查,由系统 cron 每分钟拉起,tau 不常驻守护进程)
- `tau eval` - 运行行为评测(委托 eval 包)
- `tau --version` / `-V` - 版本号(单二进制自证)
- 配置:`tau config` 命令经 store.kv 读写(全局库 `~/.tau/config.sqlite`,可用 `--store` 改指项目库);契约 Config schema 的装载/合并/消费方(预算/tier 规则读取)标注规划中,随 M9 配置热更新定案
- 持久化:`--store <path>` 指定 SQLite 文件;缺省内存(重启丢失)。compose 支持 `storePath` 选项
- 分发:`bun run build` 产出 `dist/tau`(当前平台);`bun run build:all [目标过滤]` 交叉编译 darwin/linux(x64+arm64)与 windows-x64

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
| `src/cli.ts` | 参数解析 + 子命令路由 + doctor/观测/治理/配置/调度子命令 |
| `src/compose.ts` | 依赖拼装(唯一) |
| `scripts/build.ts` | 交叉编译单二进制(仓库根,非包内) |

> 配置与 doctor 未单列模块:两者各百余行且只被 CLI 调用,拆包只会多一层间接。契约 Config schema 的装载/合并落地时再抽 `src/config.ts`。

## 模块宪法要点
- `compose.ts`:依赖图只在此声明,其他包禁止互相 new
- `cli.ts`:解析失败输出统一格式(exit code 2 + 一行原因);**观测命令严格只读**——`log`/`replay`/`export` 只 `openStore` 直读,绝不 `compose()`,否则"看一眼"就会往被观测的会话里写 recovery 事件;治理命令(resume/archive)反之必须走 session,状态转移才有 lifecycle 事件可重放
- 配置:项目/全局配置合并,敏感字段不入日志;**key 命中 secret 模式(key/token/secret/password/credential)一律拒绝落盘**,指向环境变量

## 开源依赖
`@tau/*` 全包(含 `@tau/tui`——交互模式经动态 `import` 懒加载,但必须是声明依赖,否则单二进制打不进也 resolve 不到)。CLI 解析用 Bun 内建 `Bun.argv` + 手写路由(保持体积小)。

## 性能与算法
- 毫秒级启动:Bun compile + 子命令懒加载(非交互路径不求值 TUI 模块;实测 `tau --version` ~38ms)
- 拼装一次:Effect 依赖图在进程启动构建一次,不重复实例化
- `doctor` 零等待:凭据检查走缓存,超时即报告不阻塞

## 多语言
- CLI 参数与输出格式文档化 = 其他语言/脚本调用 tau 的规范
- `-j` 输出 = contract 事件 wire 格式,机器可直接消费
- 单二进制无语言运行时依赖,可嵌入任意构建管线

## 边界(明确不做)
不做业务逻辑(那是各包)、不做遥测、不做账户系统。
后期:配置热更新、崩溃诊断日志(当前改配置需重启,重启后从 store 恢复)。
