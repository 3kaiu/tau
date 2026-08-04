// @tau/tui - 命令发布器。汇总出口。
// 一切经 surface:只 publish Command + subscribe Event;渲染与状态分离;可离线发布;不生成内容。

export { createTui } from "./tui.ts"
export type { Tui, TuiDeps } from "./tui.ts"

export { runPrintMode, renderEventLine, renderEventJson } from "./print.ts"
export type { PrintStyle, PrintModeOptions } from "./print.ts"

export { parseInput, formatHelp, SLASH_COMMANDS } from "./prompt.ts"
export type { ParsedInput, SlashCommandDef } from "./prompt.ts"

export { TranscriptView } from "./views/transcript.ts"
export type { TranscriptOptions } from "./views/transcript.ts"
export { ToolPanelView } from "./views/tool-panel.ts"
export { ResourcePanelView, emptyResourceState } from "./views/resource-panel.ts"
export type { ResourceState } from "./views/resource-panel.ts"
export { PermissionPopup } from "./views/permission.ts"
export type { PermissionDecision } from "./views/permission.ts"

export { editorTheme, selectListTheme, markdownTheme, roleColor, statusColor } from "./theme.ts"

export const version = "0.0.1"
