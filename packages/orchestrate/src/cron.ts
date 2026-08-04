// @tau/orchestrate — cron.ts:定时唤醒(调度表 + 持久化)。
// 零新依赖:五段 cron 最小子集自实现,分钟粒度;调度表落 store.kv,不新写内核。

import type { Store } from "@tau/store"

/** 解析后的 cron 规格。dom/dow 的 restricted 标志用于表达 cron 的"或"语义。 */
export type CronSpec = {
  minute: readonly number[]
  hour: readonly number[]
  dom: readonly number[]
  month: readonly number[]
  dow: readonly number[]
  domRestricted: boolean
  dowRestricted: boolean
}

/** 调度条目:cron 到点 → 向 sessionId 注入 goalText 作为目标。 */
export type ScheduleEntry = {
  id: string
  cron: string
  sessionId: string
  goalText: string
  createdAt: string
  lastRunAt: string | null
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
}

function range(min: number, max: number): number[] {
  const out: number[] = []
  for (let i = min; i <= max; i++) out.push(i)
  return out
}

/** 单字段解析:`*` / `n` / `a-b` / `*\/n` / `a-b/n` / 逗号列表。非法返回 null(调用方给可操作报错)。 */
function parseField(raw: string, min: number, max: number, normalize?: (n: number) => number): number[] | null {
  const values = new Set<number>()
  for (const part of raw.split(",")) {
    const [spec, stepRaw] = part.split("/")
    if (spec === undefined || spec === "") return null
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null

    let base: number[]
    if (spec === "*") {
      base = range(min, max)
    } else if (spec.includes("-")) {
      const [aRaw, bRaw] = spec.split("-")
      const a = Number(aRaw)
      const b = Number(bRaw)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) return null
      base = range(a, b)
    } else {
      const n = Number(spec)
      if (!Number.isInteger(n)) return null
      base = [n]
    }

    for (let i = 0; i < base.length; i++) {
      if (i % step !== 0) continue
      const v = normalize?.(base[i]!) ?? base[i]!
      if (v < min || v > max) return null
      values.add(v)
    }
  }
  return values.size === 0 ? null : [...values].sort((a, b) => a - b)
}

/** 解析五段 cron(分 时 日 月 周)或 @hourly/@daily/@weekly/@monthly/@yearly 别名。非法返回 null。 */
export function parseCron(expr: string): CronSpec | null {
  const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr.trim()
  const fields = normalized.split(/\s+/)
  if (fields.length !== 5) return null
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string]

  const minute = parseField(m, 0, 59)
  const hour = parseField(h, 0, 23)
  const domV = parseField(dom, 1, 31)
  const month = parseField(mon, 1, 12)
  // 周:7 与 0 同义(周日)
  const dowV = parseField(dow, 0, 6, (n) => (n === 7 ? 0 : n))
  if (minute === null || hour === null || domV === null || month === null || dowV === null) return null

  return {
    minute,
    hour,
    dom: domV,
    month,
    dow: dowV,
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  }
}

/** 日期面匹配:dom 与 dow 都受限时取"或"(标准 cron 语义)。 */
function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.month.includes(d.getMonth() + 1)) return false
  const domOk = spec.dom.includes(d.getDate())
  const dowOk = spec.dow.includes(d.getDay())
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  if (spec.domRestricted) return domOk
  if (spec.dowRestricted) return dowOk
  return true
}

/** 某一分钟是否命中(本地时区,与用户书写的 cron 直觉一致)。 */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  return dayMatches(spec, date) && spec.hour.includes(date.getHours()) && spec.minute.includes(date.getMinutes())
}

/** 严格晚于 from 的下一个命中时刻;366 天内无命中返回 null。
 * 逐日/逐时跳跃而非逐分扫描:最坏 366 + 24 + 60 步,不做全年分钟遍历。 */
export function nextAfter(spec: CronSpec, from: Date): Date | null {
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000

  while (cursor.getTime() <= limit) {
    if (!dayMatches(spec, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!spec.hour.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (spec.minute.includes(cursor.getMinutes())) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
  }
  return null
}

/** 到点判定:上次运行(或创建)之后是否已越过一个命中时刻。纯函数,eval 可离线断言。 */
export function isDue(entry: ScheduleEntry, now: Date): boolean {
  const spec = parseCron(entry.cron)
  if (spec === null) return false
  const since = new Date(entry.lastRunAt ?? entry.createdAt)
  if (Number.isNaN(since.getTime())) return false
  const next = nextAfter(spec, since)
  return next !== null && next.getTime() <= now.getTime()
}

export function dueEntries(entries: readonly ScheduleEntry[], now: Date): readonly ScheduleEntry[] {
  return entries.filter((e) => isDue(e, now))
}

// ---------- 持久化(store.kv,不新建表) ----------

export const SCHEDULES_KEY = "schedules"

export function loadSchedules(store: Store): ScheduleEntry[] {
  const raw = store.kv.get(SCHEDULES_KEY)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as ScheduleEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveSchedules(store: Store, entries: readonly ScheduleEntry[]): void {
  store.kv.set(SCHEDULES_KEY, JSON.stringify(entries))
}

/** 同 id 覆盖,否则追加。返回写入后的全量表。 */
export function upsertSchedule(store: Store, entry: ScheduleEntry): ScheduleEntry[] {
  const entries = loadSchedules(store)
  const idx = entries.findIndex((e) => e.id === entry.id)
  if (idx >= 0) entries[idx] = entry
  else entries.push(entry)
  saveSchedules(store, entries)
  return entries
}

export function removeSchedule(store: Store, id: string): boolean {
  const entries = loadSchedules(store)
  const next = entries.filter((e) => e.id !== id)
  if (next.length === entries.length) return false
  saveSchedules(store, next)
  return true
}

/** 记录本次触发时刻(幂等锚点:下次 isDue 从此刻起算,防同一命中重复触发)。 */
export function markRan(store: Store, id: string, atIso: string): void {
  const entries = loadSchedules(store)
  const idx = entries.findIndex((e) => e.id === id)
  if (idx < 0) return
  entries[idx] = { ...entries[idx]!, lastRunAt: atIso }
  saveSchedules(store, entries)
}
