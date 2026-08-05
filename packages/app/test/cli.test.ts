// @tau/app — cli.test.ts:治理/配置/调度子命令的契约(退出码 + 可见输出 + 落盘副作用)。
// 全部走真实 SQLite 临时库:CLI 的价值就在跨进程持久,内存 store 测不出。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "@tau/store"
import { createSession } from "@tau/session"
import { loadSchedules, upsertSchedule } from "@tau/orchestrate"
import { runCli } from "../src/cli.ts"

let dir: string
let dbPath: string
let out: string[]
let err: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tau-cli-"))
  dbPath = join(dir, "tau.sqlite")
  out = []
  err = []
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")))
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")))
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk).trimEnd())
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const stdout = (): string => out.join("\n")
const stderr = (): string => err.join("\n")

/** 播种会话:CLI 只读注册表,写路径在 session 生命周期里。 */
function seed(): void {
  const store = createStore("sqlite", dbPath)
  store.migrate()
  const main = createSession({ store, sessionId: "main", cwd: dir, workspaceRoots: [dir], tools: [] })
  main.admit({ kind: "prompt", sender: { clientId: "t", kind: "cli" }, text: "第一条" })
  main.close()
  const old = createSession({ store, sessionId: "调研", cwd: dir, workspaceRoots: [dir], tools: [] })
  old.admit({ kind: "prompt", sender: { clientId: "t", kind: "cli" }, text: "hi" })
  old.archive()
  store.close?.()
}

describe("tau --version / --help", () => {
  it("--version 打印版本,退出 0", async () => {
    expect(await runCli(["--version"])).toBe(0)
    expect(stdout()).toMatch(/^tau \d+\.\d+\.\d+$/)
  })

  it("--help 覆盖治理与观测子命令", async () => {
    expect(await runCli(["--help"])).toBe(0)
    for (const cmd of ["tau -p", "tau -j", "tau sessions", "tau config", "tau schedule", "tau log", "tau replay", "tau export"]) {
      expect(stdout()).toContain(cmd)
    }
  })
})

describe("tau sessions(会话治理)", () => {
  it("list 读注册表:含状态/转述数,按更新倒序", async () => {
    seed()
    expect(await runCli(["sessions", "list", "--store", dbPath])).toBe(0)
    expect(stdout()).toContain("main")
    expect(stdout()).toContain("调研")
    expect(stdout()).toContain("archived")
    expect(stdout()).toContain("closed")
  })

  it("list --json 每行一条快照(机器消费)", async () => {
    seed()
    await runCli(["sessions", "list", "--json", "--store", dbPath])
    const rows = stdout().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { sessionId: string })
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["main", "调研"])
  })

  it("无 --store 时提示内存无持久记录(而不是假装为空)", async () => {
    expect(await runCli(["sessions", "list"])).toBe(0)
    expect(stdout()).toContain("--store")
  })

  it("show 未知会话退出 1", async () => {
    seed()
    expect(await runCli(["sessions", "show", "nope", "--store", dbPath])).toBe(1)
    expect(stderr()).toContain("不在注册表")
  })

  it("resume 把归档会话置回 active,且跨进程持久", async () => {
    seed()
    expect(await runCli(["sessions", "resume", "调研", "--store", dbPath])).toBe(0)
    const store = createStore("sqlite", dbPath)
    expect(store.sessions.get("调研")?.status).toBe("active")
    store.close?.()
  })

  it("delete 等价 archive:历史不物理删,仍可 replay", async () => {
    seed()
    const before = (() => {
      const s = createStore("sqlite", dbPath)
      const n = s.messages.count("main")
      s.close?.()
      return n
    })()
    expect(await runCli(["sessions", "delete", "main", "--store", dbPath])).toBe(0)
    const store = createStore("sqlite", dbPath)
    expect(store.sessions.get("main")?.status).toBe("archived")
    expect(store.messages.count("main")).toBe(before)
    expect(store.events.replay("main").length).toBeGreaterThan(0)
    store.close?.()
  })

  it("未知子命令退出 2(解析失败统一退出码)", async () => {
    expect(await runCli(["sessions", "bogus", "--store", dbPath])).toBe(2)
    expect(stderr()).toContain("用法")
  })
})

describe("tau config(配置)", () => {
  it("set → get → list → unset 闭环,落 store.kv", async () => {
    expect(await runCli(["config", "set", "model", "gpt-5", "--store", dbPath])).toBe(0)
    out = []
    expect(await runCli(["config", "get", "model", "--store", dbPath])).toBe(0)
    expect(stdout()).toBe("gpt-5")

    out = []
    await runCli(["config", "set", "ui.theme", "dark", "--store", dbPath])
    out = []
    await runCli(["config", "list", "--json", "--store", dbPath])
    expect(JSON.parse(stdout())).toEqual({ model: "gpt-5", "ui.theme": "dark" })

    out = []
    expect(await runCli(["config", "unset", "ui.theme", "--store", dbPath])).toBe(0)
    out = []
    await runCli(["config", "list", "--json", "--store", dbPath])
    expect(JSON.parse(stdout())).toEqual({ model: "gpt-5" })
  })

  it("拒绝明文落盘凭据(退出 2,指向环境变量)", async () => {
    for (const key of ["openai_api_key", "token", "my.secret", "db-password"]) {
      out = []
      err = []
      expect(await runCli(["config", "set", key, "x", "--store", dbPath])).toBe(2)
      expect(stderr()).toContain("拒绝明文落盘凭据")
    }
    const store = createStore("sqlite", dbPath)
    expect(store.kv.list("config:")).toHaveLength(0)
    store.close?.()
  })

  it("get 未设置的键退出 1", async () => {
    expect(await runCli(["config", "get", "nope", "--store", dbPath])).toBe(1)
  })

  it("config 命名空间与 schedule 互不串台", async () => {
    await runCli(["config", "set", "model", "gpt-5", "--store", dbPath])
    await runCli(["schedule", "add", "@daily", "整理笔记", "--store", dbPath])
    out = []
    await runCli(["config", "list", "--json", "--store", dbPath])
    expect(JSON.parse(stdout())).toEqual({ model: "gpt-5" })
  })

  it("配置即契约:set 对 Config 已知键强转校验,非法退出 2 且不落盘", async () => {
    err = []
    expect(await runCli(["config", "set", "maxContextTokens", "abc", "--store", dbPath])).toBe(2)
    expect(stderr()).toContain("非法配置")
    err = []
    expect(await runCli(["config", "set", "toolTierRules", "{bad", "--store", dbPath])).toBe(2)
    expect(stderr()).toContain("非法配置")
    const store = createStore("sqlite", dbPath)
    expect(store.kv.list("config:")).toHaveLength(0)
    store.close?.()
  })

  it("配置即契约:set 合法值强转后落盘,get 读到原始串", async () => {
    expect(await runCli(["config", "set", "maxContextTokens", "16000", "--store", dbPath])).toBe(0)
    expect(await runCli(["config", "set", "toolTierRules", '{"defaultTier":"T1","overrides":{"read":"T0"}}', "--store", dbPath])).toBe(0)
    out = []
    expect(await runCli(["config", "get", "maxContextTokens", "--store", dbPath])).toBe(0)
    expect(stdout()).toBe("16000")
    err = []
    expect(await runCli(["config", "set", "maxContextTokens", "0", "--store", dbPath])).toBe(2)
    expect(stderr()).toContain("非法配置")
  })
})

describe("tau schedule(定时目标)", () => {
  it("add 校验 cron,非法退出 2", async () => {
    expect(await runCli(["schedule", "add", "每天早上", "x", "--store", dbPath])).toBe(2)
    expect(stderr()).toContain("非法 cron")
    const store = createStore("sqlite", dbPath)
    expect(loadSchedules(store)).toHaveLength(0)
    store.close?.()
  })

  it("add 落盘:cron/目标/会话齐全,缺省 session=main", async () => {
    expect(await runCli(["schedule", "add", "0 9 * * 1", "汇总上周进展", "--store", dbPath])).toBe(0)
    expect(await runCli(["schedule", "add", "@daily", "整理笔记", "--session", "notes", "--store", dbPath])).toBe(0)
    const store = createStore("sqlite", dbPath)
    const entries = loadSchedules(store)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ cron: "0 9 * * 1", goalText: "汇总上周进展", sessionId: "main", lastRunAt: null })
    expect(entries[1]).toMatchObject({ cron: "@daily", sessionId: "notes" })
    store.close?.()
  })

  it("list 展示下次触发时刻;rm 未知 id 退出 1", async () => {
    await runCli(["schedule", "add", "0 9 * * 1", "汇总", "--store", dbPath])
    out = []
    expect(await runCli(["schedule", "list", "--store", dbPath])).toBe(0)
    expect(stdout()).toContain("下次")
    expect(await runCli(["schedule", "rm", "nope", "--store", dbPath])).toBe(1)
  })

  it("run --dry-run 只报到点条目,不改 lastRunAt", async () => {
    const store = createStore("sqlite", dbPath)
    store.migrate()
    upsertSchedule(store, {
      id: "sch-past",
      cron: "* * * * *",
      sessionId: "main",
      goalText: "过去的到点调度",
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      lastRunAt: null,
    })
    upsertSchedule(store, {
      id: "sch-future",
      cron: "0 3 1 1 *",
      sessionId: "main",
      goalText: "元旦凌晨",
      createdAt: new Date().toISOString(),
      lastRunAt: null,
    })
    store.close?.()

    expect(await runCli(["schedule", "run", "--dry-run", "--store", dbPath])).toBe(0)
    expect(stdout()).toContain("sch-past")
    expect(stdout()).not.toContain("sch-future")

    const after = createStore("sqlite", dbPath)
    expect(loadSchedules(after).find((e) => e.id === "sch-past")?.lastRunAt).toBeNull()
    after.close?.()
  })

  it("无到点调度时 run 静默成功(系统 cron 每分钟拉一次,不该刷屏报错)", async () => {
    expect(await runCli(["schedule", "run", "--store", dbPath])).toBe(0)
    expect(stdout()).toContain("无到点调度")
    expect(stderr()).toBe("")
  })
})

describe("观测命令只读", () => {
  it("log/replay/export 不写事件,不改会话状态", async () => {
    seed()
    const snapshot = (() => {
      const s = createStore("sqlite", dbPath)
      const r = { events: s.events.count("main"), status: s.sessions.get("main")?.status }
      s.close?.()
      return r
    })()

    expect(await runCli(["log", "main", "--store", dbPath])).toBe(0)
    expect(await runCli(["replay", "main", "--store", dbPath])).toBe(0)
    expect(await runCli(["export", "main", "--format", "markdown", "--store", dbPath])).toBe(0)

    const after = createStore("sqlite", dbPath)
    expect(after.events.count("main")).toBe(snapshot.events)
    expect(after.sessions.get("main")?.status).toBe(snapshot.status)
    after.close?.()
  })

  it("export --format 未知值退出 2", async () => {
    seed()
    expect(await runCli(["export", "main", "--format", "pdf", "--store", dbPath])).toBe(2)
  })

  it("--store 的路径不会被误当成 sessionId", async () => {
    seed()
    expect(await runCli(["log", "--store", dbPath, "--session", "main"])).toBe(0)
    expect(stderr()).toContain("session=main")
  })
})
