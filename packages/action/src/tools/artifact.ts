// @tau/action — tools/artifact.ts:artifact 检索工具。正文存 store(大载荷外置),历史仅引用;
// 模型凭引用(ref)按需取回正文,不烧上下文。读操作 T0 allow(与 read/result 同权限语义)。

import { toolError, toolResult } from "@tau/contract"
import type { ArtifactTable } from "@tau/store"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"

export function makeArtifactTool(artifacts: ArtifactTable) {
  return async (req: ExecuteRequest): Promise<ReturnType<typeof toolResult>> => {
    const ref = String(req.args.ref ?? "")
    if (ref === "") throw new ToolErrorException(toolError("rejected", "artifact:缺 ref(历史中的 artifact 引用块)"))
    const record = artifacts.get(ref)
    if (record === null) {
      throw new ToolErrorException(toolError("not_found", `artifact:${ref} 不存在(已删除或未落库)`))
    }
    return toolResult({
      stdout: record.body,
      stderr: null,
      exitCode: 0,
      truncated: false,
      totalPages: 1,
      page: 0,
    })
  }
}
