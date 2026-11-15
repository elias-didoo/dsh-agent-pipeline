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

/** Can this decision point still fire? */
function isSpent(decision, progress) {
  return (progress?.byDecisionId?.[decision.id] ?? 0) > 0
}

/**
 * Turn the model's choice into what to do this round.
 *
 * The model names the situation; this decides whether acting on it is new.
 * A `stop` halts auto-advance once and then keeps quiet; a `send` that already
 * went out is never repeated.
 *
 * When the model picks something already spent, the next-best candidate is
 * considered rather than giving up on the turn. Two adjacent decision points
 * can score within a percentage point of each other — measured 29.9% against
 * 29.2% on a third self-check round — and in that case the model's second
 * choice is the right one while its first is merely the same situation one
 * round earlier. Without this the turn would end in `already-sent` and the
 * pipeline would stall on a tie it cannot break.
 *
 * @param decision the decision point the model chose
 * @param progress result of decisionProgress()
 * @param alt optional next candidate, used only when `decision` is spent
 * @returns `{ decision }` or `{ skip: reason }`
 */
export function resolveDecision(decision, progress, alt) {
  if (!decision || typeof decision.id !== "string" || decision.id.length === 0) {
    return { skip: "no-decision" }
  }

  switch (decision.do) {
    case "silent":
      return { skip: "silent" }
    case "stop":
      // Halt once. Repeating the halt every turn would flood the log and pin
      // the projection, so a stop that already fired stays quiet.
      return isSpent(decision, progress) ? { skip: "already-stopped" } : { decision }
    case "send": {
      if (!isSpent(decision, progress)) return { decision }
      if (alt && !isSpent(alt, progress)) {
        return { decision: alt, fellBackFrom: decision.id }
      }
      return { skip: "already-sent" }
    }
    default:
      return { skip: `unknown-action:${decision.do}` }
  }
}

/**
 * Pick the best candidate that has not fired yet.
 *
 * The floor here is deliberately lower than `confidenceFloor`. That floor
 * guards the model's *first* answer, where a low score means the conversation
 * matched nothing in particular. A fallback is different: the first answer
 * already showed the conversation matched a real decision point, just the wrong
 * round of it, so its neighbour is a correction rather than a guess.
 *
 * Raised to the normal floor, the fallback would be refused exactly when the
 * model was least sure — 11.1% against a 15% floor — and the turn would stall.
 *
 * @param decisions the workspace's decision points
 * @param probabilities the model's distribution, id → probability
 * @param progress result of decisionProgress()
 * @returns the highest-scoring unspent decision point, or undefined
 */
export function bestRemaining(decisions, probabilities, progress) {
  // Above 1/n so a flat distribution picks nothing, below the ~0.11 a genuine
  // neighbouring round scores.
  const floor = 0.1
  let best
  let bestP = floor
  for (const d of decisions ?? []) {
    const p = probabilities?.[d?.id]
    if (typeof p !== "number" || p < bestP) continue
    if (isSpent(d, progress)) continue
    if (d.do === "silent") continue
    best = d
    bestP = p
  }
  return best
}
