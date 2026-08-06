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
import type { Event, GitStatus, Model, Sender, SessionSnapshot } from "@tau/contract"
import { editorTheme, statusColor } from "./theme.ts"
import { TranscriptView } from "./views/transcript.ts"
import { FooterComponent } from "./views/footer.ts"
import { PermissionPopup, type PermissionDecision } from "./views/permission.ts"
import { InfoDialog } from "./views/info-dialog.ts"
import { parseInput, formatHelp, SLASH_COMMANDS } from "./prompt.ts"
import { version } from "./index.ts"

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
  /** 会话注册表(可选,/sessions 列出)。 */
  sessions?: readonly SessionSnapshot[]
  /** 当前会话 id。 */
  sessionId?: string
}

export interface Tui {
  run(): Promise<void>
  stop(): void
  /** 权限询问(action onPermission 回调入口):弹窗 -> 用户决策。 */
  askPermission(req: { toolCallId: string; toolName: string; summary: string }): Promise<boolean>
}

const DEFAULT_SENDER: Sender = { clientId: "tui", kind: "tui" }

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function copyToClipboard(text: string): void {
  try {
    const escaped = text.replaceAll("'", "'\\''")
    Bun.spawnSync(["sh", "-c", `printf '%s' '${escaped}' | pbcopy`])
  } catch {
    // 剪贴板不可用静默降级
  }
}

export function createTui(deps: TuiDeps): Tui {
  const sender = deps.sender ?? DEFAULT_SENDER
  const face = deps.face

  const terminal = new ProcessTerminal()
  const ui = new PiTui(terminal)

  const transcript = new TranscriptView({ maxLines: 1000, maxTurns: 15, leftPad: 1 })
  const permissionPopup = new PermissionPopup()
  const infoDialog = new InfoDialog()

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
  const footer = new FooterComponent({ leftPad: 1 })
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
  /** 流式期间排队待发消息(kimi queue-pane;空闲后逐条消费)。 */
  const queuedMessages: string[] = []

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
    if (!transcript.isStreaming()) {
      stopSpinner()
      // 流式结束:排队消息已作为 steer 消费,清空队列
      if (queuedMessages.length > 0) {
        queuedMessages.length = 0
        footer.setTransient("队列已消费")
      }
    }
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
        // 帮助弹窗(overlay),不破坏对话历史
        infoDialog.show("斜杠命令", formatHelp().split("\n"), () => {
          ui.hideOverlay()
          focusEditor()
        })
        ui.showOverlay(infoDialog, { anchor: "center", width: "80%", maxHeight: 30 })
        return
      case "unknown":
        footer.setTransient(`未知命令: /${parsed.name} (${parsed.detail})`)
        ui.requestRender()
        return
      case "list_models": {
        const models = deps.models ?? []
        const rows = [
          `可用模型(${models.length} 个):`,
          ...models.slice(0, 40).map((m) => `  ${statusColor.accent(m.id)}${m.name !== m.id ? statusColor.dim(`  ${m.name}`) : ""}`),
          statusColor.dim(`用 /model <id> 切换`),
        ]
        infoDialog.show("模型目录", rows, () => {
          ui.hideOverlay()
          focusEditor()
        })
        ui.showOverlay(infoDialog, { anchor: "center", width: "80%", maxHeight: 30 })
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
      case "sessions": {
        const sessions = deps.sessions ?? []
        const cur = deps.sessionId ?? ""
        const rows = sessions.length === 0
          ? [statusColor.dim("(无持久会话记录)")]
          : sessions.map((s) => `  ${s.sessionId === cur ? statusColor.ok("●") : statusColor.dim(" ")} ${s.sessionId}  [${s.status}]  ${s.transcriptCount}消息 ${s.updatedAt.slice(0, 19)}`)
        rows.push("", statusColor.dim(`用 CLI 切会话:tau sessions resume <id>`))
        infoDialog.show("会话", rows, () => { ui.hideOverlay(); focusEditor() })
        ui.showOverlay(infoDialog, { anchor: "center", width: "80%", maxHeight: 25 })
        return
      }
      case "new_session":
        footer.setTransient("新会话需重启:退出后运行 tau 或 tau --session <id>")
        focusEditor()
        return
      case "status": {
        const s = footer.getState()
        const rows = [
          `  会话:   ${deps.sessionId ?? "-"}`,
          `  cwd:    ${s.cwd ?? "-"}`,
          `  model:  ${s.model ?? "-"}`,
          `  权限:   ${s.mode ?? "ask"}`,
          `  git:    ${s.git?.branch ?? "-"}${s.git?.dirty ? " (dirty)" : ""}`,
          `  turn:   ${s.turn}`,
          `  context:${s.cumulativeTokens} tok${s.maxContextTokens ? ` / ${s.maxContextTokens}` : ""}`,
          "",
          statusColor.dim(`tau ${version}`),
        ]
        infoDialog.show("状态", rows, () => { ui.hideOverlay(); focusEditor() })
        ui.showOverlay(infoDialog, { anchor: "center", width: "70%", maxHeight: 20 })
        return
      }
      case "copy": {
        // 复制最后一条 assistant 回复:从 transcript 取,写剪贴板
        const last = transcript.getLastAssistantText()
        if (last === null) {
          footer.setTransient("无助手回复可复制")
        } else {
          copyToClipboard(last)
          footer.setTransient(`已复制最后一条回复(${last.length} 字符)`)
        }
        focusEditor()
        return
      }
      case "title":
        footer.setTransient("会话标题在创建时设定(重启生效)")
        focusEditor()
        return
      case "usage": {
        const s = footer.getState()
        const pct = s.maxContextTokens !== null && s.maxContextTokens > 0 ? `${Math.round((s.cumulativeTokens / s.maxContextTokens) * 100)}%` : "-"
        const rows = [
          `  turn            ${s.turn}`,
          `  context         ${pct} (${formatTokens(s.cumulativeTokens)}/${s.maxContextTokens !== null ? formatTokens(s.maxContextTokens) : "?"})`,
          `  model           ${s.model ?? "-"}`,
          `  permission      ${s.mode ?? "ask"}`,
          `  git             ${s.git?.branch ?? "-"}${s.git?.dirty ? " (dirty)" : ""}`,
          "",
          statusColor.dim(`/compact 可手动压缩上下文释放空间`),
        ]
        infoDialog.show("用量", rows, () => {
          ui.hideOverlay()
          focusEditor()
        })
        ui.showOverlay(infoDialog, { anchor: "center", width: "70%", maxHeight: 20 })
        return
      }
      case "set_permission": {
        editor.disableSubmit = true
        const result = await face.publish(parsed.command)
        editor.disableSubmit = false
        editor.addToHistory?.(text)
        footer.update({ mode: parsed.enabled ? "auto" : "ask" })
        footer.setTransient(result.accepted ? result.detail : `切换失败: ${result.detail}`)
        focusEditor()
        return
      }
      case "prompt":
      case "steer":
      case "abort":
      case "approve":
      case "deny":
      case "skill":
      case "compact": {
        const cmdKind = parsed.command.kind
        editor.disableSubmit = true
        // 流式期间提交普通 prompt → 排队(kimi queue-pane):显示"已排队",经 steer 注入
        if (cmdKind === "prompt" && transcript.isStreaming()) {
          editor.disableSubmit = false
          queuedMessages.push(parsed.command.text.slice(0, 200))
          editor.addToHistory?.(text)
          transcript.appendNote(statusColor.dim(`⏳ 已排队:${parsed.command.text.slice(0, 60)}${parsed.command.text.length > 60 ? "…" : ""}`))
          void face.publish({ kind: "steer", sender, text: parsed.command.text, ref: "queued" })
          footer.setTransient(`已排队(${queuedMessages.length} 条待发)`)
          ui.requestRender()
          focusEditor()
          return
        }
        const result = await face.publish(parsed.command)
        editor.disableSubmit = false
        // 提交成功 → 入历史(↑/↓ 回顾);失败也入历史(便于重试修正)
        editor.addToHistory?.(text)
        if (!result.accepted) {
          footer.setTransient(`命令未接受: ${result.detail}`)
        } else if (cmdKind === "steer") {
          footer.setTransient("已排队补充指令")
        } else if (cmdKind === "abort") {
          footer.setTransient("已请求中断")
        }
        ui.requestRender()
        focusEditor()
        return
      }
    }
  }

  editor.onSubmit = (text) => {
    void submit(text)
  }

  let ctrlCArmed = false
  ui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+t")) {
      transcript.toggleThinking()
      ui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, "ctrl+o")) {
      transcript.toggleTool()
      ui.requestRender()
      return { consume: true }
    }
    // Ctrl+S:把当前输入作为 steer 注入(对齐 kimi;空输入无效)
    if (matchesKey(data, "ctrl+s")) {
      const text = editor.getText?.().trim() ?? ""
      if (text === "" || transcript.isStreaming() === false) {
        footer.setTransient("Ctrl+S 需在生成中输入补充指令")
        ui.requestRender()
        return { consume: true }
      }
      editor.setText("")
      void submit(`/steer ${text}`)
      return { consume: true }
    }
    // Ctrl+D:空输入时退出;有输入时删除(编辑器默认行为)
    if (matchesKey(data, "ctrl+d")) {
      const text = editor.getText?.() ?? ""
      if (text === "" && !transcript.isStreaming() && !infoDialog.isActive() && !permissionPopup.isActive()) {
        stop()
        return { consume: true }
      }
      return undefined // 交给编辑器处理(删除字符)
    }
    if (matchesKey(data, "ctrl+c")) {
      if (infoDialog.isActive()) {
        infoDialog.dismiss()
        ui.hideOverlay()
        focusEditor()
        return { consume: true }
      }
      if (permissionPopup.isActive()) {
        return { consume: true }
      }
      // 有进行中活动(LLM 流式或工具执行)→ 首次 Ctrl+C = 打断 turn
      if (transcript.isStreaming()) {
        footer.setTransient("已请求中断…再次 Ctrl+C 立即停止")
        void face.publish({ kind: "abort", sender })
        return { consume: true }
      }
      // 空闲时:双击 Ctrl+C 才退出(避免误触关闭,参考 kimi)
      if (ctrlCArmed) {
        stop()
        return { consume: true }
      }
      ctrlCArmed = true
      footer.setTransient("再按一次 Ctrl+C 退出")
      ui.requestRender()
      setTimeout(() => {
        ctrlCArmed = false
        ui.requestRender()
      }, 2000)
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
    infoDialog.dismiss()
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
