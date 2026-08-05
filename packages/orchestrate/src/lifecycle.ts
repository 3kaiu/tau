// @tau/orchestrate — lifecycle.ts:turn 生命周期工具(行为指纹 / 提交点标记)。
// 恢复链分工:turnId 生成与 commitTurn 调用在 scheduler(turn 尾部),recovery 事件与
// 悬置判定(审计 turnId vs 已提交 turn)在 session 恢复路径产出——调度器不 import session 依赖之外的包。

/** 行为指纹:同工具同参数无论成败累计次数,超阈值判为循环 → loop_detected(防"成功但原地踏步")。 */
export class LoopGuard {
  private readonly counts = new Map<string, number>()
  private readonly threshold: number

  constructor(threshold: number) {
    this.threshold = threshold
  }

  /** 检查一次调用;命中循环阈值返回指纹(pattern),否则 null。 */
  check(call: { name: string; args: unknown }): string | null {
    const pattern = `${call.name}:${JSON.stringify(call.args)}`
    const count = (this.counts.get(pattern) ?? 0) + 1
    this.counts.set(pattern, count)
    return count > this.threshold ? pattern : null
  }

  /** 清空指纹计数(每 turn 边界调用:循环判定只在同 turn 迭代内成立,换任务/换 turn 不延续毒化)。 */
  reset(): void {
    this.counts.clear()
  }
}

/** turnId 生成:以会话 epoch 为单调序列(epoch 经 kv 持久,跨重启不重置、进程内同会话不重复)。
 * 提交点语义:崩溃必然发生在 turn 中途,悬置判定只需"审计最后 turn ≠ 已提交 turn"。 */
export function turnIdOf(epoch: number): string {
  return `t${epoch}`
}
