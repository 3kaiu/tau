// @tau/app — main.ts:入口(Bun compile 目标)。子命令懒加载,启动毫秒级。

import { runCli } from "./cli.ts"

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}

export { runCli } from "./cli.ts"
export { compose } from "./compose.ts"
export type { TauRuntime, ComposeOptions } from "./compose.ts"
