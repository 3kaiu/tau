// @tau/tui - views/info-dialog.ts:信息弹窗(帮助/模型列表等只读展示)。
// 覆盖在 transcript 之上,不破坏对话;任意键/Enter/Esc 关闭。
// 与 PermissionPopup 同构:Focusable + handleInput + render 行。

import type { Component, Focusable } from "@earendil-works/pi-tui"
import { statusColor } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export class InfoDialog implements Component, Focusable {
  focused = false
  private lines: string[] = []
  private title = ""
  private onDismiss?: (() => void) | undefined
  private cachedLines: string[] | null = null

  show(title: string, lines: string[], onDismiss?: () => void): void {
    this.title = title
    this.lines = lines
    this.onDismiss = onDismiss
    this.cachedLines = null
  }

  isActive(): boolean {
    return this.lines.length > 0
  }

  dismiss(): void {
    const cb = this.onDismiss
    this.onDismiss = undefined
    this.lines = []
    this.cachedLines = null
    cb?.()
  }

  handleInput(_data: string): void {
    if (!this.isActive()) return
    // 任意键关闭(Enter/Esc/空格/任意字符)
    this.dismiss()
  }

  invalidate(): void {
    this.cachedLines = null
  }

  render(width: number): string[] {
    if (this.cachedLines !== null) return this.cachedLines
    const boxW = Math.min(width - 4, 72)
    const innerW = boxW - 4
    const lines: string[] = []
    const side = statusColor.accent("│")

    lines.push(statusColor.accent("┌" + "─".repeat(boxW - 2) + "┐"))
    const titleLine = ` ${this.title} `
    const titlePad = Math.max(0, boxW - 2 - visibleWidth(titleLine))
    lines.push(`${side}${titleLine}${" ".repeat(titlePad)}${side}`)
    lines.push(statusColor.accent("├" + "─".repeat(boxW - 2) + "┤"))

    for (const l of this.lines.slice(0, 40)) {
      const content = truncateToWidth(l, innerW)
      const pad = Math.max(0, boxW - 4 - visibleWidth(content))
      lines.push(`${side} ${content}${" ".repeat(pad)} ${side}`)
    }

    lines.push(statusColor.accent("└" + "─".repeat(boxW - 2) + "┘"))
    const hint = statusColor.dim("  任意键关闭")
    lines.push(hint)
    this.cachedLines = lines
    return lines
  }
}