// @tau/surface - http.ts:Hono HTTP + SSE 端点。
// 命令面无状态:POST /command 发布,GET /events 订阅 SSE,GET /snapshot 拉取快照。

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { Command, Event } from "@tau/contract"
import type { CommandFace } from "./face.ts"

export type HttpDeps = {
  face: CommandFace
  /** 事件重放(用于 SSE resume;缺省不 resume)。 */
  replay?(): readonly Event[]
}

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono()

  app.get("/health", (c) => c.json({ ok: true, version: "0.0.1" }))

  app.get("/snapshot", (c) => c.json(deps.face.snapshot()))

  app.post("/command", async (c) => {
    const body = await c.req.json<Partial<Command>>()
    if (body.kind === undefined) {
      return c.json({ accepted: false, eventId: "", detail: "缺 kind 字段" }, 400)
    }
    const clientId = c.req.header("X-Client-Id") ?? `http-${Date.now()}`
    const command: Command = {
      ...body,
      sender: { clientId, kind: "http" },
    } as Command
    const result = await deps.face.publish(command)
    return c.json(result)
  })

  app.get("/events", (c) => {
    const lastEventId = c.req.header("Last-Event-ID")

    return streamSSE(c, async (stream) => {
      // Resume: 重放 missed events
      if (deps.replay !== undefined && lastEventId !== undefined) {
        const all = deps.replay()
        let found = false
        for (const event of all) {
          if (found) {
            await stream.writeSSE({ data: JSON.stringify(event), id: event.id })
          }
          if (event.id === lastEventId) found = true
        }
        // If lastEventId not found, send all (full sync)
        if (!found) {
          for (const event of all) {
            await stream.writeSSE({ data: JSON.stringify(event), id: event.id })
          }
        }
      } else if (deps.replay !== undefined) {
        // No resume: send all existing events
        for (const event of deps.replay()) {
          await stream.writeSSE({ data: JSON.stringify(event), id: event.id })
        }
      }

      // Subscribe to new events
      const abortController = new AbortController()
      const unsubscribe = deps.face.subscribe((event: Event) => {
        if (abortController.signal.aborted) return
        void stream.writeSSE({ data: JSON.stringify(event), id: event.id })
      })

      // Heartbeat (every 30s)
      const heartbeat = setInterval(() => {
        if (abortController.signal.aborted) return
        void stream.writeSSE({ data: ": heartbeat", id: "" })
      }, 30_000)

      // Wait for disconnect
      stream.onAbort(() => {
        abortController.abort()
        clearInterval(heartbeat)
        unsubscribe()
      })

      // Keep stream open until client disconnects
      // streamSSE keeps the response body open; we just need to not return
      await new Promise<void>((resolve) => {
        abortController.signal.addEventListener("abort", () => resolve())
      })
    })
  })

  return app
}

/** 用 Bun.serve 启动 HTTP 服务器。 */
export function serveHttp(deps: HttpDeps, port: number): { stop: () => void } {
  const app = createHttpApp(deps)
  const server = Bun.serve({ port, fetch: app.fetch })
  return { stop: () => server.stop() }
}
