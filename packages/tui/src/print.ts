// @tau/tui - print.ts:非交互模式(print/JSONL)。
// 与 TUI 走同一条 Event 流;输出格式稳定(脚本依赖)。
// -p:人类可读转述流; -j:JSONL(wire 格式,机器消费,严格对齐 contract 事件)。

import type { CommandFace } from "@tau/surface"
import type { ContentBlock, Event, Sender } from "@tau/contract"

/** 单内容块 → 纯文本(print 模式供脚本消费,不着色)。thinking/artifact 显式渲染。 */
function formatBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text
    case "image":
      return "[image]"
    case "thinking":
      return `(thinking) ${b.text}`
    case "artifact": {
      const meta = [b.mime, b.size !== undefined ? `${b.size}B` : null]
        .filter((x): x is string => x !== null)
        .join(" ")
      return `[artifact${meta ? ` ${meta}` : ""}${b.ref ? ` ref=${b.ref}` : ""}]`
    }
  }
}

export type PrintStyle = "print" | "jsonl"

export type PrintModeOptions = {
  style?: PrintStyle
  showToolCalls?: boolean
}

const DEFAULT_SENDER: Sender = { clientId: "cli", kind: "cli" }

/** 渲染单条事件为人类可读行(print 模式)。 */
export function renderEventLine(event: Event, showTools: boolean): string[] {
  switch (event.kind) {
    case "transcript": {
      const { message } = event
      if (message.role === "user") {
        const text = message.content.map(formatBlock).join("")
        return [`> ${text}`]
      }
      if (message.role === "assistant") {
        const text = message.content.map(formatBlock).join("")
        const lines: string[] = []
        if (text !== "") lines.push(text)
        if (showTools) {
          for (const call of message.toolCalls) {
            lines.push(`-> ${call.name} ${JSON.stringify(call.arguments)}`)
          }
        }
        return lines
      }
      if (message.role === "tool") {
        if (!showTools) return []
        const lines: string[] = []
        for (const ref of message.toolResults) {
          if (ref.error) {
            lines.push(`✗ [${ref.error.code}] ${ref.error.message}`)
          } else if (ref.result) {
            const out = ref.result.stdout ?? ""
            const preview = out.length > 400 ? `${out.slice(0, 400)}…(${out.length} chars)` : out
            lines.push(`↳ ${preview}`)
          }
        }
        return lines
      }
      if (message.role === "system") {
        const text = message.content.map(formatBlock).join("")
        return text !== "" ? [`# ${text}`] : []
      }
      return []
    }
    case "retry":
      return [`(retry ${event.attempts}: ${event.cause})`]
    case "interrupted":
      return [`(interrupted: ${event.targetId})`]
    case "loop_detected":
      return [`(loop: ${event.pattern})`]
    case "budget_exceeded":
      return [`(budget: ${event.metric} ${event.used}/${event.limit})`]
    case "model_switched":
      return [`(model: ${event.from} -> ${event.to}: ${event.reason})`]
    case "compression":
      return [`(compacted ${event.droppedIds.length} msgs)`]
    case "recovery":
      return [`(recovery: ${event.detail ?? event.from})`]
    case "permission":
      return [`(permission: ${event.toolName} ${event.state})`]
    case "lifecycle":
      return [`(lifecycle: ${event.state})`]
    default:
      return []
  }
}

/** 渲染单条事件为 JSONL 行(jsonl 模式,严格对齐 contract wire 格式)。 */
export function renderEventJson(event: Event): string {
  return JSON.stringify(event)
}

/**
 * 运行非交互模式:订阅 Event 流,发布 prompt,输出到 stdout,返回后结束。
 * print 模式输出人类可读转述;jsonl 模式输出 contract wire 格式(机器消费)。
 */
export async function runPrintMode(
  face: CommandFace,
  prompt: string,
  options: PrintModeOptions = {},
): Promise<number> {
  const style = options.style ?? "print"
  const showTools = options.showToolCalls ?? true
  const sender = DEFAULT_SENDER

  const unsubscribe = face.subscribe((event) => {
    if (style === "jsonl") {
      process.stdout.write(`${renderEventJson(event)}\n`)
    } else {
      for (const line of renderEventLine(event, showTools)) {
        process.stdout.write(`${line}\n`)
      }
    }
  })

  try {
    const result = await face.publish({ kind: "prompt", sender, text: prompt })
    if (!result.accepted) {
      process.stderr.write(`tau: ${result.detail}\n`)
      return 1
    }
    return 0
  } finally {
    unsubscribe()
  }
}
