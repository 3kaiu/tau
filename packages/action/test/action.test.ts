import { describe, expect, it } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { createMemoryStore } from "@tau/store"
import { createActionPlane } from "../src/index.ts"
import * as createActionPlaneModule from "../src/index.ts"

function fresh(autoApprove = false) {
  const store = createMemoryStore()
  const plane = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove })
  return { store, plane }
}

describe("action 平面:read/bash/write + 门 + 审计", () => {
  it("工具目录:内置 4 工具且契约可解析", () => {
    const { plane } = fresh()
    const names = plane.registry.all().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["read", "write", "bash", "result"]))
  })

  it("read 缺 path → rejected", async () => {
    const { plane } = fresh()
    const out = await plane.execute({ sessionId: "s", toolCallId: "c1", name: "read", args: {} })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("rejected")
  })

  it("read 不存在文件 → not_found", async () => {
    const { plane } = fresh()
    const out = await plane.execute({ sessionId: "s", toolCallId: "c2", name: "read", args: { path: "/tmp/tau-test/__nope__.txt" } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("not_found")
  })

  it("read 越界(../ 逃逸)直接拒绝", async () => {
    const { plane } = fresh()
    const out = await plane.execute({ sessionId: "s", toolCallId: "c3", name: "read", args: { path: "../../etc/passwd" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("permission_denied")
  })

  it("write 原子写 + read 回读", async () => {
    const { plane } = fresh(true)
    const w = await plane.execute({ sessionId: "s", toolCallId: "c4", name: "write", args: { path: "hello.txt", content: "你好 tau\nline2\n" }, cwd: "/tmp/tau-test" })
    expect(w.ok).toBe(true)
    const r = await plane.execute({ sessionId: "s", toolCallId: "c5", name: "read", args: { path: "hello.txt" }, cwd: "/tmp/tau-test" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.stdout).toContain("你好 tau")
      expect(r.result.stdout).toContain("共 3)")
    }
  })

  it("bash 执行 + stderr 分离 + exitCode", async () => {
    const { plane } = fresh(true)
    const out = await plane.execute({ sessionId: "s", toolCallId: "c6", name: "bash", args: { command: "echo hi && echo err >&2" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.exitCode).toBe(0)
      expect(out.result.stdout).toContain("hi")
      expect(out.result.stderr).toContain("err")
    }
  })

  it("bash 持久 shell 保留 cwd", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "c7", name: "bash", args: { command: "cd /tmp/tau-test && mkdir -p sub && cd sub && pwd" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "c8", name: "bash", args: { command: "pwd" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("/tmp/tau-test/sub")
  })

  it("bash 长输出截断 + result 分页续读", async () => {
    const { plane } = fresh(true)
    const out = await plane.execute({ sessionId: "s", toolCallId: "big1", name: "bash", args: { command: "seq 1 20000" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.truncated).toBe(true)
      expect(out.result.totalPages).toBeGreaterThan(1)
      const page1 = await plane.execute({ sessionId: "s", toolCallId: "r1", name: "result", args: { call_id: "big1", page: 1 } })
      expect(page1.ok).toBe(true)
      if (page1.ok) expect(page1.result.stdout.length).toBeGreaterThan(0)
    }
  })

  it("默认规则:bash ask → requested 事件挂起,deny 后 rejected;autoApprove 后放行", async () => {
    const { plane } = fresh()
    void plane
    const events: Array<{ kind: string; state?: string; requestId?: string }> = []
    const store0 = createMemoryStore()
    const observed = createActionPlane(store0, { workspaceRoots: ["/tmp/tau-test"], onEvent: (e) => events.push(e as never) })
    const denied = observed.execute({ sessionId: "s", toolCallId: "c9", name: "bash", args: { command: "echo ok" }, cwd: "/tmp/tau-test" })
    await Promise.resolve()
    expect(observed.permissionRequest().length).toBe(1)
    expect(observed.permissionRequest()[0]?.toolName).toBe("bash")
    expect(events.some((e) => e.kind === "permission" && e.state === "requested" && e.requestId === "c9")).toBe(true)
    expect(observed.deny("c9")).toBe(true)
    const deniedOut = await denied
    expect(deniedOut.ok).toBe(false)
    if (!deniedOut.ok) expect(deniedOut.error.code).toBe("rejected")
    expect(events.some((e) => e.kind === "permission" && e.state === "denied")).toBe(true)

    const store2 = createMemoryStore()
    const auto = createActionPlane(store2, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const ok = await auto.execute({ sessionId: "s", toolCallId: "c10", name: "bash", args: { command: "echo ok" }, cwd: "/tmp/tau-test" })
    expect(ok.ok).toBe(true)
  })

  it("危险命令:autoApprove 也不豁免(强制询问,deny 后 rejected)", async () => {
    const store2 = createMemoryStore()
    const auto = createActionPlane(store2, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const out = auto.execute({ sessionId: "s", toolCallId: "danger1", name: "bash", args: { command: "sudo rm -rf /" }, cwd: "/tmp/tau-test" })
    await Promise.resolve()
    expect(auto.permissionRequest().length).toBe(1)
    expect(auto.deny("danger1")).toBe(true)
    const result = await out
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("rejected")
  })

  it("未知工具 → not_found 且带可用目录", async () => {
    const { plane } = fresh()
    const out = await plane.execute({ sessionId: "s", toolCallId: "c11", name: "nope", args: {} })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error.code).toBe("not_found")
      expect(out.error.message).toContain("read")
    }
  })

  it("审计:执行记录落 store 可查", async () => {
    const { store, plane } = fresh()
    await plane.execute({ sessionId: "s1", toolCallId: "c12", name: "read", args: { path: "/tmp/tau-test/__nope__.txt" } })
    const entries = store.audit.query({ sessionId: "s1" })
    expect(entries.length).toBe(1)
    expect(entries[0]?.action).toContain("read")
  })

  it("secret 检测:结果命中 KEY= 模式被脱敏", async () => {
    const store2 = createMemoryStore()
    const auto = createActionPlane(store2, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const out = await auto.execute({ sessionId: "s", toolCallId: "c13", name: "bash", args: { command: 'echo "MY_API_KEY=12345678901234567890"' }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.stdout).not.toContain("12345678901234567890")
      expect(out.result.stdout).toContain("[redacted]")
    }
  })
})

describe("action 平面:补齐工具面(edit/grep/find/ls/ask_user/system/catalog/retrieve/detach)", () => {
  it("工具目录:17 内置工具齐全(14 模型可见 + 3 worktree 内部件)", () => {
    const { plane } = fresh()
    const names = plane.registry.all().map((t) => t.name).sort()
    expect(names).toEqual(["artifact:read", "ask_user", "bash", "edit", "fetch", "find", "grep", "ls", "read", "result", "retrieve", "system", "tool:catalog", "worktree:create", "worktree:list", "worktree:rm", "write"].sort())
  })

  it("edit:old→new 原子替换 + fileMeta", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "e0", name: "write", args: { path: "edit.txt", content: "hello tau\nworld" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "e1", name: "edit", args: { path: "edit.txt", old: "tau", new: "tua" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.fileMeta?.size).toBeGreaterThan(0)
      const r = await plane.execute({ sessionId: "s", toolCallId: "e2", name: "read", args: { path: "edit.txt" }, cwd: "/tmp/tau-test" })
      if (r.ok) expect(r.result.stdout).toContain("hello tua")
    }
  })

  it("edit:old 未命中 → rejected 诊断", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "e3", name: "write", args: { path: "edit2.txt", content: "abc" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "e4", name: "edit", args: { path: "edit2.txt", old: "xyz", new: "z" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("rejected")
  })

  it("read 结果带 fileMeta(mtime/size)", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "f0", name: "write", args: { path: "meta.txt", content: "x" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "f1", name: "read", args: { path: "meta.txt" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.fileMeta?.mtime).toBeDefined()
  })

  it("grep:按正则命中行号", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "g0", name: "write", args: { path: "g.txt", content: "alpha\nbeta\n" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "g1", name: "grep", args: { pattern: "beta", path: "." }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("g.txt:2")
  })

  it("find:文件名子串", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "fn0", name: "write", args: { path: "special_report.md", content: "x" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "fn1", name: "find", args: { name: "special" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("special_report.md")
  })

  it("ls:目录条目", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "l0", name: "write", args: { path: "ls.txt", content: "x" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "l1", name: "ls", args: {}, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("ls.txt")
  })

  it("ask_user:挂起后 answer 恢复,onPending 通知", async () => {
    const store2 = createMemoryStore()
    const auto = createActionPlane(store2, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const pendings: Array<{ questionId: string; toolName: string }> = []
    const out = auto.execute({ sessionId: "s", toolCallId: "ask1", name: "ask_user", args: { question: "继续?" }, cwd: "/tmp/tau-test",
      onPending: (p) => pendings.push({ questionId: p.questionId, toolName: p.toolName }) })
    for (let i = 0; i < 50 && pendings.length === 0; i++) await Bun.sleep(5)
    expect(pendings.length).toBe(1)
    const questionId = pendings[0]?.questionId
    expect(questionId).toBeDefined()
    expect(auto.answer(questionId!, "yes")).toBe(true)
    const result = await out
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.stdout).toContain("yes")
      expect(result.result.stdout).toContain(questionId!)
    }
  })

  it("system:rules/pending/catalog + cancel_task", async () => {
    const { plane } = fresh()
    const rules = await plane.execute({ sessionId: "s", toolCallId: "s0", name: "system", args: { action: "rules" } })
    expect(rules.ok).toBe(true)
    if (rules.ok) expect(rules.result.stdout).toContain("bash")
    const catalog = await plane.execute({ sessionId: "s", toolCallId: "s1", name: "system", args: { action: "catalog" } })
    if (catalog.ok) expect(catalog.result.stdout).toContain("read")
    const cancel = await plane.execute({ sessionId: "s", toolCallId: "s2", name: "system", args: { action: "cancel_task", task_id: "nope" } })
    if (cancel.ok) expect(cancel.result.stdout).toContain("不存在")
  })

  it("tool:catalog:detail 模式含参数 schema", async () => {
    const { plane } = fresh()
    const out = await plane.execute({ sessionId: "s", toolCallId: "t0", name: "tool:catalog", args: { detail: true } })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("params:")
  })

  it("bash detach:返回 taskId,后台完成可轮询", async () => {
    const { plane } = fresh(true)
    const out = await plane.execute({ sessionId: "s", toolCallId: "det1", name: "bash", args: { command: "sleep 0.2 && echo done", detach: true }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("det1")
    await Bun.sleep(600)
    const poll = await plane.execute({ sessionId: "s", toolCallId: "poll1", name: "result", args: { call_id: "det1", page: 0 } })
    expect(poll.ok).toBe(true)
    if (poll.ok) expect(poll.result.stdout).toContain("done")
  })

  it("bash 持久 shell 保留 env(export 跨命令)", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "env0", name: "bash", args: { command: "export TAU_TEST_VAR=hello42" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "env1", name: "bash", args: { command: "echo $TAU_TEST_VAR" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("hello42")
  })

  it("fetch:拒绝 file:// 协议", async () => {
    const { plane } = fresh(true)
    const out = await plane.execute({ sessionId: "s", toolCallId: "f1", name: "fetch", args: { url: "file:///etc/passwd" } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("permission_denied")
  })

  it("retrieve:检索暂存输出", async () => {
    const { plane } = fresh(true)
    await plane.execute({ sessionId: "s", toolCallId: "big2", name: "bash", args: { command: "seq 1 20000" }, cwd: "/tmp/tau-test" })
    const out = await plane.execute({ sessionId: "s", toolCallId: "rt1", name: "retrieve", args: { query: "19999" } })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("big2")
  })

  it("权限挂起超时:timeout 事件 + rejected", async () => {
    const store2 = createMemoryStore()
    const events: Array<{ kind: string; state?: string }> = []
    const plane = createActionPlane(store2, { workspaceRoots: ["/tmp/tau-test"], permissionTimeoutMs: 20, onEvent: (e) => events.push(e as never) })
    const out = await plane.execute({ sessionId: "s", toolCallId: "tmo1", name: "bash", args: { command: "echo ok" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("rejected")
    expect(events.some((e) => e.kind === "permission" && e.state === "timeout")).toBe(true)
  })

  it("onPermission 回调:决议后发 granted/denied 事件(双轨)", async () => {
    const store2 = createMemoryStore()
    const events: Array<{ kind: string; state?: string }> = []
    const plane = createActionPlane(store2, {
      workspaceRoots: ["/tmp/tau-test"],
      onPermission: async (req) => req.toolCallId === "ok1",
      onEvent: (e) => events.push(e as never),
    })
    const out = await plane.execute({ sessionId: "s", toolCallId: "ok1", name: "bash", args: { command: "echo hi" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(true)
    expect(events.some((e) => e.kind === "permission" && e.state === "requested" && (e as { requestId?: string }).requestId === "ok1")).toBe(true)
    expect(events.some((e) => e.kind === "permission" && e.state === "granted")).toBe(true)
  })

  it("onPermission 回调无应答 → 超时拒绝(不永久挂起)", async () => {
    const store2 = createMemoryStore()
    const events: Array<{ kind: string; state?: string }> = []
    const plane = createActionPlane(store2, {
      workspaceRoots: ["/tmp/tau-test"],
      permissionTimeoutMs: 30,
      onPermission: () => new Promise<boolean>(() => {}),
      onEvent: (e) => events.push(e as never),
    })
    const out = await plane.execute({ sessionId: "s", toolCallId: "c1", name: "bash", args: { command: "echo hi" }, cwd: "/tmp/tau-test" })
    expect(out.ok).toBe(false)
    expect(events.some((e) => e.kind === "permission" && e.state === "timeout")).toBe(true)
  })
})

describe("action 平面:grantScope 作用域预授权", () => {
  it("grant 后工具免询问直接执行(一次批准 N 次)", async () => {
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"] })
    plane.grantScope(["bash"], { maxUses: 2, sessionId: "s" })

    const first = await plane.execute({ sessionId: "s", toolCallId: "c1", name: "bash", args: { command: "echo one" }, cwd: "/tmp/tau-test" })
    expect(first.ok).toBe(true)
    const second = await plane.execute({ sessionId: "s", toolCallId: "c2", name: "bash", args: { command: "echo two" }, cwd: "/tmp/tau-test" })
    expect(second.ok).toBe(true)
    // 次数耗尽:第三次回到询问(无回调 → 挂起等待决议)
    const third = plane.execute({ sessionId: "s", toolCallId: "c3", name: "bash", args: { command: "echo three" }, cwd: "/tmp/tau-test" })
    expect(plane.deny("c3")).toBe(true)
    await expect(third).resolves.toMatchObject({ ok: false })
  })

  it("grant 不豁免危险命令(强制询问,宪法 16)", async () => {
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"] })
    plane.grantScope(["bash"], { maxUses: 10, sessionId: "s" })
    const out = plane.execute({ sessionId: "s", toolCallId: "d1", name: "bash", args: { command: "rm -rf /tmp/evil" }, cwd: "/tmp/tau-test" })
    expect(plane.deny("d1")).toBe(true)
    const result = await out
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe("rejected")
  })

  it("grant 落审计(grantScope 记录)", async () => {
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"] })
    plane.grantScope(["write"], { sessionId: "s1" })
    const entries = store.audit.query({ sessionId: "s1" })
    expect(entries.some((e) => e.action === "grant:write:approved")).toBe(true)
  })
})

describe("action 平面:executeStream 流式事件形态(P1-22)", () => {
  function ensureFile(): void {
    mkdirSync("/tmp/tau-test", { recursive: true })
    writeFileSync("/tmp/tau-test/hello.txt", "hello")
  }

  it("成功路径:started → completed(带结果),execute 收口与终态一致", async () => {
    ensureFile()
    const { plane } = fresh(true)
    const events: import("@tau/contract").ToolEvent[] = []
    for await (const ev of plane.executeStream({ sessionId: "s", toolCallId: "c1", name: "read", args: { path: "/tmp/tau-test/hello.txt" }, cwd: "/tmp/tau-test" })) {
      events.push(ev)
    }
    expect(events[0]?.state).toBe("started")
    expect(events[events.length - 1]?.state).toBe("completed")
    expect(events.some((e) => e.state === "failed")).toBe(false)
    const last = events[events.length - 1]!
    if (last.state === "completed" && last.result !== undefined) {
      const out = await plane.execute({ sessionId: "s", toolCallId: "c1", name: "read", args: { path: "/tmp/tau-test/hello.txt" }, cwd: "/tmp/tau-test" })
      expect(out.ok).toBe(true)
      if (out.ok) expect(out.result).toEqual(last.result)
    }
  })

  it("失败路径:started → failed(带错误码),execute 收口与终态一致", async () => {
    const { plane } = fresh(true)
    const events: import("@tau/contract").ToolEvent[] = []
    for await (const ev of plane.executeStream({ sessionId: "s", toolCallId: "c2", name: "read", args: { path: "/tmp/tau-test/__nope__.txt" }, cwd: "/tmp/tau-test" })) {
      events.push(ev)
    }
    expect(events[0]?.state).toBe("started")
    const last = events[events.length - 1]!
    expect(last.state).toBe("failed")
    if (last.state === "failed" && last.error !== undefined) {
      expect(last.error.code).toBe("not_found")
      const out = await plane.execute({ sessionId: "s", toolCallId: "c2", name: "read", args: { path: "/tmp/tau-test/__nope__.txt" }, cwd: "/tmp/tau-test" })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error.code).toBe("not_found")
    }
  })

  it("门拒绝路径:只发 failed(rejected),无 started", async () => {
    const { plane } = fresh(false)
    const eventsPromise = (async () => {
      const events: import("@tau/contract").ToolEvent[] = []
      for await (const ev of plane.executeStream({ sessionId: "s", toolCallId: "c3", name: "bash", args: { command: "echo hi" }, cwd: "/tmp/tau-test" })) {
        events.push(ev)
      }
      return events
    })()
    for (let i = 0; i < 1000 && plane.permissionRequest().length === 0; i++) await Bun.sleep(3)
    expect(plane.deny("c3")).toBe(true)
    const events = await eventsPromise
    expect(events).toHaveLength(1)
    expect(events[0]?.state).toBe("failed")
  })

  it("事件也进 onEvent 双轨(全局桥与流不互斥)", async () => {
    ensureFile()
    const store = createMemoryStore()
    const collected: unknown[] = []
    const plane = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true, onEvent: (e) => collected.push(e) })
    const streamed: import("@tau/contract").ToolEvent[] = []
    for await (const ev of plane.executeStream({ sessionId: "s", toolCallId: "c4", name: "read", args: { path: "/tmp/tau-test/hello.txt" }, cwd: "/tmp/tau-test" })) {
      streamed.push(ev)
    }
    expect(collected.filter((e) => (e as { kind?: string }).kind === "tool").length).toBe(streamed.length)
    expect(collected.length).toBeGreaterThanOrEqual(streamed.length)
  })
})

describe("action 平面:artifact:read 检索工具(M10.3-b)", () => {
  it("外置正文按引用取回;缺 ref 拒绝;不存在 not_found", async () => {
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const big = "z".repeat(2_000)
    store.artifacts.put({ ref: "art-abc123", sessionId: "s", size: big.length, hash: "h", body: big, createdAt: new Date().toISOString() })

    const got = await plane.execute({ sessionId: "s", toolCallId: "a1", name: "artifact:read", args: { ref: "art-abc123" }, cwd: "/tmp/tau-test" })
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.result.stdout).toBe(big)

    const missing = await plane.execute({ sessionId: "s", toolCallId: "a2", name: "artifact:read", args: { ref: "art-nope" }, cwd: "/tmp/tau-test" })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe("not_found")

    const emptyRef = await plane.execute({ sessionId: "s", toolCallId: "a3", name: "artifact:read", args: {}, cwd: "/tmp/tau-test" })
    expect(emptyRef.ok).toBe(false)
    if (!emptyRef.ok) expect(emptyRef.error.code).toBe("rejected")
  })
})

describe("action 平面:workspace 文件树增量索引(M10.3-d)", () => {
  const { WorkspaceIndex } = createActionPlaneModule
  let root = ""

  function makeTree(ts: string) {
    root = `/tmp/tau-index-test-${Date.now()}-${ts}`
    mkdirSync(`${root}/a/src`, { recursive: true })
    mkdirSync(`${root}/a/sub`, { recursive: true })
    writeFileSync(`${root}/c.ts`, "c")
    writeFileSync(`${root}/a/src/a.ts`, "a")
    writeFileSync(`${root}/a/sub/b.ts`, "b")
  }

  it("WorkspaceIndex 冷扫全量;重复 refresh 零重扫(目录 mtime 命中)", () => {
    makeTree("t1")
    const index = new WorkspaceIndex()
    const all = index.walkAll(root)
    expect(all.length).toBe(6)
    const stats1 = index.stats()
    expect(stats1).toMatchObject({ dirs: 4, fullScans: 1 })

    index.walkAll(root)
    const stats2 = index.stats()
    expect(stats2.dirHits).toBe(4)
    expect(stats2.dirRescans).toBe(4)
    expect(stats2.fullScans).toBe(1)
  })

  it("子目录新增文件:只重扫该目录,不全量重扫,find 立即可见", () => {
    makeTree("t2")
    const index = new WorkspaceIndex()
    index.walkAll(root)

    writeFileSync(`${root}/a/sub/new.ts`, "new")
    const all = index.walkAll(root)
    expect(all.some((e) => e.path.endsWith("a/sub/new.ts"))).toBe(true)
    const stats = index.stats()
    expect(stats.fullScans).toBe(1)
    expect(stats.dirRescans).toBe(5)
    expect(stats.dirHits).toBe(3)
  })

  it("删除子目录:条目消失且缓存键被剪除(无幽灵条目)", () => {
    makeTree("t3")
    const index = new WorkspaceIndex()
    index.walkAll(root)

    const { rmSync } = require("node:fs") as typeof import("node:fs")
    rmSync(`${root}/a/sub`, { recursive: true })
    const all = index.walkAll(root)
    expect(all.some((e) => e.path.includes("sub"))).toBe(false)
    expect(index.stats().dirs).toBe(3)
  })

  it("文件内容编辑不改目录 mtime:结构查询零重扫", () => {
    makeTree("t4")
    const index = new WorkspaceIndex()
    index.walkAll(root)
    const hitsBefore = index.stats().dirHits

    writeFileSync(`${root}/a/src/a.ts`, "a".repeat(1000))
    index.walkAll(root)
    const stats = index.stats()
    expect(stats.dirRescans).toBe(4)
    expect(stats.dirHits).toBe(hitsBefore + 4)
  })

  it("find 工具走索引且不牺牲新鲜度(新文件立即命中)", async () => {
    makeTree("t5")
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: [root], autoApprove: true })

    const first = await plane.execute({ sessionId: "s", toolCallId: "f1", name: "find", args: { name: "b.ts" }, cwd: root })
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.result.stdout).toContain("a/sub/b.ts")

    writeFileSync(`${root}/a/src/zz-b.ts`, "x")
    const second = await plane.execute({ sessionId: "s", toolCallId: "f2", name: "find", args: { name: "zz-b" }, cwd: root })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.result.stdout).toContain("a/src/zz-b.ts")
  })
})

describe("action 平面:workspace 模型统一(M10.5:gitignore + 越界归属 + worktree)", () => {
  const { WorkspaceIndex } = createActionPlaneModule
  let root = ""

  function makeTree(ts: string) {
    root = `/tmp/tau-ws-test-${Date.now()}-${ts}`
    mkdirSync(`${root}/build`, { recursive: true })
    mkdirSync(`${root}/src`, { recursive: true })
    writeFileSync(`${root}/a.log`, "a")
    writeFileSync(`${root}/keep.log`, "k")
    writeFileSync(`${root}/src/a.ts`, "a")
    writeFileSync(`${root}/src/b.txt`, "b")
    writeFileSync(`${root}/build/x.js`, "x")
  }

  it("gitignore 匹配树:忽略文件与目录,否定规则放行", () => {
    makeTree("t1")
    writeFileSync(`${root}/.gitignore`, "*.log\nbuild/\n!keep.log\n")
    const index = new WorkspaceIndex()
    const paths = index.walkAll(root).map((e) => e.path.slice(root.length + 1)).sort()
    expect(paths).toEqual([".gitignore", "keep.log", "src", "src/a.ts", "src/b.txt"])
    expect(index.stats().dirs).toBe(2)
  })

  it("gitignore 变更即失效:目录 mtime 未变也整根重扫(不牺牲新鲜度)", () => {
    makeTree("t2")
    writeFileSync(`${root}/.gitignore`, "*.log\n")
    const index = new WorkspaceIndex()
    index.walkAll(root)
    const before = index.stats().fullScans

    writeFileSync(`${root}/.gitignore`, "*.log\nsrc/\n")
    const paths = index.walkAll(root).map((e) => e.path.slice(root.length + 1)).sort()
    expect(paths).toEqual([".gitignore", "build", "build/x.js"])
    expect(index.stats().fullScans).toBe(before + 1)
  })

  it("越界校验归属:多根边界,resolveWithin 拒绝根外路径", () => {
    makeTree("t3")
    const index = new WorkspaceIndex([root, `${root}/src`])
    expect(index.resolveWithin(root, "./src/a.ts")).toBe(`${root}/src/a.ts`)
    expect(index.resolveWithin(`${root}/src`, "a.ts")).toBe(`${root}/src/a.ts`)
    expect(index.resolveWithin(`${root}/src`, "../a.log")).toBe(`${root}/a.log`)
    expect(() => index.resolveWithin(root, `${root}/build/x.js`)).not.toThrow()
    expect(() => index.resolveWithin(root, `/etc/passwd`)).toThrow(/越界拒绝/)
    const outside = new WorkspaceIndex([root])
    expect(outside.contains(`${root}/a.log`)).toBe(true)
    expect(outside.contains(`/etc`)).toBe(false)
  })

  it("find/ls 与索引同源:被忽略条目不进命中集;read 仍可直读(行为统一)", async () => {
    makeTree("t4")
    writeFileSync(`${root}/.gitignore`, "*.log\n")
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: [root], autoApprove: true })

    const find = await plane.execute({ sessionId: "s", toolCallId: "w1", name: "find", args: { name: "log" }, cwd: root })
    expect(find.ok).toBe(true)
    if (find.ok) expect(find.result.stdout).toContain("0 命中")

    const ls = await plane.execute({ sessionId: "s", toolCallId: "w2", name: "ls", args: {}, cwd: root })
    expect(ls.ok).toBe(true)
    if (ls.ok) {
      expect(ls.result.stdout).toContain(".gitignore")
      expect(ls.result.stdout).not.toContain("a.log")
      expect(ls.result.stdout).toContain("src")
    }

    const read = await plane.execute({ sessionId: "s", toolCallId: "w3", name: "read", args: { path: "a.log" }, cwd: root })
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.result.stdout).toContain("a")
  })

  it("worktree 生命周期:create/list/rm + 名称契约 + 模型视野隐藏", async () => {
    makeTree("t5")
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: [root], autoApprove: true })

    const created = await plane.execute({ sessionId: "s", toolCallId: "w4", name: "worktree:create", args: { name: "run-1" }, cwd: root })
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.result.stdout).toBe(`${root}/.tau-worktrees/run-1`)

    const listed = await plane.execute({ sessionId: "s", toolCallId: "w5", name: "worktree:list", args: {}, cwd: root })
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.result.stdout).toContain("run-1")

    const bad = await plane.execute({ sessionId: "s", toolCallId: "w6", name: "worktree:create", args: { name: "../escape" }, cwd: root })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe("rejected")

    const find = await plane.execute({ sessionId: "s", toolCallId: "w7", name: "find", args: { name: "run-1" }, cwd: root })
    if (find.ok) expect(find.result.stdout).toContain("0 命中")

    const rm = await plane.execute({ sessionId: "s", toolCallId: "w8", name: "worktree:rm", args: { name: "run-1" }, cwd: root })
    expect(rm.ok).toBe(true)
    const listed2 = await plane.execute({ sessionId: "s", toolCallId: "w9", name: "worktree:list", args: {}, cwd: root })
    if (listed2.ok) expect(listed2.result.stdout).toContain("0 条目")
  })
})

describe("capability:类别匹配(P1-3)", () => {
  it("read 类别规则命中 grep/find/ls/retrieve(defaultRule.pattern 为类别)", async () => {
    const { plane } = fresh(false)
    for (const name of ["grep", "find", "ls", "retrieve"]) {
      const syscall = plane.registry.get(name)
      if (syscall === null) continue
      expect(plane.gate.decide(name, syscall.dangerous, syscall.defaultRule?.pattern)).toEqual({ rule: "allow" })
    }
  })

  it("write 类别命中 edit(同 ask 语义,规则表确定性命中)", async () => {
    const { plane } = fresh(false)
    const syscall = plane.registry.get("edit")
    expect(plane.gate.decide("edit", false, syscall?.defaultRule?.pattern)).toEqual({ rule: "ask" })
  })

  it("headless 全链路:autoApprove=false 时 grep 直接执行(不挂起询问)", async () => {
    const dir = `/tmp/tau-cap-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/a.txt`, "hello world")
    const store = createMemoryStore()
    const plane = createActionPlane(store, { workspaceRoots: [dir], autoApprove: false })
    const out = await plane.execute({ sessionId: "s", toolCallId: "g1", name: "grep", args: { pattern: "hello", path: dir }, cwd: dir })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.stdout).toContain("hello world")
  })
})
