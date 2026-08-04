// @tau/enhance - skills.ts:skill 注册表与目录装载。
// 两级装载:目录级(名称+一句话)常驻 system;全文按需取(skill:load)。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { parseFrontmatter } from "./frontmatter.ts"

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
}

/** 扫描目录下所有 .md 文件,解析 frontmatter 构建 skill 目录。 */
export function loadSkills(dir: string): SkillCatalog {
  const entries = new Map<string, SkillEntry>()
  if (!existsSync(dir)) return { names: [], entries }

  const files = scanMarkdown(dir)
  for (const file of files) {
    const raw = readFileSync(file, "utf8")
    const { frontmatter, body } = parseFrontmatter(raw)
    const name = frontmatter?.name ?? basename(file, ".md")
    const entry: SkillEntry = {
      name,
      description: frontmatter?.description ?? "",
      triggers: frontmatter?.triggers ?? [],
      body,
      source: file,
    }
    entries.set(name, entry)
  }

  return { names: [...entries.keys()], entries }
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

/** 递归扫描目录下所有 .md 文件。 */
function scanMarkdown(dir: string): string[] {
  const results: string[] = []
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
