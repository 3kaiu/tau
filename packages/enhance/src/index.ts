// @tau/enhance - 汇总出口。

export const version = "0.0.1"

export { createEnhancer } from "./enhancer.ts"
export type { Enhancer, EnhancerOptions, EnhancerState } from "./enhancer.ts"
export { loadSkills, catalogBlock, getSkillText } from "./skills.ts"
export type { SkillEntry, SkillCatalog } from "./skills.ts"
export { parseFrontmatter } from "./frontmatter.ts"
export type { Frontmatter, ParsedResource } from "./frontmatter.ts"
export { remember, recall, forget } from "./memory.ts"
export type { MemoryEntry } from "./memory.ts"
export { ruleSummarize } from "./summarize.ts"
export type { SummaryInput } from "./summarize.ts"
export {
  createPluginRegistry,
  createTrustedPluginRegistry,
  parsePluginManifest,
  validatePluginManifest,
  createPlugin,
} from "./plugins.ts"
export type {
  Plugin,
  PluginManifest,
  PluginRegistry,
  PluginWithTrust,
  TrustedPluginRegistry,
  TrustLevel,
} from "./plugins.ts"
