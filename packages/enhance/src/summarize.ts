// @tau/enhance - summarize.ts:摘要策略(压缩的摘要源)。
// 默认规则摘要:提取用户指令 + 工具调用摘要 + 关键结论;LLM policy 可插拔(M7+)。

import type { Message } from "@tau/contract"

export type SummaryInput = {
  sessionId: string
  messages: readonly Message[]
  reason: string
}

/** 规则摘要:提取关键信息,不调 LLM。 */
export function ruleSummarize(input: SummaryInput): string {
  const { messages, reason } = input
  const userTurns = messages.filter((m) => m.role === "user")
  const assistantTurns = messages.filter((m) => m.role === "assistant")
  const toolTurns = messages.filter((m) => m.role === "tool")

  const parts: string[] = [`[压缩摘要 · 原因: ${reason} · ${messages.length} 条消息]`]

  if (userTurns.length > 0) {
    parts.push(`用户指令:`)
    for (const m of userTurns.slice(-3)) {
      const text = textOf(m).slice(0, 200)
      parts.push(`  - ${text}`)
    }
  }

  if (assistantTurns.length > 0) {
    parts.push(`助手回复(${assistantTurns.length} 轮):`)
    for (const m of assistantTurns.slice(-2)) {
      const text = textOf(m).slice(0, 200)
      parts.push(`  - ${text}`)
    }
  }

  if (toolTurns.length > 0) {
    const toolNames = new Set<string>()
    for (const m of toolTurns) {
      for (const tr of m.toolResults) {
        void tr
      }
      if (m.source !== "") toolNames.add(m.source)
    }
    parts.push(`工具调用: ${[...toolNames].join(", ")}`)
  }

  return parts.join("\n")
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
}
