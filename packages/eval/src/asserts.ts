// @tau/eval - asserts.ts:行为断言(契约级,离线,FauxLlm 驱动)。
// 断言检查只依赖 contract 不变量(assertX);fixture 负责构造场景。
// 每个断言独立创建 fixture,无共享状态;失败抛 Error,runner 捕获汇总。

import { assertDualView, assertReplay, assertToolPairing, checkBudget, type UiView } from "@tau/contract"
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

// ---------- 10. 恢复告知 ----------

const assert10: Assert = {
  id: 10,
  name: "恢复告知",
  description: "模拟 crash(进程级终止),断言恢复后投影含 recovery 告警",
  async run() {
    const f = createFixture({ script: { replies: [textReply("ok")] } })
    await runTurn(f, "test")
    const sessionId = f.session.sessionId
    const store = f.store
    f.abandon()

    const f2 = createFixture({ script: { replies: [textReply("recovered")] }, sessionId, store })
    void f2

    const events2 = store.events.replay(sessionId)
    const hasRecovery = events2.some((e) => e.kind === "recovery")
    if (!hasRecovery) throw new Error("恢复后缺 recovery 事件(模型与用户应可见崩溃恢复)")
    f2.cleanup()
  },
}

// ---------- 11. 命令级安全 ----------

const assert11: Assert = {
  id: 11,
  name: "命令级安全",
  description: "危险模式命令强制询问(不静默执行)",
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
    await runTurn(f, "跑命令")
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
  description: "多模型并行执行,收集所有结果",
  async run() {
    const { runMultiRun, selectBestRun } = await import("@tau/orchestrate")
    const f = createFixture({
      script: {
        replies: [textReply("result from model")],
      },
    })
    const result = await runMultiRun(
      { llm: f.llm, session: f.session, action: f.action },
      { models: ["model-a", "model-b"], task: "test task", maxConcurrent: 2 },
    )
    if (result.runs.length !== 2) throw new Error(`期望 2 个 run,实际 ${result.runs.length}`)
    const best = selectBestRun(result.runs)
    if (best === null) throw new Error("selectBestRun 返回 null")
    if (!["model-a", "model-b"].includes(best.model)) throw new Error(`best model 不符: ${best.model}`)
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

export const allAsserts: readonly Assert[] = [
  assert1, assert2, assert3, assert4, assert5, assert6,
  assert7, assert8, assert9, assert10, assert11, assert12, assert13,
  assert14, assert15, assert16, assert17, assert18,
  assert19, assert20, assert21, assert22,
]
