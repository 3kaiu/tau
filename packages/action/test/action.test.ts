import { describe, expect, it } from "vitest"
import { createMemoryStore } from "@tau/store"
import { createActionPlane } from "../src/index.ts"

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
  it("工具目录:12 内置工具齐全", () => {
    const { plane } = fresh()
    const names = plane.registry.all().map((t) => t.name).sort()
    expect(names).toEqual(["ask_user", "bash", "edit", "fetch", "find", "grep", "ls", "read", "result", "retrieve", "system", "tool:catalog", "write"].sort())
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
