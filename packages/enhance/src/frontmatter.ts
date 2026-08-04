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
  try {
    const parsed = parseYaml(fmRaw) as Record<string, unknown>
    const fm: Frontmatter = {
      name: String(parsed.name ?? ""),
      description: String(parsed.description ?? ""),
      ...(Array.isArray(parsed.triggers) ? { triggers: parsed.triggers.map(String) } : {}),
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in fm)) (fm as Record<string, unknown>)[k] = v
    }
    return { frontmatter: fm, body: body.trim() }
  } catch {
    return { frontmatter: null, body: raw }
  }
}
