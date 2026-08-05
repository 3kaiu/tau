// @tau/tui - tui.ts:命令发布器(pi-tui 装载 + 生命周期)。
// 宪法:一切经 surface(只 publish Command + subscribe Event);渲染与状态分离;可离线发布;不生成内容;打断是命令。

import {
  TUI as PiTui,
  ProcessTerminal,
  Editor,
  Text,
  Spacer,
  matchesKey,
} from "@earendil-works/pi-tui"
import type { CommandFace } from "@tau/surface"
import type { Event, Sender, SessionSnapshot } from "@tau/contract"
import { editorTheme } from "./theme.ts"
import { statusColor } from "./theme.ts"
import { TranscriptView } from "./views/transcript.ts"
import { ToolPanelView } from "./views/tool-panel.ts"
import { ResourcePanelView, emptyResourceState } from "./views/resource-panel.ts"
import { PermissionPopup, type PermissionDecision } from "./views/permission.ts"
import { parseInput, formatHelp } from "./prompt.ts"

export type TuiDeps = {
  face: CommandFace
  sender?: Sender
  /** 初始快照(可选,从 session.snapshot() 拉取)。 */
  snapshot?: SessionSnapshot
  /** 模型显示名(可选)。 */
  model?: string
  /** cwd 显示(可选)。 */
  cwd?: string
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
  const toolPanel = new ToolPanelView()
  const resourcePanel = new ResourcePanelView()
  const permissionPopup = new PermissionPopup()

  const resourceState = emptyResourceState()
  if (deps.snapshot) {
    resourceState.snapshot = deps.snapshot
    resourceState.pendingCount = deps.snapshot.pendingSyscalls.length
    resourceState.activeGoals = deps.snapshot.activeGoals.length
  }
  if (deps.model) resourceState.model = deps.model
  if (deps.cwd) resourceState.cwd = deps.cwd
  resourcePanel.update(resourceState)

  const editor = new Editor(ui, editorTheme, { paddingX: 1 })
  const helpHint = new Text(statusColor.dim("  /help 查看命令 · Ctrl+C 打断/退出 · Enter 发送"), 0, 0)

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
    const width = terminal.columns
    // 固定区高度 = 资源面板(1) + 空行(3) + 工具面板(可变) + 编辑器(1) + 提示(1)。
    // 工具面板行数随内容浮动,按当前宽度实测(物理行),避免其膨胀把 editor 顶出可视区。
    const toolLines = toolPanel.render(width).length
    const fixedOverhead = 1 + 3 + toolLines + 1 + 1
    transcript.setMaxRenderLines(Math.max(4, rows - fixedOverhead))
    ui.requestRender()
  }

  function handleEvent(event: Event): void {
    transcript.consume(event)
    toolPanel.consume(event)

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

    const snap = face.snapshot()
    resourcePanel.update({
      snapshot: snap,
      pendingCount: snap.pendingSyscalls.length,
      activeGoals: snap.activeGoals.length,
      busy: transcript.isStreaming() || toolPanel.hasActivity(),
    })
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
        transcript.setLines([statusColor.error(`未知命令: /${parsed.name} (${parsed.detail})`)])
        ui.requestRender()
        return
      case "prompt":
      case "steer":
      case "abort":
      case "approve":
      case "deny":
      case "skill":
        editor.disableSubmit = true
        const result = await face.publish(parsed.command)
        editor.disableSubmit = false
        if (!result.accepted) {
          transcript.setLines([statusColor.error(`命令未接受: ${result.detail}`)])
          ui.requestRender()
        }
        ui.setFocus(editor)
        return
    }
  }

  editor.onSubmit = (text) => {
    void submit(text)
  }

  ui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (permissionPopup.isActive()) {
        return { consume: true }
      }
      if (toolPanel.hasActivity()) {
        void face.publish({ kind: "abort", sender })
        return { consume: true }
      }
      stop()
      return { consume: true }
    }
    return undefined
  })

  ui.addChild(resourcePanel)
  ui.addChild(new Spacer(0))
  ui.addChild(transcript)
  ui.addChild(new Spacer(0))
  ui.addChild(toolPanel)
  ui.addChild(new Spacer(0))
  ui.addChild(editor)
  ui.addChild(helpHint)

  ui.setFocus(editor)
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
