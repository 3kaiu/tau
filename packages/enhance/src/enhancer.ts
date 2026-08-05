// @tau/enhance - enhancer.ts:Enhancer 聚合(装载/应用/查询)。
// 全声明式:资源 = Markdown + frontmatter;代码只注册不内联行为。

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SystemBlock } from "@tau/contract"
import type { Store } from "@tau/store"
import { loadSkills, catalogBlock, getSkillText, type SkillCatalog } from "./skills.ts"
import { remember, recall, forget, type MemoryEntry } from "./memory.ts"
import { ruleSummarize, type SummaryInput } from "./summarize.ts"
import { policyCatalog } from "./policies.ts"
import type { Message } from "@tau/contract"

export type EnhancerOptions = {
  cwd: string
  store: Store
  /** skills 目录(缺省 {cwd}/.tau/skills)。 */
  skillsDir?: string
  /** AGENTS.md 路径(缺省 {cwd}/AGENTS.md)。 */
  agentsMdPath?: string
  /** LLM 摘要 policy 注入(app 拼装点注入带 llm 访问的实现;enhance 不 import llm)。 */
  llmSummarize?: (input: SummaryInput) => string | Promise<string>
}

export type EnhancerState = {
  skills: SkillCatalog
  agentsMd: string | null
}

export interface Enhancer {
  /** 装载/刷新资源(skill/AGENTS.md)。 */
  load(): EnhancerState
  /** 产出投影块(注入 session.extraSystemBlocks + self.skills)。 */
  apply(): { systemBlocks: SystemBlock[]; skillNames: string[]; skillsDir: string }
  /** skill:load -- 按名取全文。 */
  getSkill(name: string): string | null
  /** skill 目录。 */
  catalog(): SkillCatalog
  /** skill 检索(名称/描述/触发词索引)。 */
  search(query: string): string[]
  /** 记忆 syscall 后端(overwrite 缺省 false,防误覆盖)。 */
  remember(sessionId: string, key: string, content: string, opts?: { overwrite?: boolean }): boolean
  recall(sessionId: string, key: string): MemoryEntry | null
  forget(sessionId: string, key: string): void
  /** 摘要策略(session.compact 的摘要源):注入的 llmSummarize 优先,失败/未注入回退规则摘要。 */
  summarize(sessionId: string, messages: readonly Message[], reason: string): Promise<string>
  /** 策略目录(codemode 解释器 + 子代理三件套)。 */
  policies(): ReturnType<typeof policyCatalog>
}

export function createEnhancer(opts: EnhancerOptions): Enhancer {
  const options = opts
  const skillsDir = opts.skillsDir ?? join(opts.cwd, ".tau", "skills")
  const agentsMdPath = opts.agentsMdPath ?? join(opts.cwd, "AGENTS.md")

  let state: EnhancerState = { skills: { names: [], entries: new Map() }, agentsMd: null }

  function load(): EnhancerState {
    const skills = loadSkills(skillsDir)
    let agentsMd: string | null = null
    if (existsSync(agentsMdPath)) {
      agentsMd = readFileSync(agentsMdPath, "utf8")
    }
    state = { skills, agentsMd }
    return state
  }

  // 构造期自动装载一次
  load()

  return {
    load,

    apply() {
      const blocks: SystemBlock[] = []

      // AGENTS.md -> constitution 级 system 块
      if (state.agentsMd !== null) {
        blocks.push({
          kind: "constitution",
          priority: 50,
          content: state.agentsMd,
        })
      }

      // skill 目录 -> context 级 system 块(常驻,供模型发现)
      const catBlock = catalogBlock(state.skills)
      if (catBlock !== "") {
        blocks.push({
          kind: "context",
          priority: 40,
          content: catBlock,
        })
      }

      return {
        systemBlocks: blocks,
        skillNames: state.skills.names,
        skillsDir,
      }
    },

    getSkill(name: string): string | null {
      return getSkillText(state.skills, name)
    },

    catalog() {
      return state.skills
    },

    remember(sessionId: string, key: string, content: string, ropts?: { overwrite?: boolean }): boolean {
      return remember(options.store, sessionId, key, content, ropts)
    },

    recall(sessionId: string, key: string): MemoryEntry | null {
      return recall(options.store, sessionId, key)
    },

    forget(sessionId: string, key: string): void {
      forget(options.store, sessionId, key)
    },

    async summarize(sessionId: string, messages: readonly Message[], reason: string): Promise<string> {
      const input: SummaryInput = { sessionId, messages, reason }
      if (options.llmSummarize !== undefined) {
        try {
          return await options.llmSummarize(input)
        } catch {
          // 摘要不阻塞压缩:LLM 失败回退规则摘要
        }
      }
      return ruleSummarize(input)
    },

    search(query: string): string[] {
      const q = query.trim().toLowerCase()
      if (q === "") return []
      const hits: Array<{ name: string; score: number }> = []
      for (const entry of state.skills.entries.values()) {
        const haystack = [entry.name, entry.description, ...entry.triggers].join(" ").toLowerCase()
        let score = 0
        if (entry.name.toLowerCase().includes(q)) score += 3
        else if (haystack.includes(q)) score += 1
        if (score > 0) hits.push({ name: entry.name, score })
      }
      return hits.sort((a, b) => b.score - a.score).map((h) => h.name)
    },

    policies() {
      return policyCatalog()
    },
  }
}
