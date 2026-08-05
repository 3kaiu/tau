// @tau/enhance — loader.ts:声明式资源装载(mtime/hash 增量 + 缓存)。
// 装载结果由 (mtime, size) 决定:命中缓存 → 不重读文件、不重解析、不重算 hash;未命中 → 重读 + sha256 + 解析。
// 缓存进程内(单进程装载期);跨进程一致性由"文件即真相源"兜底(mtime/size 变化必然触发重读)。

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export type LoadedResource<T> = {
  value: T
  /** true = 缓存命中(mtime/size 未变,未重读文件)。 */
  fromCache: boolean
  hash: string
  path: string
}

export type LoaderStats = {
  /** 缓存条目数。 */
  paths: number
  /** 累计装载请求数 / 命中数。 */
  loads: number
  hits: number
}

export class LoaderCache {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; hash: string; value: unknown }>()
  private loads = 0
  private hits = 0

  /**
   * 读取 + 解析文件;mtime/size 未变 → 缓存直取(不重读不重解析);
   * 变化 → 重读、算 hash、重解析(parse 收到的 raw 一定是当前文件内容)。
   */
  load<T>(path: string, parse: (raw: string, hash: string) => T): LoadedResource<T> | null {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    const cached = this.entries.get(path)
    this.loads++
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.hits++
      return { value: cached.value as T, fromCache: true, hash: cached.hash, path }
    }
    const raw = readFileSync(path, "utf8")
    const hash = sha256(raw)
    const value = parse(raw, hash)
    this.entries.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, hash, value })
    return { value, fromCache: false, hash, path }
  }

  invalidate(path: string): void {
    this.entries.delete(path)
  }

  clear(): void {
    this.entries.clear()
    this.loads = 0
    this.hits = 0
  }

  stats(): LoaderStats {
    return { paths: this.entries.size, loads: this.loads, hits: this.hits }
  }
}

/** 递归扫描目录下所有 .md 文件。 */
export function scanMarkdown(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  function walk(d: string): void {
    let items: string[]
    try {
      items = readdirSync(d)
    } catch {
      return
    }
    for (const item of items) {
      const full = join(d, item)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (item.endsWith(".md")) results.push(full)
    }
  }
  walk(dir)
  return results
}
