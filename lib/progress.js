/**
 * Progress: has this decision point already fired?
 *
 * DSH treats the session log as the single source of truth. Every message this
 * plugin sends carries the id of the decision point that sent it, so counting
 * those messages answers "did this already fire?" without a second store.
 *
 * This is the only part of the pipeline that keeps state, and it guards one
 * property: a decision point that sends fires once. The model is not asked to
 * remember that — it reads the conversation and picks whatever matches the
 * situation, and if that is something already sent, this says so.
 */

import { PLUGIN_SOURCE_KIND } from "./arbiter.js"

/**
 * Count how many times each decision point has fired.
 *
 * Only ids present in the current config are counted, so records left behind by
 * an older config cannot make a fresh decision look already spent.
 *
 * @param messages result of session.deriveMessages()
 * @param decisions current workspace decision points
 * @returns {{ byDecisionId: Record<string, number> }}
 */
export function decisionProgress(messages, decisions) {
  const known = new Set((decisions ?? []).map((d) => d.id))
  /** @type {Record<string, number>} */
  const byDecisionId = {}

  for (const m of messages ?? []) {
    if (m?.role !== "user") continue
    const src = m?.source
    if (!src || src.kind !== PLUGIN_SOURCE_KIND) continue
    // The field is `ruleId` because that is the v4 message-source shape this
    // plugin already writes; it now carries a decision id.
    const id = src.ruleId
    if (typeof id !== "string" || !known.has(id)) continue
    byDecisionId[id] = (byDecisionId[id] ?? 0) + 1
  }

  return { byDecisionId }
}

/**
 * Turn the model's choice into what to do this round.
 *
 * The model names the situation; this decides whether acting on it is new.
 * A `stop` halts auto-advance once and then keeps quiet; a `send` that already
 * went out is never repeated.
 *
 * @param decision the decision point the model chose
 * @param progress result of decisionProgress()
 * @returns `{ decision }` or `{ skip: reason }`
 */
export function resolveDecision(decision, progress) {
  if (!decision || typeof decision.id !== "string" || decision.id.length === 0) {
    return { skip: "no-decision" }
  }
  const fired = progress?.byDecisionId?.[decision.id] ?? 0

  switch (decision.do) {
    case "silent":
      return { skip: "silent" }
    case "stop":
      // Halt once. Repeating the halt every turn would flood the log and pin
      // the projection, so a stop that already fired stays quiet.
      return fired === 0 ? { decision } : { skip: "already-stopped" }
    case "send":
      return fired === 0 ? { decision } : { skip: "already-sent" }
    default:
      return { skip: `unknown-action:${decision.do}` }
  }
}
