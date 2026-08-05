// @tau/tui - views/footer.ts:底部状态栏(参考 kimi-code FooterComponent)。
// 双行:Line1 = 模型 + busy 点 + goal/pending 徽标 + 右侧 tips;
//       Line2 = 左侧 transient 提示 + 右侧 context 用量。
// 只读事件驱动:usage/budget/goal/permission 事件累计进状态,不直读 store。

import type { Component } from "@earendil-works/pi-tui"
import type { Event } from "@tau/contract"
import { statusColor } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export type FooterState = {
  model: string | null
  cwd: string | null
  busy: boolean
  cumulativeTokens: number
  maxContextTokens: number | null
  pendingCount: number
  activeGoals: number
}

export function emptyFooterState(): FooterState {
  return {
    model: null,
    cwd: null,
    busy: false,
    cumulativeTokens: 0,
    maxContextTokens: null,
    pendingCount: 0,
    activeGoals: 0,
  }
}

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

    // ── Line1:模型 + busy + goal/pending + 右侧 tips ──
    const left: string[] = []
    if (this.state.model) left.push(statusColor.accent(this.state.model))
    if (this.state.busy) left.push(statusColor.dim("●"))
    if (this.state.activeGoals > 0) left.push(statusColor.accent(`[goal ${this.state.activeGoals}]`))
    if (this.state.pendingCount > 0) left.push(statusColor.warn(`[pending ${this.state.pendingCount}]`))
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

  private tipForWidth(width: number, leftLine: string): string | null {
    const tip = "Ctrl+T 展开思考 · Ctrl+C 打断/退出"
    if (visibleWidth(leftLine) + visibleWidth(tip) + 2 > width) return null
    return statusColor.dim(tip)
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}