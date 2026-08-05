// @tau/tui - views/resource-panel.ts:资源面板(模型/预算/状态)。
// 默认 TUI 布局已改为纯流式(顶部仅一行 Model),本组件保留供外部/可插拔布局复用。
// 渲染快照 + 事件流中的用量/预算信息;只读投影,不直读内核。

import type { Component } from "@earendil-works/pi-tui"
import type { SessionSnapshot } from "@tau/contract"
import { statusColor } from "../theme.ts"
import { truncateToWidth } from "@earendil-works/pi-tui"

export type ResourceState = {
  snapshot: SessionSnapshot | null
  model: string | null
  cwd: string | null
  turn: number
  toolCallsThisTurn: number
  cumulativeTokens: number
  costUsd: number
  pendingCount: number
  activeGoals: number
  busy: boolean
}

export function emptyResourceState(): ResourceState {
  return {
    snapshot: null,
    model: null,
    cwd: null,
    turn: 0,
    toolCallsThisTurn: 0,
    cumulativeTokens: 0,
    costUsd: 0,
    pendingCount: 0,
    activeGoals: 0,
    busy: false,
  }
}

export class ResourcePanelView implements Component {
  private state: ResourceState = emptyResourceState()
  private cachedLines: string[] | null = null

  update(state: Partial<ResourceState>): void {
    this.state = { ...this.state, ...state }
    this.cachedLines = null
  }

  getState(): ResourceState {
    return this.state
  }

  invalidate(): void {
    this.cachedLines = null
  }

  render(width: number): string[] {
    if (this.cachedLines !== null) return this.cachedLines
    const s = this.state
    const parts: string[] = []

    const statusIcon = s.busy ? statusColor.accent("●") : statusColor.dim("○")
    parts.push(statusIcon)

    // 简洁状态栏(参考 kimi-code):常驻仅 busy 点 + model + cwd;
    // 预算/工具数等统计不再常驻,只保留警告性质的 pending/goals。
    if (s.model) parts.push(statusColor.accent(s.model))
    if (s.cwd) parts.push(statusColor.dim(s.cwd))
    if (s.pendingCount > 0) parts.push(statusColor.warn(`pending ${s.pendingCount}`))
    if (s.activeGoals > 0) parts.push(statusColor.accent(`goals ${s.activeGoals}`))

    const line = truncateToWidth(parts.join(" "), width)
    this.cachedLines = [line]
    return this.cachedLines
  }
}
