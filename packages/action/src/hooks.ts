// @tau/action - hooks.ts:生命周期 hooks 机制。
// 在工具执行前/后触发用户定义的钩子函数,用于审计、门禁、日志等。

import type { SystemCall } from "@tau/contract"

export type HookPhase = "before" | "after" | "error"

export type HookContext = {
  sessionId: string
  toolCallId: string
  syscall: SystemCall
  args: Record<string, unknown>
  phase: HookPhase
  result?: Record<string, unknown>
  error?: Error
}

export type Hook = (ctx: HookContext) => Promise<void> | void

export type HookRegistry = {
  register(hook: Hook): () => void
  execute(ctx: HookContext): Promise<void>
}

export function createHookRegistry(): HookRegistry {
  const hooks: Hook[] = []

  return {
    register(hook: Hook) {
      hooks.push(hook)
      return () => {
        const idx = hooks.indexOf(hook)
        if (idx >= 0) hooks.splice(idx, 1)
      }
    },

    async execute(ctx: HookContext) {
      for (const hook of hooks) {
        await hook(ctx)
      }
    },
  }
}

// 内置 hooks

/** 审计日志 hook:记录所有工具调用。 */
export function auditHook(onLog: (entry: string) => void): Hook {
  return (ctx) => {
    const timestamp = new Date().toISOString()
    if (ctx.phase === "before") {
      onLog(`[${timestamp}] START ${ctx.syscall.name}(${JSON.stringify(ctx.args)})`)
    } else if (ctx.phase === "after") {
      onLog(`[${timestamp}] END ${ctx.syscall.name} -> ${JSON.stringify(ctx.result)}`)
    } else if (ctx.phase === "error") {
      onLog(`[${timestamp}] ERROR ${ctx.syscall.name} -> ${ctx.error?.message}`)
    }
  }
}

/** 危险工具门禁 hook:阻止特定工具执行。 */
export function dangerousToolGate(blockedTools: string[]): Hook {
  return (ctx) => {
    if (ctx.phase === "before" && blockedTools.includes(ctx.syscall.name)) {
      throw new Error(`工具 ${ctx.syscall.name} 已被安全策略阻止`)
    }
  }
}

/** 资源限制 hook:限制工具调用频率。 */
export function rateLimitHook(maxCallsPerMinute: number): Hook {
  const callTimestamps: number[] = []

  return (ctx) => {
    if (ctx.phase === "before") {
      const now = Date.now()
      const oneMinuteAgo = now - 60_000

      // 清理过期记录
      while (callTimestamps.length > 0) {
        const first = callTimestamps[0]
        if (first !== undefined && first < oneMinuteAgo) {
          callTimestamps.shift()
        } else {
          break
        }
      }

      // 检查限制
      if (callTimestamps.length >= maxCallsPerMinute) {
        throw new Error(`工具调用频率超限:最多 ${maxCallsPerMinute} 次/分钟`)
      }

      callTimestamps.push(now)
    }
  }
}
