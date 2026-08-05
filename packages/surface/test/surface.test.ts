// @tau/surface - 单测:HTTP/SSE + ACP 协议 + 订阅过滤。

import { describe, expect, it, beforeEach } from "vitest"
import { type CommandFace, matchesFilter, PUBLIC_EVENT_KINDS } from "../src/face.ts"
import { createHttpApp } from "../src/http.ts"
import type { Command, Event, SessionSnapshot } from "@tau/contract"

// Mock CommandFace for testing
function createMockFace(): CommandFace {
  const listeners = new Set<(event: Event) => void>()
  const events: Event[] = []

  return {
    publish: async (command: Command) => {
      const event: Event = {
        id: `evt-${Date.now()}`,
        kind: "transcript",
        timestamp: new Date().toISOString(),
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: [{ type: "text", text: `Received: ${JSON.stringify(command)}` }],
          createdAt: new Date().toISOString(),
        },
      }
      events.push(event)
      listeners.forEach((fn) => fn(event))
      return { accepted: true, eventId: event.id }
    },
    subscribe: (listener: (event: Event) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: (): SessionSnapshot => ({
      sessionId: "test",
      epoch: 1,
      status: "active",
      transcriptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeGoals: [],
      pendingSyscalls: [],
    }),
  }
}

describe("face: matchesFilter(observe 可见范围)", () => {
  const toolEvent: Event = {
    id: "t1",
    kind: "tool",
    timestamp: new Date().toISOString(),
    toolCallId: "c1",
    name: "bash",
    state: "started",
    args: { command: "sudo rm -rf /" },
  }
  const transcriptEvent: Event = {
    id: "m1",
    kind: "transcript",
    timestamp: new Date().toISOString(),
    message: {
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      createdAt: new Date().toISOString(),
    },
  }
  const permissionEvent: Event = {
    id: "p1",
    kind: "permission",
    timestamp: new Date().toISOString(),
    requestId: "c1",
    toolName: "bash",
    summary: "run command",
    state: "requested",
  }

  it("缺省 filter(public)隐藏工具明细,放行公开事件", () => {
    expect(matchesFilter(toolEvent)).toBe(false)
    expect(matchesFilter(transcriptEvent)).toBe(true)
    expect(matchesFilter(permissionEvent)).toBe(true)
  })

  it("includeSensitive: true 放行工具明细", () => {
    expect(matchesFilter(toolEvent, { includeSensitive: true })).toBe(true)
  })

  it("kinds 白名单过滤", () => {
    const filter = { kinds: ["transcript"] as Event["kind"][] }
    expect(matchesFilter(transcriptEvent, filter)).toBe(true)
    expect(matchesFilter(permissionEvent, filter)).toBe(false)
  })

  it("permission 永远在 public 可见面(approve 落点依赖)", () => {
    expect(PUBLIC_EVENT_KINDS).toContain("permission")
  })
})

describe("HTTP: createHttpApp", () => {
  let face: CommandFace
  let app: ReturnType<typeof createHttpApp>

  beforeEach(() => {
    face = createMockFace()
    app = createHttpApp({ face })
  })

  it("GET /health 返回 ok", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, version: "0.0.1" })
  })

  it("GET /snapshot 返回会话快照", async () => {
    const res = await app.request("/snapshot")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe("test")
    expect(body.epoch).toBe(1)
    expect(body.status).toBe("active")
  })

  it("POST /command 发布 prompt 命令", async () => {
    const res = await app.request("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "test-client" },
      body: JSON.stringify({ kind: "prompt", text: "hello" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accepted).toBe(true)
  })

  it("POST /command 缺 kind 返回 400", async () => {
    const res = await app.request("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.detail).toContain("kind")
  })

  it("POST /command 带 X-Client-Id 头", async () => {
    const res = await app.request("/command", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "my-client" },
      body: JSON.stringify({ kind: "prompt", text: "test" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accepted).toBe(true)
  })

  it("GET /events 返回 SSE 流头", async () => {
    // SSE 流测试复杂(连接保持开放),这里只验证端点存在且返回正确的 Content-Type
    // 实际流行为需要集成测试验证
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 100)

    try {
      const res = await app.request("/events", { signal: controller.signal })
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/event-stream")
    } catch (e) {
      // AbortError is expected since we're testing a streaming endpoint
      if (!(e instanceof Error && e.name === "AbortError")) {
        throw e
      }
    } finally {
      clearTimeout(timeout)
    }
  })

  it("P1-13:SSE 续传竞态——先订阅后重放,重放按 seen 去重(空窗不丢、交接不重)", async () => {
    // 单测针对流端点的读端辅助语义:replay 跳过 lastEventId 之前的事件;找不到 → 全量
    const replay: readonly Event[] = [
      { id: "ev-1", timestamp: "t1", redact: [], kind: "transcript", message: { id: "m1", role: "assistant", content: [], createdAt: "t1" } },
      { id: "ev-2", timestamp: "t2", redact: [], kind: "transcript", message: { id: "m2", role: "assistant", content: [], createdAt: "t2" } },
    ]
    const face = createMockFace()
    const httpApp = createHttpApp({ face, replay: () => replay })
    const res = await httpApp.request("/snapshot?since=ev-1")
    expect(res.status).toBe(200)
    const body = await res.json() as { epoch: number; events: readonly Event[] }
    expect(body.events.map((e) => e.id)).toEqual(["ev-2"])
    const stale = await httpApp.request("/snapshot?since=nonexistent")
    const staleBody = await stale.json() as { epoch: number; events: readonly Event[] }
    expect(staleBody.events.map((e) => e.id)).toEqual(["ev-1", "ev-2"])
    // 无 since:全量快照(兼容旧客户端)
    const full = await httpApp.request("/snapshot")
    expect((await full.json() as SessionSnapshot).epoch).toBeGreaterThanOrEqual(0)
  })
})

describe("HTTP: serveHttp", () => {
  it("启动服务器并响应", async () => {
    const face = createMockFace()
    const { serveHttp } = await import("../src/http.ts")

    const port = 13000 + Math.floor(Math.random() * 1000)
    const server = serveHttp({ face }, port)

    try {
      // Test health endpoint
      const res = await fetch(`http://localhost:${port}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      // Test snapshot endpoint
      const snapRes = await fetch(`http://localhost:${port}/snapshot`)
      expect(snapRes.status).toBe(200)
      const snap = await snapRes.json()
      expect(snap.sessionId).toBe("test")
    } finally {
      server.stop()
    }
  })
})
