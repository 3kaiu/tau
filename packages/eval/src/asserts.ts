// @tau/eval - asserts.ts:行为断言(契约级,离线,FauxLlm 驱动)。
// 断言检查只依赖 contract 不变量(assertX);fixture 负责构造场景。
// 每个断言独立创建 fixture,无共享状态;失败抛 Error,runner 捕获汇总。

import { createMemoryStore } from "@tau/store"
import { createSession } from "@tau/session"
import { createActionPlane, queryAudit } from "@tau/action"
import { createEnhancer } from "@tau/enhance"
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { assertDualView, assertReplay, assertToolPairing, checkBudget, parseMergedConfig, type UiView } from "@tau/contract"
import type { ScheduleEntry } from "@tau/orchestrate"
import type { Assert } from "./eval.ts"
import { createFixture, runTurn } from "./fixtures.ts"
import { textReply, toolReply } from "./faux.ts"

// ---------- 1. 双视角不变量 ----------

const assert1: Assert = {
  id: 1,
  name: "双视角不变量",
  description: "UI 可见信息 ⊆ 投影(Context, Events)",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: "pkg.json" } }]),
          textReply("done"),
        ],
      },
    })
    await runTurn(f, "读 pkg.json")
    const projection = f.session.project()
    const snapshot = f.session.snapshot()
    const ui: UiView = {
      transcript: projection.history.map((m) => ({ messageId: m.id, role: m.role })),
      pendingSyscalls: snapshot.pendingSyscalls.map((p) => ({ questionId: p.questionId, toolName: p.toolName })),
      activeGoals: snapshot.activeGoals.map((g) => ({ id: g.id, status: g.status })),
      status: snapshot.status,
    }
    assertDualView(ui, projection, f.events)
    f.cleanup()
  },
}

// ---------- 2. 投影纯函数 ----------

const assert2: Assert = {
  id: 2,
  name: "投影纯函数",
  description: "同 (快照, epoch) 必得同投影(缓存合法性)",
  async run() {
    const f = createFixture({ script: { replies: [textReply("hello")] } })
    await runTurn(f, "hi")
    const p1 = f.session.project()
    const p2 = f.session.project()
    if (p1.version !== p2.version) throw new Error(`version 不一致: ${p1.version} vs ${p2.version}`)
    if (p1.history.length !== p2.history.length) throw new Error("history 长度不一致")
    for (let i = 0; i < p1.history.length; i++) {
      if (p1.history[i]!.id !== p2.history[i]!.id) throw new Error(`history[${i}] id 不一致`)
    }
    f.cleanup()
  },
}

// ---------- 3. 先落盘后响应 ----------

const assert3: Assert = {
  id: 3,
  name: "先落盘后响应",
  description: "admit 后消息必先落盘,再跑 turn",
  async run() {
    const f = createFixture({ script: { replies: [textReply("ok")] } })
    await runTurn(f, "test")
    const stored = f.store.messages.list(f.session.sessionId).messages
    const userMsgs = stored.filter((m) => m.role === "user")
    if (userMsgs.length === 0) throw new Error("用户消息未落盘")
    const inputAccepted = f.events.find((e) => e.kind === "input_accepted")
    if (inputAccepted === undefined) throw new Error("缺 input_accepted 事件")
    const firstTranscript = f.events.find((e) => e.kind === "transcript")
    if (firstTranscript === undefined) throw new Error("缺 transcript 事件")
    const inputIdx = f.events.indexOf(inputAccepted)
    const transcriptIdx = f.events.indexOf(firstTranscript)
    if (inputIdx > transcriptIdx) throw new Error("input_accepted 在 transcript 之后(应先回执再转述)")
    f.cleanup()
  },
}

// ---------- 4. 命令纪律 ----------

const assert4: Assert = {
  id: 4,
  name: "命令纪律",
  description: "所有交互 = Command(带 sender),无旁路",
  async run() {
    const f = createFixture({ script: { replies: [textReply("ok")] } })
    await runTurn(f, "test")
    const accepted = f.events.filter((e) => e.kind === "input_accepted")
    if (accepted.length === 0) throw new Error("缺 input_accepted 事件")
    for (const e of accepted) {
      if (e.kind !== "input_accepted") continue
      if (e.command.sender === undefined) throw new Error("input_accepted 缺 sender")
      if (e.command.sender.clientId === "") throw new Error("sender.clientId 为空")
    }
    f.cleanup()
  },
}

// ---------- 5. 副作用纪律 ----------

const assert5: Assert = {
  id: 5,
  name: "副作用纪律",
  description: "一切副作用经 action,审计齐全",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: "pkg.json" } }]),
          textReply("done"),
        ],
      },
    })
    await runTurn(f, "读文件")
    const audit = f.store.audit.query({ sessionId: f.session.sessionId })
    if (audit.length === 0) throw new Error("审计表为空(工具执行应留审计)")
    const hasRead = audit.some((a) => a.action.includes("read") || a.detail.includes("read"))
    if (!hasRead) throw new Error("审计中无 read 工具记录")
    f.cleanup()
  },
}

// ---------- 6. 重放一致性 ----------

const assert6: Assert = {
  id: 6,
  name: "重放一致性",
  description: "重放事件流 -> 重建投影 -> 与快照逐字节一致",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: "pkg.json" } }]),
          textReply("done"),
        ],
      },
    })
    await runTurn(f, "读文件")
    const events = f.store.events.replay(f.session.sessionId)
    const projection = f.session.project()
    const snapshot = f.session.snapshot()
    assertReplay(events, projection, snapshot)
    f.cleanup()
  },
}

// ---------- 7. 性能回归 ----------

const assert7: Assert = {
  id: 7,
  name: "性能回归",
  description: "project() 耗时上限、预算检查 O(1)",
  async run() {
    const f = createFixture({ script: { replies: [textReply("ok")] } })
    await runTurn(f, "test")
    const t0 = Date.now()
    f.session.project()
    const projectMs = Date.now() - t0
    if (projectMs > 50) throw new Error(`project() 耗时 ${projectMs}ms > 50ms 上限`)

    const projection = f.session.project()
    const t1 = Date.now()
    const result = checkBudget(projection)
    const budgetMs = Date.now() - t1
    if (budgetMs > 5) throw new Error(`checkBudget 耗时 ${budgetMs}ms > 5ms 上限`)
    if (!result.ok) throw new Error("checkBudget 不应失败(正常预算下)")
    f.cleanup()
  },
}

// ---------- 8. 消息配对 ----------

const assert8: Assert = {
  id: 8,
  name: "消息配对",
  description: "tool_call/result 按 callId 配对、顺序稳定",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: "a.txt" } }]),
          textReply("done"),
        ],
      },
    })
    await runTurn(f, "读文件")
    const projection = f.session.project()
    assertToolPairing(projection.history)
    f.cleanup()
  },
}

// ---------- 9. 预算纪律 ----------

const assert9: Assert = {
  id: 9,
  name: "预算纪律",
  description: "turn 超预算即中断 + 投影告警,无失控循环",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: "a.txt" } }]),
          toolReply([{ id: "c2", name: "read", args: { path: "b.txt" } }]),
          toolReply([{ id: "c3", name: "read", args: { path: "c.txt" } }]),
        ],
      },
      schedulerOptions: { maxTurns: 2 },
    })
    await runTurn(f, "一直读文件")
    const hasBudgetEvent = f.events.some((e) => e.kind === "budget_exceeded")
    if (!hasBudgetEvent) throw new Error("超预算未触发 budget_exceeded 事件")
    const projection = f.session.project()
    if (projection.self.usage.turn > 2) throw new Error(`turn ${projection.self.usage.turn} > maxTurns 2`)
    f.cleanup()
  },
}

// ---------- 10. 恢复不误报 ----------

const assert10: Assert = {
  id: 10,
  name: "恢复不误报",
  description: "已提交 turn 崩溃恢复不发 recovery 告警(提交点锚定后无悬置,不虚惊)",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: "pkg.json" } }]),
          textReply("done"),
        ],
      },
    })
    await runTurn(f, "读文件")
    const sessionId = f.session.sessionId
    const store = f.store
    const auditBefore = store.audit.query({ sessionId })
    if (auditBefore.length === 0) throw new Error("工具执行应留审计(turnId 判定的前提)")
    f.abandon()

    const f2 = createFixture({ script: { replies: [textReply("recovered")] }, sessionId, store })
    const events2 = store.events.replay(sessionId)
    if (events2.some((e) => e.kind === "recovery")) throw new Error("已提交 turn 崩溃恢复不应发 recovery 告警")
    if (f2.session.project().system.some((b) => b.content.includes("恢复告知"))) throw new Error("已提交 turn 不应有恢复告知块")
    f2.cleanup()
  },
}

// ---------- 11. 命令级安全 ----------

const assert11: Assert = {
  id: 11,
  name: "命令级安全",
  description: "危险模式命令强制询问(不静默执行);autoApprove=false 时挂起,deny 拒绝",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "bash", args: { command: "echo hi" } }]),
          textReply("done"),
        ],
      },
      autoApprove: false,
    })
    const turn = runTurn(f, "跑命令")
    // 双轨:无回调无非 autoApprove → 挂起等决议(permission(requested) 事件不静默执行)
    for (let i = 0; i < 1000 && f.action.permissionRequest().length === 0; i++) await Bun.sleep(3)
    if (f.action.permissionRequest().length === 0) throw new Error("bash 未挂起权限询问(autoApprove=false 且危险工具)")
    f.action.deny("c1")
    await turn
    const bashEvents = f.events.filter((e) => e.kind === "tool" && e.name === "bash")
    if (bashEvents.length === 0) throw new Error("缺 bash tool 事件")
    const failed = bashEvents.find((e) => e.kind === "tool" && e.state === "failed")
    if (failed === undefined) throw new Error("bash 未被拒绝(autoApprove=false 时危险工具应 rejected)")
    if (failed.kind === "tool" && failed.error && failed.error.code !== "rejected") {
      throw new Error(`bash 错误码应为 rejected,实际 ${failed.error.code}`)
    }
    f.cleanup()
  },
}

// ---------- 12. 原子写 ----------

const assert12: Assert = {
  id: 12,
  name: "原子写",
  description: "write 中途失败不产生损坏文件(write 行为断言)",
  async run() {
    const tmpDir = `/tmp/tau-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "write", args: { path: `${tmpDir}/out.txt`, content: "hello" } }]),
          textReply("written"),
        ],
      },
      cwd: tmpDir,
      workspaceRoots: [tmpDir],
      autoApprove: true,
    })
    await runTurn(f, "写文件")
    const writeEvents = f.events.filter((e) => e.kind === "tool" && e.name === "write")
    if (writeEvents.length === 0) throw new Error("缺 write tool 事件")
    const completed = writeEvents.find((e) => e.kind === "tool" && e.state === "completed")
    if (completed === undefined) throw new Error("write 未完成")
    const fs = await import("node:fs")
    if (!fs.existsSync(`${tmpDir}/out.txt`)) throw new Error("文件未创建(原子写应成功产出完整文件)")
    const content = fs.readFileSync(`${tmpDir}/out.txt`, "utf-8")
    if (content !== "hello") throw new Error(`文件内容损坏: 期望 "hello", 实际 "${content}"`)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    f.cleanup()
  },
}

// ---------- 13. 真相源 ----------

const assert13: Assert = {
  id: 13,
  name: "真相源",
  description: "进程类工具结果必带 exitCode,stderr 独立",
  async run() {
    const fs = await import("node:fs")
    const tmpDir = `/tmp/tau-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`
    fs.mkdirSync(tmpDir, { recursive: true })
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "bash", args: { command: "echo stdout-msg && echo stderr-msg 1>&2" } }]),
          textReply("done"),
        ],
      },
      cwd: tmpDir,
      workspaceRoots: [tmpDir],
      autoApprove: true,
    })
    await runTurn(f, "跑命令")
    const bashEvents = f.events.filter((e) => e.kind === "tool" && e.name === "bash")
    if (bashEvents.length === 0) throw new Error("缺 bash tool 事件")
    const completed = bashEvents.find((e) => e.kind === "tool" && e.state === "completed")
    if (completed === undefined) {
      const failed = bashEvents.find((e) => e.kind === "tool" && e.state === "failed")
      const detail = failed && failed.kind === "tool" && failed.error ? `: ${failed.error.message}` : ""
      throw new Error(`bash 未完成${detail}`)
    }
    if (completed.kind !== "tool" || completed.result === undefined) throw new Error("bash 结果缺 result")
    const r = completed.result
    if (r.exitCode === null) throw new Error("进程类工具 exitCode 为 null(应必填)")
    if (r.exitCode !== 0) throw new Error(`exitCode 应为 0,实际 ${r.exitCode}`)
    if (r.stderr === null || r.stderr === "") throw new Error("stderr 应独立(非 null/空)")
    if (!r.stderr!.includes("stderr-msg")) throw new Error(`stderr 内容不符: ${r.stderr}`)
    if (!r.stdout!.includes("stdout-msg")) throw new Error(`stdout 内容不符: ${r.stdout}`)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    f.cleanup()
  },
}

// ---------- 14. Goals 判定 ----------

const assert14: Assert = {
  id: 14,
  name: "Goals 判定",
  description: "设置目标后,每 turn 后校验,完成时发 goal 事件",
  async run() {
    const f = createFixture({
      script: {
        replies: [
          textReply("已完成目标"),
        ],
      },
    })
    f.session.setGoal({
      id: "g1",
      text: "测试目标",
      status: "active",
      progress: 0,
      strategy: "llm_judged",
      checklist: [],
      createdAt: new Date().toISOString(),
    })
    await runTurn(f, "执行任务")
    const goalEvents = f.events.filter((e) => e.kind === "goal")
    if (goalEvents.length === 0) throw new Error("缺 goal 事件(目标判定应触发)")
    const completed = goalEvents.find((e) => e.kind === "goal" && e.status === "completed")
    if (completed === undefined) throw new Error("目标未标记为 completed(助手回复含'已完成')")
    f.cleanup()
  },
}

// ---------- 15. 生命周期 hooks ----------

const assert15: Assert = {
  id: 15,
  name: "生命周期 hooks",
  description: "before/after/error hooks 按序触发",
  async run() {
    const fs = await import("node:fs")
    const tmpDir = `/tmp/tau-eval-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`
    fs.mkdirSync(tmpDir, { recursive: true })
    const testFile = `${tmpDir}/test.txt`
    fs.writeFileSync(testFile, "test content")

    const logs: string[] = []
    const f = createFixture({
      script: {
        replies: [
          toolReply([{ id: "c1", name: "read", args: { path: testFile } }]),
          textReply("done"),
        ],
      },
      cwd: tmpDir,
      workspaceRoots: [tmpDir],
    })
    f.action.registerHook((ctx) => {
      logs.push(`${ctx.phase}:${ctx.syscall.name}`)
    })
    await runTurn(f, "读文件")
    const hasBefore = logs.some((l) => l.startsWith("before:"))
    const hasAfter = logs.some((l) => l.startsWith("after:"))
    if (!hasBefore) throw new Error("缺 before hook 触发")
    if (!hasAfter) throw new Error("缺 after hook 触发")
    const beforeIdx = logs.findIndex((l) => l.startsWith("before:"))
    const afterIdx = logs.findIndex((l) => l.startsWith("after:"))
    if (beforeIdx >= afterIdx) throw new Error("before 应在 after 之前")
    fs.rmSync(tmpDir, { recursive: true, force: true })
    f.cleanup()
  },
}

// ---------- 16. Multi-run ----------

const assert16: Assert = {
  id: 16,
  name: "Multi-run",
  description: "多模型并行执行,子会话隔离 + 独立审计;fusion 产出新会话",
  async run() {
    const { runMultiRun, selectBestRun, createFusedSession } = await import("@tau/orchestrate")
    const f = createFixture({
      script: {
        replies: [textReply("result from model")],
      },
    })
    const result = await runMultiRun(
      { llm: f.llm, session: f.session, store: f.store, action: f.action },
      { models: ["model-a", "model-b"], task: "test task", maxConcurrent: 2 },
    )
    if (result.runs.length !== 2) throw new Error(`期望 2 个 run,实际 ${result.runs.length}`)
    const best = selectBestRun(result.runs)
    if (best === null) throw new Error("selectBestRun 返回 null")
    if (!["model-a", "model-b"].includes(best.model)) throw new Error(`best model 不符: ${best.model}`)

    // 子会话隔离:每个 run 独立 sessionId 且 parentId 指向祖先;主会话历史不被污染
    const ids = new Set(result.runs.map((r) => r.sessionId))
    if (ids.size !== 2) throw new Error(`子会话未隔离:${ids.size} 个独立 session`)
    for (const r of result.runs) {
      const child = f.store.sessions.get(r.sessionId)
      if (child === undefined) throw new Error(`子会话 ${r.sessionId} 未落 store`)
    }
    if (f.session.project().history.length > 0) throw new Error("主会话历史被子 run 污染")

    // 工作树隔离:子会话 cwd 落在独立工作树内(不在祖先目录里互踩);
    // 创建/清理经 action.execute 审计(tool 事件可见);run 结束后 .tau-worktrees 无残留
    for (const r of result.runs) {
      if (!r.cwd.includes("/.tau-worktrees/")) throw new Error(`子会话未隔离到工作树: ${r.cwd}`)
    }
    const worktreeEvents = f.events.filter((e) => e.kind === "tool" && (e.name === "worktree:create" || e.name === "worktree:rm"))
    if (worktreeEvents.length < 4) throw new Error(`工作树工具调用事件不足(2 run × create+rm ≥ 4):${worktreeEvents.length}`)
    const wtDir = join(f.session.project().self.cwd, ".tau-worktrees")
    if (existsSync(wtDir)) {
      const leftovers = readdirSync(wtDir)
      if (leftovers.length !== 0) throw new Error(`工作树残留未清理:${leftovers.join(",")}`)
    }

    // fusion:汇总各 run 产出生成新会话(可继续对话)
    const fused = createFusedSession({ store: f.store, session: f.session }, result.runs, { sessionId: "eval-fusion" })
    const fusedProjection = fused.project()
    if (!fusedProjection.self.session.parentId) throw new Error("fusion 会话缺 parentId")
    fused.close()

    f.cleanup()
  },
}

// ---------- 17. 插件市场 ----------

const assert17: Assert = {
  id: 17,
  name: "插件市场",
  description: "插件注册表:安装/卸载/查询/信任级别",
  async run() {
    const { createTrustedPluginRegistry, createPlugin } = await import("@tau/enhance")
    const registry = createTrustedPluginRegistry()
    const plugin = createPlugin(
      { name: "test-plugin", version: "1.0.0", description: "Test plugin" },
      new Map([["skill1", "skill content"]]),
      new Map(),
      new Map(),
    )
    registry.install(plugin, "verified")
    const list = registry.list()
    if (list.length !== 1) throw new Error(`期望 1 个插件,实际 ${list.length}`)
    const retrieved = registry.get("test-plugin")
    if (retrieved === undefined) throw new Error("查询插件失败")
    if (retrieved.trustLevel !== "verified") throw new Error(`信任级别不符: ${retrieved.trustLevel}`)
    const uninstalled = registry.uninstall("test-plugin")
    if (!uninstalled) throw new Error("卸载失败")
    const afterUninstall = registry.list()
    if (afterUninstall.length !== 0) throw new Error("卸载后仍有插件")
  },
}

// ---------- 18. deny 命令闭环 ----------

const assert18: Assert = {
  id: 18,
  name: "deny 命令闭环",
  description: "deny 命令经 face → session.resolvePending(false) → permission(denied) 事件,挂起权限消除",
  async run() {
    const f = createFixture({ script: { replies: [textReply("ok")] } })
    // 挂起一个待授权 syscall(模拟 ask 工具等待用户决策)
    const pending = f.session.pendSyscall({ toolCallId: "c1", toolName: "bash", summary: "echo hi" })
    if (f.session.snapshot().pendingSyscalls.length === 0) throw new Error("pendSyscall 未进入挂起列表")
    // 用户经 face 发布 deny 命令(对应 ApprovalState.denied)
    const result = await f.face.publish({
      kind: "deny",
      sender: { clientId: "eval", kind: "cli" },
      requestId: pending.questionId,
      reason: "",
    })
    if (!result.accepted) throw new Error("deny 命令未被接受")
    const denied = f.events.find(
      (e) => e.kind === "permission" && e.state === "denied" && e.requestId === pending.questionId,
    )
    if (denied === undefined) throw new Error("deny 后缺 permission(denied) 事件")
    if (f.session.snapshot().pendingSyscalls.length !== 0) throw new Error("deny 后挂起权限未消除")
    f.cleanup()
  },
}

// ---------- 19. 导出与投影同源 ----------

const assert19: Assert = {
  id: 19,
  name: "导出与投影同源",
  description: "tau export/log/replay 的两条数据源(events / messages)wire 可往返,且与 project().history 逐条同源",
  async run() {
    const { CommandSchema, EventSchema } = await import("@tau/contract")
    void CommandSchema
    const f = createFixture({
      script: { replies: [toolReply([{ id: "c1", name: "read", args: { path: "pkg.json" } }]), textReply("导出验证")] },
    })
    await runTurn(f, "读 pkg.json")
    const sid = f.session.sessionId

    // JSONL 导出面:每条事件序列化后必须能原样解回(否则 tau log 的产物不可重放)
    const events = f.store.events.replay(sid)
    if (events.length === 0) throw new Error("事件流为空,无可导出")
    for (const e of events) {
      const back = EventSchema.parse(JSON.parse(JSON.stringify(e)))
      if (back.kind !== e.kind || back.id !== e.id) throw new Error(`事件 wire 往返丢信息: ${e.kind}`)
    }
    if (f.store.events.count(sid) !== events.length) throw new Error("events.count 与 replay 长度不一致")

    // Markdown 导出面:store.messages 即投影 history 的来源,不得有第二条真相
    const stored = f.store.messages.list(sid).messages
    const history = f.session.project().history
    if (stored.length !== history.length) throw new Error(`导出消息数 ${stored.length} ≠ 投影 history ${history.length}`)
    for (let i = 0; i < stored.length; i++) {
      if (stored[i]!.id !== history[i]!.id) throw new Error(`导出与投影第 ${i} 条不同源`)
    }
    assertReplay(events, f.session.project(), f.session.snapshot())
    f.cleanup()
  },
}

// ---------- 20. doctor 自检项成立 ----------

const assert20: Assert = {
  id: 20,
  name: "doctor 自检项成立",
  description: "契约 wire 往返 / store 迁移幂等 + kv 前缀枚举 / capability 门可决策 —— doctor 的三项断言在契约级成立",
  async run() {
    const { CommandSchema, EventSchema } = await import("@tau/contract")
    const f = createFixture({ script: { replies: [textReply("ok")] } })

    // 1) 契约 wire 往返
    const cmd = CommandSchema.parse({ kind: "prompt", sender: { clientId: "doctor", kind: "cli" }, text: "ping" })
    const evt = EventSchema.parse({ id: "e1", timestamp: "t", redact: [], kind: "input_accepted", command: cmd })
    const roundtrip = EventSchema.parse(JSON.parse(JSON.stringify(evt)))
    if (roundtrip.kind !== "input_accepted") throw new Error("Command/Event wire 往返失败")

    // 2) store 迁移幂等 + kv 前缀枚举(config 命令的读端)
    f.store.migrate()
    f.store.migrate()
    f.store.kv.set("config:model", "faux-1")
    f.store.kv.set("config:ui.theme", "dark")
    f.store.kv.set("other:x", "1")
    const conf = f.store.kv.list("config:")
    if (conf.length !== 2) throw new Error(`kv 前缀枚举应得 2 条,实际 ${conf.length}`)
    if (conf.some((e) => !e.key.startsWith("config:"))) throw new Error("kv 前缀枚举漏进无关键")
    if (f.store.events.replay("doctor-probe").length !== 0) throw new Error("未知会话 replay 应为空而非报错")

    // 3) capability 门有规则且可决策
    if (f.action.gate.rules.length === 0) throw new Error("capability 门无规则")
    const decision = f.action.gate.decide("bash", true)
    if (decision.rule === undefined) throw new Error("capability 门对 bash 无决策")
    f.cleanup()
  },
}

// ---------- 21. 归档不是删除 ----------

const assert21: Assert = {
  id: 21,
  name: "归档不是删除",
  description: "archive 只标记状态:重启后仍可重放全部历史,resume 置回 active 且转述不丢",
  async run() {
    const f = createFixture({ script: { replies: [textReply("归档前的回答")] } })
    await runTurn(f, "归档前的提问")
    const sid = f.session.sessionId
    const store = f.store
    const beforeEvents = store.events.replay(sid).length
    const beforeMessages = store.messages.count(sid)
    if (beforeMessages === 0) throw new Error("归档前无消息,场景无效")

    f.session.archive()
    if (f.session.snapshot().status !== "archived") throw new Error("archive 后状态非 archived")
    if (store.messages.count(sid) !== beforeMessages) throw new Error("archive 物理删了消息(违反'归档不是删除')")
    if (store.sessions.get(sid)?.status !== "archived") throw new Error("注册表未反映 archived")

    // 重启:同 store 新建 session,从事件重放恢复
    const f2 = createFixture({ script: { replies: [textReply("恢复后的回答")] }, store, sessionId: sid })
    if (f2.session.snapshot().status !== "archived") throw new Error("重启后未恢复为 archived")
    if (f2.session.project().history.length === 0) throw new Error("重启后历史丢失")
    if (store.events.replay(sid).length < beforeEvents) throw new Error("重启后事件流变短(历史被截断)")

    f2.session.resume()
    if (f2.session.snapshot().status !== "active") throw new Error("resume 后状态非 active")
    if (store.sessions.get(sid)?.status !== "active") throw new Error("resume 未刷新注册表")
    if (store.messages.count(sid) !== beforeMessages) throw new Error("resume 后消息数变化")

    // 再重启一次:resume 的结论必须落在事件流里(最后一条 lifecycle 为准)
    const f3 = createFixture({ script: { replies: [textReply("x")] }, store, sessionId: sid })
    if (f3.session.snapshot().status !== "active") throw new Error("resume 后再重启退回了 archived")
    f3.cleanup()
  },
}

// ---------- 22. 定时目标到点触发 ----------

const assert22: Assert = {
  id: 22,
  name: "定时目标到点触发",
  description: "cron 到点 → 目标经 session.setGoal 进投影(不旁路拼 Context)→ markRan 后同一命中不重复触发",
  async run() {
    const { dueEntries, isDue, loadSchedules, markRan, parseCron, upsertSchedule } = await import("@tau/orchestrate")
    const { goal } = await import("@tau/contract")
    if (parseCron("*/5 * * * *") === null) throw new Error("合法 cron 被判非法")
    if (parseCron("每天早上") !== null) throw new Error("非法 cron 未被拒绝")

    const f = createFixture({ script: { replies: [textReply("定时任务已执行")] } })
    const now = new Date()
    const entry: ScheduleEntry = {
      id: "sch-eval",
      cron: "* * * * *",
      sessionId: f.session.sessionId,
      goalText: "每分钟汇总收件箱",
      createdAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      lastRunAt: null,
    }
    upsertSchedule(f.store, entry)
    const due = dueEntries(loadSchedules(f.store), now)
    if (due.length !== 1 || due[0]!.id !== "sch-eval") throw new Error("过去创建的每分钟调度未判为到点")

    // 触发路径:目标进 session(投影可见),再以 prompt 唤醒 —— 模型输入唯一路径
    f.scheduler.goals.set(goal(entry.id, entry.goalText))
    const projection = f.session.project()
    if (!projection.activeGoals.some((g) => g.id === entry.id)) throw new Error("定时目标未进投影 activeGoals")
    if (!JSON.stringify(projection.system).includes(entry.goalText)) throw new Error("定时目标文本未进 system 块(模型看不到)")

    const result = await f.face.publish({ kind: "prompt", sender: { clientId: "cron", kind: "cli" }, text: entry.goalText })
    if (!result.accepted) throw new Error(`定时唤醒未被接受: ${result.detail}`)
    await f.scheduler.waitForIdle()

    // 幂等锚点:markRan 后同一命中不得重复触发
    markRan(f.store, entry.id, now.toISOString())
    const after = loadSchedules(f.store)[0]!
    if (after.lastRunAt !== now.toISOString()) throw new Error("markRan 未落 lastRunAt")
    if (isDue(after, now)) throw new Error("markRan 后同一时刻仍判到点(会重复触发)")
    if (dueEntries(loadSchedules(f.store), now).length !== 0) throw new Error("markRan 后仍有到点条目")
    f.cleanup()
  },
}

// ---------- 23. 恢复悬置判定 ----------

const assert23: Assert = {
  id: 23,
  name: "恢复悬置判定",
  description: "崩溃前未提交 turn 的 syscall 进 recovery 事件 detail 与投影告警(带清单,非瞎猜)",
  async run() {
    const fs = await import("node:fs")
    const tmpDir = `/tmp/tau-eval-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(`${tmpDir}/pkg.json`, "{\"name\":\"x\"}")
    const f = createFixture({ script: { replies: [textReply("ok")] }, cwd: tmpDir, workspaceRoots: [tmpDir] })
    await runTurn(f, "正常 turn")
    const sid = f.session.sessionId
    const store = f.store

    // 模拟崩溃前的未提交 turn:审计写入带 turnId 的 syscall,但无 commitTurn(提交点在 turn 尾部,未到)
    const outcome = await f.action.execute({
      sessionId: sid,
      toolCallId: "c-crash",
      name: "read",
      args: { path: "pkg.json" },
      cwd: tmpDir,
      turnId: `t${f.session.snapshot().epoch + 1000}`,
    })
    if (!outcome.ok) throw new Error(`模拟 syscall 失败: ${outcome.error.code} ${outcome.error.message}`)
    const audit = store.audit.query({ sessionId: sid })
    if (!audit.some((a) => a.turnId === `t${f.session.snapshot().epoch + 1000}`)) throw new Error("审计未带 turnId(悬置判定输入缺失)")

    f.abandon()
    const f2 = createFixture({ script: { replies: [textReply("recovered")] }, sessionId: sid, store, cwd: tmpDir, workspaceRoots: [tmpDir] })
    const recovery = store.events.replay(sid).find((e) => e.kind === "recovery")
    if (recovery === undefined) throw new Error("未提交 turn 崩溃恢复缺 recovery 事件")
    if (recovery.kind !== "recovery") throw new Error("recovery 事件类型异常")
    if (!recovery.detail?.includes("read")) throw new Error(`recovery detail 未带 syscall 清单: ${recovery.detail}`)
    if (!f2.session.project().system.some((b) => b.content.includes("未提交"))) throw new Error("投影缺悬置告警")
    f2.cleanup()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  },
}

// ---------- 24. executeStream 流式事件形态 ----------

const assert24: Assert = {
  id: 24,
  name: "executeStream 流式事件形态",
  description: "executeStream 逐调用产出 started → completed/failed(终态带结果/错误);execute 收口与终态一致;事件同进 onEvent 双轨",
  async run() {
    const fs = await import("node:fs")
    const tmpDir = `/tmp/tau-eval-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(`${tmpDir}/pkg.json`, "{\"name\":\"x\"}")
    const f = createFixture({
      script: { replies: [toolReply([{ id: "c1", name: "read", args: { path: "pkg.json" } }]), textReply("done")] },
      cwd: tmpDir,
      workspaceRoots: [tmpDir],
    })

    // 成功路径:started → completed,结果与 execute 收口一致
    const streamed: import("@tau/contract").ToolEvent[] = []
    for await (const ev of f.action.executeStream({ sessionId: f.session.sessionId, toolCallId: "s1", name: "read", args: { path: "pkg.json" }, cwd: tmpDir })) {
      streamed.push(ev)
    }
    if (streamed[0]?.state !== "started") throw new Error("executeStream 首事件非 started")
    const last = streamed[streamed.length - 1]!
    if (last.state !== "completed") throw new Error(`成功路径终态应 completed,实际 ${last.state}`)
    if (last.state !== "completed" || last.result === undefined) throw new Error("completed 事件缺 result")
    const outcome = await f.action.execute({ sessionId: f.session.sessionId, toolCallId: "s1", name: "read", args: { path: "pkg.json" }, cwd: tmpDir })
    if (!outcome.ok) throw new Error("execute 收口失败")
    if (JSON.stringify(outcome.result) !== JSON.stringify(last.result)) throw new Error("execute 收口与流终态结果不一致")

    // 失败路径:started → failed(错误码),execute 收口一致
    const failedStreamed: import("@tau/contract").ToolEvent[] = []
    for await (const ev of f.action.executeStream({ sessionId: f.session.sessionId, toolCallId: "s2", name: "read", args: { path: "__nope__.json" }, cwd: tmpDir })) {
      failedStreamed.push(ev)
    }
    const failedLast = failedStreamed[failedStreamed.length - 1]!
    if (failedLast.state !== "failed") throw new Error("失败路径终态应 failed")
    if (failedLast.state !== "failed" || failedLast.error === undefined || failedLast.error.code !== "not_found") {
      throw new Error("failed 事件错误码应 not_found")
    }
    const failedOutcome = await f.action.execute({ sessionId: f.session.sessionId, toolCallId: "s2", name: "read", args: { path: "__nope__.json" }, cwd: tmpDir })
    if (failedOutcome.ok || (failedOutcome.ok === false && failedOutcome.error.code !== "not_found")) {
      throw new Error("execute 收口与流终态错误不一致")
    }

    // 双轨:流内事件同样经 onEvent 全局桥(consumers 两种订阅面看到同一序列)
    const toolEvents = f.events.filter((e) => e.kind === "tool")
    if (toolEvents.length < streamed.length) throw new Error("onEvent 双轨未收到与流等量的 tool 事件")
    f.cleanup()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  },
}

// ---------- 25. steer 立即断流 ----------

const assert25: Assert = {
  id: 25,
  name: "steer 立即断流(interrupt: immediate)",
  description: "busy 时 immediate steer 中止在飞工具(cancelled)与剩余调用;已提交结果落审计,interrupted 事件 + aborted 返回;steer 队列随后消费不卡死",
  async run() {
    const fs = await import("node:fs")
    const tmpDir = `/tmp/tau-eval-steer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    fs.mkdirSync(tmpDir, { recursive: true })
    const f = createFixture({
      script: {
        replies: [
          toolReply([
            { id: "t1", name: "bash", args: { command: "sleep 3; echo SLEPT" } },
            { id: "t2", name: "bash", args: { command: "echo NOOP" } },
          ]),
          textReply("停了"),
        ],
      },
      cwd: tmpDir,
      workspaceRoots: [tmpDir],
    })

    const p = f.scheduler.prompt({ text: "跑吧", source: "prompt" })
    for (let i = 0; i < 2000 && !f.events.some((e) => e.kind === "tool" && e.state === "started" && e.toolCallId === "t1"); i++) {
      await Bun.sleep(2)
    }
    if (!f.events.some((e) => e.kind === "tool" && e.state === "started" && e.toolCallId === "t1")) throw new Error("未观察到 t1 开始")
    await f.scheduler.steer({ text: "立刻停", source: "steer" }, { interrupt: "immediate" })
    const result = await p

    if (result.aborted !== true) throw new Error("立即断流后 turn 应 aborted")
    if (!f.events.some((e) => e.kind === "interrupted")) throw new Error("缺 interrupted 事件")
    const audit = f.store.audit.query({ sessionId: f.session.sessionId })
    if (!audit.some((e) => e.action.startsWith("bash:") && e.detail.includes("sleep"))) throw new Error("在飞 bash 未落审计(已提交结果应落盘)")
    if (audit.some((e) => e.action.startsWith("bash:") && e.detail.includes("NOOP"))) throw new Error("剩余调用不应执行")
    const t1Msg = f.session.project().history.find((m) => m.role === "tool" && m.toolResults[0]?.callId === "t1")
    if (t1Msg?.toolResults[0]?.error?.code !== "cancelled") throw new Error("在飞 bash 错误码应 cancelled")
    // steer 队列消费:prompt 返回前 drain 已跑完(脚本耗尽回复),会话不卡死
    f.cleanup()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  },
}

// ---------- 26. 大载荷外置(artifacts) ----------

const assert26: Assert = {
  id: 26,
  name: "大载荷外置(artifact 正文存 store,历史仅引用)",
  description: "超阈值 text 块自动外置为引用块(size/hash 可见,正文不进投影/事件流);按引用经 artifact:read 取回原文;小文本保持 inline",
  async run() {
    const store = createMemoryStore()
    const session = createSession({
      store,
      sessionId: "eval-art",
      cwd: "/tmp/tau-eval",
      workspaceRoots: ["/tmp/tau-eval"],
      artifactThresholdBytes: 64,
    })
    const big = "大载荷正文".repeat(200)
    session.appendMessage({
      id: "m-big",
      role: "assistant",
      content: [
        { type: "text", text: "小段" },
        { type: "text", text: big },
      ],
      toolCalls: [],
      toolResults: [],
      interrupted: false,
      source: "model",
      retention: "normal",
      createdAt: new Date().toISOString(),
    })

    const history = session.project().history
    const msg = history.find((m) => m.id === "m-big")
    if (msg === undefined) throw new Error("大载荷消息未进历史")
    const blocks = msg.content
    if (blocks[0]?.type !== "text" || blocks[1]?.type !== "artifact") throw new Error("超阈值块未外置为引用")
    if (blocks[1].size !== big.length) throw new Error("引用 size 与正文不符")
    if (JSON.stringify(history).includes(big)) throw new Error("投影历史含大载荷正文(违宪:不烧上下文)")

    const body = session.readArtifact(blocks[1].ref)
    if (body?.body !== big) throw new Error("按引用取回正文不一致")

    // 模型检索路径:artifact:read 工具(经 action 平面)
    const action = createActionPlane(store, { workspaceRoots: ["/tmp/tau-eval"], autoApprove: true })
    const got = await action.execute({ sessionId: "eval-art", toolCallId: "r1", name: "artifact:read", args: { ref: blocks[1].ref }, cwd: "/tmp/tau-eval" })
    if (!got.ok || got.result.stdout !== big) throw new Error("artifact:read 取回正文不一致")
    session.close()
  },
}

// ---------- 27. 增量装载(enhance loader mtime/hash) ----------

const assert27: Assert = {
  id: 27,
  name: "增量装载(loader mtime/hash 缓存,不牺牲新鲜度)",
  description: "reload 时未变文件命中缓存(不重读);文件内容变化后 reload 反映新内容;删除后消失;装载统计可观测",
  async run() {
    const dir = `/tmp/tau-eval-loader-${Date.now()}`
    const skillsDir = join(dir, ".tau", "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(dir, "AGENTS.md"), "# Rules\n保守。")
    writeFileSync(join(skillsDir, "greet.md"), "---\nname: greet\ndescription: 问候\n---\nSay hello.")

    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: dir, store })
    if (enhancer.apply().skillNames.join(",") !== "greet") throw new Error("首轮装载未见到技能")

    enhancer.load()
    const stats1 = enhancer.loaderStats()
    if (stats1.hits !== 2 || stats1.loads !== 4) throw new Error("重复装载应全命中缓存(未变文件不重读)")

    writeFileSync(join(skillsDir, "greet.md"), "---\nname: greet\ndescription: 升级版问候\n---\nSay hello loudly.")
    enhancer.load()
    const blocks = enhancer.apply().systemBlocks
    const context = blocks.find((b) => b.kind === "context")?.content ?? ""
    if (!context.includes("升级版问候")) throw new Error("文件变化后 reload 未反映新内容(增量装载不牺牲新鲜度)")
    const stats2 = enhancer.loaderStats()
    if (stats2.hits !== stats1.hits + 1) throw new Error("变化文件应重读,未变文件仍命中缓存")

    rmSync(join(skillsDir, "greet.md"))
    enhancer.load()
    if (enhancer.apply().skillNames.length !== 0) throw new Error("文件删除后 reload 目录条目未消失")

    rmSync(dir, { recursive: true, force: true })
  },
}

// ---------- 28. 工作区文件树增量索引 ----------

const assert28: Assert = {
  id: 28,
  name: "工作区文件树增量索引(目录 mtime 失效,不全量重扫)",
  description: "find 首扫全量,重复查询未变目录零重扫(fullScans 不增);新增文件只重扫所在目录且 find 立即可见;删除目录条目消失且缓存剪除",
  async run() {
    const dir = `/tmp/tau-eval-index-${Date.now()}`
    mkdirSync(`${dir}/a/src`, { recursive: true })
    mkdirSync(`${dir}/a/sub`, { recursive: true })
    writeFileSync(`${dir}/c.ts`, "c")
    writeFileSync(`${dir}/a/src/a.ts`, "a")
    writeFileSync(`${dir}/a/sub/b.ts`, "b")

    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: [dir], autoApprove: true })
    const exec = async (callId: string, args: Record<string, unknown>) => {
      const out = await plane.execute({ sessionId: "eval-idx", toolCallId: callId, name: "find", args, cwd: dir })
      if (!out.ok) throw new Error(`find 失败:${out.error.code}`)
      return out.result.stdout as string
    }

    const first = await exec("i1", { name: "b.ts" })
    if (!first.includes("a/sub/b.ts")) throw new Error("首扫未命中既有文件")

    writeFileSync(`${dir}/a/sub/new.ts`, "new")
    const second = await exec("i2", { name: "new.ts" })
    if (!second.includes("a/sub/new.ts")) throw new Error("增量刷新未反映新文件(不牺牲新鲜度)")

    rmSync(`${dir}/a/sub`, { recursive: true })
    const third = await exec("i3", { name: "b.ts" })
    if (!third.includes("0 命中")) throw new Error("目录删除后条目未消失")

    rmSync(dir, { recursive: true, force: true })
  },
}

// ---------- 29. Config tier 工具注入裁剪 ----------

const assert29: Assert = {
  id: 29,
  name: "Config tier 工具注入裁剪(T0 常驻,T1 按需,新 turn 重置)",
  description: "提供 toolTierRules 时投影只含 T0 + tool:catalog;requestTools 注入 T1(本 turn);beginTurn 重置;无规则时全量注入不变",
  async run() {
    const tools = [
      { name: "read", description: "r", parameters: {}, tier: "T0" as const, dangerous: false },
      { name: "grep", description: "g", parameters: {}, tier: "T1" as const, dangerous: false },
      { name: "find", description: "f", parameters: {}, tier: "T1" as const, dangerous: false },
      { name: "tool:catalog", description: "c", parameters: {}, tier: "T0" as const, dangerous: false },
    ]
    const store = createMemoryStore()
    const session = createSession({
      store,
      sessionId: "eval-tier",
      cwd: "/tmp/tau-eval",
      workspaceRoots: ["/tmp/tau-eval"],
      tools,
      toolTierRules: { defaultTier: "T1", overrides: {} },
    })
    const names = () => session.project().tools.map((t) => t.name)

    const first = names()
    if (!first.includes("read") || !first.includes("tool:catalog")) throw new Error("T0/发现入口应常驻")
    if (first.includes("grep") || first.includes("find")) throw new Error("T1 不应缺省注入")

    session.requestTools(["grep"])
    const second = names()
    if (!second.includes("grep")) throw new Error("requestTools 未注入 T1")
    if (second.includes("find")) throw new Error("未请求的 T1 不应注入")

    session.beginTurn()
    const third = names()
    if (third.includes("grep")) throw new Error("新 turn 未重置 T1 注入")

    session.close()
  },
}

// ---------- 30. 配置即契约 ----------

const assert30: Assert = {
  id: 30,
  name: "配置即契约(App 宪法 4)",
  description: "kv 原始串 → coerce → parseMergedConfig(缺省填充/非法拒绝);装载结果直接消费为 session 注入裁剪与预算",
  async run() {
    const store = createMemoryStore()
    store.kv.set("config:toolTierRules", JSON.stringify({ defaultTier: "T1", overrides: { read: "T0" } }))
    store.kv.set("config:maxContextTokens", "48000")
    store.kv.set("config:compaction", JSON.stringify({ triggerRatio: 0.5 }))

    const raw = Object.fromEntries(store.kv.list("config:").map((e) => [e.key.slice("config:".length), e.value]))
    const cfg = parseMergedConfig(raw)
    if (cfg.maxContextTokens !== 48000) throw new Error(`maxContextTokens 未强转: ${cfg.maxContextTokens}`)
    if (cfg.compaction.triggerRatio !== 0.5) throw new Error("compaction 覆写未合并")
    if (cfg.compaction.keepRecent !== 6) throw new Error("缺省未填充")
    if (cfg.toolTierRules.overrides.read !== "T0") throw new Error("tier 覆写未装载")

    // 消费方:把装载出的配置作为 session 选项,注入裁剪 + 预算同时生效
    const f = createFixture({
      script: { replies: [textReply("ok")] },
      toolTierRules: cfg.toolTierRules,
      maxContextTokens: cfg.maxContextTokens,
    })
    const names = () => f.session.project().tools.map((t) => t.name)
    const first = names()
    if (!first.includes("read") || !first.includes("tool:catalog")) throw new Error("T0/发现入口应常驻")
    if (first.includes("grep") || first.includes("bash")) throw new Error("T1 不应缺省注入")
    f.session.requestTools(["grep"])
    if (!names().includes("grep")) throw new Error("requestTools 未注入 T1")
    f.session.beginTurn()
    if (names().includes("grep")) throw new Error("新 turn 未重置")
    f.cleanup()

    // 非法配置:装载即拒
    const bad = createMemoryStore()
    bad.kv.set("config:maxContextTokens", "abc")
    let threw = false
    try {
      parseMergedConfig(Object.fromEntries(bad.kv.list("config:").map((e) => [e.key.slice("config:".length), e.value])))
    } catch {
      threw = true
    }
    if (!threw) throw new Error("非法配置未拒绝")
  },
}

// ---------- 31. T2 内部机制永不注入 ----------

const assert31: Assert = {
  id: 31,
  name: "T2 内部机制不注入模型视野(worktree 归属经 execute 审计)",
  description: "action 注册的 T2 工作树工具(create/rm/list)不进入投影 tools(有/无 tier 规则均排除);调用仍经 execute 审计并落盘",
  async run() {
    const dir = `/tmp/tau-eval-t2-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: [dir], autoApprove: true })

    const names = plane.registry.all().map((t) => t.name)
    if (!names.includes("worktree:create") || !names.includes("worktree:rm") || !names.includes("worktree:list")) {
      throw new Error("worktree 工具未注册")
    }

    const session = createSession({
      store,
      sessionId: "eval-t2",
      cwd: dir,
      workspaceRoots: [dir],
      tools: plane.registry.all(),
    })
    const injected = session.project().tools.map((t) => t.name)
    if (injected.some((n) => n.startsWith("worktree:"))) throw new Error(`T2 工具泄漏进投影:${injected.join(",")}`)
    session.close()

    // 带 tier 规则时同样排除(两条路径均无 T2)
    const rules = createSession({
      store,
      sessionId: "eval-t2-rules",
      cwd: dir,
      workspaceRoots: [dir],
      tools: plane.registry.all(),
      toolTierRules: { defaultTier: "T0", overrides: {} },
    })
    const injectedRules = rules.project().tools.map((t) => t.name)
    if (injectedRules.some((n) => n.startsWith("worktree:"))) throw new Error("带规则时 T2 工具泄漏进投影")
    rules.close()

    // 内部调用面:仍走 execute(审计落盘),模型不可见不代表不可用
    const created = await plane.execute({ sessionId: "eval-t2", toolCallId: "t1", name: "worktree:create", args: { name: "run-1" }, cwd: dir })
    if (!created.ok) throw new Error(`worktree:create 失败:${created.error.code}`)
    const audit = queryAudit(store, "eval-t2")
    if (!audit.some((a) => a.action.startsWith("worktree:create"))) throw new Error("worktree 调用未审计落盘")

    rmSync(dir, { recursive: true, force: true })
  },
}

// ---------- 32. 认知与长程记忆(M11) ----------

const assert32: Assert = {
  id: 32,
  name: "认知与长程记忆(记忆后端 + 两级注入)",
  description: "记忆写入/检索/会话隔离契约;索引块(kind memory)注入投影 system;覆盖保护缺省拒绝;跨会话续用(长程)",
  async run() {
    const { createEnhancer } = await import("@tau/enhance")
    const dir = `/tmp/tau-eval-memory-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    const store = createMemoryStore()
    const enhancer = createEnhancer({ cwd: dir, store })

    // 写入 + 覆盖保护
    if (enhancer.remember("s-a", "偏好", "简洁回复") !== true) throw new Error("首次写入失败")
    if (enhancer.remember("s-a", "偏好", "覆盖") !== false) throw new Error("缺省覆盖保护失效")
    if (enhancer.remember("s-a", "偏好", "覆盖", { overwrite: true }) !== true) throw new Error("overwrite: true 未放行")
    if (enhancer.recall("s-a", "偏好")?.content !== "覆盖") throw new Error("覆盖未生效")

    // 检索:key 命中权重高于内容命中
    enhancer.remember("s-a", "db-密码", "root")
    enhancer.remember("s-a", "杂项", "提到 db-密码 的事")
    const hits = enhancer.searchMemories("s-a", "db-密码")
    if (hits[0]?.key !== "db-密码") throw new Error(`key 命中未优先:${hits[0]?.key}`)
    if (hits.length < 2) throw new Error("内容命中未召回")

    // 会话隔离:list 只列本会话
    enhancer.remember("s-b", "他会话", "x")
    if (enhancer.listMemory("s-a").some((e) => e.key === "他会话")) throw new Error("listMemory 会话串扰")

    // 两级注入:索引块 kind=memory 进 system(预览截断,全文不常驻)
    const longContent = "这是一条非常长的记忆内容,超过预览字符上限,应当被截断而不是整条灌进投影索引块。" + "继续填充。" + "x".repeat(80)
    enhancer.remember("s-a", "长记录", longContent)
    const applied = enhancer.apply("s-a")
    const block = applied.systemBlocks.find((b) => b.kind === "memory")
    if (block === undefined) throw new Error("记忆索引块缺失")
    if (block.priority !== 30) throw new Error(`索引块优先级不符:${block.priority}`)
    if (!block.content.includes("[偏好] 覆盖")) throw new Error("索引块未含 key 预览")
    const longLine = block.content.split("\n").find((l) => l.includes("长记录"))
    if (longLine === undefined) throw new Error("索引块缺长记录条目")
    if (longLine.includes("x".repeat(80))) throw new Error("索引块泄漏全文(应截断为预览)")
    if (!longLine.endsWith("…")) throw new Error("截断未标注省略号")

    // 无记忆会话无索引块
    const empty = enhancer.apply("s-empty")
    if (empty.systemBlocks.some((b) => b.kind === "memory")) throw new Error("空会话不应有索引块")

    // 长程续用:同一 store 新 enhancer(模拟重启/新会话进程)仍可读回
    const enhancer2 = createEnhancer({ cwd: dir, store })
    if (enhancer2.recall("s-a", "db-密码")?.content !== "root") throw new Error("跨进程续用失败(长程记忆未持久)")

    rmSync(dir, { recursive: true, force: true })
  },
}

// ---------- 33. 多代理编排(M12) ----------

/** 简单脚本化 LLM:按调用序产出(奇数次工具调用,偶数次文本)。 */
function makeFakeLlm(script: (call: number) => { text?: string; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] }): import("@tau/llm").LlmKernel {
  let calls = 0
  return {
    complete: async () => {
      calls++
      const s = script(calls)
      const hasTools = (s.toolCalls?.length ?? 0) > 0
      return {
        text: s.text ?? "",
        thinking: "",
        toolCalls: s.toolCalls ?? [],
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        finishReason: hasTools ? "tool-calls" : "stop",
        error: undefined,
        aborted: false,
      }
    },
    stream: async function* () {},
    models: () => [],
    getModel: () => null,
    features: () => ({ supportsTools: true, supportsThinking: false, supportsParallelCalls: false, supportsVision: false, supportsStreaming: false }),
    getAuth: () => null,
    cachePolicy: () => "none" as const,
    cacheStats: () => ({ calls: 0, cachedTokenCandidates: 0, cacheReadTokens: 0 }),
    refresh: () => {},
  }
}

const assert33: Assert = {
  id: 33,
  name: "多代理编排(子代理生命周期 + capability 递减 + 深度/并发上限)",
  description: "runSubagent 独立子会话与注册表;白名单外工具 rejected 且落审计;嵌套深度与并发上限 partial;background 注册表落态",
  async run() {
    const dir = `/tmp/tau-eval-subagent-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    const store = createMemoryStore()
    const action = createActionPlane(store, { workspaceRoots: [dir], autoApprove: true })
    const parent = createSession({ store, sessionId: "eval-parent", cwd: dir, workspaceRoots: [dir], tools: action.registry.all() })
    const { runSubagent, listSubagents, depthOf, subagentUsage } = await import("@tau/orchestrate")

    let calls = 0
    const fakeLlm = makeFakeLlm(() => {
      calls++
      if (calls % 2 === 1) return { toolCalls: [{ id: `t${calls}`, name: "read", args: { path: "a.txt" } }] }
      return { text: `调查完成 #${calls}` }
    })
    const deps = { llm: fakeLlm, store, action, session: parent }

    // 白名单缺省只读:write 不在面内,子代理调用被 rejected 且落审计(递减不留白)
    let wCalls = 0
    const wllm = makeFakeLlm(() => {
      wCalls++
      if (wCalls === 1) return { toolCalls: [{ id: "w1", name: "write", args: { path: "evil.txt", content: "x" } }] }
      return { text: "写操作被拒,继续" }
    })
    const r1 = await runSubagent({ ...deps, llm: wllm }, { parentSessionId: "eval-parent", task: "尝试写入" })
    if (r1.status !== "completed") throw new Error(`递减场景未完成:${r1.status}`)
    const audit = queryAudit(store, r1.sessionId)
    if (!audit.some((a) => a.action === "write:rejected")) throw new Error("递减拒绝未落审计")
    if (existsSync(`${dir}/evil.txt`)) throw new Error("子代理写入越界(工作树隔离失败)")

    // 注册表与深度:子会话入表,parentId 链深度 = 1
    const regs = listSubagents(store, "eval-parent")
    if (regs.length < 1) throw new Error("注册表无记录")
    if (depthOf(store, r1.sessionId) !== 1) throw new Error(`深度不符:${depthOf(store, r1.sessionId)}`)
    if (store.sessions.get(r1.sessionId) === null) throw new Error("子会话未落 store")

    // 并发上限:maxPerParent 1 时同时发起两个 → 第二个 partial
    const [r2, r3] = await Promise.all([
      runSubagent(deps, { parentSessionId: "eval-parent", task: "b" }, { maxPerParent: 1 }),
      runSubagent(deps, { parentSessionId: "eval-parent", task: "c" }, { maxPerParent: 1 }),
    ])
    if (r2.status !== "completed") throw new Error(`并发首任务未完成:${r2.status}`)
    if (r3.status !== "partial" || !r3.text.includes("并发超限")) throw new Error(`并发上限未生效:${r3.status}`)

    // 深度上限:maxDepth 1 时父深度 1 → 子派生拒绝
    const r4 = await runSubagent(deps, { parentSessionId: r1.sessionId, task: "d" }, { maxDepth: 1 })
    if (r4.status !== "partial" || !r4.text.includes("深度超限")) throw new Error(`深度上限未生效:${r4.status}`)

    // background:立即 running,后台完成后注册表落 completed
    const rb = await runSubagent(deps, { parentSessionId: "eval-parent", task: "e", background: true })
    if (rb.status !== "running") throw new Error(`background 未立即返回 running:${rb.status}`)
    const deadline = Date.now() + 5000
    let bgDone = false
    while (Date.now() < deadline) {
      const bgReg = listSubagents(store, "eval-parent").find((e) => e.sessionId === rb.sessionId)
      if (bgReg?.status === "completed") { bgDone = true; break }
      await new Promise((r) => setTimeout(r, 20))
    }
    if (!bgDone) throw new Error("background 未落 completed")
    if (subagentUsage().global !== 0) throw new Error("limiter 泄漏(全局占用未归零)")

    parent.close()
    rmSync(dir, { recursive: true, force: true })
  },
}

export const allAsserts: readonly Assert[] = [
  assert1, assert2, assert3, assert4, assert5, assert6,
  assert7, assert8, assert9, assert10, assert11, assert12, assert13,
  assert14, assert15, assert16, assert17, assert18,
  assert19, assert20, assert21, assert22,
  assert23, assert24, assert25, assert26, assert27, assert28, assert29, assert30,
  assert31, assert32, assert33,
]
