/**
 * Stage progress: derive "how far into the stage are we" from the log.
 *
 * Design notes:
 *   - No extra state store. DSH treats the session log as the single source
 *     of truth, and every message this plugin sends carries a `ruleId`, so
 *     counting them yields progress for free.
 *   - The model only answers "which of the six stages is this?".
 *     Ordering *within* a stage (which self-check round, whether to summarise)
 *     is decided by the counters here — "how many times so far" is not present
 *     in the conversation text and the model cannot infer it.
 */

import { PLUGIN_SOURCE_KIND } from "./arbiter.js"

/**
 * Group the session's messages into per-rule progress.
 *
 * @param messages result of session.deriveMessages()
 * @param rules current workspace rules (tells us which ids belong to this plugin)
 * @returns {{ byRuleId: Record<string, number>, selfCheckRound: number }}
 */
export function phaseProgress(messages, rules) {
  const known = new Set((rules ?? []).map((r) => r.id))
  /** @type {Record<string, number>} */
  const byRuleId = {}

  for (const m of messages ?? []) {
    if (m?.role !== "user") continue
    const src = m?.source
    if (!src || src.kind !== PLUGIN_SOURCE_KIND) continue
    const id = src.ruleId
    // Count only rules still present in the current config, so records left
    // behind by an older config cannot pollute progress.
    if (typeof id !== "string" || !known.has(id)) continue
    byRuleId[id] = (byRuleId[id] ?? 0) + 1
  }

  // Self-check round = number of self-check rules already sent (one each).
  let selfCheckRound = 0
  for (const [id, n] of Object.entries(byRuleId)) {
    if (/^self[-_]?check/i.test(id)) selfCheckRound += n
  }

  return { byRuleId, selfCheckRound }
}

/**
 * Decide which rule to run this round.
 *
 * @param stage stage reported by the model
 * @param progress result of phaseProgress()
 * @param rules rules for this workspace
 * @returns `{ rule }` or `{ skip: reason }`
 */
export function pickRule(stage, progress, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return { skip: "no-rules" }

  // Config order within a stage drives the sequential rules.
  const inStage = rules.filter((r) => r.when === stage && r.action !== "silent")

  if (stage === "implementing") {
    // The agent is working — no reason to nudge it.
    return { skip: "implementing" }
  }

  if (stage === "waiting") {
    const r = inStage.find((x) => x.action === "stop")
    return r ? { rule: r } : { skip: "no-stop-rule" }
  }

  if (stage === "finished") {
    const r = inStage.find((x) => x.action === "stop")
    return r ? { rule: r } : { skip: "no-stop-rule" }
  }

  if (stage === "conflict") {
    const r = inStage.find((x) => x.action === "send")
    return r ? { rule: r } : { skip: "no-send-rule" }
  }

  if (stage === "selfchecking") {
    // Self-check is a fixed sequence: 1 → 2 → 3 → push.
    const ordered = inStage.filter((r) => r.action === "send")
    const next = ordered[progress.selfCheckRound]
    if (next === undefined) return { skip: "selfcheck-complete" }
    return { rule: next }
  }

  if (stage === "planning") {
    const ordered = inStage.filter((r) => r.action === "send")
    if (ordered.length === 0) {
      const r = inStage.find((x) => x.action === "stop")
      return r ? { rule: r } : { skip: "no-rule" }
    }

    // planning `send` rules advance in config order: each fires once and is
    // then skipped, judged from the ruleId counts in the log. No special naming
    // convention is needed for the sequence to work.
    for (const r of ordered) {
      const fired = progress.byRuleId?.[r.id] ?? 0
      if (fired > 0) continue
      return { rule: r }
    }

    // Everything that should fire has fired → hand over to the stop rule.
    const halt = inStage.find((x) => x.action === "stop")
    if (halt) {
      const fired = progress.byRuleId?.[halt.id] ?? 0
      if (fired === 0) return { rule: halt }
    }
    return { skip: "planning-complete" }
  }

  return { skip: `unknown-stage:${stage}` }
}
