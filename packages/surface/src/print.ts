// @tau/surface — print.ts:print 模式渲染(转述流,非 TUI;M2 过渡)。
// 订阅 Event 流,把会话转述渲染到 stdout;工具调用/事件带前缀标记,机器与人都可读。

import type { ContentBlock, Event } from "@tau/contract"

/** 单内容块 → 纯文本(转述流)。thinking/artifact 显式渲染,避免退回 [image]。 */
function formatBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text
    case "image":
      return "[image]"
    case "thinking":
      return `(思考链) ${b.text}`
    case "artifact": {
      const meta = [b.mime, b.size !== undefined ? `${b.size}字节` : null]
        .filter((x): x is string => x !== null)
        .join(" ")
      return `[附件${meta ? ` ${meta}` : ""}${b.ref ? ` ref=${b.ref}` : ""}]`
    }
  }
}

export type PrintStyle = {
  /** 前缀样式:plain(仅文本)/ marked(带事件标记) */
  markdown?: boolean
  showToolCalls?: boolean
}

export function createPrintRenderer(style: PrintStyle = {}) {
  const showTools = style.showToolCalls ?? true
  const lines: string[] = []

  function consume(event: Event): void {
    switch (event.kind) {
      case "transcript": {
        const { message } = event
        if (message.role === "user") {
          const text = message.content.map(formatBlock).join("")
          lines.push(`> ${text}`)
        } else if (message.role === "assistant") {
          const text = message.content.map(formatBlock).join("")
          if (text !== "") lines.push(text)
          if (showTools && message.toolCalls.length > 0) {
            for (const call of message.toolCalls) {
              lines.push(`→ ${call.name} ${JSON.stringify(call.arguments)}`)
            }
          }
        } else if (message.role === "tool") {
          if (showTools) {
            for (const ref of message.toolResults) {
              if (ref.error) {
                lines.push(`✗ [${ref.error.code}] ${ref.error.message}`)
              } else if (ref.result) {
                const out = ref.result.stdout ?? ""
                const preview = out.length > 400 ? `${out.slice(0, 400)}…(截断 ${out.length} 字符)` : out
                lines.push(`↳ ${preview}`)
              }
            }
          }
        }
        break
      }
      case "retry":
        lines.push(`(重试 ${event.attempts}:${event.cause})`)
        break
      case "interrupted":
        lines.push(`(打断:${event.targetId})`)
        break
      case "loop_detected":
        lines.push(`(循环防护:${event.pattern})`)
        break
      case "budget_exceeded":
        lines.push(`(预算超限:${event.metric} ${event.used}/${event.limit})`)
        break
      default:
        break
    }
  }

  return {
    consume,
    /** 渲染 buffer 并清空(流式渲染用;结束时可再取一次)。 */
    flush(): string {
      const out = lines.join("\n")
      lines.length = 0
      return out
    },
  }
}
