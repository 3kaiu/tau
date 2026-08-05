// @tau/action — workspace.ts:工作区模型(根列表归属 + 越界校验 + 增量索引 + 忽略规则)。
// 根列表与越界校验的唯一归宿(自 common.ts PathBoundary 迁入);
// 忽略规则 = 静态 SKIP_DIRS(基线)+ 根 .gitignore(ignore 包预编译匹配树,指纹化失效:
// .gitignore 内容变更即使目录 mtime 未变也会触发整根重扫,不牺牲新鲜度)。
// 树查询语义:目录 mtime 是子条目增删改的结构指纹——目录 mtime 未变 → 整棵子树零 stat 复用;
// 变了 → 只重扫该目录一层并递归检查子目录,不全量重扫。

import { isAbsolute, join, normalize, relative, resolve } from "node:path"
import { readdirSync, readFileSync, statSync } from "node:fs"
import ignore, { type Ignore } from "ignore"

/** 基线跳过集合:与 gitignore 叠加生效(即使仓库没写这些规则也跳过)。
 * .tau-worktrees:编排层工作树(transient,不进模型视野)。 */
export const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".next", ".turbo", "dist", ".workbuddy", ".tau-worktrees"])

export type IndexEntry = {
  /** 绝对路径。 */
  path: string
  isDir: boolean
  size: number
  mtimeMs: number
}

export type IndexStats = {
  /** 已索引目录数(缓存条目)。 */
  dirs: number
  /** 已索引条目数。 */
  entries: number
  /** 全量扫描次数(冷启动/索引根重建/.gitignore 变更)。 */
  fullScans: number
  /** 单目录重扫次数(目录 mtime 变化触发)。 */
  dirRescans: number
  /** 缓存命中跳过重扫的目录数。 */
  dirHits: number
}

/** .gitignore 指纹:内容变更的失效依据(文件 mtime + size)。 */
export type IgnoreFingerprint = { mtimeMs: number; size: number } | null

/** 忽略规则装载:给定根返回 pattern 清单 + 指纹;无 .gitignore 返回 null。
 * 子集声明:仅根 .gitignore(嵌套 .gitignore 不支持);行 = 注释(#)/空白忽略,内联注释不处理。 */
export type LoadIgnoreFn = (root: string) => { patterns: string[]; fingerprint: IgnoreFingerprint } | null

function defaultLoadIgnore(root: string): { patterns: string[]; fingerprint: IgnoreFingerprint } | null {
  const igPath = join(root, ".gitignore")
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(igPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const raw = readFileSync(igPath, "utf8")
  const patterns = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
  return { patterns, fingerprint: { mtimeMs: st.mtimeMs, size: st.size } }
}

export class WorkspaceIndex {
  readonly roots: readonly string[]
  private readonly dirs = new Map<string, { mtimeMs: number; entries: IndexEntry[] }>()
  private readonly rootIgnores = new Map<string, { fp: IgnoreFingerprint; matcher: Ignore | null }>()
  private readonly loadIgnore: LoadIgnoreFn | null
  private fullScans = 0
  private dirRescans = 0
  private dirHits = 0

  constructor(roots: readonly string[] = [], opts: { loadIgnore?: LoadIgnoreFn | null } = {}) {
    this.roots = roots.map((r) => resolve(r))
    this.loadIgnore = opts.loadIgnore === undefined ? defaultLoadIgnore : opts.loadIgnore
  }

  /** 解析相对/绝对路径并做边界检查(根列表归属)。越界抛权限错误。无根绑定则原样返回。 */
  resolveWithin(cwd: string, pathIn: string): string {
    const candidate = isAbsolute(pathIn) ? pathIn : resolve(cwd, pathIn)
    const normalized = normalize(candidate)
    if (this.roots.length === 0) return normalized
    for (const root of this.roots) {
      if (normalized === root || normalized.startsWith(root + "/")) return normalized
    }
    throw new Error(`越界拒绝:${pathIn} 在 workspaceRoots 之外`)
  }

  /** 是否落在任一 workspaceRoot 内(根本身也算)。 */
  contains(path: string): boolean {
    const normalized = normalize(path)
    return this.roots.some((root) => normalized === root || normalized.startsWith(root + "/"))
  }

  /**
   * 确保 root 子树已索引且新鲜。返回 root 下全部条目(含 root 自身一层)。
   * 增量语义:root 或任一子目录 mtime 未变 → 该目录条目直接复用。
   */
  refresh(root: string, opts: { maxDepth?: number } = {}): IndexEntry[] {
    const normalized = normalizeDir(resolve(root))
    const loaded = this.loadIgnoreMatcher(normalized)
    const prev = this.rootIgnores.get(normalized)
    const ignoreChanged = prev === undefined || prev.fp !== loaded.fp
    const needFull = ignoreChanged || !this.dirs.has(normalized)
    if (needFull) {
      if (this.dirs.has(normalized)) this.clearSubtree(normalized)
      this.fullScans++
      this.scanDir(normalized, 0, opts.maxDepth ?? 10, loaded.matcher, normalized)
    } else {
      this.checkDir(normalized, 0, opts.maxDepth ?? 10, loaded.matcher, normalized)
    }
    this.rootIgnores.set(normalized, loaded)
    return this.dirs.get(normalized)?.entries ?? []
  }

  /** 单目录条目(不递归)。目录不存在返回 null。 */
  listDir(dir: string): IndexEntry[] | null {
    this.refresh(dir, { maxDepth: 0 })
    return this.dirs.get(normalizeDir(resolve(dir)))?.entries ?? null
  }

  /** root 下全部条目(扁平,find/grep 用)。按目录缓存键组装,不做任何 stat。 */
  walkAll(root: string): IndexEntry[] {
    const normalized = normalizeDir(resolve(root))
    this.refresh(normalized)
    const out: IndexEntry[] = []
    for (const [dir, cached] of this.dirs) {
      if (dir === normalized || dir.startsWith(normalized + "/")) {
        out.push(...cached.entries)
      }
    }
    return out
  }

  /** 忽略判定(ls 等直读路径复用):SKIP_DIRS 基线 + root .gitignore。 */
  isIgnored(root: string, name: string, fullAbs: string): boolean {
    if (SKIP_DIRS.has(name)) return true
    const matcher = this.loadIgnoreMatcher(normalizeDir(resolve(root))).matcher
    if (matcher === null) return false
    return matcher.ignores(relative(resolve(root), fullAbs).replaceAll("\\", "/"))
  }

  stats(): IndexStats {
    let entries = 0
    for (const d of this.dirs.values()) entries += d.entries.length
    return { dirs: this.dirs.size, entries, fullScans: this.fullScans, dirRescans: this.dirRescans, dirHits: this.dirHits }
  }

  private loadIgnoreMatcher(root: string): { fp: IgnoreFingerprint; matcher: Ignore | null } {
    if (this.loadIgnore === null) return { fp: null, matcher: null }
    const loaded = this.loadIgnore(root)
    if (loaded === null) return { fp: null, matcher: null }
    const matcher = ignore()
    matcher.add(loaded.patterns)
    return { fp: loaded.fingerprint, matcher }
  }

  private clearSubtree(root: string): void {
    for (const key of this.dirs.keys()) {
      if (key === root || key.startsWith(root + "/")) this.dirs.delete(key)
    }
  }

  private checkDir(dir: string, depth: number, maxDepth: number, matcher: Ignore | null, ignoreRoot: string): void {
    if (depth > maxDepth) return
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      return
    }
    const cached = this.dirs.get(dir)
    if (cached !== undefined && cached.mtimeMs === st.mtimeMs) {
      this.dirHits++
      for (const entry of cached.entries) {
        if (entry.isDir) this.checkDir(entry.path, depth + 1, maxDepth, matcher, ignoreRoot)
      }
      return
    }
    this.scanDir(dir, depth, maxDepth, matcher, ignoreRoot)
  }

  private scanDir(dir: string, depth: number, maxDepth: number, matcher: Ignore | null, ignoreRoot: string): void {
    if (depth > maxDepth) return
    let st: ReturnType<typeof statSync>
    let names: string[]
    try {
      st = statSync(dir)
      names = readdirSync(dir)
    } catch {
      return
    }
    names.sort()
    const entries: IndexEntry[] = []
    const subDirs: string[] = []
    for (const name of names) {
      const full = join(dir, name)
      let child: ReturnType<typeof statSync>
      try {
        child = statSync(full)
      } catch {
        continue
      }
      const isDir = child.isDirectory()
      if (isDir && SKIP_DIRS.has(name)) continue
      if (matcher !== null) {
        const rel = relative(ignoreRoot, full).replaceAll("\\", "/")
        // git 语义:目录型 pattern(foo/) 在 ignore 包只拦子条目,需对目录本身补查 rel + "/"
        if (matcher.ignores(rel) || (isDir && matcher.ignores(rel + "/"))) continue
      }
      entries.push({ path: full, isDir, size: child.size, mtimeMs: child.mtimeMs })
      if (isDir) subDirs.push(full)
    }
    this.dirs.set(dir, { mtimeMs: st.mtimeMs, entries })
    this.dirRescans++
    this.pruneDescendants(dir, subDirs)
    for (const sub of subDirs) this.checkDir(sub, depth + 1, maxDepth, matcher, ignoreRoot)
  }

  /** 重扫后清掉已消失子目录的缓存键,防幽灵条目与内存膨胀。 */
  private pruneDescendants(dir: string, alive: readonly string[]): void {
    const aliveSet = new Set(alive)
    for (const key of this.dirs.keys()) {
      if (key === dir) continue
      if (key.startsWith(dir + "/") && !aliveSet.has(key)) this.dirs.delete(key)
    }
  }
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, "") || "/"
}
