// @tau/action — tools/common.ts:路径契约与分页暂存。
// 相对路径相对会话 cwd;越出 workspaceRoots 直接拒绝(防 ../ 逃逸)。

import { join, resolve, relative, isAbsolute, normalize } from "node:path"

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
}

export function pathJoin(cwd: string, ...parts: string[]): string {
  return join(cwd, ...parts)
}
