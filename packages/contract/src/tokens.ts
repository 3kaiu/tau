// @tau/contract — tokens.ts:无 tokenizer 的字符级 token 估算(多语言加权)。
// CJK 字符按 1 token 计(实测约 0.6–1.2),其余按 4 字符/token;估算只用于预算/压缩触发,
// 真实计数以 LLM usage 为准(recordUsage 覆盖)。

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/

/** 估算一段文本的 token 数:CJK 字符 1:1,其余 4 字符:1。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let rest = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else rest++
  }
  return cjk + rest / 4
}
