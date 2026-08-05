// @tau/session — artifacts.ts:大载荷存储(artifact 正文存 store,历史仅引用)。
// 按引用取回正文;正文不进事件流与投影;引用保留 mime/大小/hash(模型按需检索,不烧上下文)。

import { createHash } from "node:crypto"
import type { ArtifactMeta, Store } from "@tau/store"
import type { ArtifactBlock, ContentBlock } from "@tau/contract"

export type ArtifactBody = {
  ref: string
  mime?: string
  size: number
  hash: string
  body: string
}

/** 缺省 artifact 阈值(text 块超此字节数 → 外置为引用;大载荷不烧上下文)。 */
export const DEFAULT_ARTIFACT_THRESHOLD_BYTES = 16 * 1024

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/** 正文落 store,返回历史用引用块。ref 缺省 = 内容 hash 前缀(同内容同引用,天然去重)。 */
export function storeArtifact(
  store: Store,
  input: { sessionId: string; ref?: string; content: string; mime?: string },
): ArtifactBlock {
  const hash = sha256(input.content)
  const ref = input.ref ?? `art-${hash.slice(0, 16)}`
  store.artifacts.put({
    ref,
    sessionId: input.sessionId,
    ...(input.mime !== undefined ? { mime: input.mime } : {}),
    size: input.content.length,
    hash,
    body: input.content,
    createdAt: new Date().toISOString(),
  })
  return {
    type: "artifact",
    ref,
    ...(input.mime !== undefined ? { mime: input.mime } : {}),
    size: input.content.length,
    hash,
  } as ArtifactBlock
}

export function readArtifact(store: Store, ref: string): ArtifactBody | null {
  const record = store.artifacts.get(ref)
  if (record === null) return null
  return {
    ref: record.ref,
    ...(record.mime !== undefined ? { mime: record.mime } : {}),
    size: record.size,
    hash: record.hash,
    body: record.body,
  } as ArtifactBody
}

export function listArtifacts(store: Store, sessionId: string): readonly ArtifactMeta[] {
  return store.artifacts.list(sessionId)
}

/** purge 悬空提示:删前检查活跃历史是否仍引用该 ref;返回 true = 无残留引用,false = 产生了悬空引用(调用方应提示)。 */
export function purgeArtifact(store: Store, ref: string): boolean {
  const record = store.artifacts.get(ref)
  if (record === null) return true
  const messages = store.messages.list(record.sessionId).messages
  const stillReferenced = messages.some((m) => m.content.some((b) => b.type === "artifact" && b.ref === ref))
  store.artifacts.delete(ref)
  return !stillReferenced
}

const encoder = new TextEncoder()

/** 消息内容外置:超过阈值的 text 块(按字节计,CJK 等宽字符不被字符计数低估)→ artifact 引用块(正文存 store,历史不烧上下文)。 */
export function externalizeContent(
  store: Store,
  sessionId: string,
  content: readonly ContentBlock[],
  thresholdBytes: number,
): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    if (block.type === "text" && encoder.encode(block.text).length > thresholdBytes) {
      out.push(storeArtifact(store, { sessionId, content: block.text, mime: "text/plain" }))
    } else {
      out.push(block)
    }
  }
  return out
}
