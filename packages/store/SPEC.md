# @tau/store - 存储(持久化)

## 使命
会话数据的唯一持久化层。sqlite 与 memory 双实现,接口一致,可热切换。session/action/audit 全部读写经此。

## 功能(公开 API 面)
- `createStore(driver: "sqlite" | "memory", path?)` -> `Store`(sqlite 需 path,memory 忽略)
- `createMemoryStore()` / `createSqliteStore(path)` -> `Store`
- `store.sessions` / `store.messages` / `store.events` / `store.audit` / `store.kv`
- 事务:`store.tx(cb)`(批量原子写)
- 迁移:`store.migrate()`(版本化 schema 迁移,幂等)
- 关闭:`store.close?()`(memory 无操作;sqlite 释放文件句柄)
- 查询:消息分页、事件重放、审计过滤、**会话注册表**(`sessions.list` 按 updatedAt 倒序,治理面读端)与 **kv 前缀列举**(`kv.list(prefix)`,配置/记忆读端)
- 保留策略:`SqliteStore.archiveAudit(sessionId, olderThanIso)`(旧审计移至 `audit_archive` 表,不删历史)

## 宪法
1. **单一数据源**:任何数据只存一份,禁止内存态与磁盘态漂移
2. **写先落盘**:事务提交成功才算成功(durable 优先)
3. **接口不泄漏实现**:sqlite/memory 切换对上层零感知
4. **schema 即契约**:表结构变更走迁移,不破坏旧数据
5. **读不锁写**:WAL 模式,长读不影响写
6. **单写者模型**:同一会话同一时刻只有一个进程可写(surface serve / CLI 互斥:锁文件 + 会话所有权);第二写者收到明确错误而非数据竞争
7. **保留策略**:会话归档(完成会话经 **session 层 API** `session.archive()` 置 archived 状态——API 归属 session,store 提供 archived 状态列与归档查询)、审计滚动窗口(`archiveAudit` 移至 `audit_archive` 表,不删历史)、artifact 配额(M6 随 artifacts 模块定案)--事件表/审计表/artifact 正文三条增长线都有去处,不无限膨胀

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/store.ts` | Store 接口 + 聚合 |
| `src/sqlite.ts` | SQLite 实现(WAL + 索引 + JSON blob;audit 归档) |
| `src/memory.ts` | 内存实现(测试/评测用,同接口) |
| `src/migrate.ts` | 版本化迁移(幂等,forward-only) |

## 模块宪法要点
- `sqlite.ts`:开启 WAL、外键、busy_timeout;写入走批量事务;复杂对象(Message/Event/SessionSnapshot)存 JSON blob,查询字段提为列;事件/消息按 AUTOINCREMENT seq 保序
- `memory.ts`:与 sqlite 行为逐项对齐,store 单测覆盖两驱动对齐(排序键/注册表/迁移语义)
- `sqlite.ts` 补充:`kv.list(prefix)` 用 `substr(key,1,n) = prefix` 而非 `LIKE prefix||'%'`——前缀里的 `%`/`_` 是 LIKE 元字符,会把 `100%off` 这类键匹配歪
- `migrate.ts`:迁移幂等(forward-only,不回滚);版本号记在 kv 表(当前 `SCHEMA_VERSION = 2`);首次迁移建全量表(sessions/messages/events/audit/audit_archive + 索引);v2 追加 `idx_sessions_updated (updated_at DESC, session_id ASC)`——治理面 `sessions.list` 的排序键。建索引语句一律 `IF NOT EXISTS` 且每次打开库都执行,老库无需重建即可获得新索引

## 开源依赖
`drizzle-orm`(查询层,已声明;当前实现直接用 `bun:sqlite`,drizzle 留作复杂查询扩展)。SQLite 本体 Bun 内置,零额外二进制。

## 性能与算法
- WAL 模式 + 批量事务:事件写入合并成事务组,非逐条 fsync
- 索引齐全:消息按 (session, seq) 索引、事件按 (session, seq) 索引、审计按 (session, timestamp) 索引、会话注册表按 (updated_at DESC, session_id) 索引
- 预处理语句缓存:每条 SQL 构造期 prepare 一次,运行期复用
- 慢查询可观测:SQL 日志按阈值输出,不静默吞性能问题
- FTS5 全文索引:session 检索/记忆检索/历史检索共享(M5+ 随 retrieve 升级)

## 多语言
- SQLite schema 文档化(建表 SQL 即规范),任何语言可直读数据文件
- 存储格式不依赖 TS 运行时类型(JSON blob + 标准列),数据文件可移植
- 提供跨语言访问文档:其他宿主可用自身生态连同一 .tau 目录

## 边界(明确不做)
不做业务语义(那是 session)、不做缓存层(上层自管)、不做分布式存储。
