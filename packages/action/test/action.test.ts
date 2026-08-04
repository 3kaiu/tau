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

  it("默认规则:bash 未授权(ask)→ rejected;autoApprove 后放行", async () => {
    const { plane } = fresh()
    const denied = await plane.execute({ sessionId: "s", toolCallId: "c9", name: "bash", args: { command: "echo ok" }, cwd: "/tmp/tau-test" })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe("rejected")
    const store2 = createMemoryStore()
    const auto = createActionPlane(store2, { workspaceRoots: ["/tmp/tau-test"], autoApprove: true })
    const ok = await auto.execute({ sessionId: "s", toolCallId: "c10", name: "bash", args: { command: "echo ok" }, cwd: "/tmp/tau-test" })
    expect(ok.ok).toBe(true)
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
