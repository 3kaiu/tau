// @tau/action — worktree.ts:编排层工作树(唯一副作用出口,经 plane.execute 审计)。
// tier T2(内部机制):不注入投影,仅 orchestrate 经 execute 调用——multi-run 子会话
// 在独立工作树内读写(相对路径默认落在工作树,并行 run 互不污染);
// 位置固定在首个 workspaceRoot 的 .tau-worktrees/ 下,SKIP_DIRS 已含该目录(不进模型视野)。

import { join, relative } from "node:path"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { toolError, toolResult } from "@tau/contract"
import type { ToolResult } from "@tau/contract"
import { ToolErrorException, type ExecuteRequest } from "./runtime.ts"
import type { WorkspaceIndex } from "./workspace.ts"

export const WORKTREE_DIR = ".tau-worktrees"

/** 名称契约:文件系统安全(字母/数字/._- 开头须为字母数字),最长 64。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function rootOf(req: ExecuteRequest, index: WorkspaceIndex): string {
  const root = index.roots[0]
  if (root === undefined) throw new ToolErrorException(toolError("rejected", "worktree:无 workspaceRoot 绑定"))
  return root
}

function sanitize(req: ExecuteRequest, raw: unknown): string {
  const name = String(raw ?? "")
  if (!NAME_RE.test(name)) throw new ToolErrorException(toolError("rejected", `worktree:非法名称 "${name || "(空)"}"(字母/数字/._- ,最长 64)`))
  return name
}

function worktreePath(root: string, name: string): string {
  const target = join(root, WORKTREE_DIR, name)
  if (relative(root, target).startsWith("..")) throw new ToolErrorException(toolError("rejected", "worktree:越界"))
  return target
}

export function makeWorktreeCreateTool(index: WorkspaceIndex) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const name = sanitize(req, req.args.name)
    const target = worktreePath(rootOf(req, index), name)
    mkdirSync(target, { recursive: true })
    return toolResult({ stdout: target, stderr: null })
  }
}

export function makeWorktreeRmTool(index: WorkspaceIndex) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const name = sanitize(req, req.args.name)
    const target = worktreePath(rootOf(req, index), name)
    rmSync(target, { recursive: true, force: true })
    return toolResult({ stdout: `removed ${name}`, stderr: null })
  }
}

export function makeWorktreeListTool(index: WorkspaceIndex) {
  return async (req: ExecuteRequest): Promise<ToolResult> => {
    const dir = join(rootOf(req, index), WORKTREE_DIR)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      names = []
    }
    names.sort()
    return toolResult({
      stdout: `${names.length} 条目\n${names
        .map((n) => (index.contains(join(dir, n)) ? "d " + n : "- " + n))
        .join("\n")}`,
      stderr: null,
    })
  }
}