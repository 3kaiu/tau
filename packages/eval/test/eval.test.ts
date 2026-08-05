// @tau/eval - 套件测试:运行全部行为断言,验证全绿。

import { describe, expect, it } from "vitest"
import { runSuite, allAsserts, formatSummary } from "../src/index.ts"

describe("eval:全部行为断言全绿", () => {
  it("runSuite(allAsserts) 全部通过", async () => {
    const result = await runSuite(allAsserts)
    const failed = result.results.filter((r) => !r.passed)
    if (failed.length > 0) {
      const detail = failed.map((r) => `  ✗ #${r.id} ${r.name}: ${r.detail}`).join("\n")
      throw new Error(`${failed.length}/${result.total} 断言失败:\n${detail}`)
    }
    expect(result.passed).toBe(result.total)
    expect(result.failed).toBe(0)
  }, 30000)

  it("formatSummary 输出包含全部断言", async () => {
    const result = await runSuite(allAsserts)
    const summary = formatSummary(result)
    for (const a of allAsserts) {
      expect(summary).toContain(`#${a.id}`)
      expect(summary).toContain(a.name)
    }
  })
})
