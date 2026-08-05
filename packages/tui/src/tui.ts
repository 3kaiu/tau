// @tau/tui - tui.ts:命令发布器(pi-tui 装载 + 生命周期)。
// 宪法:一切经 surface(只 publish Command + subscribe Event);渲染与状态分离;可离线发布;不生成内容;打断是命令。

import {
  TUI as PiTui,
  ProcessTerminal,
  Editor,
  Spacer,
  matchesKey,
  CombinedAutocompleteProvider,
} from "@earendil-works/pi-tui"
import type { CommandFace } from "@tau/surface"
import type { Event, GitStatus, Model, Sender } from "@tau/contract"
import { editorTheme, statusColor } from "./theme.ts"
import { TranscriptView } from "./views/transcript.ts"
import { FooterComponent } from "./views/footer.ts"
import { PermissionPopup, type PermissionDecision } from "./views/permission.ts"
import { parseInput, formatHelp, SLASH_COMMANDS } from "./prompt.ts"

export type TuiDeps = {
  face: CommandFace
  sender?: Sender
  /** 模型显示名(可选)。 */
  model?: string
  /** thinking effort(可选,如 "high";显示为 `model thinking: high`)。 */
  thinkingEffort?: string
  /** cwd 显示(可选)。 */
  cwd?: string
  /** permission 模式(可选,如 "auto"/"ask")。 */
  permissionMode?: string
  /** git 状态(可选,footer git 徽标)。 */
  git?: GitStatus | null
  /** 模型目录(可选,/model 无参时列出)。 */
  models?: readonly Model[]
}

export interface Tui {
  run(): Promise<void>
  stop(): void
  /** 权限询问(action onPermission 回调入口):弹窗 -> 用户决策。 */
  askPermission(req: { toolCallId: string; toolName: string; summary: string }): Promise<boolean>
}

const DEFAULT_SENDER: Sender = { clientId: "tui", kind: "tui" }

export function createTui(deps: TuiDeps): Tui {
  const sender = deps.sender ?? DEFAULT_SENDER
  const face = deps.face

  const terminal = new ProcessTerminal()
  const ui = new PiTui(terminal)

  const transcript = new TranscriptView({ maxLines: 1000 })
  const permissionPopup = new PermissionPopup()

  const editor = new Editor(ui, editorTheme, { paddingX: 1 })
  // 聚焦高亮:pi-tui borderColor 是实例字段,聚焦时提亮边框(失焦回 dim)。
  function focusEditor(): void {
    editor.borderColor = (s) => statusColor.accent(s)
    ui.setFocus(editor)
    ui.requestRender()
  }
  editor.borderColor = (s) => statusColor.dim(s)
  // 斜杠命令自动补全 + 文件路径补全(pi-tui CombinedAutocompleteProvider)。
  // `/help` 等命令名与参数(文件路径)都补全,对齐 kimi 输入体验。
  editor.setAutocompleteProvider?.(
    new CombinedAutocompleteProvider(
      SLASH_COMMANDS.map((cmd) => ({
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        argumentHint: cmd.usage,
      })),
      deps.cwd ?? process.cwd(),
    ),
  )
  editor.setAutocompleteMaxVisible?.(6)
  // 欢迎态(对齐 kimi welcome):首屏提示,不是交互元素。
  transcript.setLines([
    statusColor.accent(`● 欢迎使用 tau ${deps.model ? `· ${deps.model}` : ""}`),
    statusColor.dim("  直接提问,或 /help 查看命令"),
    "",
  ])
  // kimi-code 风格底部状态栏(双行:mode/goal/model/pending/cwd/git + context 用量),贴编辑器下方
  const footer = new FooterComponent()
  footer.update({
    model: deps.model ?? null,
    thinkingEffort: deps.thinkingEffort ?? null,
    cwd: deps.cwd ?? null,
    mode: deps.permissionMode ?? null,
    git: deps.git ?? null,
  })

  let stopped = false
  let resolveStop: () => void
  const stopPromise = new Promise<void>((r) => {
    resolveStop = r
  })

  let spinnerTimer: ReturnType<typeof setInterval> | null = null
  function ensureSpinner(): void {
    if (transcript.isStreaming() && spinnerTimer === null) {
      spinnerTimer = setInterval(() => {
        transcript.tick()
        ui.requestRender()
      }, 80)
    }
  }
  function stopSpinner(): void {
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer)
      spinnerTimer = null
    }
  }

  function adjustLayout(): void {
    const rows = terminal.rows
    // 固定区 = 空行(1) + 编辑器(1) + footer 双行(2)。
    // transcript 占剩余;physical 行截断已由视图内部保证。
    const fixedOverhead = 1 + 1 + 2
    transcript.setMaxRenderLines(Math.max(4, rows - fixedOverhead))
    ui.requestRender()
  }

  function handleEvent(event: Event): void {
    transcript.consume(event)
    footer.consume(event)

    switch (event.kind) {
      case "permission":
        if (event.state === "requested" && !permissionPopup.isActive()) {
          permissionPopup.show(event, handlePermissionDecision)
          ui.showOverlay(permissionPopup, { anchor: "center", width: "80%", maxHeight: 20 })
        } else if (event.state !== "requested") {
          if (permissionPopup.isActive()) permissionPopup.dismiss()
          ui.hideOverlay()
        }
        break
      case "input_accepted":
        editor.setText("")
        break
      default:
        break
    }

    footer.setBusy(transcript.isStreaming())
    ensureSpinner()
    if (!transcript.isStreaming()) stopSpinner()
    adjustLayout()
    ui.requestRender()
  }

  async function handlePermissionDecision(decision: PermissionDecision): Promise<void> {
    if (decision.approved) {
      await face.publish({
        kind: "approve",
        sender,
        toolCallId: decision.requestId,
        capability: "ask",
        reason: "user-approved",
      })
    } else {
      await face.publish({
        kind: "abort",
        sender,
        targetId: decision.requestId,
      })
    }
  }

  async function submit(text: string): Promise<void> {
    const parsed = parseInput(text, sender)
    switch (parsed.kind) {
      case "empty":
        return
      case "help":
        transcript.setLines(formatHelp().split("\n"))
        ui.requestRender()
        return
      case "unknown":
        footer.setTransient(`未知命令: /${parsed.name} (${parsed.detail})`)
        ui.requestRender()
        return
      case "list_models": {
        const models = deps.models ?? []
        const ids = models.slice(0, 40).map((m) => m.id).join("  ")
        transcript.setLines([
          statusColor.accent(`可用模型(${models.length} 个):`),
          statusColor.dim(ids.length > 0 ? ids : "(目录为空)"),
          statusColor.dim(`用 /model <id> 切换`),
        ])
        ui.requestRender()
        return
      }
      case "set_model": {
        editor.disableSubmit = true
        const result = await face.publish(parsed.command)
        editor.disableSubmit = false
        editor.addToHistory?.(text)
        if (!result.accepted) {
          footer.setTransient(`模型切换失败: ${result.detail}`)
        } else {
          footer.update({ model: parsed.modelId })
          footer.setTransient(`已切换到 ${parsed.modelId}`)
        }
        focusEditor()
        return
      }
      case "prompt":
      case "steer":
      case "abort":
      case "approve":
      case "deny":
      case "skill":
        editor.disableSubmit = true
        const result = await face.publish(parsed.command)
        editor.disableSubmit = false
        // 提交成功 → 入历史(↑/↓ 回顾);失败也入历史(便于重试修正)
        editor.addToHistory?.(text)
        if (!result.accepted) {
          footer.setTransient(`命令未接受: ${result.detail}`)
          ui.requestRender()
        }
        focusEditor()
        return
    }
  }

  editor.onSubmit = (text) => {
    void submit(text)
  }

  ui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+t")) {
      transcript.toggleThinking()
      ui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, "ctrl+c")) {
      if (permissionPopup.isActive()) {
        return { consume: true }
      }
      if (transcript.isStreaming()) {
        void face.publish({ kind: "abort", sender })
        return { consume: true }
      }
      stop()
      return { consume: true }
    }
    return undefined
  })

  ui.addChild(transcript)
  ui.addChild(new Spacer(1))
  ui.addChild(editor)
  ui.addChild(footer)

  focusEditor()
  adjustLayout()

  const unsubscribe = face.subscribe(handleEvent)

  // 终端 resize 后重算布局(pi-tui 不向应用转发 resize,自挂 process.stdout)。
  // 防止高度变化后 transcript 显示行数与可视区错位(editor 漂移)。
  const onResize = (): void => adjustLayout()
  process.stdout.on("resize", onResize)

  function stop(): void {
    if (stopped) return
    stopped = true
    stopSpinner()
    process.stdout.off("resize", onResize)
    unsubscribe()
    permissionPopup.dismiss()
    ui.stop()
    resolveStop()
  }

  return {
    run() {
      terminal.setTitle("tau")
      ui.start()
      adjustLayout()
      return stopPromise
    },
    stop,
    askPermission(req) {
      return new Promise<boolean>((resolve) => {
        const event = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          redact: [],
          kind: "permission" as const,
          requestId: req.toolCallId,
          toolName: req.toolName,
          summary: req.summary,
          state: "requested" as const,
        }
        permissionPopup.show(event, (decision) => {
          permissionPopup.dismiss()
          ui.hideOverlay()
          resolve(decision.approved)
        })
        ui.showOverlay(permissionPopup, { anchor: "center", width: "80%", maxHeight: 20 })
      })
    },
  }
}
