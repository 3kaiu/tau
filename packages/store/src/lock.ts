// @tau/store - lock.ts:store 单写者锁(宪法 6:锁文件 + 会话所有权;第二写者明确错误)。
// 仅文件型 sqlite 使用;`:memory:` 与 readonly 打开不拿锁。崩溃残留由 pid 存活判定接管。

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"

export class StoreLock {
  private readonly lockPath: string
  private held = false

  constructor(dbPath: string) {
    this.lockPath = `${dbPath}.lock`
  }

  /** 独占获取:失败(pid 存活)抛明确错误;pid 已死(崩溃残留)接管后重试一次。 */
  acquire(): void {
    try {
      const fd = openSync(this.lockPath, "wx")
      try {
        writeSync(fd, `${process.pid}`)
      } finally {
        closeSync(fd)
      }
      this.held = true
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
    // 已有锁:pid 存活 = 另一写者在场;pid 死亡 = 崩溃残留,接管
    if (isProcessAlive(readLockPid(this.lockPath))) {
      throw new Error(
        `store 已被另一 tau 进程独占(pid ${readLockPid(this.lockPath)}):并发写会数据竞争,禁止第二写者。锁文件:${this.lockPath}`,
      )
    }
    try {
      unlinkSync(this.lockPath)
    } catch {
      // 竞态:对方刚释放,继续走首次获取
    }
    this.acquire()
  }

  release(): void {
    if (!this.held) return
    this.held = false
    try {
      unlinkSync(this.lockPath)
    } catch {
      // 锁已不存在(被接管/清理)不视为错误
    }
  }
}

function readLockPid(lockPath: string): number {
  try {
    if (!existsSync(lockPath)) return -1
    return Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10)
  } catch {
    return -1
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
