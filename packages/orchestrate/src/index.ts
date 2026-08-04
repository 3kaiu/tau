// @tau/orchestrate — index.ts。零新增依赖(契约+llm+session+action 组合)。

export { createScheduler } from "./scheduler.ts"
export type { Scheduler, SchedulerOptions, SchedulerDeps, SchedulerInput, TurnResult } from "./scheduler.ts"
export { GoalJudge, judgeGoalHeuristic } from "./goals.ts"
export type { GoalJudgeResult, GoalJudgeOptions } from "./goals.ts"
export { runMultiRun, selectBestRun, fuseRunResults } from "./multirun.ts"
export type { MultiRunConfig, MultiRunResult, RunResult, MultiRunDeps } from "./multirun.ts"
export const version = "0.0.1"
