/**
 * Prompt sent to resume an interrupted turn.
 *
 * This is runtime data handed to the agent, so it follows the UI language
 * rather than the repository's source language.
 */
const RETRY_TEXT = {
  zh: "刚才的请求似乎中断了，请继续。",
  en: "The previous request seems to have been interrupted. Please continue.",
}

/** UI locale from config, defaulting to English. */
function uiLocale(cfg) {
  return cfg?.locale === "zh" ? "zh" : "en"
}

/**
 * Main loop: turn/end → arbitration → decision → action.
 *
 * State lives in a sessionProjection (the officially recommended place)
 * rather than process memory: it can be rebuilt from the log after a restart,
 * and no full session/event subscription is needed.
 */

import { arbitrate, lastHumanAt } from "./arbiter.js"
import { buildState } from "./context.js"
import { judge, Outcome, isRetryable } from "./judge.js"
import { decisionProgress, resolveDecision, bestRemaining } from "./progress.js"
import { decisionById } from "./decisions.js"
import { sendMessage } from "./action.js"
import { effectiveConfig } from "./config.js"
import { log, summarize } from "./log.js"

/**
 * Read runtime state out of the projection state.
 * The projection's `apply` only does pure counting; derived decisions live here.
 */
export function readRuntime(state) {
  return {
    iterations: state?.iterations ?? 0,
    failures: state?.failures ?? 0,
    stoppedReason: state?.stoppedReason ?? null,
    awaitingRuleId: state?.awaitingRuleId ?? null,
  }
}

/**
 * Handle one turn/end.
 *
 * @param {object} p
 * @param {object} p.ctx
 * @param {object} p.agent
 * @param {object} p.session
 * @param {object} p.turnEnd     event.data（{ turn, reason }）
 * @param {object} p.config      raw plugin config
 * @param {object} p.state       current projection state (write back via mutate)
 * @param {Function} p.mutate    update the projection state
 * @param {object} p.queue       serial queue
 * @returns {Promise<object>} outcome; `action` is one of:
 *   - `send`    a prompt was sent
 *   - `retry`   re-sent "please continue" after a network interruption
 *   - `halt`    a stop point was reached, or the judgement was uncertain; auto-advance
 *               paused until the user replies
 *   - `stopped` terminated by an error or the iteration limit (see `reason`)
 *   - `error`   this run failed but the termination threshold was not reached
 *   or `{ skipped }` when it was held back without acting
 */
export async function handleTurnEnd({ ctx, agent, session, turnEnd, config, state, mutate, queue }) {
  const sessionId = session?.id ?? "unknown"
  const wsPath = session?.header?.cwd
  const cfg = wsPath ? effectiveConfig(config, wsPath) : null
  if (!cfg) return { skipped: "not-enabled" }

  const reasonKind = turnEnd?.reason?.kind ?? "unknown"
  // Mutable: clearing the awaiting flag must update this snapshot too,
  // otherwise a later mutate({ ...rt }) would write the stale value back.
  let rt = readRuntime(state)

  if (rt.stoppedReason) return { skipped: `stopped:${rt.stoppedReason}` }

  // An abort is not a failure — just skip.
  if (reasonKind === "aborted" || reasonKind === "interrupted") {
    log({ ev: "skip", sessionId, wsPath, why: reasonKind })
    return { skipped: reasonKind }
  }

  let messages = []
  try {
    messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : []
  } catch (e) {
    log({ ev: "skip", sessionId, why: "derive-failed", err: String(e?.message ?? e) })
    return { skipped: "derive-failed" }
  }

  // Paused, waiting on the user: clear once they actually speak, otherwise stay
  // silent so we do not re-judge on every turn.
  if (rt.awaitingRuleId) {
    const humanAt = lastHumanAt(messages)
    if (humanAt > 0 && Date.now() - humanAt < 5 * 60 * 1000) {
      rt = { ...rt, awaitingRuleId: null }
      mutate(rt)
    } else {
      log({ ev: "skip", sessionId, wsPath, why: `awaiting:${rt.awaitingRuleId}` })
      return { skipped: "awaiting-user" }
    }
  }

  // ── Error path: bounded retry for network/transport failures ──
  if (reasonKind === "error") {
    const code = turnEnd?.reason?.error?.code ?? "UNKNOWN"
    const retryable = isRetryable(code)
    const failures = rt.failures + 1
    const limit = cfg.failureRetryLimit ?? 3

    log({ ev: "error", sessionId, wsPath, code, retryable, failures, limit })

    if (!retryable || failures > limit) {
      mutate({ ...rt, failures, stoppedReason: retryable ? `failure-limit:${failures}` : `non-retryable:${code}` })
      log({ ev: "stop", sessionId, wsPath, why: retryable ? "failure-limit" : "non-retryable" })
      return { action: "stopped", reason: code }
    }

    // Retryable: nudge the agent to resume.
    mutate({ ...rt, failures })
    const sent = await sendMessage({ agent, ctx, text: RETRY_TEXT[uiLocale(cfg)], ruleId: "retry" })
    log({ ev: "retry", sessionId, wsPath, ok: sent.ok, err: sent.error })
    return { action: sent.ok ? "retry" : "error", error: sent.error }
  }

  // ── Normal completion ──
  const arb = await arbitrate({ ctx, agent, session, messages, cfg })
  if (!arb.allow) {
    log({ ev: "skip", sessionId, wsPath, why: arb.reason, detail: arb.detail })
    return { skipped: arb.reason }
  }

  if (rt.iterations >= (cfg.maxIterations ?? 20)) {
    mutate({ ...rt, stoppedReason: `iteration-limit:${rt.iterations}` })
    log({ ev: "stop", sessionId, wsPath, why: "iteration-limit" })
    return { action: "stopped", reason: "iteration-limit" }
  }

  // Build the input
  const measure = makeMeasure(ctx)
  const { state: input, stats } = buildState(messages, cfg, 8192, measure)
  if (!input.trim()) {
    log({ ev: "skip", sessionId, wsPath, why: "empty-input" })
    return { skipped: "empty-input" }
  }

  // Decide (serialized)
  const result = await queue.run(() => judge({ state: input, cfg }))

  log({
    ev: "judge",
    sessionId,
    wsPath,
    outcome: result.outcome,
    decision: result.decision,
    confidence: result.confidence,
    probabilities: result.probabilities,
    reason: result.reason,
    error: result.error,
    input: stats,
    msg: summarize(messages),
  })

  // The decision service failed
  if (result.outcome === Outcome.ERROR) {
    const failures = rt.failures + 1
    const limit = cfg.failureRetryLimit ?? 3
    if (failures > limit) {
      mutate({ ...rt, failures, stoppedReason: `judge-failure:${failures}` })
      log({ ev: "stop", sessionId, wsPath, why: "judge-failure", failures })
      return { action: "stopped", reason: "judge-failure" }
    }
    mutate({ ...rt, failures })
    return { action: "error", error: result.error }
  }

  // Uncertain → pause auto-advance instead of calling the model every turn.
  if (result.outcome === Outcome.UNCERTAIN) {
    rt = { ...rt, awaitingRuleId: "uncertain" }
    mutate(rt)
    log({ ev: "uncertain", sessionId, wsPath, reason: result.reason })
    return { action: "halt", reason: result.reason }
  }

  // The model named the situation. Progress decides whether acting on it is new.
  const chosen = decisionById(cfg.decisions, result.decision)
  const progress = decisionProgress(messages, cfg.decisions)
  // The model's second choice covers the case where its first is the same
  // situation one round earlier: that one is spent, this one is not.
  const alt = bestRemaining(cfg.decisions, result.probabilities, progress)
  const picked = resolveDecision(chosen, progress, alt)

  if (!picked.decision) {
    const why = chosen ? picked.skip : `undefined-decision:${result.decision}`
    log({ ev: "skip", sessionId, wsPath, decision: result.decision, why, progress })
    return { skipped: why, decision: result.decision }
  }

  const rule = picked.decision
  log({
    ev: "pick",
    sessionId,
    wsPath,
    decision: rule.id,
    // Present only when the model's first choice was spent and a neighbour was
    // taken instead. Without it, a fallback would be indistinguishable from an
    // outright selection in the log.
    ...(picked.fellBackFrom ? { fellBackFrom: picked.fellBackFrom } : {}),
    progress,
  })

  // Stop → halt auto-advance and wait for the user.
  if (rule.do === "stop") {
    // Enter the paused state so later turns do not re-judge and stop again at
    // the same place. Cleared once the user actually speaks (see the
    // awaitingRuleId check above).
    mutate({ ...rt, awaitingRuleId: rule.id })
    log({ ev: "halt", sessionId, wsPath, decision: rule.id })
    return { action: "halt", ruleId: rule.id }
  }

  // Send
  const sent = await sendMessage({ agent, ctx, text: rule.prompt, ruleId: rule.id })
  if (!sent.ok) {
    mutate({ ...rt, failures: rt.failures + 1 })
    log({ ev: "send-fail", sessionId, wsPath, ruleId: rule.id, err: sent.error })
    return { action: "error", error: sent.error }
  }

  mutate({
    ...rt,
    iterations: rt.iterations + 1,
    failures: 0,
  })
  log({ ev: "send", sessionId, wsPath, ruleId: rule.id, iteration: rt.iterations + 1, messageId: sent.messageId })
  return { action: "send", ruleId: rule.id, messageId: sent.messageId }
}

/** Precise measurement via tokenMeter; undefined falls back to the rough estimate. */
function makeMeasure(ctx) {
  try {
    const tm = ctx.get("tokenMeter")
    if (tm && typeof tm.estimateMessage === "function") {
      return (msg) => tm.estimateMessage(msg) + 8
    }
  } catch { /* ignore */ }
  return undefined
}


