// @tau/enhance - skills.ts:skill 注册表与目录装载。
// 两级装载:目录级(名称+一句话)常驻 system;全文按需取(skill:load)。
// 文件级装载走 LoaderCache(mtime/hash 增量):未变文件不重读不重解析。

import { basename } from "node:path"
import { parseFrontmatter } from "./frontmatter.ts"
import { LoaderCache, scanMarkdown } from "./loader.ts"

export type SkillEntry = {
  name: string
  description: string
  triggers: string[]
  body: string
  source: string
}

export type SkillCatalog = {
  names: string[]
  entries: Map<string, SkillEntry>
  /** 装载时跳过的坏文件(bad frontmatter 不静默降级为正文注入)。 */
  skipped: string[]
}

/** 扫描目录下所有 .md 文件,解析 frontmatter 构建 skill 目录。缓存传入时按文件增量装载。 */
export function loadSkills(dir: string, cache?: LoaderCache): SkillCatalog {
  const entries = new Map<string, SkillEntry>()
  const skipped: string[] = []
  const loader = cache ?? new LoaderCache()
  for (const file of scanMarkdown(dir)) {
    try {
      const loaded = loader.load(file, (raw) => parseSkillFile(file, raw))
      if (loaded !== null) entries.set(loaded.value.name, loaded.value)
    } catch (e) {
      // 坏 frontmatter 文件跳过,不阻断其余技能装载;skipped 列表供上层告警
      skipped.push(`${file}:${(e as Error).message}`)
    }
  }
  return { names: [...entries.keys()], entries, skipped }
}

function parseSkillFile(file: string, raw: string): SkillEntry {
  const { frontmatter, body, error } = parseFrontmatter(raw)
  if (error !== undefined) {
    // 坏 frontmatter 整文件跳过:不把"声明段 + 原文"当正文注入(静默降级 = 契约污染)
    throw new Error(`${file}:${error}`)
  }
  const name = frontmatter?.name ?? basename(file, ".md")
  return {
    name,
    description: frontmatter?.description ?? "",
    triggers: frontmatter?.triggers ?? [],
    body,
    source: file,
  }
}

/** skill:load -- 按名取全文。 */
export function getSkillText(catalog: SkillCatalog, name: string): string | null {
  const entry = catalog.entries.get(name)
  if (entry === undefined) return null
  return entry.body
}

/** 构建 skill 目录 system 块内容(常驻,供模型发现)。 */
export function catalogBlock(catalog: SkillCatalog): string {
  if (catalog.names.length === 0) return ""
  const lines = catalog.names.map((name) => {
    const entry = catalog.entries.get(name)
    if (entry === undefined) return `  - ${name}`
    return `  - ${name}: ${entry.description}`
  })
  return `可用技能(用 skill:load 工具取全文):\n${lines.join("\n")}`
}
