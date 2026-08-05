// @tau/enhance - frontmatter.ts:YAML frontmatter 解析。
// skill/AGENTS.md 资源 = frontmatter 元数据 + Markdown 正文。

import { parse as parseYaml } from "yaml"

export type Frontmatter = {
  name: string
  description: string
  triggers?: string[]
  [key: string]: unknown
}

export type ParsedResource = {
  frontmatter: Frontmatter | null
  body: string
  /** frontmatter YAML 解析失败原因:坏文件不静默降级为正文注入。 */
  error?: string
}

/** 从 Markdown 文本中分离 frontmatter 与正文。 */
export function parseFrontmatter(raw: string): ParsedResource {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (match === null) {
    return { frontmatter: null, body: raw }
  }
  const [, fmRaw, body] = match
  if (fmRaw === undefined || body === undefined) {
    return { frontmatter: null, body: raw }
  }
  let parsed: Record<string, unknown>
  try {
    const value = parseYaml(fmRaw)
    parsed = value === null || typeof value !== "object" ? {} : (value as Record<string, unknown>)
  } catch (e) {
    return { frontmatter: null, body: "", error: `frontmatter YAML 解析失败:${(e as Error).message}` }
  }
  const fm: Frontmatter = {
    name: String(parsed.name ?? ""),
    description: String(parsed.description ?? ""),
    ...(Array.isArray(parsed.triggers) ? { triggers: parsed.triggers.map(String) } : {}),
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in fm)) (fm as Record<string, unknown>)[k] = v
  }
  return { frontmatter: fm, body: body.trim() }
}
