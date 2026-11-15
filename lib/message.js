/**
 * 消息构造。
 *
 * 等价于官方 @deepseek-ai/dsh-llm 的 createUserMessage：
 *   createMessage → deepFreeze(structuredClone({ ...input, id: randomUUID() }))
 *   createUserMessage → createMessage({ ...input, role: "user" })
 *
 * 不直接 import 该包：外部插件位于 ~/.dsh 下，无法解析 asar 内的依赖。
 * 语义保持完全一致（id 由 randomUUID 生成、对象冻结）。
 */

import { randomUUID } from "node:crypto"

/** 深冻结（与 deepFreeze 等价）。 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** 创建一个带稳定 id 且已冻结的 user 消息。 */
export function createUserMessage(input) {
  return deepFreeze(
    structuredClone({
      ...input,
      role: "user",
      id: randomUUID(),
    }),
  )
}
