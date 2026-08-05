// @tau/tui - views/footer.ts:底部状态栏(还原 kimi-code FooterComponent)。
// 双行:Line1 = slots 拼接(mode/goal/model/tasks/cwd/git)+ 右侧 tips(10s 轮换);
//       Line2 = 左侧 transient 提示 + 右侧 context 用量。
// 只读事件驱动:usage/budget/goal/permission 事件累计进状态;git/mode 由外部注入,不直读内核。

import type { Component } from "@earendil-works/pi-tui"
import type { Event, GitStatus } from "@tau/contract"
import { statusColor, uiColor } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export type FooterState = {
  model: string | null
  /** thinking effort 后缀(如 "high"/"off");null 不显示。 */
  thinkingEffort: string | null
  cwd: string | null
  /** permission 模式:auto/ask/yolo 等;null 不显示。 */
  mode: string | null
  git: GitStatus | null
  busy: boolean
  cumulativeTokens: number
  maxContextTokens: number | null
  pendingCount: number
  activeGoals: number
}

export function emptyFooterState(): FooterState {
  return {
    model: null,
    thinkingEffort: null,
    cwd: null,
    mode: null,
    git: null,
    busy: false,
    cumulativeTokens: 0,
    maxContextTokens: null,
    pendingCount: 0,
    activeGoals: 0,
  }
}

/** Line1 slot 顺序(参考 kimi DEFAULT_STATUS_LINE_ITEMS)。 */
const STATUS_LINE_ITEMS = ["busy", "mode", "goal", "model", "pending", "cwd", "git"] as const

/** tips 轮换(参考 kimi ROTATION):短提示成对展示,宽终端两两组合。 */
const TIPS: { text: string; solo?: boolean }[] = [
  { text: "/help 查看命令" },
  { text: "Ctrl+T 展开思考 · Ctrl+O 工具结果" },
  { text: "Ctrl+C 打断 · 双击退出" },
  { text: "Ctrl+S 生成中补充指令", solo: true },
  { text: "Shift+Enter 换行" },
  { text: "/model <id> 切换模型" },
  { text: "/abort 终止当前 turn" },
]
const TIP_ROTATE_MS = 10_000
const TIP_SEPARATOR = " | "

export class FooterComponent implements Component {
  private state: FooterState = emptyFooterState()
  private transientHint: string | null = null
  private cachedLines: string[] | null = null
  private cachedWidth = -1

  update(state: Partial<FooterState>): void {
    this.state = { ...this.state, ...state }
    this.cachedLines = null
  }

  /** 事件 → 状态累计(footer 只吃用量/预算/目标/权限四类;其余忽略)。 */
  consume(event: Event): void {
    switch (event.kind) {
      case "usage":
        this.state.cumulativeTokens = event.cumulativeTokens
        this.state.busy = false
        break
      case "budget_exceeded":
        this.state.maxContextTokens = event.limit
        this.transientHint = `${event.metric} 超限:${event.used}/${event.limit}`
        break
      case "goal":
        this.state.activeGoals = Math.max(0, event.status === "completed" || event.status === "blocked" ? this.state.activeGoals - 1 : this.state.activeGoals)
        break
      case "permission":
        if (event.state === "requested") this.state.pendingCount += 1
        else this.state.pendingCount = Math.max(0, this.state.pendingCount - 1)
        break
      case "interrupted":
        this.state.busy = false
        this.transientHint = `已打断 ${event.targetId}`
        break
      case "retry":
        this.transientHint = `重试 ${event.attempts}:${event.cause}`
        break
      default:
        break
    }
    this.cachedLines = null
  }

  setBusy(busy: boolean): void {
    if (this.state.busy === busy) return
    this.state.busy = busy
    this.cachedLines = null
  }

  /** 短暂提示(如命令未接受),下一次渲染后保留直到被新提示覆盖。 */
  setTransient(text: string): void {
    this.transientHint = text
    this.cachedLines = null
  }

  getState(): FooterState {
    return this.state
  }

  invalidate(): void {
    this.cachedLines = null
  }

  render(width: number): string[] {
    if (this.cachedLines !== null && this.cachedWidth === width) return this.cachedLines
    this.cachedWidth = width

    // ── Line1:slots 拼接 + 右侧 tips ──
    const slots = this.buildSlots()
    const left: string[] = []
    for (const slot of STATUS_LINE_ITEMS) {
      const pieces = slots[slot]
      if (pieces !== undefined) left.push(...pieces)
    }
    const leftLine = left.join("  ")

    const tip = this.tipForWidth(width, leftLine)
    let line1: string
    if (tip !== null) {
      const pad = Math.max(0, width - visibleWidth(leftLine) - visibleWidth(tip) - 2)
      line1 = truncateToWidth(leftLine, Math.max(0, width - visibleWidth(tip) - 2)) + " ".repeat(pad) + tip
    } else {
      line1 = truncateToWidth(leftLine, width)
    }

    // ── Line2:左侧 transient 提示 + 右侧 context 用量 ──
    const contextText = this.formatContext()
    const contextWidth = visibleWidth(contextText)
    let line2: string
    if (this.transientHint !== null) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1)
      const shown = visibleWidth(this.transientHint) <= maxHintWidth ? this.transientHint : truncateToWidth(this.transientHint, maxHintWidth)
      const pad = Math.max(0, width - visibleWidth(shown) - contextWidth)
      line2 = statusColor.warn(shown) + " ".repeat(pad) + statusColor.dim(contextText)
    } else {
      line2 = " ".repeat(Math.max(0, width - contextWidth)) + statusColor.dim(contextText)
    }

    this.cachedLines = [truncateToWidth(line1, width), truncateToWidth(line2, width)]
    return this.cachedLines
  }

  /** 各 slot 的可见片段;空内容返回空数组(跳过)。 */
  private buildSlots(): Record<string, string[]> {
    const s = this.state
    const slots: Record<string, string[]> = {}

    if (s.busy) slots.busy = [uiColor.primary("●")]

    if (s.mode !== null) slots.mode = [statusColor.warn(s.mode)]

    if (s.activeGoals > 0) {
      slots.goal = [statusColor.accent(`[goal ${s.activeGoals}]`)]
    }

    if (s.model !== null) {
      const suffix = s.thinkingEffort !== null && s.thinkingEffort !== "off" ? ` thinking: ${s.thinkingEffort}` : ""
      slots.model = [uiColor.primary(`${s.model}${suffix}`)]
    }

    if (s.pendingCount > 0) slots.pending = [statusColor.warn(`[pending ${s.pendingCount}]`)]

    if (s.cwd !== null) slots.cwd = [uiColor.muted(shortenCwd(s.cwd))]

    if (s.git !== null) slots.git = [formatGitBadge(s.git)]

    return slots
  }

  private tipForWidth(width: number, leftLine: string): string | null {
    const { primary, pair } = tipsForIndex()
    const best = pair ?? primary
    if (best === "") return null
    if (visibleWidth(leftLine) + visibleWidth(best) + 2 > width) return null
    return statusColor.dim(best)
  }

  private formatContext(): string {
    const n = this.state.cumulativeTokens
    if (this.state.maxContextTokens !== null && this.state.maxContextTokens > 0) {
      const pct = Math.round((n / this.state.maxContextTokens) * 100)
      return `context: ${pct}% (${formatTokens(n)}/${formatTokens(this.state.maxContextTokens)})`
    }
    if (n > 0) return `context: ${formatTokens(n)} tok`
    return ""
  }
}

/** tips 轮换:10s 一换;当前/下一条非 solo 且不同 → 成对。 */
function tipsForIndex(): { primary: string; pair: string | null } {
  const n = TIPS.length
  if (n === 0) return { primary: "", pair: null }
  const index = Math.floor(Date.now() / TIP_ROTATE_MS)
  const offset = ((index % n) + n) % n
  const current = TIPS[offset]!
  if (n === 1 || current.solo === true) return { primary: current.text, pair: null }
  const next = TIPS[(offset + 1) % n]!
  if (next.solo === true || next.text === current.text) return { primary: current.text, pair: null }
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text }
}

function formatGitBadge(git: GitStatus): string {
  const branch = git.branch ?? "?"
  const dirty = git.dirty ? statusColor.warn("●") : ""
  return `${statusColor.dim("git:")} ${statusColor.dim(branch)}${dirty}`
}

function shortenCwd(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p !== "")
  const max = 3
  if (parts.length <= max) return cwd
  const head = parts.slice(0, 2).join("/")
  const tail = parts.slice(-1).join("/")
  return `…/${tail} (${head}/…)`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}