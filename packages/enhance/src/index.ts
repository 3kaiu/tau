// @tau/enhance - 汇总出口。

export const version = "0.0.1"

export { createEnhancer } from "./enhancer.ts"
export type { Enhancer, EnhancerOptions, EnhancerState } from "./enhancer.ts"
export { loadSkills, catalogBlock, getSkillText } from "./skills.ts"
export type { SkillEntry, SkillCatalog } from "./skills.ts"
export { parseFrontmatter } from "./frontmatter.ts"
export type { Frontmatter, ParsedResource } from "./frontmatter.ts"
export { LoaderCache, scanMarkdown, sha256 } from "./loader.ts"
export type { LoaderStats, LoadedResource } from "./loader.ts"
export { remember, recall, forget, listMemory, searchMemories } from "./memory.ts"
export type { MemoryEntry, MemoryScope } from "./memory.ts"
export { ruleSummarize } from "./summarize.ts"
export type { SummaryInput } from "./summarize.ts"
export { policyCatalog, interpretCodemode, SUB_AGENT_POLICIES } from "./policies.ts"
export type { PolicyCatalog, SubAgentPolicy, PolicyCapability } from "./policies.ts"
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
