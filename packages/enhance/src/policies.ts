// @tau/enhance - policies.ts:策略集(codemode 解释器 + 子代理三件套)。
// 声明式:每个 policy = 名称/一句话/能力清单/行为提示;代码只注册不内联行为。
// 子代理(coder/explore/plan)是可注入 Context 的会话策略,不是独立进程。

export type PolicyCapability =
  | "read"
  | "edit"
  | "bash"
  | "search"
  | "memory"
  | "ask_user"
  | "no_network"
  | "readonly"

export type SubAgentPolicy = {
  name: "coder" | "explore" | "plan"
  description: string
  /** 允许的工具面(降权依据:explore/plan 无写权)。 */
  capabilities: readonly PolicyCapability[]
  /** 注入系统块的提示文本(声明式,不内联行为)。 */
  systemHint: string
}

const CODING_CAPS: readonly PolicyCapability[] = ["read", "edit", "bash", "search", "memory", "ask_user"]
const READONLY_CAPS: readonly PolicyCapability[] = ["read", "search", "ask_user"]

/** 子代理三件套(SPEC:默认 policy 集,declarative)。 */
export const SUB_AGENT_POLICIES: readonly SubAgentPolicy[] = [
  {
    name: "coder",
    description: "写代码子代理:被授予编辑权,按步骤实现并在每步后验证",
    capabilities: CODING_CAPS,
    systemHint:
      "你是 coder 子代理:先读目标文件确认现状,再最小化编辑;每步编辑后运行校验命令;不要重写无关代码;改完报告改了哪些文件。",
  },
  {
    name: "explore",
    description: "探索子代理:只读调查代码库,产出结构化发现,不改任何文件",
    capabilities: READONLY_CAPS,
    systemHint:
      "你是 explore 子代理:只读模式,禁止任何写操作(edit/write/bash 都不可用);用 grep/find/read 收集证据,按主题归纳,引用文件:行号。",
  },
  {
    name: "plan",
    description: "规划子代理:只读分析任务并产出分步计划(步骤/验证/风险),不执行",
    capabilities: READONLY_CAPS,
    systemHint:
      "你是 plan 子代理:只读模式;产出分步实施计划——每步含目标、验证命令、失败回退;标出风险与需用户确认的点;不执行任何改动。",
  },
]

export type PolicyCatalog = {
  names: string[]
  entries: Map<string, SubAgentPolicy>
}

/** 策略目录(供模型发现与能力降权查询)。 */
export function policyCatalog(): PolicyCatalog {
  const entries = new Map<string, SubAgentPolicy>()
  for (const p of SUB_AGENT_POLICIES) entries.set(p.name, p)
  return { names: SUB_AGENT_POLICIES.map((p) => p.name), entries }
}

/** codemode 解释器:把用户意图映射到子代理(policy 匹配,声明式)。 */
export function interpretCodemode(text: string): { agent: SubAgentPolicy; confidence: "high" | "medium" | "low" } {
  const t = text.toLowerCase()
  const hits = SUB_AGENT_POLICIES.map((p) => {
    let score = 0
    if (p.name === "coder" && /(实现|写|改|修复|implement|write|fix|refactor|add)/.test(t)) score += 2
    if (p.name === "explore" && /(调查|探索|了解|为什么|explore|investigate|how does|搜索)/.test(t)) score += 2
    if (p.name === "plan" && /(计划|方案|步骤|规划|plan|design|approach)/.test(t)) score += 2
    if (p.name === "coder" && /(explore|plan|调查|计划)/.test(t)) score -= 1
    return { p, score }
  })
  const best = hits.sort((a, b) => b.score - a.score)[0]
  if (best === undefined || best.score === 0) {
    return { agent: SUB_AGENT_POLICIES[2]!, confidence: "low" }
  }
  return { agent: best.p, confidence: best.score >= 2 ? "high" : "medium" }
}
