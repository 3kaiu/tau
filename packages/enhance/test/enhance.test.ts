// @tau/enhance - 单测:frontmatter 解析、skill 装载、记忆、摘要、enhancer 聚合。

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "../src/frontmatter.ts"
import { loadSkills, catalogBlock, getSkillText } from "../src/skills.ts"
import { remember, recall, forget, listMemory, searchMemories } from "../src/memory.ts"
import { ruleSummarize } from "../src/summarize.ts"
import { createEnhancer } from "../src/enhancer.ts"
import { LoaderCache, sha256 } from "../src/loader.ts"
import {
  createTrustedPluginRegistry,
  createPlugin,
  interpretCodemode,
  SUB_AGENT_POLICIES,
} from "../src/index.ts"
import { createMemoryStore } from "@tau/store"
import { MessageSchema, type Message } from "@tau/contract"

function msg(id: string, role: "user" | "assistant", text: string): Message {
  return MessageSchema.parse({ id, role, content: [{ type: "text", text }], createdAt: "2025-01-01T00:00:00Z" })
}

describe("frontmatter: parseFrontmatter", () => {
  it("有 frontmatter 的 markdown", () => {
    const raw = `---
name: my-skill
description: 一个测试技能
triggers:
  - test
  - demo
---
# Skill Body
做这件事。`
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter?.name).toBe("my-skill")
    expect(frontmatter?.description).toBe("一个测试技能")
    expect(frontmatter?.triggers).toEqual(["test", "demo"])
    expect(body).toContain("# Skill Body")
  })

  it("无 frontmatter 的 markdown", () => {
    const raw = `# Plain markdown\n没有 frontmatter。`
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter).toBeNull()
    expect(body).toBe(raw)
  })

  it("损坏的 frontmatter 不崩溃、不静默降级为正文注入", () => {
    const raw = `---
name: [invalid yaml
---
body`
    const { frontmatter, body, error } = parseFrontmatter(raw)
    expect(frontmatter).toBeNull()
    expect(error).toContain("frontmatter YAML 解析失败")
    expect(body).toBe("")
  })
})

describe("skills: loadSkills + catalogBlock", () => {
  const tmpDir = `/tmp/tau-enhance-test-${Date.now()}`

  beforeEach(() => {
    mkdirSync(join(tmpDir, "sub"), { recursive: true })
    writeFileSync(join(tmpDir, "alpha.md"), `---\nname: alpha\ndescription: 第一个技能\n---\nAlpha body.`)
    writeFileSync(join(tmpDir, "sub", "beta.md"), `---\nname: beta\ndescription: 第二个技能\n---\nBeta body.`)
    writeFileSync(join(tmpDir, "plain.md"), `# Plain\nNo frontmatter.`)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("扫描目录,解析 frontmatter,构建目录", () => {
    const catalog = loadSkills(tmpDir)
    expect(catalog.names).toHaveLength(3)
    expect(catalog.names).toContain("alpha")
    expect(catalog.names).toContain("beta")
    expect(catalog.names).toContain("plain")
  })

  it("getSkillText 按名取全文", () => {
    const catalog = loadSkills(tmpDir)
    expect(getSkillText(catalog, "alpha")).toBe("Alpha body.")
    expect(getSkillText(catalog, "beta")).toBe("Beta body.")
    expect(getSkillText(catalog, "nonexistent")).toBeNull()
  })

  it("catalogBlock 生成目录 system 块内容", () => {
    const catalog = loadSkills(tmpDir)
    const block = catalogBlock(catalog)
    expect(block).toContain("alpha: 第一个技能")
    expect(block).toContain("beta: 第二个技能")
    expect(block).toContain("skill:load")
  })

  it("不存在目录返回空目录", () => {
    const catalog = loadSkills("/nonexistent/path")
    expect(catalog.names).toEqual([])
    expect(catalog.entries.size).toBe(0)
  })
})

describe("memory: remember/recall/forget", () => {
  const store = createMemoryStore()

  it("写入/读取/删除记忆", () => {
    remember(store, "s1", "pref", "用户偏好:简洁回复")
    const entry = recall(store, "s1", "pref")
    expect(entry?.content).toBe("用户偏好:简洁回复")
    expect(entry?.updatedAt).toBeTruthy()

    forget(store, "s1", "pref")
    expect(recall(store, "s1", "pref")).toBeNull()
  })

  it("会话隔离", () => {
    remember(store, "s1", "key", "value1")
    remember(store, "s2", "key", "value2")
    expect(recall(store, "s1", "key")?.content).toBe("value1")
    expect(recall(store, "s2", "key")?.content).toBe("value2")
  })

  it("不存在的 key 返回 null", () => {
    expect(recall(store, "s1", "nope")).toBeNull()
  })

  it("overwrite 缺省 false:已存在 key 拒绝覆盖", () => {
    expect(remember(store, "s1", "locked", "old")).toBe(true)
    expect(remember(store, "s1", "locked", "new")).toBe(false)
    expect(recall(store, "s1", "locked")?.content).toBe("old")
    expect(remember(store, "s1", "locked", "new", { overwrite: true })).toBe(true)
    expect(recall(store, "s1", "locked")?.content).toBe("new")
  })

  it("overwrite 保留 createdAt,更新 updatedAt", () => {
    remember(store, "s1", "timed", "v1")
    const created = recall(store, "s1", "timed")!.createdAt
    remember(store, "s1", "timed", "v2", { overwrite: true })
    const updated = recall(store, "s1", "timed")!
    expect(updated.createdAt).toBe(created)
    expect(updated.content).toBe("v2")
  })
})

describe("memory: listMemory + searchMemories(M11 真实化)", () => {
  const store = createMemoryStore()

  it("listMemory 真实枚举(前缀 kv,更新序倒序)", () => {
    remember(store, "s-m1", "a", "alpha")
    remember(store, "s-m1", "b", "beta")
    remember(store, "s-m1", "c", "gamma")
    const keys = listMemory(store, "s-m1").map((e) => e.key)
    expect(keys).toEqual(["c", "b", "a"])
    expect(listMemory(store, "s-m1")[0]?.updatedAt).toBeTruthy()
  })

  it("listMemory 会话隔离:只列本会话", () => {
    remember(store, "s-other", "x", "1")
    const keys = listMemory(store, "s-m1").map((e) => e.key)
    expect(keys).not.toContain("x")
  })

  it("searchMemories:key 命中权重高于内容命中", () => {
    remember(store, "s-m1", "db-密码", "root")
    remember(store, "s-m1", "杂项", "提到 db-密码 的事")
    const hits = searchMemories(store, "s-m1", "db-密码")
    expect(hits[0]?.key).toBe("db-密码")
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  it("searchMemories:空查询不命中,limit 生效", () => {
    expect(searchMemories(store, "s-m1", "  ")).toEqual([])
    const hits = searchMemories(store, "s-m1", "db", { limit: 1 })
    expect(hits.length).toBe(1)
  })

  it("searchMemories:时间衰减越新越靠前", () => {
    vi.useFakeTimers()
    try {
      remember(store, "s-m1", "旧记录", "同一个词")
      vi.advanceTimersByTime(86_400_000 * 3)
      remember(store, "s-m1", "新记录", "同一个词")
      const hits = searchMemories(store, "s-m1", "同一个词")
      expect(hits[0]?.key).toBe("新记录")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("summarize: ruleSummarize", () => {
  it("提取用户指令 + 助手回复 + 工具调用", () => {
    const messages: Message[] = [
      msg("u1", "user", "帮我读文件"),
      msg("a1", "assistant", "好的,我来读取"),
      msg("t1", "tool" as never, ""),
    ]
    // tool 消息需要特殊构造
    const toolMsg = MessageSchema.parse({
      id: "t1", role: "tool", content: [],
      toolResults: [{ callId: "c1", result: { exitCode: 0, stdout: "file content", stderr: null, truncated: false, totalPages: 1, page: 0 } }],
      source: "read", createdAt: "2025-01-01T00:00:00Z",
    })
    messages[2] = toolMsg

    const summary = ruleSummarize({ sessionId: "s1", messages, reason: "budget" })
    expect(summary).toContain("压缩摘要")
    expect(summary).toContain("帮我读文件")
    expect(summary).toContain("好的,我来读取")
    expect(summary).toContain("read")
  })

  it("空消息列表不崩溃", () => {
    const summary = ruleSummarize({ sessionId: "s1", messages: [], reason: "test" })
    expect(summary).toContain("压缩摘要")
  })
})

describe("plugins: 信任分级与降权执行", () => {
  const manifest = { name: "p1", version: "1.0.0", description: "测试插件" }

  it("untrusted 插件的 skill/hook 带降权标记", () => {
    const registry = createTrustedPluginRegistry()
    const hook = () => {}
    registry.install(
      createPlugin(manifest, new Map([["secret", "malicious body"]]), new Map(), new Map([["h1", hook]])),
      "untrusted",
    )
    const skill = registry.executeSkill("p1", "secret")
    expect(skill?.content).toBe("malicious body")
    expect(skill?.demoted).toBe(true)
    const h = registry.executeHook("p1", "h1")
    expect(h?.hook).toBe(hook)
    expect(h?.demoted).toBe(true)
  })

  it("official 插件不降权", () => {
    const registry = createTrustedPluginRegistry()
    registry.install(createPlugin(manifest, new Map([["ok", "body"]])), "official")
    expect(registry.executeSkill("p1", "ok")?.demoted).toBe(false)
  })

  it("未知插件返回 null", () => {
    const registry = createTrustedPluginRegistry()
    expect(registry.executeSkill("nope", "x")).toBeNull()
  })

  it("listByTrustLevel 按级别过滤", () => {
    const registry = createTrustedPluginRegistry()
    registry.install(createPlugin(manifest, new Map()), "official")
    registry.install(createPlugin({ ...manifest, name: "p2" }, new Map()), "untrusted")
    expect(registry.listByTrustLevel("official")).toHaveLength(1)
    expect(registry.listByTrustLevel("verified")).toHaveLength(0)
  })
})

describe("enhancer: createEnhancer 聚合", () => {
  const tmpDir = `/tmp/tau-enhancer-test-${Date.now()}`

  beforeEach(() => {
    mkdirSync(join(tmpDir, ".tau", "skills"), { recursive: true })
    writeFileSync(join(tmpDir, ".tau", "skills", "greet.md"), `---\nname: greet\ndescription: 问候技能\n---\nSay hello.`)
    writeFileSync(join(tmpDir, "AGENTS.md"), `# Project Rules\n使用 TypeScript。`)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("装载 skills + AGENTS.md,产出投影块", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })

    const applied = enhancer.apply()
    expect(applied.skillNames).toContain("greet")
    expect(applied.systemBlocks.length).toBeGreaterThanOrEqual(2)

    const constitutionBlock = applied.systemBlocks.find((b) => b.kind === "constitution")
    expect(constitutionBlock?.content).toContain("Project Rules")

    const contextBlock = applied.systemBlocks.find((b) => b.kind === "context")
    expect(contextBlock?.content).toContain("greet: 问候技能")
  })

  it("getSkill 按名取全文", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    expect(enhancer.getSkill("greet")).toBe("Say hello.")
    expect(enhancer.getSkill("nonexistent")).toBeNull()
  })

  it("summarize 产出摘要文本(LLM 未注入回退规则摘要)", async () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    const messages = [msg("u1", "user", "test"), msg("a1", "assistant", "reply")]
    const summary = await enhancer.summarize("s1", messages, "budget")
    expect(summary).toContain("压缩摘要")
    expect(summary).toContain("test")
  })

  it("注入 llmSummarize 时优先用注入回调,失败回退规则摘要", async () => {
    const store = createMemoryStore()
    const calls: string[] = []
    const enhancer = createEnhancer({
      cwd: tmpDir,
      store,
      llmSummarize: async (input) => {
        calls.push(input.reason)
        return `[LLM 摘要] ${input.messages.length} 条`
      },
    })
    const messages = [msg("u1", "user", "test")]
    const summary = await enhancer.summarize("s1", messages, "budget")
    expect(summary).toBe("[LLM 摘要] 1 条")
    expect(calls).toEqual(["budget"])
  })

  it("llmSummarize 抛错时回退规则摘要,不阻塞压缩", async () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({
      cwd: tmpDir,
      store,
      llmSummarize: async () => {
        throw new Error("llm down")
      },
    })
    const messages = [msg("u1", "user", "test")]
    const summary = await enhancer.summarize("s1", messages, "budget")
    expect(summary).toContain("压缩摘要")
  })

  it("search 按名称/描述/触发词检索 skill", () => {
    const store = createMemoryStore()
    writeFileSync(
      join(tmpDir, ".tau", "skills", "deploy.md"),
      `---\nname: deploy\ndescription: 部署流程\ntriggers:\n  - release\n  - 发布\n---\nDeploy body.`,
    )
    writeFileSync(
      join(tmpDir, ".tau", "skills", "cjk.md"),
      `---\nname: cjk\ndescription: 中文分词实践\ntriggers:\n  - 中文\n---\nCJK body.`,
    )
    const enhancer = createEnhancer({ cwd: tmpDir, store })

    expect(enhancer.search("deploy")).toEqual(["deploy"])
    expect(enhancer.search("部署")).toEqual(["deploy"])
    expect(enhancer.search("中文")).toEqual(["cjk"])
    expect(enhancer.search("不存在")).toEqual([])
  })

  it("policies 暴露子代理三件套", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    const catalog = enhancer.policies()
    expect(catalog.names).toEqual(["coder", "explore", "plan"])
    for (const p of SUB_AGENT_POLICIES) expect(catalog.entries.get(p.name)?.description).toBe(p.description)
  })

  it("codemode 解释器把意图映射到子代理", () => {
    expect(interpretCodemode("帮我实现一个函数").agent.name).toBe("coder")
    expect(interpretCodemode("调查一下这个崩溃").agent.name).toBe("explore")
    expect(interpretCodemode("给出重构方案").agent.name).toBe("plan")
  })

  it("remember 经 enhancer 默认不覆盖,overwrite 可强制", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    expect(enhancer.remember("s1", "k", "v1")).toBe(true)
    expect(enhancer.remember("s1", "k", "v2")).toBe(false)
    expect(enhancer.recall("s1", "k")?.content).toBe("v1")
    expect(enhancer.remember("s1", "k", "v2", { overwrite: true })).toBe(true)
    expect(enhancer.recall("s1", "k")?.content).toBe("v2")
  })

  it("记忆操作经 enhancer", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    enhancer.remember("s1", "pref", "简洁")
    expect(enhancer.recall("s1", "pref")?.content).toBe("简洁")
    enhancer.forget("s1", "pref")
    expect(enhancer.recall("s1", "pref")).toBeNull()
  })

  it("apply(sessionId) 注入记忆索引块(两级装载:索引常驻,全文按需)", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    enhancer.remember("s1", "偏好", "用户偏好简洁回复,不要啰嗦")
    enhancer.remember("s1", "项目", "tau 是 LLM 宿主项目")

    const applied = enhancer.apply("s1")
    const memoryBlock = applied.systemBlocks.find((b) => b.kind === "memory")
    expect(memoryBlock).toBeDefined()
    expect(memoryBlock!.priority).toBe(30)
    expect(memoryBlock!.content).toContain("[偏好] 用户偏好简洁回复,不要啰嗦")
    expect(memoryBlock!.content).toContain("memory:read")

    // 无记忆时无 memory 块;其他会话隔离
    const empty = enhancer.apply("s-other")
    expect(empty.systemBlocks.some((b) => b.kind === "memory")).toBe(false)
  })

  it("无 skills 目录和 AGENTS.md 时不崩溃", () => {
    const emptyDir = `/tmp/tau-enhancer-empty-${Date.now()}`
    mkdirSync(emptyDir, { recursive: true })
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: emptyDir, store })
    const applied = enhancer.apply()
    expect(applied.skillNames).toEqual([])
    expect(applied.systemBlocks).toEqual([])
    rmSync(emptyDir, { recursive: true, force: true })
  })
})

describe("loader: mtime/hash 增量装载 + 缓存", () => {
  const tmpDir = `/tmp/tau-loader-test-${Date.now()}`
  const skillPath = () => join(tmpDir, ".tau", "skills", "greet.md")
  const agentsPath = () => join(tmpDir, "AGENTS.md")

  beforeEach(() => {
    mkdirSync(join(tmpDir, ".tau", "skills"), { recursive: true })
    writeFileSync(skillPath(), `---\nname: greet\ndescription: 问候技能\n---\nSay hello.`)
    writeFileSync(agentsPath(), `# Project Rules\n使用 TypeScript。`)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("首次装载全 miss,重复装载全 hit(未变文件不重读)", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    expect(enhancer.loaderStats()).toMatchObject({ paths: 2, loads: 2, hits: 0 })

    const applied = enhancer.apply()
    expect(applied.skillNames).toEqual(["greet"])

    enhancer.load()
    const stats = enhancer.loaderStats()
    expect(stats.loads).toBe(4)
    expect(stats.hits).toBe(2)
  })

  it("文件内容变化后 reload 反映新内容(该文件 miss,其余 hit)", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    enhancer.load()

    writeFileSync(skillPath(), `---\nname: greet\ndescription: 升级版问候\n---\nSay hello loudly.`)
    enhancer.load()

    const applied = enhancer.apply()
    const contextBlock = applied.systemBlocks.find((b) => b.kind === "context")
    expect(contextBlock?.content).toContain("升级版问候")
    const stats = enhancer.loaderStats()
    expect(stats.hits).toBe(3)
    expect(stats.loads).toBe(6)
  })

  it("文件删除后 reload 从目录消失(缓存不残留幽灵条目)", () => {
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: tmpDir, store })
    enhancer.load()

    rmSync(skillPath())
    enhancer.load()

    expect(enhancer.apply().skillNames).toEqual([])
  })

  it("LoaderCache 独立使用:mtime 变但内容同 → 重读但结果不变;内容变 → 新值新 hash", () => {
    const cache = new LoaderCache()
    const file = join(tmpDir, "note.md")
    writeFileSync(file, "hello")

    const first = cache.load(file, (raw, hash) => ({ raw, hash }))
    expect(first?.fromCache).toBe(false)
    const second = cache.load(file, (raw, hash) => ({ raw, hash }))
    expect(second?.fromCache).toBe(true)
    expect(second?.value).toEqual(first?.value)
    expect(cache.stats()).toMatchObject({ loads: 2, hits: 1 })
    expect(second?.hash).toBe(sha256("hello"))

    writeFileSync(file, "hello")
    const third = cache.load(file, (raw, hash) => ({ raw, hash }))
    expect(third?.fromCache).toBe(false)
    expect(third?.value).toEqual({ raw: "hello", hash: sha256("hello") })

    writeFileSync(file, "hello world")
    const fourth = cache.load(file, (raw, hash) => ({ raw, hash }))
    expect(fourth?.fromCache).toBe(false)
    expect(fourth?.value).toEqual({ raw: "hello world", hash: sha256("hello world") })

    expect(cache.load("/nonexistent/file.md", (r) => r)).toBeNull()
  })
})
