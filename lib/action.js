/**
 * Actions: send a message, stop, or stay silent.
 *
 * The send path mirrors the official dsh-schedule:
 *   createUserMessage({ content, source })   ← has an id, frozen
 *   agent.followup(message)                  ← synchronous
 *   await ctx.sessions.flush(session)        ← wait for durability
 *
 * `source.kind` is "decision" — our own semantics, deliberately not "plugin".
 * Measured against the v4 validator: it only rejects `kind === "plugin"`
 * and empty strings.
 */

import { createUserMessage } from "./message.js"
import { PLUGIN_SOURCE_KIND } from "./arbiter.js"

/**
 * Send one message to the agent.
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 */
export async function sendMessage({ agent, ctx, text, ruleId }) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "empty message" }
  }
  if (typeof agent?.followup !== "function") {
    return { ok: false, error: "agent.followup unavailable" }
  }

  let message
  try {
    message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: PLUGIN_SOURCE_KIND, ruleId },
    })
  } catch (e) {
    return { ok: false, error: `failed to build message: ${String(e?.message ?? e)}` }
  }

  try {
    agent.followup(message)
  } catch (e) {
    return { ok: false, error: `followup failed: ${String(e?.message ?? e)}` }
  }

  // Wait for durability confirmation: the official dsh-schedule always does,
  // and a failure here must be observable.
  try {
    const flushed = await ctx.sessions.flush(agent.session)
    if (flushed === false) {
      return { ok: false, messageId: message.id, error: "durability not confirmed" }
    }
  } catch (e) {
    return { ok: false, messageId: message.id, error: `flush failed: ${String(e?.message ?? e)}` }
  }

  return { ok: true, messageId: message.id }
}
