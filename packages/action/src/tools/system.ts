// @tau/action — tools/system.ts:system 工具。内省 syscall:完整权限规则/挂起计数/工具目录/
// 后台任务;取消后台任务(cancel_task 是唯一允许的写动作)。tool:catalog 的工具目录后端。

import { toolError, toolResult } from "@tau/contract"
import type { SystemCall, ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"
import type { ActionPlane } from "../runtime.ts"
import type { ToolRegistry } from "../registry.ts"

export type SystemContext = {
  plane: ActionPlane
  registry: ToolRegistry
}

export function makeSystemTool(ctx: SystemContext) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const action = String(req.args.action ?? "queue")
    if (action === "rules") {
      return toolResult({ stdout: JSON.stringify(ctx.plane.gate.rules, null, 2), stderr: null })
    }
    if (action === "pending") {
      const perms = ctx.plane.permissionRequest()
      const asks = ctx.plane.listPendingQuestions()
      return toolResult({ stdout: `permission:${perms.length} ask_user:${asks.length}`, stderr: null })
    }
    if (action === "catalog") {
      return toolResult({ stdout: catalogText(ctx.registry.all()), stderr: null })
    }
    if (action === "cancel_task") {
      const taskId = String(req.args.task_id ?? "")
      if (taskId === "") throw new ToolErrorException(toolError("rejected", "system:cancel_task 缺 task_id"))
      const killed = await ctx.plane.tasks.cancel(taskId)
      return toolResult({ stdout: killed ? `task ${taskId} 已终止` : `task ${taskId} 不存在或已结束`, stderr: null })
    }
    return toolResult({ stdout: JSON.stringify(ctx.plane.capabilities(), null, 2), stderr: null })
  }
}

/** 工具目录文本(含危险标记与 tier;模型据此决定调用哪个工具)。 */
export function catalogText(tools: readonly SystemCall[]): string {
  return tools
    .map((t) => `${t.name}${t.dangerous ? "(危险)" : ""} [${t.tier}] ${t.description}`)
    .join("\n")
}
