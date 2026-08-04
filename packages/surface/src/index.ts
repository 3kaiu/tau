// @tau/surface - index.ts。face + print + http + acp。

export { createCommandFace } from "./face.ts"
export type { CommandFace, CommandResult, FaceDeps } from "./face.ts"
export { createPrintRenderer } from "./print.ts"
export type { PrintStyle } from "./print.ts"
export { createHttpApp, serveHttp } from "./http.ts"
export type { HttpDeps } from "./http.ts"
export { runAcpServer } from "./acp.ts"
export type { AcpDeps } from "./acp.ts"
export const version = "0.0.1"
