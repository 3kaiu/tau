// @tau/session — retrieve.ts:分页检索实现。
// 查询结果必须标注来源(历史/摘要),LLM 可辨别。

import type { Message } from "@tau/contract"

export type Retrieved = {
  id: string
  source: "history" | "summary"
  message: Message
  excerpt: string
}

export type RetrieveOptions = {
  query: string
  offset?: number
  limit?: number
}

/** 内存线性检索(M2;SQLite FTS5 版随 M4)。只回内容块文本,标注来源(摘要消息 → summary)。 */
export function retrieveFrom(
  history: readonly Message[],
  summaryIds: readonly string[],
  options: RetrieveOptions,
): { results: readonly Retrieved[]; total: number } {
  const needle = options.query.toLowerCase()
  const summarySet = new Set(summaryIds)
  const hits: Retrieved[] = []
  for (const m of history) {
    const excerpt = textOf(m)
    if (excerpt.toLowerCase().includes(needle)) {
      hits.push({ id: m.id, source: summarySet.has(m.id) ? "summary" : "history", message: m, excerpt: excerpt.slice(0, 200) })
    }
  }
  const offset = options.offset ?? 0
  const limit = options.limit ?? hits.length
  return { results: hits.slice(offset, offset + limit), total: hits.length }
}

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
