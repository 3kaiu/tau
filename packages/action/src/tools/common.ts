// @tau/action — tools/common.ts:路径契约、分页暂存与目录遍历。
// 相对路径相对会话 cwd;越出 workspaceRoots 直接拒绝(防 ../ 逃逸);遍历跳过隐藏目录与 node_modules。

import { join, resolve, relative, isAbsolute, normalize } from "node:path"
import { readdirSync, statSync } from "node:fs"

export class PathBoundary {
  readonly roots: readonly string[]

  constructor(roots: readonly string[]) {
    this.roots = roots
  }

  /** 解析相对/绝对路径并做边界检查。越界抛权限错误。 */
  resolve(cwd: string, pathIn: string): string {
    const candidate = isAbsolute(pathIn) ? pathIn : resolve(cwd, pathIn)
    const normalized = normalize(candidate)
    for (const root of this.roots) {
      const rootPath = resolve(root)
      if (normalized === rootPath || normalized.startsWith(rootPath + "/")) {
        return normalized
      }
    }
    const rel = relative(this.roots[0] ?? cwd, normalized)
    throw new Error(`越界拒绝:${pathIn} 在 workspaceRoots 之外(${rel})`)
  }
}

export class ResultPageStore {
  private readonly pages = new Map<string, { text: string; maxBytes: number }>()

  put(key: string, text: string, maxBytes: number): void {
    this.pages.set(key, { text, maxBytes })
  }

  getPage(key: string, page: number): { text: string; totalPages: number } | null {
    const entry = this.pages.get(key)
    if (entry === undefined) return null
    const totalPages = Math.max(1, Math.ceil(entry.text.length / entry.maxBytes))
    if (page < 0 || page >= totalPages) return { text: "", totalPages }
    return { text: entry.text.slice(page * entry.maxBytes, (page + 1) * entry.maxBytes), totalPages }
  }

  /** 全部暂存条目(retrieve 检索源)。 */
  all(): { callId: string; text: string }[] {
    return [...this.pages.entries()].map(([callId, entry]) => ({ callId, text: entry.text }))
  }

  size(): number {
    return this.pages.size
  }
}

export function pathJoin(cwd: string, ...parts: string[]): string {
  return join(cwd, ...parts)
}

const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".next", ".turbo", "dist", ".workbuddy"])

/** 深度优先目录遍历(同步,限制深度与文件数,防爆炸)。 */
export function walk(
  root: string,
  opts: { maxDepth?: number; maxFiles?: number } = {},
): { path: string; isDir: boolean }[] {
  const maxDepth = opts.maxDepth ?? 8
  const maxFiles = opts.maxFiles ?? 2000
  const out: { path: string; isDir: boolean }[] = []
  const visit = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    entries.sort()
    for (const name of entries) {
      if (out.length >= maxFiles) return
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir && SKIP_DIRS.has(name)) continue
      out.push({ path: full, isDir })
      if (isDir) visit(full, depth + 1)
    }
  }
  visit(root, 0)
  return out
}
