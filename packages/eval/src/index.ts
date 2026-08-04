// @tau/eval - 行为评测汇总出口。
// 证明"宪法没被违反":契约级行为断言 + FauxLlm 注入,全部离线、零网络、零真实模型依赖。

export { runSuite } from "./eval.ts"
export type { Assert, AssertResult, EvalResult } from "./eval.ts"

export { createFauxLlm, textReply, toolReply, errorReply, abortedReply } from "./faux.ts"
export type { FauxScript, FauxReply } from "./faux.ts"

export { createFixture, runTurn } from "./fixtures.ts"
export type { Fixture, FixtureOptions } from "./fixtures.ts"

export { allAsserts } from "./asserts.ts"

export { formatSummary, formatJsonl, formatAssertResult, toRunRecord } from "./report.ts"

export const version = "0.0.1"

/** 默认套件:13 个行为断言。CI 调 `runSuite(allAsserts)` 即可。 */
export { allAsserts as defaultSuite } from "./asserts.ts"
