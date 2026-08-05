// @tau/enhance - 单测:frontmatter 解析、skill 装载、记忆、摘要、enhancer 聚合。

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "../src/frontmatter.ts"
import { loadSkills, catalogBlock, getSkillText } from "../src/skills.ts"
import { remember, recall, forget } from "../src/memory.ts"
import { ruleSummarize } from "../src/summarize.ts"
import { createEnhancer } from "../src/enhancer.ts"
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

  it("损坏的 frontmatter 不崩溃", () => {
    const raw = `---
name: [invalid yaml
---
body`
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter).toBeNull()
    expect(body).toBe(raw)
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
