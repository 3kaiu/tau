// @tau/tui - views/transcript.ts:transcript 流渲染(参考 kimi-code 消息组件化)。
// 只读投影驱动:订阅 transcript/tool 事件,增量追加行;不直读 store(双视角不变量)。
// 收敛为两条通道:已提交行(entries,来自 transcript 等终态事件)与进行中流式行(pending,
// 来自 text_delta 增量预览)。进行中行在收到本 turn 终态 transcript 事件时被清空/替换。
// 长输出虚拟化:只保留最近 maxLines 行,旧行丢弃(不 DOM 全量重建)。
// 换行由 render 按实时宽度驱动,consume 阶段不预 wrap(窄终端不截断中文)。
// thinking 折叠:已提交的 thinking 块默认折叠为摘要行(防长推理刷屏),
// 经 toggleThinking() 展开/收起(kimi-code 风格)。

import type { Component } from "@earendil-works/pi-tui"
import { Markdown } from "@earendil-works/pi-tui"
import type { ContentBlock, Event, Message } from "@tau/contract"
import { roleColor, statusColor, markdownTheme } from "../theme.ts"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** kimi-code 共享符号:assistant 回复 bullet、user 输入 bullet、工具结果标记。 */
const STATUS_BULLET = "● "
const USER_BULLET = "✨ "
const MESSAGE_INDENT = "  "

/** thinking 折叠预览的最大物理行数(参考 kimi THINKING_PREVIEW_LINES=2)。 */
const THINKING_PREVIEW_LINES = 2

export type TranscriptOptions = {
  maxLines?: number
  /** 保留的最近轮数(user 消息计为轮边界;0 = 禁用轮裁剪,仅按 maxLines)。 */
  maxTurns?: number
  /** 左侧 gutter(对齐输入框内区,参考 kimi CHROME_GUTTER)。 */
  leftPad?: number
}

/** 已提交行:普通文本行 / markdown 块(assistant 正文,md 渲染) / thinking 块(可折叠) / 工具行(进行中/完成)。 */
type Entry =
  | { kind: "text"; text: string }
  | { kind: "md"; text: string }
  | { kind: "thinking"; msgId: string; text: string; expanded: boolean }
  | { kind: "tool"; toolCallId: string; name: string; args: string; state: "running" | "done" | "failed"; resultBrief: string | null; expanded: boolean }

/** 用户前缀(单调颜色,截断换行时续行不重复前缀)。 */
function formatPrefix(msg: Message): string {
  switch (msg.role) {
    case "user":
      return USER_BULLET
    case "assistant":
      return STATUS_BULLET
    case "tool":
      return MESSAGE_INDENT
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

/** 将一条 Message 格式化为 Entry 序列(不做宽度截断;换行交由 render)。 */
function formatMessage(msg: Message): Entry[] {
  const prefix = formatPrefix(msg)

  if (msg.role === "tool") {
    const lines: Entry[] = []
    for (const ref of msg.toolResults) {
      if (ref.error) {
        lines.push({ kind: "text", text: `${MESSAGE_INDENT}${statusColor.error("✗")} [${ref.error.code}] ${ref.error.message}` })
      } else if (ref.result) {
        const out = ref.result.stdout ?? ""
        const preview = out.length > 400 ? `${out.slice(0, 400)}…(${out.length} chars)` : out
        for (const line of preview.split("\n")) {
          lines.push({ kind: "text", text: `${MESSAGE_INDENT}${statusColor.dim("↳")} ${line}` })
        }
      }
    }
    return lines
  }

  // thinking 块独立成可折叠 entry;其余块(text/artifact/image)合并为文本流。
  // assistant 的正文合并为单一 md entry(整段 markdown 渲染,kimi-code 风格);
  // 其他角色(user/system)按纯文本行处理。
  const textParts: string[] = []
  const entries: Entry[] = []
  const flushText = (): void => {
    const text = textParts.join("")
    if (text === "") return
    if (msg.role === "assistant") {
      entries.push({ kind: "md", text: text.trim() })
    } else {
      for (const line of text.split("\n")) {
        entries.push({ kind: "text", text: `${prefix}${line}` })
      }
    }
    textParts.length = 0
  }
  for (const block of msg.content) {
    if (block.type === "thinking") {
      flushText()
      entries.push({ kind: "thinking", msgId: msg.id, text: block.text, expanded: false })
    } else {
      textParts.push(formatBlock(block))
    }
  }
  flushText()

  if (entries.length === 0 && msg.toolCalls.length === 0) return []

  for (const call of msg.toolCalls) {
    const argBrief = briefArgs(call.name, call.arguments)
    entries.push({ kind: "text", text: `${MESSAGE_INDENT}${statusColor.accent(`→ ${call.name}`)} ${statusColor.dim(argBrief)}` })
  }
  if (msg.interrupted) {
    entries.push({ kind: "text", text: `${prefix}${statusColor.warn("[interrupted]")}` })
  }
  return entries
}

/** 单内容块 → 可见文本(thinking 由调用方独立抽取)。 */
function formatBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text
    case "image":
      return statusColor.dim("[image]")
    case "artifact": {
      const meta = [b.mime, b.size !== undefined ? `${b.size}B` : null]
        .filter((x): x is string => x !== null)
        .join(" ")
      const ref = b.ref ? statusColor.dim(` ref=${b.ref}`) : ""
      return `${statusColor.accent(`[artifact${meta ? ` ${meta}` : ""}]`)}${ref}`
    }
    case "thinking":
      return ""
  }
}

export class TranscriptView implements Component {
  private entries: Entry[] = []
  private readonly maxLines: number
  private readonly maxTurns: number
  private maxRenderLines = 200
  private cachedWidth = -1
  private cachedLines: string[] | null = null

  // ---- 流中行:来自 text_delta 的进行中预览 ----
  private streaming = false
  private thinkingBuf = ""
  private textBuf = ""
  private spinnerIdx = 0
  private streamDirty = false
  /** 正在运行的工具数(tool started 未 completed):busy 判定的第二来源。 */
  private runningTools = 0

  constructor(opts: TranscriptOptions = {}) {
    this.maxLines = opts.maxLines ?? 500
    this.maxTurns = opts.maxTurns ?? 0
    this.leftPad = opts.leftPad ?? 0
  }

  /** 设置渲染时最多返回的行数(从底部截取),由 TUI 按终端高度调控。 */
  setMaxRenderLines(n: number): void {
    this.maxRenderLines = n
    this.cachedLines = null
  }

  /** spinner 帧推进(TUI 的 setInterval 驱动),有流或运行中工具时重算。 */
  tick(): void {
    if (!this.streaming && this.runningTools === 0) return
    this.spinnerIdx++
    this.streamDirty = true
  }

  /** 是否有进行中的流或工具(供 busy 指示)。 */
  isStreaming(): boolean {
    return this.streaming || this.runningTools > 0
  }

  /**
   * 切换 thinking 折叠:从最新往前展开下一个未展开的块;全部已展开则全部收起。
   * 参考 kimi-code:思考默认折叠为单行,按需展开。
   */
  toggleThinking(): void {
    const thinkingIdx: number[] = []
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.kind === "thinking") thinkingIdx.push(i)
    }
    if (thinkingIdx.length === 0) return
    if (thinkingIdx.every((i) => (this.entries[i] as Extract<Entry, { kind: "thinking" }>).expanded)) {
      // 全展开 → 全部收起
      for (const i of thinkingIdx) (this.entries[i] as Extract<Entry, { kind: "thinking" }>).expanded = false
    } else {
      // 展开最新一个未展开的
      for (const i of thinkingIdx) {
        const e = this.entries[i] as Extract<Entry, { kind: "thinking" }>
        if (!e.expanded) {
          e.expanded = true
          break
        }
      }
    }
    this.cachedLines = null
  }

  /**
   * 切换工具结果折叠:从最新往前展开下一个有长结果的工具;全部展开则全部收起。
   * 参考 kimi ctrl+o(与 thinking 折叠同语序)。无长结果工具 → 无效。
   */
  toggleTool(): void {
    const toolIdx: number[] = []
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e?.kind === "tool" && e.resultBrief !== null && e.resultBrief !== "" && e.resultBrief.length > 80) toolIdx.push(i)
    }
    if (toolIdx.length === 0) return
    const allExpanded = toolIdx.every((i) => (this.entries[i] as Extract<Entry, { kind: "tool" }>).expanded)
    for (const i of toolIdx) {
      const e = this.entries[i] as Extract<Entry, { kind: "tool" }>
      if (allExpanded) e.expanded = false
      else if (!e.expanded) {
        e.expanded = true
        break
      }
    }
    this.cachedLines = null
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
        // user 消息 = 轮边界:超过 maxTurns 时裁剪最老轮(参考 kimi 滑动窗口,保留最近 N 轮完整)
        if (event.message.role === "user") {
          // 轮间空行分隔(对齐 kimi assistant-message 前导空行)
          if (this.entries.length > 0) this.appendEntries([{ kind: "text", text: "" }])
          if (this.maxTurns > 0) this.trimToMaxTurns()
        }
        this.appendEntries(formatMessage(event.message))
        break
      }
      case "retry":
        this.resetStreaming()
        this.appendEntries([{ kind: "text", text: statusColor.warn(`(retry ${event.attempts}: ${event.cause})`) }])
        break
      case "interrupted":
        this.resetStreaming()
        this.appendEntries([{ kind: "text", text: statusColor.warn(`(interrupted: ${event.targetId})`) }])
        break
      case "loop_detected":
        this.appendEntries([{ kind: "text", text: statusColor.error(`(loop: ${event.pattern})`) }])
        break
      case "budget_exceeded":
        this.appendEntries([{ kind: "text", text: statusColor.warn(`(budget: ${event.metric} ${event.used}/${event.limit})`) }])
        break
      case "model_switched":
        this.appendEntries([{ kind: "text", text: statusColor.accent(`(model: ${event.from} -> ${event.to})`) }])
        break
      case "tool": {
        const existing = this.entries.find((e) => e.kind === "tool" && e.toolCallId === event.toolCallId)
        if (existing?.kind === "tool") {
          // 更新已有工具行状态(started → completed/failed),在渲染时用状态渲染
          if (event.state === "started") {
            existing.state = "running"
            existing.args = briefArgs(event.name, event.args ?? {})
          } else if (event.state === "completed" && event.result) {
            existing.state = "done"
            existing.resultBrief = (event.result.stdout ?? "").slice(0, 2000)
            existing.expanded = false
            this.runningTools = Math.max(0, this.runningTools - 1)
          } else if (event.state === "failed") {
            existing.state = "failed"
            existing.resultBrief = event.error ? `[${event.error.code}] ${event.error.message}` : "failed"
            existing.expanded = false
            this.runningTools = Math.max(0, this.runningTools - 1)
          }
          if (existing.state === "running") {
            this.streaming = true
            this.streamDirty = true
          }
        } else if (event.state === "started") {
          // 新工具启动:先挂进行中行(等待完成由 started→completed 更新)
          this.appendEntries([{ kind: "tool", toolCallId: event.toolCallId, name: event.name, args: briefArgs(event.name, event.args ?? {}), state: "running", resultBrief: null, expanded: false }])
          this.runningTools += 1
          this.streamDirty = true
        }
        this.cachedLines = null
        break
      }
      case "compression":
        this.appendEntries([{ kind: "text", text: statusColor.dim(`(compacted ${event.droppedIds.length} msgs)`) }])
        break
      case "recovery":
        this.appendEntries([{ kind: "text", text: statusColor.warn(`(recovery: ${event.detail ?? event.from})`) }])
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

  /** 追加一条附注行(排队提示等;不触发 turn 裁剪)。 */
  appendNote(text: string): void {
    this.appendEntries([{ kind: "text", text }])
  }

  private appendEntries(newEntries: Entry[]): void {
    this.entries.push(...newEntries)
    if (this.entries.length > this.maxLines) {
      this.entries = this.entries.slice(this.entries.length - this.maxLines)
    }
    this.cachedLines = null
    this.mdComponent = null
    this.mdText = ""
    this.mdWidth = -1
  }

  /** 按轮裁剪:user 消息(✨ 前缀)计为轮边界,保留最近 maxTurns 轮,丢弃更老轮次。
   * 防止单条超长消息挤掉多轮历史(参考 kimi 滑动窗口)。 */
  private trimToMaxTurns(): void {
    // 找所有轮边界(user 消息 entry 的首行)
    const boundaries: number[] = []
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e?.kind === "text" && e.text.startsWith(USER_BULLET)) boundaries.push(i)
    }
    if (boundaries.length <= this.maxTurns - 1) return
    // 在 user 消息 append 前调用:此时已有 maxTurns-1 个旧轮边界。
    // 保留最近 maxTurns-1 个旧轮 + 即将 append 的当前轮 = 共 maxTurns 轮。
    const keepFrom = boundaries[boundaries.length - (this.maxTurns - 1)]!
    this.entries = this.entries.slice(keepFrom)
    this.cachedLines = null
    this.mdComponent = null
    this.mdText = ""
    this.mdWidth = -1
  }

  /** 直接覆盖行(print 模式 / 快照恢复用)。 */
  setLines(lines: string[]): void {
    this.entries = lines.slice(-this.maxLines).map((l) => ({ kind: "text", text: l }))
    this.resetStreaming()
    this.cachedLines = null
    this.mdComponent = null
    this.mdText = ""
    this.mdWidth = -1
  }

  getLineCount(): number {
    return this.entries.length
  }

  /** 取最后一条 assistant 文本(复制 /copy 用);无则返回 null。 */
  getLastAssistantText(): string | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e?.kind === "md") return e.text
    }
    return null
  }

  invalidate(): void {
    this.cachedLines = null
  }

  /** 进行中流行的可见行(thinking/正文各成段,带 spinner;对齐 kimi MoonLoader)。 */
  private streamLines(): string[] {
    if (!this.streaming) return []
    const glyph = statusColor.accent(SPINNER[this.spinnerIdx % SPINNER.length]!)
    const lines: string[] = []
    if (this.thinkingBuf !== "") {
      lines.push(`${glyph} ${statusColor.dim("thinking...")}`)
      lines.push(`${MESSAGE_INDENT}${statusColor.dim(this.thinkingBuf)}`)
    }
    if (this.textBuf !== "") {
      if (this.thinkingBuf !== "") lines.push("")
      lines.push(`${glyph} ${this.textBuf}`)
    }
    return lines
  }

  /** 单条 Entry → 可见物理行(thinking 折叠/markdown 渲染/工具状态在此分叉)。 */
  private entryLines(e: Entry, width: number): string[] {
    if (e.kind === "tool") {
      const icon = e.state === "running"
        ? statusColor.accent(SPINNER[this.spinnerIdx % SPINNER.length]!)
        : e.state === "done"
          ? statusColor.ok("✓")
          : statusColor.error("✗")
      const name = statusColor.accent(e.name)
      const arg = e.args !== "" ? statusColor.dim(` ${e.args}`) : ""
      const head = `${MESSAGE_INDENT}${icon} ${name}${arg}`
      const lines = wrapLine(head, width).split("\n")
      if (e.resultBrief !== null && e.resultBrief !== "") {
        if (e.expanded || e.resultBrief.length <= 80) {
          for (const rl of e.resultBrief.split("\n")) {
            lines.push(...wrapLine(`${MESSAGE_INDENT}${statusColor.dim(`↳ ${rl}`)}`, width).split("\n"))
          }
        } else {
          const firstLine = e.resultBrief.split("\n")[0] ?? ""
          const preview = truncateToWidth(firstLine, Math.max(10, width - 10), "…")
          lines.push(`${MESSAGE_INDENT}${statusColor.dim(`↳ ${preview}`)}`)
          lines.push(statusColor.dim(`  (${e.resultBrief.length} chars, ctrl+o 展开)`))
        }
      }
      return lines
    }
    if (e.kind === "text") return wrapLine(e.text, width).split("\n")
    if (e.kind === "md") {
      // assistant 正文:pi-tui Markdown 整段渲染(标题/代码块/列表/粗体)。
      // 复用组件实例以保住 (text,width)→lines 缓存;前缀 bullet 与续行缩进统一处理。
      if (this.mdText !== e.text || this.mdWidth !== width) {
        this.mdComponent = new Markdown(e.text, 0, 0, markdownTheme)
        this.mdText = e.text
        this.mdWidth = width
      }
      const raw = (this.mdComponent as Markdown).render(width)
      const lines: string[] = []
      for (let i = 0; i < raw.length; i++) {
        const p = i === 0 ? STATUS_BULLET : MESSAGE_INDENT
        lines.push(p + raw[i])
      }
      return lines.map((l) => truncateToWidth(l, Math.max(1, width), "…"))
    }
    if (e.expanded) {
      const body = statusColor.dim(e.text)
      return wrapLine(`${MESSAGE_INDENT}${body}`, width).split("\n")
    }
    // 折叠:前 THINKING_PREVIEW_LINES 行 + 展开提示(参考 kimi-code)
    const contentLines = e.text.split("\n")
    const keep = contentLines.slice(0, THINKING_PREVIEW_LINES)
    const lines = keep.map((l) => `${MESSAGE_INDENT}${statusColor.dim(l)}`)
    if (contentLines.length > THINKING_PREVIEW_LINES) {
      lines.push(statusColor.dim(`  … (${contentLines.length - THINKING_PREVIEW_LINES} more lines, ctrl+t 展开)`))
    }
    return lines
  }

  private mdComponent: Markdown | null = null
  private mdText = ""
  private mdWidth = -1
  private readonly leftPad: number

  render(width: number): string[] {
    const streamLines = this.streamLines()
    const showStream = streamLines.length > 0
    const cacheStale = this.cachedLines === null || this.cachedWidth !== width || this.streamDirty || showStream !== this.cachedHasStream
    if (cacheStale) {
      this.cachedWidth = width
      // maxRenderLines 按物理行(含 wrap)截断:先 wrap 再取末尾,避免 wrap 膨胀把
      // 底部固定区(editor)顶出终端可视区。
      const flat: string[] = []
      for (const e of this.entries.slice(-this.maxLines)) {
        for (const line of this.entryLines(e, width)) flat.push(line)
      }
      this.cachedLines = flat.slice(-this.maxRenderLines)
      this.cachedHasStream = false
    }
    this.streamDirty = false
    const applyPad = (rows: string[]): string[] => {
      if (this.leftPad === 0) return rows
      const pad = " ".repeat(this.leftPad)
      return rows.map((l) => (l === "" ? l : pad + l))
    }
    if (streamLines.length === 0) return applyPad(this.cachedLines as string[])
    // 有进行中流:不可直接复用缓存(会污染),每次重建并追加流式行
    const base = this.cachedLines as string[]
    const out = base.slice()
    for (const sl of streamLines) {
      if (out.length >= this.maxRenderLines) out.shift()
      out.push(wrapLine(sl, width))
    }
    this.cachedHasStream = true
    return applyPad(out)
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
  return chunks.join("\n" + MESSAGE_INDENT)
}