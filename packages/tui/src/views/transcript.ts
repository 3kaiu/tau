// @tau/tui - views/transcript.ts:transcript 流渲染。
// 只读投影驱动:订阅 transcript/tool 事件,增量追加行;不直读 store(双视角不变量)。
// 收敛为两条通道:已提交行(lines,来自 transcript 等终态事件)与进行中流式行(pending,
// 来自 text_delta 增量预览)。进行中行在收到本 turn 终态 transcript 事件时被清空/替换。
// 长输出虚拟化:只保留最近 maxLines 行,旧行丢弃(不 DOM 全量重建)。
// 换行由 render 按实时宽度驱动,consume 阶段不预 wrap(窄终端不截断中文)。

import type { Component } from "@earendil-works/pi-tui"
import type { ContentBlock, Event, Message } from "@tau/contract"
import { roleColor, statusColor } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

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

/** 用户前缀(单调颜色,截断换行时续行不重复前缀)。 */
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

/** 将一条 Message 格式化为逻辑行(不做宽度截断;换行交由 render)。 */
function formatMessage(msg: Message): string[] {
  const prefix = formatPrefix(msg)

  if (msg.role === "tool") {
    const lines: string[] = []
    for (const ref of msg.toolResults) {
      if (ref.error) {
        lines.push(`${prefix}${statusColor.error("✗")} [${ref.error.code}] ${ref.error.message}`)
      } else if (ref.result) {
        const out = ref.result.stdout ?? ""
        const preview = out.length > 400 ? `${out.slice(0, 400)}…(${out.length} chars)` : out
        for (const line of preview.split("\n")) {
          lines.push(`${prefix}${statusColor.dim("↳")} ${line}`)
        }
      }
    }
    return lines
  }

  const text = msg.content.map(formatBlock).join("")

  if (text === "" && msg.toolCalls.length === 0) return []

  const lines: string[] = []
  if (text !== "") {
    for (const line of text.split("\n")) {
      lines.push(`${prefix}${line}`)
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

export class TranscriptView implements Component {
  private lines: string[] = []
  private readonly maxLines: number
  private maxRenderLines = 200
  private cachedWidth = -1
  private cachedLines: string[] | null = null

  // ---- 流中行:来自 text_delta 的进行中预览 ----
  private streaming = false
  private thinkingBuf = ""
  private textBuf = ""
  private spinnerIdx = 0
  private streamDirty = false

  constructor(opts: TranscriptOptions = {}) {
    this.maxLines = opts.maxLines ?? 500
  }

  /** 设置渲染时最多返回的行数(从底部截取),由 TUI 按终端高度调控。 */
  setMaxRenderLines(n: number): void {
    this.maxRenderLines = n
    this.cachedLines = null
  }

  /** spinner 帧推进(TUI 的 setInterval 驱动),仅在有进行中流时重算。 */
  tick(): void {
    if (!this.streaming) return
    this.spinnerIdx++
    this.streamDirty = true
  }

  /** 是否有进行中的流(供 busy 指示)。 */
  isStreaming(): boolean {
    return this.streaming
  }

  /** 消费事件:transcript/tool 终态落行;text_delta 进进行中缓冲。 */
  consume(event: Event): void {
    switch (event.kind) {
      case "text_delta": {
        if (event.thinking) this.thinkingBuf += event.text
        else this.textBuf += event.text
        this.streaming = true
        this.streamDirty = true
        break
      }
      case "transcript": {
        this.resetStreaming()
        this.appendLines(formatMessage(event.message))
        break
      }
      case "retry":
        this.resetStreaming()
        this.appendLines([statusColor.warn(`(retry ${event.attempts}: ${event.cause})`)])
        break
      case "interrupted":
        this.resetStreaming()
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

  private resetStreaming(): void {
    this.streaming = false
    this.thinkingBuf = ""
    this.textBuf = ""
    this.streamDirty = true
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
    this.resetStreaming()
    this.cachedLines = null
  }

  getLineCount(): number {
    return this.lines.length
  }

  invalidate(): void {
    this.cachedLines = null
  }

  /** 进行中流行的可见文本(thinking/text 各成段,带 spinner)。 */
  private streamLine(): string | null {
    if (!this.streaming) return null
    const parts: string[] = []
    if (this.thinkingBuf !== "") {
      parts.push(statusColor.dim(`(thinking) ${this.thinkingBuf}`))
    }
    if (this.textBuf !== "") {
      parts.push(this.textBuf)
    }
    if (parts.length === 0) return null
    const glyph = statusColor.accent(SPINNER[this.spinnerIdx % SPINNER.length]!)
    return `${roleColor.assistant("  ")} ${glyph} ${parts.join(" ")}`
  }

  render(width: number): string[] {
    const streamLine = this.streamLine()
    const showStream = streamLine !== null
    const cacheStale = this.cachedLines === null || this.cachedWidth !== width || this.streamDirty || showStream !== this.cachedHasStream
    if (cacheStale) {
      this.cachedWidth = width
      this.cachedLines = this.lines.slice(-this.maxRenderLines).map((line) => wrapLine(line, width))
      this.cachedHasStream = false
    }
    this.streamDirty = false
    if (streamLine === null) return this.cachedLines as string[]
    // 有进行中流:不可直接复用缓存(会污染),每次重建并追加流式行
    const base = this.cachedLines as string[]
    const out = base.slice()
    if (out.length >= this.maxRenderLines) out.shift()
    out.push(wrapLine(streamLine, width))
    this.cachedHasStream = true
    return out
  }

  private cachedHasStream = false
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