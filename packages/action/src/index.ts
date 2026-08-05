// @tau/action — index.ts:createActionPlane。注册内置工具与 SystemCall 元数据,
// 挂 capability 门(缺省规则:read/result/tool:catalog allow,write/bash ask)。

import type { Store } from "@tau/store"
import { SystemCallSchema } from "@tau/contract"
import { ActionPlane, type ActionPlaneOptions } from "./runtime.ts"
import { ResultPageStore } from "./tools/common.ts"
import { makeReadTool } from "./tools/read.ts"
import { makeWriteTool } from "./tools/write.ts"
import { makeEditTool } from "./tools/edit.ts"
import { makeBashTool, makeResultTool } from "./tools/bash.ts"
import { makeGrepTool } from "./tools/grep.ts"
import { makeFindTool } from "./tools/find.ts"
import { makeLsTool } from "./tools/ls.ts"
import { makeAskUserTool } from "./tools/ask_user.ts"
import { makeSystemTool } from "./tools/system.ts"
import { makeCatalogTool } from "./tools/catalog.ts"
import { makeFetchTool } from "./tools/fetch.ts"
import { makeRetrieveTool } from "./tools/retrieve.ts"
import { makeArtifactTool } from "./tools/artifact.ts"
import { makeWorktreeCreateTool, makeWorktreeListTool, makeWorktreeRmTool } from "./worktree.ts"
import { WorkspaceIndex } from "./workspace.ts"

export type { ActionPlane, ActionPlaneOptions, ExecuteRequest, ExecuteOutcome, PermissionRequest, PendingAsk } from "./runtime.ts"
export { ToolRegistry } from "./registry.ts"
export { CapabilityGate, DEFAULT_RULES } from "./capability.ts"
export { queryAudit, recordAudit } from "./audit.ts"
export { ResultPageStore } from "./tools/common.ts"
export { WorkspaceIndex, SKIP_DIRS } from "./workspace.ts"
export type { IndexEntry, IndexStats, LoadIgnoreFn, IgnoreFingerprint } from "./workspace.ts"
export { createHookRegistry, auditHook, dangerousToolGate, rateLimitHook } from "./hooks.ts"
export type { Hook, HookContext, HookPhase, HookRegistry } from "./hooks.ts"

export function createActionPlane(store: Store, opts: ActionPlaneOptions = {}): ActionPlane {
  const plane = new ActionPlane(store, opts)
  const pages = new ResultPageStore()
  const treeIndex = new WorkspaceIndex(opts.workspaceRoots ?? [process.cwd()])

  const builtins: { syscall: Record<string, unknown>; executor: (req: Parameters<ActionPlane["execute"]>[0]) => Promise<unknown> }[] = [
    {
      syscall: {
        name: "read",
        description: "读取文件。可选 range{from,to}(1 起)与 preview(前 N 行 + 总行数)。大文件请用 preview 或 range,勿整读。结果带 fileMeta。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对会话 cwd 或绝对路径;越出 workspaceRoots 会被拒绝" },
            from: { type: "integer", description: "起始行(1 起,含)" },
            to: { type: "integer", description: "结束行(含)" },
            preview: { type: "integer", description: "只读前 N 行" },
          },
          required: ["path"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "read", rule: "allow", scope: "tool" },
      },
      executor: makeReadTool(treeIndex),
    },
    {
      syscall: {
        name: "write",
        description: "原子写入文件(整文件覆盖)。目录自动创建。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "write", rule: "ask", scope: "tool" },
      },
      executor: makeWriteTool(treeIndex),
    },
    {
      syscall: {
        name: "edit",
        description: "原子替换文件中的单段文本(old→new)。old 未命中或多命中会拒绝并诊断,请先 read 确认。结果带 fileMeta。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old: { type: "string", description: "要被替换的原文(必须唯一命中)" },
            new: { type: "string", description: "替换后的文本" },
          },
          required: ["path", "old", "new"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "write", rule: "ask", scope: "tool" },
      },
      executor: makeEditTool(treeIndex),
    },
    {
      syscall: {
        name: "bash",
        description: "执行 shell 命令。缺省会话级持久 shell(保留 cwd/env)。长输出自动截断分页,用 result 续读;detach: true 转后台(返回 taskId)。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            new_shell: { type: "boolean", description: "true 时重置为会话起始 cwd/env" },
            shellId: { type: "string", description: "持久 shell 标识,缺省 = 会话级" },
            detach: { type: "boolean", description: "true 时后台执行,立即返回 taskId" },
          },
          required: ["command"],
        },
        tier: "T1",
        dangerous: true,
        defaultRule: { pattern: "bash", rule: "ask", scope: "tool" },
      },
      executor: makeBashTool(pages, plane.tasks),
    },
    {
      syscall: {
        name: "result",
        description: "续读截断的工具结果或轮询后台任务。call_id 来自截断提示或 taskId,page 从 0 起。",
        parameters: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            page: { type: "integer", description: "页号(0 起)" },
          },
          required: ["call_id", "page"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "result", rule: "allow", scope: "tool" },
      },
      executor: makeResultTool(pages),
    },
    {
      syscall: {
        name: "artifact:read",
        description: "按引用取回大载荷正文(artifact 外置块)。ref 来自历史中的 artifact 引用块(带 size/hash,超阈值文本自动外置)。",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "artifact 引用(历史块中的 ref)" },
          },
          required: ["ref"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "artifact:read", rule: "allow", scope: "tool" },
      },
      executor: makeArtifactTool(store.artifacts),
    },
    {
      syscall: {
        name: "grep",
        description: "按正则匹配工作区文件内容(跳过二进制与超大文件),返回 文件:行号: 文本。",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "正则表达式" },
            path: { type: "string", description: "搜索起点(目录),缺省 cwd" },
          },
          required: ["pattern"],
        },
        tier: "T1",
        dangerous: false,
        defaultRule: { pattern: "read", rule: "allow", scope: "tool" },
      },
      executor: makeGrepTool(treeIndex),
    },
    {
      syscall: {
        name: "find",
        description: "按文件名子串匹配工作区文件。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "文件名子串(不区分大小写)" },
            path: { type: "string", description: "搜索起点(目录),缺省 cwd" },
          },
          required: ["name"],
        },
        tier: "T1",
        dangerous: false,
        defaultRule: { pattern: "read", rule: "allow", scope: "tool" },
      },
      executor: makeFindTool(treeIndex),
    },
    {
      syscall: {
        name: "ls",
        description: "列出目录条目(名称+类型;long 模式带大小与 mtime)。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径,缺省 cwd" },
            long: { type: "boolean" },
          },
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "read", rule: "allow", scope: "tool" },
      },
      executor: makeLsTool(treeIndex),
    },
    {
      syscall: {
        name: "ask_user",
        description: "向用户提问并等待回答(挂起)。可选选项列表与多选。回答到达后返回 questionId + answer。",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" }, description: "选项列表(选择模式)" },
            multiple: { type: "boolean", description: "是否允许多选" },
          },
          required: ["question"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "ask_user", rule: "allow", scope: "tool" },
      },
      executor: makeAskUserTool({ waitAnswer: (questionId, toolName, summary) => plane.waitAnswer(questionId, toolName, summary) }),
    },
    {
      syscall: {
        name: "system",
        description: "内省:完整权限规则(rules)/挂起计数(pending)/工具目录(catalog)/取消后台任务(cancel_task)。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["rules", "pending", "catalog", "cancel_task"], description: "缺省返回 capabilities" },
            task_id: { type: "string", description: "cancel_task 的目标 taskId" },
          },
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "system", rule: "allow", scope: "tool" },
      },
      executor: makeSystemTool({ plane, registry: plane.registry }),
    },
    {
      syscall: {
        name: "tool:catalog",
        description: "工具目录(含危险标记/tier/规则)。冷工具 = 未激活执行器的工具,调用会 rejected。",
        parameters: {
          type: "object",
          properties: {
            detail: { type: "boolean", description: "true 时输出参数 schema 与规则详情" },
          },
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "tool:catalog", rule: "allow", scope: "tool" },
      },
      executor: makeCatalogTool(plane.registry),
    },
    {
      syscall: {
        name: "fetch",
        description: "抓取 URL 并净化为文本。拒绝 file:// 与本地协议;结果带 url/fetchedAt/truncated。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
          required: ["url"],
        },
        tier: "T1",
        dangerous: false,
        defaultRule: { pattern: "fetch", rule: "ask", scope: "tool" },
      },
      executor: makeFetchTool(),
    },
    {
      syscall: {
        name: "retrieve",
        description: "检索本会话已产生的工具输出(截断暂存区全文),子串过滤。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        tier: "T0",
        dangerous: false,
        defaultRule: { pattern: "read", rule: "allow", scope: "tool" },
      },
      executor: makeRetrieveTool(pages),
    },
    {
      syscall: {
        name: "worktree:create",
        description: "内部:编排层工作树创建(仅 orchestrate 调用,不注入模型视野)。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "工作树名(字母/数字/._-,最长 64)" },
          },
          required: ["name"],
        },
        tier: "T2",
        dangerous: false,
        defaultRule: { pattern: "worktree:create", rule: "allow", scope: "tool" },
      },
      executor: makeWorktreeCreateTool(treeIndex),
    },
    {
      syscall: {
        name: "worktree:rm",
        description: "内部:编排层工作树清理(仅 orchestrate 调用,不注入模型视野)。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
        tier: "T2",
        dangerous: false,
        defaultRule: { pattern: "worktree:rm", rule: "allow", scope: "tool" },
      },
      executor: makeWorktreeRmTool(treeIndex),
    },
    {
      syscall: {
        name: "worktree:list",
        description: "内部:枚举工作树(崩溃残留发现)。",
        parameters: { type: "object", properties: {} },
        tier: "T2",
        dangerous: false,
        defaultRule: { pattern: "worktree:list", rule: "allow", scope: "tool" },
      },
      executor: makeWorktreeListTool(treeIndex),
    },
  ]

  for (const { syscall, executor } of builtins) {
    const parsed = SystemCallSchema.parse(syscall)
    plane.registry.register(parsed)
    if (parsed.defaultRule !== undefined) plane.gate.addRule(parsed.defaultRule)
    plane.registerExecutor(parsed.name, executor as never)
  }
  return plane
}
