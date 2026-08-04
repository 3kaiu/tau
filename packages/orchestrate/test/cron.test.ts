// @tau/orchestrate — cron 测试:五段子集解析 / 下次命中 / 到点判定 / 调度表持久化。
// 纯函数为主,离线可跑;时间一律构造本地 Date(与 cronMatches 时区语义一致)。

import { describe, expect, it } from "vitest"
import { createMemoryStore } from "@tau/store"
import {
  cronMatches,
  dueEntries,
  isDue,
  loadSchedules,
  markRan,
  nextAfter,
  parseCron,
  removeSchedule,
  upsertSchedule,
  type ScheduleEntry,
} from "../src/index.ts"

function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

describe("parseCron:五段最小子集", () => {
  it("通配 / 定值 / 步长 / 区间 / 列表", () => {
    expect(parseCron("* * * * *")?.minute).toHaveLength(60)
    expect(parseCron("30 9 * * *")?.minute).toEqual([30])
    expect(parseCron("30 9 * * *")?.hour).toEqual([9])
    expect(parseCron("*/15 * * * *")?.minute).toEqual([0, 15, 30, 45])
    expect(parseCron("0 9-11 * * *")?.hour).toEqual([9, 10, 11])
    expect(parseCron("0 0 1,15 * *")?.dom).toEqual([1, 15])
  })

  it("周日 7 与 0 同义", () => {
    expect(parseCron("0 0 * * 7")?.dow).toEqual([0])
  })

  it("别名展开", () => {
    expect(parseCron("@daily")).toEqual(parseCron("0 0 * * *"))
    expect(parseCron("@weekly")?.dow).toEqual([0])
  })

  it("非法表达式返回 null(调用方给可操作报错)", () => {
    expect(parseCron("* * * *")).toBeNull()
    expect(parseCron("61 * * * *")).toBeNull()
    expect(parseCron("* 25 * * *")).toBeNull()
    expect(parseCron("abc * * * *")).toBeNull()
    expect(parseCron("*/0 * * * *")).toBeNull()
    expect(parseCron("5-1 * * * *")).toBeNull()
  })

  it("restricted 标志区分 * 与显式取值(cron 的 dom/dow 或语义)", () => {
    const spec = parseCron("0 0 13 * 5")
    expect(spec?.domRestricted).toBe(true)
    expect(spec?.dowRestricted).toBe(true)
    // 13 号或周五任一命中即算
    expect(cronMatches(spec!, at(2026, 3, 13, 0, 0))).toBe(true) // 13 号
    expect(cronMatches(spec!, at(2026, 3, 6, 0, 0))).toBe(true) // 周五
    expect(cronMatches(spec!, at(2026, 3, 7, 0, 0))).toBe(false)
  })
})

describe("nextAfter:下次命中", () => {
  it("严格晚于 from(同一分钟不重复命中)", () => {
    const spec = parseCron("0 9 * * *")!
    const from = at(2026, 3, 2, 9, 0)
    expect(nextAfter(spec, from)).toEqual(at(2026, 3, 3, 9, 0))
  })

  it("跨天 / 跨月推进", () => {
    const spec = parseCron("30 23 * * *")!
    expect(nextAfter(spec, at(2026, 1, 31, 23, 31))).toEqual(at(2026, 2, 1, 23, 30))
  })

  it("每 15 分钟", () => {
    const spec = parseCron("*/15 * * * *")!
    expect(nextAfter(spec, at(2026, 3, 2, 10, 1))).toEqual(at(2026, 3, 2, 10, 15))
  })

  it("366 天内无命中返回 null(2 月 30 日不存在)", () => {
    const spec = parseCron("0 0 30 2 *")!
    expect(nextAfter(spec, at(2026, 1, 1, 0, 0))).toBeNull()
  })
})

describe("isDue:到点判定(纯函数)", () => {
  const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
    id: "s1",
    cron: "0 9 * * *",
    sessionId: "main",
    goalText: "跑每日回归",
    createdAt: at(2026, 3, 2, 8, 0).toISOString(),
    lastRunAt: null,
    ...over,
  })

  it("越过命中时刻即到点", () => {
    expect(isDue(entry(), at(2026, 3, 2, 9, 1))).toBe(true)
  })

  it("未到点不触发", () => {
    expect(isDue(entry(), at(2026, 3, 2, 8, 59))).toBe(false)
  })

  it("lastRunAt 是幂等锚点:同一命中不重复触发", () => {
    const fired = entry({ lastRunAt: at(2026, 3, 2, 9, 0).toISOString() })
    expect(isDue(fired, at(2026, 3, 2, 9, 30))).toBe(false)
    expect(isDue(fired, at(2026, 3, 3, 9, 0))).toBe(true)
  })

  it("非法 cron 永不到点(坏条目不阻塞其他调度)", () => {
    expect(isDue(entry({ cron: "坏表达式" }), at(2030, 1, 1, 0, 0))).toBe(false)
    const list = [entry({ id: "bad", cron: "x" }), entry({ id: "ok" })]
    expect(dueEntries(list, at(2026, 3, 2, 9, 1)).map((e) => e.id)).toEqual(["ok"])
  })
})

describe("调度表持久化(store.kv,不新建表)", () => {
  it("upsert 同 id 覆盖 / remove / markRan", () => {
    const store = createMemoryStore()
    const base: ScheduleEntry = {
      id: "daily",
      cron: "0 9 * * *",
      sessionId: "main",
      goalText: "回归",
      createdAt: at(2026, 3, 2, 8, 0).toISOString(),
      lastRunAt: null,
    }
    upsertSchedule(store, base)
    upsertSchedule(store, { ...base, goalText: "回归 v2" })
    expect(loadSchedules(store)).toHaveLength(1)
    expect(loadSchedules(store)[0]?.goalText).toBe("回归 v2")

    upsertSchedule(store, { ...base, id: "weekly", cron: "@weekly" })
    expect(loadSchedules(store)).toHaveLength(2)

    markRan(store, "daily", at(2026, 3, 2, 9, 0).toISOString())
    expect(loadSchedules(store).find((e) => e.id === "daily")?.lastRunAt).toBe(at(2026, 3, 2, 9, 0).toISOString())

    expect(removeSchedule(store, "weekly")).toBe(true)
    expect(removeSchedule(store, "不存在")).toBe(false)
    expect(loadSchedules(store).map((e) => e.id)).toEqual(["daily"])
  })

  it("kv 内容损坏时降级为空表,不抛", () => {
    const store = createMemoryStore()
    store.kv.set("schedules", "{ 不是 JSON")
    expect(loadSchedules(store)).toEqual([])
  })
})
