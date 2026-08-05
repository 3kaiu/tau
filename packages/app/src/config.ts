// @tau/app - config.ts:配置装载/合并/消费方。
// 纯 schema 归 contract:本文件只做 store.kv → ConfigSchema 的装载路径,
// 不做任何配置语义决策。非法配置经 parseMergedConfig(contract)校验期暴露。

import { parseMergedConfig, type Config } from "@tau/contract"
import type { Store } from "@tau/store"

export const CONFIG_PREFIX = "config:"

/** 从 store.kv 装载配置(config:* 前缀)并合并校验。 */
export function loadConfigFromStore(store: Store): Config {
  const entries = Object.fromEntries(store.kv.list(CONFIG_PREFIX).map((e) => [e.key.slice(CONFIG_PREFIX.length), e.value]))
  return parseMergedConfig(entries)
}