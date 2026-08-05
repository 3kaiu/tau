// @tau/contract — 契约层单测:四契约 schema + 封闭联合 + 不变量检查器。

import { describe, expect, it } from "vitest"
import {
  CommandSchema,
  ConfigSchema,
  ContextProjectionSchema,
  DenyCommandSchema,
  EventSchema,
  GoalSchema,
  MessageSchema,
  ModelSchema,
  SelfSchema,
  SessionSnapshotSchema,
  SystemCallSchema,
  ToolResultSchema,
  assertBudget,
  assertDualView,
  assertToolPairing,
  checkBudget,
  checkDualView,
  checkReplay,
  checkToolPairing,
  contractSchemas,
  coerceConfigValue,
  createEventIdGenerator,
  goal,
  hasRecoveryNotice,
  isConfigKey,
  isDangerousCommand,
  jsonSchemas,
  parseMergedConfig,
  recentActivityFrom,
  redactFields,
  estimateTokens,
  toolError,
  toolResult,
  validate,
} from "@tau/contract"

function makeProjection(overrides?: Partial<Parameters<typeof ContextProjectionSchema.parse>[0]>) {
  return ContextProjectionSchema.parse({
    version: 3,
    wake: { reason: "prompt", source: "tui:1" },
    history: [
      MessageSchema.parse({
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "读一下 package.json" }],
        retention: "high",
        createdAt: "2026-08-04T00:00:00.000Z",
      }),
      MessageSchema.parse({
        id: "m2",
        role: "assistant",
        content: [{ type: "text", text: "好的" }],
        modelId: "model-x",
        createdAt: "2026-08-04T00:00:01.000Z",
      }),
    ],
    self: {
      model: { id: "model-x", provider: "test", contextWindow: { maxTokens: 4096 } },
      clock: { wall: "2026-08-04T00:00:02.000Z", monotonicMs: 2000, sessionElapsedMs: 2000 },
      usage: {
        turn: 1,
        toolCallsThisTurn: 0,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cumulativeTokens: 150,
        estimatedRemaining: 3000,
        costUsd: 0.001,
      },
      cwd: "/tmp/workspace",
      permissions: [{ pattern: "bash", rule: "ask" }],
      skills: { names: ["bun"] },
      session: { id: "s1" },
    },
    resources: {
      maxConcurrentTurns: 1,
      budget: { maxTurns: 10, maxTurnMs: 60_000, maxToolCallsPerTurn: 8 },
      workspaceRoots: ["/tmp/workspace"],
    },
    ...overrides,
  })
}

describe("四契约 schema", () => {
  it("Model 解析并带默认能力面", () => {
    const m = ModelSchema.parse({
      id: "gpt-x",
      provider: { api: "openai", provider: "openai" },
      cost: { inputPerMillion: 1, outputPerMillion: 2 },
      contextWindow: { maxTokens: 128_000 },
    })
    expect(m.capabilities.supportsTools).toBe(true)
    expect(m.capabilities.supportsVision).toBe(false)
  })

  it("Message 解析:内容块/toolCalls/toolResults/retention/modelId", () => {
    const msg = MessageSchema.parse({
      id: "m3",
      role: "assistant",
      content: [{ type: "text", text: "调用 bash" }],
      toolCalls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }],
      toolResults: [{ callId: "c1", result: toolResult({ stdout: "a\nb\n" }) }],
      modelId: "model-x",
      createdAt: "2026-08-04T00:00:03.000Z",
    })
    expect(msg.toolResults[0]?.result?.totalPages).toBe(1)
    expect(msg.toolResults[0]?.result?.truncated).toBe(false)
  })

  it("ToolResult 分页:truncated/totalPages 构造后必在", () => {
    const r = toolResult({ stdout: "x".repeat(100), truncated: true, totalPages: 4, page: 0 })
    const parsed = ToolResultSchema.parse(r)
    expect(parsed.truncated).toBe(true)
    expect(parsed.totalPages).toBe(4)
  })

  it("ToolError:ErrorCode 必填,未知 code 拒绝", () => {
    expect(toolError("timeout", "慢")).toMatchObject({ code: "timeout" })
    expect(() => ToolResultSchema.parse({})).not.toThrow()
    expect(contractSchemas.ToolResult.safeParse({ truncated: false, totalPages: 1, exitCode: 0 }).success).toBe(true)
  })

  it("SystemCall:parameters 接受任意 JSON Schema 对象", () => {
    const sc = SystemCallSchema.parse({
      name: "bash",
      description: "run shell",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      tier: "T0",
      maxOutputTokens: 8192,
      dangerous: true,
    })
    expect(sc.tier).toBe("T0")
    expect(sc.dangerous).toBe(true)
  })

  it("Command 封闭联合:七分支全过,未知 kind 拒绝", () => {
    for (const c of [
      { kind: "prompt", sender: { clientId: "t1", kind: "tui" }, text: "hi" },
      { kind: "steer", sender: { clientId: "t1", kind: "tui" }, text: "转向" },
      { kind: "approve", sender: { clientId: "t1", kind: "tui" }, toolCallId: "c1", capability: "bash", reason: "可信" },
      { kind: "answer", sender: { clientId: "t1", kind: "tui" }, questionId: "q1", answer: "选 A" },
      { kind: "abort", sender: { clientId: "t1", kind: "tui" } },
      { kind: "select", sender: { clientId: "t1", kind: "tui" }, questionId: "q1", selected: ["a", "b"], multiple: true },
      { kind: "observe", sender: { clientId: "r1", kind: "remote" }, subscribe: true, streams: ["transcript"] },
    ]) {
      expect(CommandSchema.safeParse(c).success).toBe(true)
    }
    expect(CommandSchema.safeParse({ kind: "hack", sender: {} }).success).toBe(false)
  })

  it("Event 封闭联合:十二分支全过,事件必带 id/timestamp", () => {
    const base = { id: "e1", timestamp: "2026-08-04T00:00:00.000Z" }
    const events = [
      { ...base, kind: "input_accepted", command: { kind: "prompt", sender: { clientId: "t1", kind: "tui" }, text: "hi" } },
      { ...base, kind: "transcript", message: makeProjection().history[0] },
      { ...base, kind: "tool", toolCallId: "c1", name: "bash", state: "completed", result: toolResult({ stdout: "ok" }) },
      { ...base, kind: "permission", requestId: "p1", toolName: "bash", summary: "bash -c ls", state: "requested" },
      { ...base, kind: "compression", droppedIds: ["m1"], strategy: "retention" },
      { ...base, kind: "lifecycle", sessionId: "s1", state: "created" },
      { ...base, kind: "budget_exceeded", metric: "totalTokens", used: 100, limit: 50 },
      { ...base, kind: "loop_detected", turn: 5, pattern: "same-tool-repeat" },
      { ...base, kind: "retry", cause: "timeout", attempts: 1 },
      { ...base, kind: "model_switched", from: "a", to: "b", reason: "cost" },
      { ...base, kind: "interrupted", targetId: "m2" },
      { ...base, kind: "recovery", from: "crash@e7" },
    ]
    for (const e of events) expect(EventSchema.safeParse(e).success).toBe(true)
    expect(EventSchema.safeParse({ ...base, kind: "mystery" }).success).toBe(false)
  })

  it("Goal:状态机字段与构造器", () => {
    const g = goal("g1", "重构", { strategy: "checklist", checklist: ["a", "b"] })
    expect(GoalSchema.safeParse(g).success).toBe(true)
    expect(g.status).toBe("active")
    expect(g.progress).toBe(0)
    expect(GoalSchema.safeParse({ ...g, progress: 2 }).success).toBe(false)
  })

  it("SessionSnapshot:epoch/pendingSyscalls/activeGoals", () => {
    const snap = SessionSnapshotSchema.parse({
      sessionId: "s1",
      epoch: 3,
      status: "active",
      activeGoals: [goal("g1", "重构")],
      pendingSyscalls: [{ questionId: "q1", toolCallId: "c1", toolName: "bash", raisedAt: "2026-08-04T00:00:00.000Z" }],
      transcriptCount: 2,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:01.000Z",
    })
    expect(snap.pendingSyscalls[0]?.questionId).toBe("q1")
  })

  it("ContextProjection:完整解析,self 五要素必在", () => {
    const p = makeProjection()
    expect(p.version).toBe(3)
    expect(p.self.clock.wall).toBeTruthy()
    expect(p.self.usage.costUsd).toBeGreaterThan(0)
    expect(p.self.cwd).toBe("/tmp/workspace")
    expect(p.self.permissions.length).toBeGreaterThan(0)
    expect(p.self.skills.names).toContain("bun")
    expect(p.pendingSyscalls).toEqual([])
    expect(p.activeGoals).toEqual([])
  })

  it("validate 与 jsonSchemas:跨语言 wire 契约可导出", () => {
    const r = validate(MessageSchema, { id: "x", role: "user", content: [], createdAt: "t" })
    expect(r.success).toBe(true)
    const schemas = jsonSchemas()
    expect(schemas.ContextProjection.$schema).toContain("2020-12")
    expect(schemas.Command).toBeTruthy()
    expect(schemas.Message.type).toBe("object")
  })
})

describe("redactFields", () => {
  it("按字段路径脱敏,深度安全", () => {
    const obj = { args: { command: "rm -rf", env: { TOKEN: "secret" } }, name: "bash" }
    expect(redactFields(obj, ["args.command"])).toEqual({
      args: { command: "[redacted]", env: { TOKEN: "secret" } },
      name: "bash",
    })
    expect(redactFields(obj, ["args.*"])).toEqual({
      args: { command: "[redacted]", env: "[redacted]" },
      name: "bash",
    })
    expect(redactFields(obj, [])).toEqual(obj)
  })
})

describe("recentActivityFrom / hasRecoveryNotice", () => {
  it("取最近一条 retry/interrupted/model_switched", () => {
    const e = (kind: "retry" | "interrupted" | "model_switched", id: string) => ({
      id,
      timestamp: "t",
      kind,
      cause: "x",
      attempts: 0,
      from: "a",
      to: "b",
      reason: "r",
      targetId: "m1",
    })
    const activity = recentActivityFrom([
      e("retry", "e1") as never,
      e("model_switched", "e2") as never,
    ] as never[])
    expect(activity?.kind).toBe("model_switched")
    expect(recentActivityFrom([])).toBeNull()
  })

  it("恢复告知:recovery 事件可被断言发现", () => {
    expect(hasRecoveryNotice([{ id: "e1", timestamp: "t", kind: "recovery", from: "crash" }])).toBe(true)
    expect(hasRecoveryNotice([])).toBe(false)
  })
})

describe("不变量检查器", () => {
  it("checkDualView:UI 可见 ⊆ 投影 ∪ 事件", () => {
    const p = makeProjection()
    const events = [makeProjection().history[0]].map((m) => ({
      id: "e1",
      timestamp: "t",
      kind: "transcript" as const,
      message: m,
    }))
    expect(
      checkDualView({ transcript: [{ messageId: "m1", role: "user" }], pendingSyscalls: [], activeGoals: [], status: "active" }, p, events).ok,
    ).toBe(true)
    const bad = checkDualView(
      { transcript: [{ messageId: "ghost", role: "user" }], pendingSyscalls: [], activeGoals: [], status: "active" },
      p,
      events,
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.violations[0]?.code).toBe("dual_view.message_not_derivable")
  })

  it("assertDualView 抛错", () => {
    const p = makeProjection()
    expect(() =>
      assertDualView(
        { transcript: [{ messageId: "ghost", role: "user" }], pendingSyscalls: [], activeGoals: [], status: "active" },
        p,
        [],
      ),
    ).toThrow(/双视角/)
  })

  it("checkBudget:轮次/工具调用/上下文窗", () => {
    expect(checkBudget(makeProjection()).ok).toBe(true)
    const overTurns = makeProjection({
      self: { ...makeProjection().self, usage: { ...makeProjection().self.usage, turn: 11 } },
    })
    const r = checkBudget(overTurns)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations.some((v) => v.code === "budget.max_turns")).toBe(true)
  })

  it("assertBudget 抛错", () => {
    const p = makeProjection({
      self: {
        ...makeProjection().self,
        usage: { ...makeProjection().self.usage, totalTokens: 999_999 },
      },
    })
    expect(() => assertBudget(p)).toThrow(/budget.context_overflow/)
  })

  it("checkReplay:事件重放与快照一致", () => {
    const p = makeProjection()
    const events = [
      { id: "e0", timestamp: "t", kind: "lifecycle" as const, sessionId: "s1", state: "created" as const },
      { id: "e1", timestamp: "t", kind: "transcript" as const, message: p.history[0]! },
      { id: "e2", timestamp: "t", kind: "transcript" as const, message: p.history[1]! },
    ]
    const snap = SessionSnapshotSchema.parse({
      sessionId: "s1",
      epoch: 3,
      status: "active",
      transcriptCount: 2,
      createdAt: "t",
      updatedAt: "t",
    })
    expect(checkReplay(events, p, snap).ok).toBe(true)
    const drifted = { ...p, version: 1 }
    const bad = checkReplay(events, drifted, snap)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.violations.some((v) => v.code === "replay.version_mismatch")).toBe(true)
  })

  it("checkToolPairing:callId 一一配对", () => {
    const m1 = MessageSchema.parse({
      id: "a1",
      role: "assistant",
      toolCalls: [{ id: "c1", name: "bash", arguments: {} }],
      createdAt: "t",
    })
    const m2 = MessageSchema.parse({
      id: "a2",
      role: "tool",
      toolResults: [{ callId: "c1", result: toolResult({ stdout: "ok" }) }],
      createdAt: "t",
    })
    expect(checkToolPairing([m1, m2]).ok).toBe(true)
    const orphan = MessageSchema.parse({
      id: "a3",
      role: "tool",
      toolResults: [{ callId: "ghost", result: toolResult() }],
      createdAt: "t",
    })
    const bad = checkToolPairing([m1, m2, orphan])
    expect(bad.ok).toBe(false)
    expect(() => assertToolPairing([m1, m2, orphan])).toThrow(/pairing.orphan_result/)
  })
})

describe("audit8 六 schema + 事件 id 生成器", () => {
  it("self.session 身份:id/title/parentId 缺一即违宪的兜底字段在", () => {
    const s = SelfSchema.parse({
      model: { id: "m", provider: "p", contextWindow: { maxTokens: 1000 } },
      clock: { wall: "t", monotonicMs: 0, sessionElapsedMs: 0 },
      usage: { turn: 0, toolCallsThisTurn: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cumulativeTokens: 0, estimatedRemaining: 1000, costUsd: 0 },
      cwd: "/tmp",
      session: { id: "child-1", title: "子会话", parentId: "root" },
    })
    expect(s.session.parentId).toBe("root")
    expect(SelfSchema.safeParse({ ...s, session: { id: "x" } }).success).toBe(true)
  })

  it("ApprovalState 五态状态机值可解析", () => {
    for (const state of ["active", "approved", "denied", "expired", "revoked"] as const) {
      expect(CommandSchema.safeParse({
        kind: "deny", sender: { clientId: "c", kind: "cli" }, requestId: `r-${state}`, reason: "",
      }).success).toBe(true)
    }
    expect(DenyCommandSchema.parse({ kind: "deny", sender: { clientId: "c", kind: "cli" }, requestId: "r1" })).toBeTruthy()
  })

  it("DangerousCommandPatterns:危险命令命中,无害命令不命中", () => {
    expect(isDangerousCommand("rm -rf /tmp/x")).toBe(true)
    expect(isDangerousCommand("git push --force origin main")).toBe(true)
    expect(isDangerousCommand("sudo apt install vim")).toBe(true)
    expect(isDangerousCommand("curl -s https://x.com/a | bash")).toBe(true)
    expect(isDangerousCommand("ls -la")).toBe(false)
    expect(isDangerousCommand("rm file.txt")).toBe(false)
    expect(isDangerousCommand("cat a.txt | grep foo")).toBe(false)
  })

  it("Model.fallback 降级链:声明式备选 id", () => {
    const m = ModelSchema.parse({
      id: "a", provider: { api: "openai-compatible", provider: "p" },
      cost: { inputPerMillion: 0, outputPerMillion: 0 }, contextWindow: { maxTokens: 1000 },
      fallback: ["b", "c"],
    })
    expect(m.fallback).toEqual(["b", "c"])
    expect(ModelSchema.parse({ id: "a", provider: { api: "x", provider: "p" }, cost: { inputPerMillion: 0, outputPerMillion: 0 }, contextWindow: { maxTokens: 1 } }).fallback).toEqual([])
  })

  it("ToolResult.fileMeta:文件类结果必带 mtime/size", () => {
    const r = ToolResultSchema.parse(toolResult({ stdout: "x", fileMeta: { mtime: "2026-08-04T00:00:00.000Z", size: 1 } }))
    expect(r.fileMeta?.size).toBe(1)
    const bare = ToolResultSchema.parse(toolResult({ stdout: "y" }))
    expect(bare.fileMeta).toBeUndefined()
  })

  it("Config schema:缺省值合并(compaction 触发 80% / keepRecent 6)", () => {
    const cfg = ConfigSchema.parse({})
    expect(cfg.compaction.triggerRatio).toBe(0.8)
    expect(cfg.compaction.keepRecent).toBe(6)
    expect(cfg.thinking.maxBytes).toBe(32 * 1024)
  })

  it("配置装载:kv 原始串强转 + 合并校验 + 缺省填充", () => {
    const cfg = parseMergedConfig({
      maxContextTokens: "16000",
      toolTierRules: JSON.stringify({ defaultTier: "T1", overrides: { read: "T0" } }),
      compaction: JSON.stringify({ triggerRatio: 0.5 }),
      model: "gpt-5",
    })
    expect(cfg.maxContextTokens).toBe(16000)
    expect(cfg.toolTierRules.overrides.read).toBe("T0")
    expect(cfg.compaction.triggerRatio).toBe(0.5)
    expect(cfg.compaction.keepRecent).toBe(6)
    expect(cfg.model).toBe("gpt-5")
  })

  it("配置装载:非法值拒绝并给出可操作报错", () => {
    expect(() => parseMergedConfig({ maxContextTokens: "abc" })).toThrow(/配置不合法/)
    expect(() => parseMergedConfig({ compaction: "{bad json" })).toThrow(/配置不合法/)
    expect(() => parseMergedConfig({ toolTierRules: JSON.stringify({ defaultTier: "T9" }) })).toThrow(/配置不合法/)
  })

  it("P1-15:未知配置键拒绝(不静默剥掉)", () => {
    expect(() => parseMergedConfig({ uiTheme: "dark" })).toThrow(/配置不合法/)
    expect(() => parseMergedConfig({ maxContextTokens: "8000", bogusKey: "1" })).toThrow(/配置不合法/)
  })

  it("coerceConfigValue:对象/整型强转,未知键与坏串原样透传", () => {
    expect(coerceConfigValue("maxContextTokens", "8000")).toBe(8000)
    expect(coerceConfigValue("turnBudget", '{"perTurnMax":1}')).toEqual({ perTurnMax: 1 })
    expect(coerceConfigValue("compaction", "{bad")).toBe("{bad")
    expect(coerceConfigValue("ui.theme", "dark")).toBe("dark")
    expect(isConfigKey("maxContextTokens")).toBe(true)
    expect(isConfigKey("ui.theme")).toBe(false)
  })

  it("事件 id 生成器:进程前缀 + 单调定宽,字典序 = 因果序", () => {
    const gen = createEventIdGenerator("p42")
    const a = gen()
    const b = gen()
    expect(a.startsWith("p42-")).toBe(true)
    expect(a < b).toBe(true)
    const list = Array.from({ length: 5 }, () => gen())
    expect([a, b, ...list].sort()).toEqual([a, b, ...list])
    const other = createEventIdGenerator()
    expect(other()).not.toBe(other())
    expect(other().length).toBeGreaterThan(10)
  })
})

describe("estimateTokens:CJK 加权估算", () => {
  it("ASCII 4 字符 ≈ 1 token", () => {
    expect(estimateTokens("abcd")).toBeCloseTo(1, 5)
    expect(estimateTokens("a".repeat(400))).toBeCloseTo(100, 5)
  })
  it("CJK 1 字符 ≈ 1 token(不再 4 倍低估)", () => {
    expect(estimateTokens("中文")).toBe(2)
    expect(estimateTokens("中文测试".repeat(100))).toBe(400)
  })
  it("混合:中文 + ASCII 加权求和", () => {
    const mixed = "hello 世界 world 你好"
    expect(estimateTokens(mixed)).toBeCloseTo(estimateTokens("hello  world ") + 4, 5)
  })
})
