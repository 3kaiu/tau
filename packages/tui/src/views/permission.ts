// @tau/tui - views/permission.ts:权限批准弹窗。
// 渲染 permission_request 的参数摘要(命令全文/目标路径/理由),用户批准前看到"模型要跑什么"。
// 批准是显式 Command(approve),不是渲染层技巧;deny 也是 Command(经 answer 传 false 或 approve 传拒绝)。
// 安全链最后一环:tui 渲染 summary 字段,面层原样透传不裁剪。

import chalk from "chalk"
import type { Component, Focusable } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"
import type { PermissionEvent } from "@tau/contract"
import { statusColor } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

export type PermissionDecision = {
  requestId: string
  toolName: string
  approved: boolean
}

export class PermissionPopup implements Component, Focusable {
  focused = false
  private request: PermissionEvent | null = null
  private onSelect?: ((decision: PermissionDecision) => void) | undefined
  private selected = 0
  private cachedLines: string[] | null = null

  isActive(): boolean {
    return this.request !== null
  }

  show(event: PermissionEvent, onSelect: (decision: PermissionDecision) => void): void {
    this.request = event
    this.onSelect = onSelect
    this.selected = 0
    this.cachedLines = null
  }

  dismiss(): void {
    this.request = null
    this.onSelect = undefined
    this.cachedLines = null
  }

  getRequest(): PermissionEvent | null {
    return this.request
  }

  handleInput(data: string): void {
    if (this.request === null) return
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.selected = 0
      this.cachedLines = null
    } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
      this.selected = 1
      this.cachedLines = null
    } else if (matchesKey(data, "enter")) {
      const req = this.request
      const approved = this.selected === 0
      const cb = this.onSelect
      this.dismiss()
      cb?.({ requestId: req.requestId, toolName: req.toolName, approved })
    } else if (matchesKey(data, "y")) {
      const req = this.request
      const cb = this.onSelect
      this.dismiss()
      cb?.({ requestId: req.requestId, toolName: req.toolName, approved: true })
    } else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
      const req = this.request
      const cb = this.onSelect
      this.dismiss()
      cb?.({ requestId: req.requestId, toolName: req.toolName, approved: false })
    }
  }

  invalidate(): void {
    this.cachedLines = null
  }

  render(width: number): string[] {
    if (this.cachedLines !== null) return this.cachedLines
    if (this.request === null) return []

    const req = this.request
    const innerW = Math.min(width - 4, 72)
    const lines: string[] = []

    const topBorder = statusColor.warn("┌" + "─".repeat(innerW) + "┐")
    const botBorder = statusColor.warn("└" + "─".repeat(innerW) + "┘")
    const sideBar = statusColor.warn("│")

    lines.push(topBorder)
    lines.push(`${sideBar} ${chalk.yellow.bold("⚠ 权限请求")}${" ".repeat(Math.max(0, innerW - visibleWidth("⚠ 权限请求") - 1))} ${sideBar}`)

    const toolLine = `工具: ${req.toolName}`
    lines.push(`${sideBar} ${truncateToWidth(toolLine, innerW)}${padTo(toolLine, innerW)} ${sideBar}`)

    const summaryLines = wrapText(req.summary, innerW - 2)
    lines.push(`${sideBar}${" ".repeat(innerW + 2)}${sideBar}`)
    for (const sl of summaryLines) {
      lines.push(`${sideBar} ${truncateToWidth(sl, innerW)}${padTo(sl, innerW)} ${sideBar}`)
    }

    lines.push(`${sideBar}${" ".repeat(innerW + 2)}${sideBar}`)

    const yesLabel = this.selected === 0 ? chalk.yellow.bold("[ Y 批准 ]") : statusColor.dim("[ Y 批准 ]")
    const noLabel = this.selected === 1 ? chalk.red.bold("[ N 拒绝 ]") : statusColor.dim("[ N 拒绝 ]")
    const choiceLine = `  ${yesLabel}    ${noLabel}`
    const choicePad = Math.max(0, innerW - visibleWidth(choiceLine))
    lines.push(`${sideBar} ${choiceLine}${" ".repeat(choicePad)} ${sideBar}`)

    lines.push(botBorder)
    this.cachedLines = lines
    return lines
  }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text)
  return w >= width ? "" : " ".repeat(width - w)
}

function wrapText(text: string, width: number): string[] {
  if (text === "") return [""]
  const lines: string[] = []
  for (const para of text.split("\n")) {
    if (para === "") {
      lines.push("")
      continue
    }
    let current = ""
    for (const word of para.split(" ")) {
      if (visibleWidth(current + (current === "" ? "" : " ") + word) > width) {
        lines.push(current)
        current = word
      } else {
        current = current === "" ? word : `${current} ${word}`
      }
    }
    if (current !== "") lines.push(current)
  }
  return lines
}
