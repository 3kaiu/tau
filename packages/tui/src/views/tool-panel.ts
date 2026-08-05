// @tau/tui - views/tool-panel.ts:工具执行面板(独立组件;默认 TUI 布局已改为纯流式,
// 工具事件内联进 transcript,本组件供外部/可插拔布局复用)。
// 显示参数摘要(非全文,扫一眼即知模型在干嘛);活跃/最近完成的工具调用列表。
// 事件驱动增量刷新:started -> completed/failed。

import type { Component } from "@earendil-works/pi-tui"
import type { Event } from "@tau/contract"
import { statusColor } from "../theme.ts"
import { truncateToWidth } from "@earendil-works/pi-tui"

type ToolEntry = {
  toolCallId: string
  name: string
  state: "started" | "completed" | "failed"
  argBrief: string
  resultBrief: string | null
  errorBrief: string | null
}

const MAX_ENTRIES = 20

function briefArgs(args?: Record<string, unknown>): string {
  if (args === undefined) return ""
  const keys = Object.keys(args)
  if (keys.length === 0) return ""
  const main = keys.find((k) => k === "path" || k === "command" || k === "text" || k === "file")
  if (main !== undefined) return truncateToWidth(String(args[main]), 50)
  return truncateToWidth(JSON.stringify(args), 50)
}

function briefResult(result: { stdout?: string | null; stderr?: string | null; exitCode?: number | null }): string {
  const out = result.stdout ?? ""
  if (out !== "") return truncateToWidth(out, 80)
  if (result.stderr) return truncateToWidth(result.stderr, 80)
  return `exit ${result.exitCode ?? 0}`
}

export class ToolPanelView implements Component {
  private entries: ToolEntry[] = []
  private activeCount = 0
  private cachedLines: string[] | null = null
  private cachedWidth = -1

  consume(event: Event): void {
    if (event.kind !== "tool") return
    const existing = this.entries.find((e) => e.toolCallId === event.toolCallId)
    if (existing) {
      existing.state = event.state
      if (event.state === "completed" && event.result) {
        existing.resultBrief = briefResult(event.result)
        this.activeCount = Math.max(0, this.activeCount - 1)
      } else if (event.state === "failed") {
        existing.errorBrief = event.error ? `[${event.error.code}] ${event.error.message}` : "failed"
        this.activeCount = Math.max(0, this.activeCount - 1)
      }
    } else {
      const entry: ToolEntry = {
        toolCallId: event.toolCallId,
        name: event.name,
        state: event.state,
        argBrief: briefArgs(event.args),
        resultBrief: null,
        errorBrief: null,
      }
      if (event.state === "completed" && event.result) {
        entry.resultBrief = briefResult(event.result)
      } else if (event.state === "failed") {
        entry.errorBrief = event.error ? `[${event.error.code}] ${event.error.message}` : "failed"
      } else {
        this.activeCount++
      }
      this.entries.push(entry)
      if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    }
    this.cachedLines = null
  }

  getActiveCount(): number {
    return this.activeCount
  }

  hasActivity(): boolean {
    return this.activeCount > 0
  }

  invalidate(): void {
    this.cachedLines = null
  }

  render(width: number): string[] {
    if (this.cachedLines !== null && this.cachedWidth === width) return this.cachedLines
    this.cachedWidth = width
    if (this.entries.length === 0) {
      this.cachedLines = []
      return this.cachedLines
    }

    const lines: string[] = []
    const recent = this.entries.slice(-8)
    for (const entry of recent) {
      const icon = entry.state === "started" ? "⟳" : entry.state === "completed" ? "✓" : "✗"
      const iconStr = entry.state === "completed" ? statusColor.ok(icon) : entry.state === "failed" ? statusColor.error(icon) : statusColor.accent(icon)
      const nameStr = statusColor.accent(entry.name)
      const argStr = entry.argBrief !== "" ? statusColor.dim(` ${entry.argBrief}`) : ""
      lines.push(truncateToWidth(`${iconStr} ${nameStr}${argStr}`, width))

      if (entry.resultBrief) {
        lines.push(statusColor.dim(`  ↳ ${truncateToWidth(entry.resultBrief, width - 4)}`))
      }
      if (entry.errorBrief) {
        lines.push(statusColor.error(`  ${truncateToWidth(entry.errorBrief, width - 4)}`))
      }
    }
    this.cachedLines = lines
    return lines
  }
}
