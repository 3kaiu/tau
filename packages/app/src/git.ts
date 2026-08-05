// @tau/app - git.ts:合成期 git 现场快照(投影 self.git/projectRoot 的唯一生产来源)。
// 只读元数据,非模型驱动副作用(与 enhancer 装载同界);git 缺失/非仓库 → 静默降级 null。

import type { GitStatus } from "@tau/contract"

export type GitInfo = { projectRoot: string; git: GitStatus } | null

export function gitInfo(cwd: string): GitInfo {
  const run = (args: string[]): string | null => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0 ? r.stdout.toString().trim() : null
  }
  try {
    const projectRoot = run(["rev-parse", "--show-toplevel"])
    if (projectRoot === null) return null
    const commit = run(["rev-parse", "--short", "HEAD"]) ?? undefined
    const status = run(["status", "--porcelain", "-b"])
    const lines = status === null ? [] : status.split("\n")
    const branch = /^##\s+([^.\s]+)/.exec(lines[0] ?? "")?.[1]
    const dirty = lines.slice(1).some((line) => line.trim() !== "")
    return { projectRoot, git: { branch, commit, dirty } }
  } catch {
    return null
  }
}
