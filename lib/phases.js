/**
 * Stage progress: derive "how far into the stage are we" from the log, and pick
 * the rule that should run next.
 *
 * Design notes:
 *   - No extra state store. DSH treats the session log as the single source of
 *     truth, and every message this plugin sends carries a `ruleId`, so
 *     counting them yields progress for free.
 *   - The model only answers "which stage is this?". Ordering *within* a stage
 *     (which self-check round, whether to summarise) is decided by the counters
 *     here — "how many times so far" is not present in the conversation text
 *     and the model cannot infer it.
 *   - What a stage *does* is its `behavior` (see stages.js). Nothing here
 *     mentions a stage id, so user-defined stages work the same way.
 */

import { PLUGIN_SOURCE_KIND } from "./arbiter.js"

/**
 * Group the session's messages into per-rule progress.
 *
 * @param messages result of session.deriveMessages()
 * @param rules current workspace rules (tells us which ids belong to this plugin)
 * @returns {{ byRuleId: Record<string, number> }}
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

  return { byRuleId }
}

/**
 * Decide which rule to run this round.
 *
 * @param stage stage definition ({ id, behavior, … }) or a bare id
 * @param progress result of phaseProgress()
 * @param rules rules for this workspace
 * @returns `{ rule }` or `{ skip: reason }`
 */
export function pickRule(stage, progress, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return { skip: "no-rules" }

  const id = typeof stage === "string" ? stage : stage?.id
  const behavior = typeof stage === "string" ? undefined : stage?.behavior
  if (typeof id !== "string" || id.length === 0) return { skip: "no-stage" }

  const inStage = rules.filter((r) => r.when === id && r.action !== "silent")
  const fired = (ruleId) => progress?.byRuleId?.[ruleId] ?? 0

  switch (behavior) {
    // The agent is working — any nudge would interrupt it.
    case "passive":
      return { skip: "passive" }

    // Halt auto-advance. Nothing is sent: the point is to wait for the user.
    case "terminal": {
      const stop = inStage.find((x) => x.action === "stop")
      if (!stop) return { skip: "no-stop-rule" }
      return fired(stop.id) === 0 ? { rule: stop } : { skip: "already-stopped" }
    }

    // One rule per entry into this stage.
    case "once": {
      const next = inStage.find((x) => x.action === "send" && fired(x.id) === 0)
      return next ? { rule: next } : { skip: "already-fired" }
    }

    // Fire every send rule in config order, then hand over to the stop rule.
    case "sequence": {
      const next = inStage.find((x) => x.action === "send" && fired(x.id) === 0)
      if (next) return { rule: next }
      const stop = inStage.find((x) => x.action === "stop")
      if (stop && fired(stop.id) === 0) return { rule: stop }
      return { skip: "stage-complete" }
    }

    // A stage the config does not define, or one whose behavior this version
    // does not implement. The caller logs the id and the reason, which is what
    // makes a typo in `when` findable.
    default:
      return { skip: behavior ? `unknown-behavior:${behavior}` : `undefined-stage:${id}` }
  }
}
