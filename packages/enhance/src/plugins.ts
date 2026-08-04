// @tau/enhance - plugins.ts:插件市场机制。
// 插件是声明式资源包,包含 skills、policies、hooks 等。

import type { Hook } from "@tau/action"
import { parseFrontmatter, type ParsedResource } from "./frontmatter.ts"

export type PluginManifest = {
  name: string
  version: string
  description: string
  author?: string
  skills?: string[]
  policies?: string[]
  hooks?: string[]
}

export type Plugin = {
  manifest: PluginManifest
  skills: Map<string, string>
  policies: Map<string, unknown>
  hooks: Map<string, Hook>
}

export type PluginRegistry = {
  install(plugin: Plugin): void
  uninstall(name: string): boolean
  get(name: string): Plugin | undefined
  list(): Plugin[]
  getSkill(name: string, skillName: string): string | undefined
  getHook(name: string, hookName: string): Hook | undefined
}

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, Plugin>()

  return {
    install(plugin: Plugin) {
      plugins.set(plugin.manifest.name, plugin)
    },

    uninstall(name: string): boolean {
      return plugins.delete(name)
    },

    get(name: string): Plugin | undefined {
      return plugins.get(name)
    },

    list(): Plugin[] {
      return Array.from(plugins.values())
    },

    getSkill(pluginName: string, skillName: string): string | undefined {
      const plugin = plugins.get(pluginName)
      return plugin?.skills.get(skillName)
    },

    getHook(pluginName: string, hookName: string): Hook | undefined {
      const plugin = plugins.get(pluginName)
      return plugin?.hooks.get(hookName)
    },
  }
}

/**
 * 从 Markdown 文件解析插件清单。
 * 插件清单是带有 frontmatter 的 Markdown 文件。
 */
export function parsePluginManifest(content: string): ParsedResource {
  return parseFrontmatter(content)
}

/**
 * 验证插件清单是否符合规范。
 */
export function validatePluginManifest(manifest: unknown): manifest is PluginManifest {
  if (typeof manifest !== "object" || manifest === null) return false

  const m = manifest as Record<string, unknown>
  return (
    typeof m.name === "string" &&
    typeof m.version === "string" &&
    typeof m.description === "string" &&
    (m.author === undefined || typeof m.author === "string") &&
    (m.skills === undefined || Array.isArray(m.skills)) &&
    (m.policies === undefined || Array.isArray(m.policies)) &&
    (m.hooks === undefined || Array.isArray(m.hooks))
  )
}

/**
 * 创建插件实例。
 */
export function createPlugin(
  manifest: PluginManifest,
  skills: Map<string, string> = new Map(),
  policies: Map<string, unknown> = new Map(),
  hooks: Map<string, Hook> = new Map(),
): Plugin {
  return {
    manifest,
    skills,
    policies,
    hooks,
  }
}

/**
 * 插件信任级别。
 */
export type TrustLevel = "official" | "verified" | "community" | "untrusted"

export type PluginWithTrust = {
  plugin: Plugin
  trustLevel: TrustLevel
  installedAt: string
}

/**
 * 带信任级别的插件注册表。
 */
export type TrustedPluginRegistry = {
  install(plugin: Plugin, trustLevel: TrustLevel): void
  uninstall(name: string): boolean
  get(name: string): PluginWithTrust | undefined
  list(): PluginWithTrust[]
  listByTrustLevel(level: TrustLevel): PluginWithTrust[]
}

export function createTrustedPluginRegistry(): TrustedPluginRegistry {
  const plugins = new Map<string, PluginWithTrust>()

  return {
    install(plugin: Plugin, trustLevel: TrustLevel) {
      plugins.set(plugin.manifest.name, {
        plugin,
        trustLevel,
        installedAt: new Date().toISOString(),
      })
    },

    uninstall(name: string): boolean {
      return plugins.delete(name)
    },

    get(name: string): PluginWithTrust | undefined {
      return plugins.get(name)
    },

    list(): PluginWithTrust[] {
      return Array.from(plugins.values())
    },

    listByTrustLevel(level: TrustLevel): PluginWithTrust[] {
      return Array.from(plugins.values()).filter((p) => p.trustLevel === level)
    },
  }
}
