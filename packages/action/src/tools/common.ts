// @tau/action — tools/common.ts:分页暂存与工具侧公共件。
// 路径契约(根列表/越界/忽略规则)已迁入 workspace.ts WorkspaceIndex,本文件不再持有。

import { join } from "node:path"

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
