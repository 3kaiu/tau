// @tau/eval - report.ts:结果报告(runs.jsonl + 摘要)。
// runs.jsonl 追加写,不覆盖历史;输出格式标准化,跨版本可对比。

import type { EvalResult } from "./eval.ts"
import type { AssertResult } from "./eval.ts"

/** 单行 runs.jsonl 记录(标准化,跨版本可对比)。 */
type RunRecord = {
  timestamp: string
  total: number
  passed: number
  failed: number
  durationMs: number
  results: Array<{
    id: number
    name: string
    passed: boolean
    detail: string | null
    durationMs: number
  }>
}

export function toRunRecord(result: EvalResult): RunRecord {
  return {
    timestamp: result.timestamp,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    durationMs: result.durationMs,
    results: result.results.map((r) => ({
      id: r.id,
      name: r.name,
      passed: r.passed,
      detail: r.detail,
      durationMs: r.durationMs,
    })),
  }
}

export function formatJsonl(result: EvalResult): string {
  return JSON.stringify(toRunRecord(result))
}

export function formatSummary(result: EvalResult): string {
  const lines: string[] = []
  lines.push(`eval: ${result.passed}/${result.total} passed (${result.failed} failed) in ${result.durationMs}ms`)
  for (const r of result.results) {
    const icon = r.passed ? "✓" : "✗"
    const detail = r.detail !== null ? ` -- ${r.detail}` : ""
    lines.push(`  ${icon} #${r.id} ${r.name}${detail}`)
  }
  return lines.join("\n")
}

export function formatAssertResult(r: AssertResult): string {
  const icon = r.passed ? "✓" : "✗"
  const detail = r.detail !== null ? ` -- ${r.detail}` : ""
  return `${icon} #${r.id} ${r.name}${detail}`
}
