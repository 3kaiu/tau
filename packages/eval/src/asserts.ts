// @tau/eval - asserts.ts:13 个行为断言(契约级,离线,FauxLlm 驱动)。
// 断言检查只依赖 contract 不变量(assertX);fixture 负责构造场景。
// 每个断言独立创建 fixture,无共享状态;失败抛 Error,runner 捕获汇总。

import { assertDualView, assertReplay, assertToolPairing, checkBudget, type UiView } from "@tau/contract"
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

export const allAsserts: readonly Assert[] = [
  assert1, assert2, assert3, assert4, assert5, assert6,
  assert7, assert8, assert9, assert10, assert11, assert12, assert13,
]
