// @tau/tui - theme.ts:pi-tui 组件主题(chalk 着色函数)。
// TUI 只渲染不着色语义;颜色是视觉层,不携带信息(双视角不变量:UI 可见 ⊆ 投影)。
// 色板统一经 uiColor 引用,避免各组件各自写死 chalk 色(磨砂一致)。

import chalk from "chalk"
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui"

/** 统一色板:primary(主操作/链接)、accent(进行中/强调)、warn(告警)、error、muted(弱化)。 */
export const uiColor = {
  primary: (s: string) => chalk.cyan(s),
  primaryBold: (s: string) => chalk.cyan.bold(s),
  accent: (s: string) => chalk.blue(s),
  warn: (s: string) => chalk.yellow(s),
  error: (s: string) => chalk.red(s),
  ok: (s: string) => chalk.green(s),
  muted: (s: string) => chalk.gray(s),
  dim: (s: string) => chalk.dim(s),
} as const

export const selectListTheme: SelectListTheme = {
  selectedPrefix: uiColor.primaryBold,
  selectedText: uiColor.primaryBold,
  description: uiColor.muted,
  scrollInfo: uiColor.dim,
  noMatch: uiColor.warn,
}

export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.dim(s),
  selectList: selectListTheme,
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.blue.underline(s),
  linkUrl: (s) => chalk.dim.blue(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => chalk.dim(s),
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
}

/** 角色 → 颜色:用户=绿,模型=蓝,工具=灰,系统=黄。 */
export const roleColor = {
  user: (s: string) => chalk.green(s),
  assistant: (s: string) => chalk.blue(s),
  tool: (s: string) => chalk.gray(s),
  system: (s: string) => chalk.yellow(s),
} as const

export const statusColor = {
  ok: (s: string) => chalk.green(s),
  warn: (s: string) => chalk.yellow(s),
  error: (s: string) => chalk.red(s),
  dim: (s: string) => chalk.dim(s),
  accent: (s: string) => chalk.cyan(s),
} as const

export type { EditorTheme, MarkdownTheme, SelectListTheme }
