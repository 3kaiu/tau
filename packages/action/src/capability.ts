// @tau/action — capability.ts:能力门(规则表 + 授权流)。
// 未授权 syscall 直接拒绝,审计记录;询问时带工具名/能力/理由。

import type { CapabilityRule } from "@tau/contract"

export type CapabilityDecision = { rule: "allow" } | { rule: "deny"; reason: string } | { rule: "ask" }

/** 作用域授权(一次批准 N 次):pattern 命中即允许,直到次数耗尽或到期。 */
export type ScopeGrant = {
  pattern: string
  remaining: number
  expiresAt: number
}

export const DEFAULT_RULES: readonly CapabilityRule[] = [
  { pattern: "read", rule: "allow", scope: "tool" },
  { pattern: "write", rule: "ask", scope: "tool" },
  { pattern: "bash", rule: "ask", scope: "tool" },
  { pattern: "result", rule: "allow", scope: "tool" },
  { pattern: "tool:catalog", rule: "allow", scope: "tool" },
]

export class CapabilityGate {
  private _rules: readonly CapabilityRule[]
  private _grants: ScopeGrant[] = []

  constructor(rules: readonly CapabilityRule[] = DEFAULT_RULES) {
    this._rules = rules
  }

  get rules(): readonly CapabilityRule[] {
    return this._rules
  }

  get grants(): readonly ScopeGrant[] {
    return this._grants
  }

  /** 作用域授权:pattern(工具名或通配)在次数/时限内直接允许(先于规则表,一次批准 N 次)。 */
  grant(pattern: string, scope: { maxUses?: number; durationMs?: number } = {}): void {
    this._grants = [
      ...this._grants,
      {
        pattern,
        remaining: scope.maxUses ?? 1,
        expiresAt: Date.now() + (scope.durationMs ?? 60 * 60_000),
      },
    ]
  }

  /** 追加规则(运行时装载,如 MCP server 的 defaultRule;后置优先)。 */
  addRule(rule: CapabilityRule): void {
    if (rule.scope !== "tool") return
    this._rules = [...this._rules, rule]
  }

  /** 匹配规则:同 pattern 精确或通配;规则表后置优先(冲突以后置为准)。作用域授权先于规则表。 */
  decide(toolName: string, dangerous: boolean): CapabilityDecision {
    if (this.consumeGrant(toolName) !== null) {
      return { rule: "allow" }
    }
    let matched: CapabilityRule | null = null
    for (const rule of this.rules) {
      if (rule.scope !== "tool") continue
      if (rule.pattern === toolName || rule.pattern.includes("*") && wildcardMatch(rule.pattern, toolName)) {
        matched = rule
      }
    }
    if (matched !== null) {
      if (matched.rule === "allow") return { rule: "allow" }
      if (matched.rule === "deny") return { rule: "deny", reason: matched.reason ?? `规则拒绝 ${toolName}` }
      return { rule: "ask" }
    }
    // 无规则兜底:危险工具拒绝,其余询问(默认拒绝哲学:宁可问,不可盲跑)
    if (dangerous) return { rule: "deny", reason: "危险工具且无 allow 规则" }
    return { rule: "ask" }
  }

  /** 消费一条作用域授权:命中则扣除次数(耗尽的移除)并返回,未命中返回 null。 */
  private consumeGrant(toolName: string): ScopeGrant | null {
    const now = Date.now()
    const live: ScopeGrant[] = []
    let hit: ScopeGrant | null = null
    for (const g of this._grants) {
      if (g.expiresAt <= now) continue
      if (hit === null && (g.pattern === toolName || g.pattern.includes("*") && wildcardMatch(g.pattern, toolName))) {
        hit = { ...g, remaining: g.remaining - 1 }
        if (hit.remaining > 0) live.push(hit)
        continue
      }
      live.push(g)
    }
    this._grants = live
    return hit
  }
}

export function wildcardMatch(pattern: string, value: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${regex}$`).test(value)
}
