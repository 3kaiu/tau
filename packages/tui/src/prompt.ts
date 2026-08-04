// @tau/tui - prompt.ts:斜杠命令解析与输入绑定。
// 斜杠命令只映射为 Command,不旁路逻辑(TUI 不生成内容、不直调内核)。

import type { Command, Sender } from "@tau/contract"

export type ParsedInput =
  | { kind: "prompt"; command: Command }
  | { kind: "steer"; command: Command }
  | { kind: "abort"; command: Command }
  | { kind: "approve"; command: Command; requestId: string }
  | { kind: "deny"; command: Command; requestId: string }
  | { kind: "skill"; skillName: string; command: Command }
  | { kind: "help" }
  | { kind: "unknown"; name: string; detail: string }
  | { kind: "empty" }

export type SlashCommandDef = {
  name: string
  aliases?: string[]
  description: string
  usage: string
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: "steer", description: "向运行中的 turn 注入补充指令", usage: "/steer <text>" },
  { name: "abort", aliases: ["stop"], description: "打断当前 turn", usage: "/abort" },
  { name: "approve", description: "批准挂起的权限请求", usage: "/approve <requestId>" },
  { name: "deny", description: "拒绝挂起的权限请求", usage: "/deny <requestId>" },
  { name: "skill", description: "激活技能(LLM 自动加载全文并执行)", usage: "/skill <name>" },
  { name: "help", description: "显示斜杠命令列表", usage: "/help" },
] as const

export function parseInput(raw: string, sender: Sender): ParsedInput {
  const text = raw.trim()
  if (text === "") return { kind: "empty" }
  if (!text.startsWith("/")) {
    return { kind: "prompt", command: { kind: "prompt", sender, text } }
  }

  const spaceIdx = text.indexOf(" ")
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim()

  switch (name) {
    case "steer":
      if (rest === "") return { kind: "unknown", name, detail: "缺文本" }
      return { kind: "steer", command: { kind: "steer", sender, text: rest } }
    case "abort":
    case "stop":
      return { kind: "abort", command: { kind: "abort", sender } }
    case "approve": {
      if (rest === "") return { kind: "unknown", name, detail: "缺 requestId" }
      return { kind: "approve", command: { kind: "approve", sender, toolCallId: rest, capability: "ask", reason: "user-approved" }, requestId: rest }
    }
    case "deny": {
      if (rest === "") return { kind: "unknown", name, detail: "缺 requestId" }
      return { kind: "deny", command: { kind: "deny", sender, requestId: rest, reason: "" }, requestId: rest }
    }
    case "skill": {
      if (rest === "") return { kind: "unknown", name, detail: "缺技能名(用 /help 查看命令)" }
      return { kind: "skill", skillName: rest, command: { kind: "prompt", sender, text: `请使用 skill:load 工具加载技能 "${rest}" 的全文,然后按照该技能的指引执行任务。` } }
    }
    case "help":
      return { kind: "help" }
    default:
      return { kind: "unknown", name, detail: "未知命令" }
  }
}

export function formatHelp(): string {
  const lines = ["斜杠命令:"]
  for (const cmd of SLASH_COMMANDS) {
    const aliases = cmd.aliases !== undefined ? ` (${cmd.aliases.join(", ")})` : ""
    lines.push(`  ${cmd.usage}${aliases}  - ${cmd.description}`)
  }
  return lines.join("\n")
}
