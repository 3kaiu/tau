// @tau/llm — auth.ts:凭据解析(env → 存储 → OAuth 的链条首位)。
// 动态凭据可过期刷新;本层只解析,不持有 secrets 本体于内存外。

export function fromEnv(name: string): string | null {
  const value = Bun.env[name]
  return value && value !== "" ? value : null
}

export type CredentialSource = "env" | "explicit" | "missing"

export type AuthResolution = {
  key: string | null
  /** 凭据来源(可观测,供 doctor/治理面排查缺 key 原因)。 */
  source: CredentialSource
}

/** 解析链条:显式值 > envKey 指定的环境变量 > api 默认环境变量。返回 null 表示缺凭据。 */
export function resolveApiKey(
  explicit: string | null | undefined,
  envKey: string | undefined,
  apiDefaultEnv: string,
): string | null {
  return resolveAuth(explicit, envKey, apiDefaultEnv).key
}

/** 带来源的解析(同 resolveApiKey 链条,额外报告 key 从哪来)。 */
export function resolveAuth(
  explicit: string | null | undefined,
  envKey: string | undefined,
  apiDefaultEnv: string,
): AuthResolution {
  if (explicit && explicit !== "") return { key: explicit, source: "explicit" }
  if (envKey) {
    const fromSpecified = fromEnv(envKey)
    if (fromSpecified) return { key: fromSpecified, source: "env" }
  }
  const fromDefault = fromEnv(apiDefaultEnv)
  return fromDefault ? { key: fromDefault, source: "env" } : { key: null, source: "missing" }
}

/** OAuth/存储源为规划:未来接入时在 resolveAuth 链条中扩展,API 不变。 */
