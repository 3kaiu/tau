// @tau/contract — 契约层汇总出口。
// 纯 schema + 校验,零 IO、零业务逻辑;JSON Schema 导出是跨语言 wire 契约。

import { toJSONSchema, type z } from "zod"
import { ModelSchema } from "./model.ts"
import { ContextProjectionSchema, MessageSchema, ResourcesSchema, SelfSchema } from "./context.ts"
import { SystemCallSchema, ToolResultSchema } from "./syscall.ts"
import { CommandSchema } from "./command.ts"
import { EventSchema } from "./event.ts"
import { GoalSchema } from "./goal.ts"
import { SessionSnapshotSchema } from "./session.ts"
import { ConfigSchema } from "./config.ts"

export const version = "0.0.1"

export * from "./model.ts"
export * from "./context.ts"
export * from "./syscall.ts"
export * from "./command.ts"
export * from "./event.ts"
export * from "./goal.ts"
export * from "./session.ts"
export * from "./config.ts"
export * from "./invariant.ts"

/** 契约 schema 注册表:模块加载时编译一次,热路径校验复用同一实例(zod 内部缓存)。 */
export const contractSchemas = {
  Model: ModelSchema,
  ContextProjection: ContextProjectionSchema,
  Message: MessageSchema,
  SystemCall: SystemCallSchema,
  ToolResult: ToolResultSchema,
  Command: CommandSchema,
  Event: EventSchema,
  Goal: GoalSchema,
  SessionSnapshot: SessionSnapshotSchema,
  Resources: ResourcesSchema,
  Self: SelfSchema,
  Config: ConfigSchema,
} as const

export type ContractSchemaName = keyof typeof contractSchemas

/** 全部契约的 JSON Schema(draft 2020-12),跨语言/跨进程 wire 契约。 */
export function jsonSchemas(): Record<ContractSchemaName, z.core.JSONSchema.BaseSchema> {
  return Object.fromEntries(
    Object.entries(contractSchemas).map(([name, schema]) => [name, toJSONSchema(schema as z.ZodType)]),
  ) as Record<ContractSchemaName, z.core.JSONSchema.BaseSchema>
}

/** 运行时校验:返回 zod 结果,调用方自行处理 ok/error。 */
export function validate<T extends z.ZodType>(schema: T, input: unknown): z.core.util.SafeParseResult<z.core.output<T>> {
  return schema.safeParse(input)
}
