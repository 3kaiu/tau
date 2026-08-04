// @tau/eval - eval.ts:套件运行器(并行 + 汇总)。
// 断言间无共享状态;失败不中断其余断言(收集全部结果);同输入同输出,可复现可调试。

export type AssertResult = {
  id: number
  name: string
  description: string
  passed: boolean
  detail: string | null
  durationMs: number
}

export type EvalResult = {
  total: number
  passed: number
  failed: number
  results: readonly AssertResult[]
  durationMs: number
  timestamp: string
}

export type Assert = {
  id: number
  name: string
  description: string
  run(): Promise<void> | void
}

export async function runSuite(asserts: readonly Assert[]): Promise<EvalResult> {
  const start = Date.now()
  const results: AssertResult[] = []

  for (const assert of asserts) {
    const t0 = Date.now()
    let passed = true
    let detail: string | null = null
    try {
      await assert.run()
    } catch (err) {
      passed = false
      detail = err instanceof Error ? err.message : String(err)
    }
    results.push({
      id: assert.id,
      name: assert.name,
      description: assert.description,
      passed,
      detail,
      durationMs: Date.now() - t0,
    })
  }

  const passed = results.filter((r) => r.passed).length
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
