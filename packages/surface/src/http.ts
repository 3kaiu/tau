// @tau/surface - http.ts:Hono HTTP + SSE 端点。
// 命令面无状态:POST /command 发布,GET /events 订阅 SSE,GET /snapshot 拉取快照。

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { Command, Event } from "@tau/contract"
import { matchesFilter, type CommandFace, type EventFilter } from "./face.ts"

export type HttpDeps = {
  face: CommandFace
  /** 事件重放(用于 SSE resume;缺省不 resume)。 */
  replay?(): readonly Event[]
}

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono()

  app.get("/health", (c) => c.json({ ok: true, version: "0.0.1" }))

  app.get("/snapshot", (c) => {
    // 增量对齐(P1-13):?since=<eventId> → { epoch, events }(since 之后的事件;找不到 → 全量)
    const since = c.req.query("since")
    if (since !== undefined && deps.replay !== undefined) {
      const all = deps.replay()
      const idx = all.findIndex((e) => e.id === since)
      const events = idx === -1 ? all : all.slice(idx + 1)
      return c.json({ epoch: deps.face.snapshot().epoch, events })
    }
    return c.json(deps.face.snapshot())
  })

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
    // subscribe 过滤器:?includeSensitive=1 放行工具明细;?kinds=a,b 白名单(缺省 public)
    const includeSensitive = c.req.query("includeSensitive") === "1"
    const kindsParam = c.req.query("kinds")
    const filter: EventFilter = {
      ...(kindsParam === undefined ? {} : { kinds: kindsParam.split(",") as Event["kind"][] }),
      includeSensitive,
    }

    return streamSSE(c, async (stream) => {
      const emit = async (event: Event): Promise<void> => {
        if (matchesFilter(event, filter)) await stream.writeSSE({ data: JSON.stringify(event), id: event.id })
      }

      // 先订阅后重放:订阅建立前的空窗事件先进队列(不丢),重放按 seen 去重(不重)。
      // 串行 drain 保证 SSE 写序 = 事件 id 单调序。
      const abortController = new AbortController()
      const seen = new Set<string>()
      let buffer: Event[] = []
      let draining: Promise<void> | null = null
      const push = (event: Event): void => {
        if (abortController.signal.aborted) return
        buffer.push(event)
        if (draining === null) {
          draining = (async () => {
            while (buffer.length > 0) {
              const next = buffer.shift()!
              await emit(next)
            }
            draining = null
          })()
        }
      }
      const unsubscribe = deps.face.subscribe(filter, (event: Event) => {
        seen.add(event.id)
        push(event)
      })

      // 重放:Last-Event-ID 之后的事件(找不到 → 全量同步);已实时收到的跳过
      if (deps.replay !== undefined) {
        const all = deps.replay()
        let start = 0
        if (lastEventId !== undefined) {
          const idx = all.findIndex((e) => e.id === lastEventId)
          start = idx === -1 ? 0 : idx + 1
        }
        for (let i = start; i < all.length; i++) {
          if (!seen.has(all[i]!.id)) push(all[i]!)
        }
      }
      await draining

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
