// @tau/enhance - enhancer.ts:Enhancer 聚合(装载/应用/查询)。
// 全声明式:资源 = Markdown + frontmatter;代码只注册不内联行为。

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SystemBlock } from "@tau/contract"
import type { Store } from "@tau/store"
import { loadSkills, catalogBlock, getSkillText, type SkillCatalog } from "./skills.ts"
import { remember, recall, forget, type MemoryEntry } from "./memory.ts"
import { ruleSummarize } from "./summarize.ts"
import type { Message } from "@tau/contract"

export type EnhancerOptions = {
  cwd: string
  store: Store
  /** skills 目录(缺省 {cwd}/.tau/skills)。 */
  skillsDir?: string
  /** AGENTS.md 路径(缺省 {cwd}/AGENTS.md)。 */
  agentsMdPath?: string
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
  /** 记忆 syscall 后端。 */
  remember(sessionId: string, key: string, content: string): void
  recall(sessionId: string, key: string): MemoryEntry | null
  forget(sessionId: string, key: string): void
  /** 摘要策略(session.compact 的摘要源)。 */
  summarize(sessionId: string, messages: readonly Message[], reason: string): string
}

export function createEnhancer(opts: EnhancerOptions): Enhancer {
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

    remember(sessionId: string, key: string, content: string): void {
      remember(opts.store, sessionId, key, content)
    },

    recall(sessionId: string, key: string): MemoryEntry | null {
      return recall(opts.store, sessionId, key)
    },

    forget(sessionId: string, key: string): void {
      forget(opts.store, sessionId, key)
    },

    summarize(sessionId: string, messages: readonly Message[], reason: string): string {
      return ruleSummarize({ sessionId, messages, reason })
    },
  }
}
