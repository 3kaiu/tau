// @tau/tui - theme.ts:pi-tui 组件主题(chalk 着色函数)。
// TUI 只渲染不着色语义;颜色是视觉层,不携带信息(双视角不变量:UI 可见 ⊆ 投影)。
// 色板对齐 kimi-code colors.ts(dark default):hex 值照搬,保证视觉一致。

import chalk from "chalk"
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui"

// TUI 必然跑在有色的交互终端:Bun 非 TTY 下 chalk 默认 level=0(无色)。
// 显式启用 truecolor(hex 色板依赖);print/非交互模式不经 TUI。
if (process.stdout.isTTY && chalk.level < 3) {
  chalk.level = 3
}

/** kimi-code dark 色板(参考 theme/colors.ts)。 */
const C = {
  primary: "#4FA8FF",
  accent: "#5BC0BE",
  border: "#5A5A5A",
  success: "#4EC87E",
  warning: "#E0A030",
  error: "#E5534B",
  textDim: "#888888",
  textMuted: "#6B6B6B",
  textStrong: "#E8E8E8",
} as const

/** 统一色板(对齐 kimi):primary(主/链接)、accent(强调)、warn、error、ok、muted。 */
export const uiColor = {
  primary: (s: string) => chalk.hex(C.primary)(s),
  primaryBold: (s: string) => chalk.hex(C.primary).bold(s),
  accent: (s: string) => chalk.hex(C.accent)(s),
  warn: (s: string) => chalk.hex(C.warning)(s),
  error: (s: string) => chalk.hex(C.error)(s),
  ok: (s: string) => chalk.hex(C.success)(s),
  muted: (s: string) => chalk.hex(C.textMuted)(s),
  dim: (s: string) => chalk.hex(C.textDim)(s),
  text: (s: string) => chalk.hex(C.textStrong)(s),
} as const

export const selectListTheme: SelectListTheme = {
  selectedPrefix: uiColor.primaryBold,
  selectedText: uiColor.primaryBold,
  description: uiColor.muted,
  scrollInfo: uiColor.dim,
  noMatch: uiColor.warn,
}

export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.hex(C.border)(s),
  selectList: selectListTheme,
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.hex(C.primary).bold(s),
  link: (s) => chalk.hex(C.primary).underline(s),
  linkUrl: (s) => chalk.hex(C.textMuted)(s),
  code: (s) => chalk.hex(C.primary)(s),
  codeBlock: (s) => chalk.hex(C.textStrong)(s),
  codeBlockBorder: (s) => chalk.hex(C.textMuted)(s),
  quote: (s) => chalk.italic(s),
  quoteBorder: (s) => chalk.hex(C.textDim)(s),
  hr: (s) => chalk.hex(C.border)(s),
  listBullet: (s) => chalk.hex(C.primary)(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
}

/** 角色 → 颜色(对齐 kimi):用户=green,助手=白/主,工具=主色,系统=warning。 */
export const roleColor = {
  user: (s: string) => chalk.hex(C.success)(s),
  assistant: (s: string) => chalk.hex(C.textStrong)(s),
  tool: (s: string) => chalk.hex(C.primary)(s),
  system: (s: string) => chalk.hex(C.warning)(s),
} as const

export const statusColor = {
  ok: (s: string) => chalk.hex(C.success)(s),
  warn: (s: string) => chalk.hex(C.warning)(s),
  error: (s: string) => chalk.hex(C.error)(s),
  dim: (s: string) => chalk.hex(C.textDim)(s),
  accent: (s: string) => chalk.hex(C.primary)(s),
} as const

export type { EditorTheme, MarkdownTheme, SelectListTheme }
