# @tau/store — 存储(持久化)

## 使命
会话数据的唯一持久化层。sqlite 与 memory 双实现,接口一致,可热切换。session/action/audit 全部读写经此。

## 功能(公开 API 面)
- `createStore(driver: "sqlite" | "memory")` → `Store`
- `store.sessions` / `store.messages` / `store.events` / `store.audit` / `store.kv`
- 事务:`store.tx(cb)`(批量原子写)
- 迁移:`store.migrate()`(版本化 schema 迁移)
- 查询:消息分页、事件重放、审计过滤、FTS5 全文检索

## 宪法
1. **单一数据源**:任何数据只存一份,禁止内存态与磁盘态漂移
2. **写先落盘**:事务提交成功才算成功(durable 优先)
3. **接口不泄漏实现**:sqlite/memory 切换对上层零感知
4. **schema 即契约**:表结构变更走迁移,不破坏旧数据
5. **读不锁写**:WAL 模式,长读不影响写
6. **单写者模型**:同一会话同一时刻只有一个进程可写(surface serve / CLI 互斥:锁文件 + 会话所有权);第二写者收到明确错误而非数据竞争
7. **保留策略(M4 定案)**:会话归档(完成会话可归档,增量事件折叠进快照)、**artifact 配额**(单块上限 + 会话总量上限,超限拒绝并告知)、审计滚动窗口(全量审计 + 保留期,到期归档不删历史)——事件表/审计表/artifact 正文三条增长线都有去处,不无限膨胀

## 内部模块
| 模块 | 职责 |
|---|---|
| `src/store.ts` | Store 接口 + 聚合 |
| `src/sqlite.ts` | drizzle sqlite 实现(WAL + 索引 + FTS5)**(M4 落地,当前仅 memory)** |
| `src/memory.ts` | 内存实现(测试/评测用,同接口) |
| `src/migrate.ts` | 版本化迁移**(M4 落地,当前仅 memory)** |

## 模块宪法要点
- `sqlite.ts`:开启 WAL、外键、busy_timeout;写入走批量事务;事件表归档双轨(快照 + 增量),重放 O(1) 起跳;checkpoint 策略:每 turn 提交打快照
- `memory.ts`:与 sqlite 行为逐项对齐,有差分测试兜底
- `migrate.ts`:迁移幂等,可回滚

## 开源依赖
`drizzle-orm`(查询层)。SQLite 本体 Bun 内置,零额外二进制。

## 性能与算法
- WAL 模式 + 批量事务:事件写入合并成事务组,非逐条 fsync
- 索引齐全:消息按 (session, epoch) 索引、事件按时间索引、审计按 (session, time) 索引
- FTS5 全文索引:session 检索/记忆检索/历史检索共享
- 慢查询可观测:SQL 日志按阈值输出,不静默吞性能问题

## 多语言
- SQLite schema 文档化(建表 SQL 即规范),任何语言可直读数据文件
- 存储格式不依赖 TS 运行时类型,数据文件可移植
- 提供跨语言访问文档:其他宿主可用自身生态连同一 .tau 目录

## 边界(明确不做)
不做业务语义(那是 session)、不做缓存层(上层自管)、不做分布式存储。
