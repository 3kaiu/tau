// @tau/llm — auth.ts:凭据解析(env → 存储 → OAuth 的链条首位)。
// 动态凭据可过期刷新;本层只解析,不持有 secrets 本体于内存外。

export function fromEnv(name: string): string | null {
  const value = Bun.env[name]
  return value && value !== "" ? value : null
}

/** 解析链条:显式值 > envKey 指定的环境变量 > api 默认环境变量。返回 null 表示缺凭据。 */
export function resolveApiKey(
  explicit: string | null | undefined,
  envKey: string | undefined,
  apiDefaultEnv: string,
): string | null {
  if (explicit && explicit !== "") return explicit
  if (envKey) {
    const fromSpecified = fromEnv(envKey)
    if (fromSpecified) return fromSpecified
  }
  return fromEnv(apiDefaultEnv)
}

/** OAuth/存储源占位:未来接入时在这里扩展解析链条,API 不变。 */
export type CredentialSource = "env" | "explicit" | "missing"
