// @tau/tui - views/transcript.ts:transcript 流渲染。
// 只读投影驱动:订阅 transcript/tool 事件,增量追加行;不直读 store(双视角不变量)。
// 长输出虚拟化:只保留最近 maxLines 行,旧行丢弃(不 DOM 全量重建)。

import type { Component } from "@earendil-works/pi-tui"
import type { ContentBlock, Event, Message } from "@tau/contract"
import { roleColor, statusColor } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

/**
 * 单内容块 → 可见文本。thinking/artifact 是审计7 P1-2/P1-3 新增的契约变体,
 * 必须显式渲染(而非退回 [image]),否则这两类信息在 TUI 不可见(违反双视角不变量)。
 */
function formatBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text
    case "image":
      return statusColor.dim("[image]")
    case "thinking":
      return statusColor.dim(`(thinking) ${b.text}`)
    case "artifact": {
      const meta = [b.mime, b.size !== undefined ? `${b.size}B` : null]
        .filter((x): x is string => x !== null)
        .join(" ")
      const ref = b.ref ? statusColor.dim(` ref=${b.ref}`) : ""
      return `${statusColor.accent(`[artifact${meta ? ` ${meta}` : ""}]`)}${ref}`
    }
  }
}

export type TranscriptOptions = {
  maxLines?: number
}

/** 将一条 Message 格式化为可见行(角色前缀 + 内容摘要)。 */
function formatMessage(msg: Message, width: number): string[] {
  const prefix = formatPrefix(msg)
  const prefixW = visibleWidth(prefix)
  const contentW = Math.max(1, width - prefixW)

  if (msg.role === "tool") {
    return formatToolMessage(msg, prefix, contentW)
  }

  const text = msg.content.map(formatBlock).join("")

  if (text === "" && msg.toolCalls.length === 0) return []

  const lines: string[] = []
  if (text !== "") {
    for (const line of text.split("\n")) {
      lines.push(`${prefix}${wrapLine(line, contentW)}`)
    }
  }
  for (const call of msg.toolCalls) {
    const argBrief = briefArgs(call.name, call.arguments)
    lines.push(`${prefix}${statusColor.accent(`-> ${call.name}`)} ${statusColor.dim(argBrief)}`)
  }
  if (msg.interrupted) {
    lines.push(`${prefix}${statusColor.warn("[interrupted]")}`)
  }
  return lines
}

function formatPrefix(msg: Message): string {
  switch (msg.role) {
    case "user":
      return roleColor.user("> ")
    case "assistant":
      return roleColor.assistant("  ")
    case "tool":
      return roleColor.tool("  ")
    case "system":
      return roleColor.system("# ")
  }
}

function formatToolMessage(msg: Message, prefix: string, contentW: number): string[] {
  const lines: string[] = []
  for (const ref of msg.toolResults) {
    if (ref.error) {
      const errText = `[${ref.error.code}] ${ref.error.message}`
      lines.push(`${prefix}${statusColor.error("✗")} ${truncateToWidth(errText, contentW)}`)
    } else if (ref.result) {
      const out = ref.result.stdout ?? ""
      const preview = out.length > 400 ? `${out.slice(0, 400)}…(${out.length} chars)` : out
      for (const line of preview.split("\n")) {
        lines.push(`${prefix}${statusColor.dim("↳")} ${truncateToWidth(line, contentW)}`)
      }
    }
  }
  return lines
}

function briefArgs(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  if (keys.length === 0) return ""
  const main = keys.find((k) => k === "path" || k === "command" || k === "text" || k === "file")
  if (main !== undefined) {
    const val = String(args[main])
    return truncateToWidth(val, 60)
  }
  return truncateToWidth(JSON.stringify(args), 60)
}

function wrapLine(text: string, width: number): string {
  if (text === "") return ""
  if (visibleWidth(text) <= width) return text
  const chunks: string[] = []
  let current = ""
  for (const char of text) {
    if (visibleWidth(current + char) > width) {
      chunks.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current !== "") chunks.push(current)
  return chunks.join("\n  ")
}

export class TranscriptView implements Component {
  private lines: string[] = []
  private readonly maxLines: number
  private maxRenderLines = 200
  private cachedWidth = -1
  private cachedLines: string[] | null = null

  constructor(opts: TranscriptOptions = {}) {
    this.maxLines = opts.maxLines ?? 500
  }

  /** 设置渲染时最多返回的行数(从底部截取),由 TUI 按终端高度调控。 */
  setMaxRenderLines(n: number): void {
    this.maxRenderLines = n
    this.cachedLines = null
  }

  /** 消费事件:只处理 transcript/tool/告警类,其余忽略(事件订阅按视图裁剪)。 */
  consume(event: Event): void {
    switch (event.kind) {
      case "transcript": {
        this.appendLines(formatMessage(event.message, 80))
        break
      }
      case "retry":
        this.appendLines([statusColor.warn(`(retry ${event.attempts}: ${event.cause})`)])
        break
      case "interrupted":
        this.appendLines([statusColor.warn(`(interrupted: ${event.targetId})`)])
        break
      case "loop_detected":
        this.appendLines([statusColor.error(`(loop: ${event.pattern})`)])
        break
      case "budget_exceeded":
        this.appendLines([statusColor.warn(`(budget: ${event.metric} ${event.used}/${event.limit})`)])
        break
      case "model_switched":
        this.appendLines([statusColor.accent(`(model: ${event.from} -> ${event.to})`)])
        break
      case "compression":
        this.appendLines([statusColor.dim(`(compacted ${event.droppedIds.length} msgs)`)])
        break
      case "recovery":
        this.appendLines([statusColor.warn(`(recovery: ${event.detail ?? event.from})`)])
        break
      default:
        break
    }
  }

  private appendLines(newLines: string[]): void {
    this.lines.push(...newLines)
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines)
    }
    this.cachedLines = null
  }

  /** 直接覆盖行(print 模式 / 快照恢复用)。 */
  setLines(lines: string[]): void {
    this.lines = lines.slice(-this.maxLines)
    this.cachedLines = null
  }

  getLineCount(): number {
    return this.lines.length
  }

  invalidate(): void {
    this.cachedLines = null
  }

  render(width: number): string[] {
    if (this.cachedLines !== null && this.cachedWidth === width) return this.cachedLines
    this.cachedWidth = width
    this.cachedLines = this.lines.slice(-this.maxRenderLines)
    return this.cachedLines
  }
}
