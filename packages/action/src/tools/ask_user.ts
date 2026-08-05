// @tau/action — tools/ask_user.ts:ask_user 工具。返回 questionId 挂起(经 onPending 登记
// pendingSyscalls),answer 到达恢复返回;选择模式(选项列表)经 answer 的 selected 字段回传。

import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "../runtime.ts"

export function makeAskUserTool(opts: { waitAnswer: (questionId: string, toolName: string, summary: string) => Promise<unknown> }) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const question = String(req.args.question ?? "")
    const options = Array.isArray(req.args.options) ? req.args.options.map(String) : []
    const multiple = req.args.multiple === true
    if (question === "") throw new ToolErrorException(toolError("rejected", "ask_user:缺 question 参数"))
    const questionId = crypto.randomUUID()
    req.onPending?.({ questionId, toolName: req.name, summary: `question:${question}`, resolve: () => undefined })
    const answer = await opts.waitAnswer(questionId, req.name, question.slice(0, 120))

    if (answer !== null && typeof answer === "object" && "__tau_timeout" in (answer as Record<string, unknown>)) {
      throw new ToolErrorException(toolError("timeout", `ask_user:${questionId} 等待回答超时`))
    }
    const answerText = typeof answer === "string" ? answer : JSON.stringify(answer)
    const optionsNote = options.length > 0 ? `\noptions:${options.join(" | ")}${multiple ? "(可多选)" : ""}` : ""
    return toolResult({ stdout: `questionId:${questionId}\nanswer:${answerText ?? ""}${optionsNote}`, stderr: null })
  }
}
