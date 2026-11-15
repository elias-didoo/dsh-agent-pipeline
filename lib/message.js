/**
 * Message construction.
 *
 * Mirrors the official @deepseek-ai/dsh-llm `createUserMessage`:
 *   createMessage     → deepFreeze(structuredClone({ ...input, id: randomUUID() }))
 *   createUserMessage → createMessage({ ...input, role: "user" })
 *
 * The package is not imported directly: external plugins live under ~/.dsh
 * and cannot resolve dependencies inside app.asar. Semantics are identical
 * (id from randomUUID, object frozen).
 */

import { randomUUID } from "node:crypto"

/** Deep freeze, equivalent to the official `deepFreeze`. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Build a frozen user message with a stable id. */
export function createUserMessage(input) {
  return deepFreeze(
    structuredClone({
      ...input,
      role: "user",
      id: randomUUID(),
    }),
  )
}
