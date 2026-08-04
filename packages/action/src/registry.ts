// @tau/action — registry.ts:SystemCall 注册表(内置+扩展)。
// 工具只能经契约参数与返回与外界交流;同一工具可并发,写操作互斥由 runtime 管。

import type { SystemCall } from "@tau/contract"

export class ToolRegistry {
  readonly tools = new Map<string, SystemCall>()

  register(syscall: SystemCall): void {
    if (this.tools.has(syscall.name)) {
      throw new Error(`工具重复注册:${syscall.name}`)
    }
    this.tools.set(syscall.name, syscall)
  }

  get(name: string): SystemCall | null {
    return this.tools.get(name) ?? null
  }

  all(): SystemCall[] {
    return [...this.tools.values()]
  }
}
