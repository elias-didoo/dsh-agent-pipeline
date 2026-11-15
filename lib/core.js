/**
 * Main loop: one turn end, one step of the active flow.
 *
 * The plugin no longer asks the model what to do on every turn. A flow is
 * started once — by the agent calling `start_flow` — and from then on the step
 * list says what happens next. The model is consulted only where a flow
 * genuinely branches, which in the shipped configuration is once per pipeline
 * instead of once per turn.
 *
 * State lives in a sessionProjection, the place the harness recommends for
 * derived per-session state: it can be rebuilt from the log after a restart, and
 * keeping it there is what makes the panel survive a user message.
 */

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

import { arbitrate, lastHumanAt } from "./arbiter.js"
import { buildState } from "./context.js"
import { judge, Outcome, isRetryable } from "./judge.js"
import { sendMessage } from "./action.js"
import { effectiveConfig } from "./config.js"
import { log, summarize } from "./log.js"
import {
  FLOW_STATUS,
  currentStep,
  currentStepId,
  advance,
  jumpTo,
  pauseFlow,
  resumeFlow,
  cancelFlow,
  replayFlow,
} from "./flow-machine.js"
import { stepLabel } from "./flow-spec.js"

/**
 * Read runtime state out of the projection state.
 * The projection's apply only folds facts from the log; nothing here is derived
 * from it except what the main loop itself wrote.
 */
export function readRuntime(state) {
  return {
    iterations: state?.iterations ?? 0,
    failures: state?.failures ?? 0,
    stoppedReason: state?.stoppedReason ?? null,
    awaitingRuleId: state?.awaitingRuleId ?? null,
    flow: state?.flow ?? null,
  }
}

/**
 * Which steps this plugin has already sent, read from the transcript.
 *
 * This is the replay input: a step whose message appears in the log has already
 * run, so the flow must sit past it. Reading it from the messages rather than
 * from a counter is what lets a reloaded session pick up where it stopped.
 */
export function sentStepIds(messages) {
  const ids = new Set()
  for (const m of messages ?? []) {
    const kind = m?.source?.kind
    const ruleId = m?.source?.ruleId
    if (kind === "decision" && typeof ruleId === "string" && ruleId) ids.add(ruleId)
  }
  return ids
}

/**
 * Decide whether the last human message is the one a wait-user step is waiting
 * for.
 *
 * An empty `expect` accepts any human message; otherwise the message has to
 * contain the expected phrase. Substring rather than equality because the user
 * writes "开干。注释和文档…" as readily as "开干".
 */
export function waitSatisfied(step, messages) {
  if (!step?.expect) return true
  // The last human message, by position rather than by timestamp: two
  // messages written in the same millisecond are ordered by the log, and only
  // the later one can be the reply.
  let latest
  for (const m of messages ?? []) {
    if (m?.source?.kind === "user") latest = m
  }
  if (!latest) return false
  const text = (latest.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
  // Only a message from after the flow arrived here counts. Without this, a
  // "开干" the user typed in an earlier round would satisfy every later wait
  // forever, and the flow would skip the step it was trying to hold.
  // Strictly before, not equal: a message written in the same millisecond the
  // flow arrived is a reply to it, and sub-millisecond ordering is not
  // something the session log records.
  if (step.since && latest.time && latest.time < step.since) return false
  return text.includes(step.expect)
}

/**
 * Rebuild the flow state from the transcript and the recorded lifecycle.
 *
 * @param {object} p
 * @param {object} p.cfg effective workspace config
 * @param {Array} p.messages derived messages
 * @param {object} p.rt current runtime snapshot
 */
export function rebuildFlow({ cfg, messages, rt }) {
  const name = rt?.flow?.name
  if (!name) return null
  const spec = { steps: cfg.steps ?? {}, flows: cfg.flows ?? {} }
  const replayed = replayFlow(
    name,
    spec,
    sentStepIds(messages),
    {
      passedStepIds: new Set(rt.flow.passed ?? []),
      status: rt.flow.status,
      startedAt: rt.flow.startedAt,
      branchChoices: (id) => rt.flow.branches?.[id],
    },
    Date.now(),
  )
  return replayed ?? null
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
 *   - `halt`    the flow reached a stop point, or the judgement was uncertain;
 *               auto-advance paused until the user replies
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

  // No flow → nothing to advance. This is the normal state for a session that
  // has not started a pipeline, and it costs one log line per turn.
  if (!rt.flow?.name) {
    log({ ev: "skip", sessionId, wsPath, why: "no-flow" })
    return { skipped: "no-flow" }
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

  // Arbitration applies to every step, not just the branch. A send still has to
  // stay out of the way while the user is typing, another agent is talking, or
  // a goal is driving — those conditions say "not now", not "not this step".
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

  // Walk the flow. A pass normally stops after one action, but a wait-user
  // step that the user has already answered advances and continues, so the next
  // step happens in the same turn rather than a turn later.
  for (let guard = 0; guard < 64; guard++) {
    rt = readRuntime({ ...state, ...rt })
    // ── Where is the flow? ──
    const spec = { steps: cfg.steps ?? {}, flows: cfg.flows ?? {} }
    let flow = rebuildFlow({ cfg, messages, rt })
    if (!flow) {
      log({ ev: "skip", sessionId, wsPath, why: "flow-unknown", flow: rt.flow.name })
      return { skipped: "flow-unknown" }
    }

    // A paused or finished flow does not advance; record it and stop.
    if (flow.status === FLOW_STATUS.PAUSED) {
      mutate({ ...rt, flow: snapshotFlow(flow, rt) })
      log({ ev: "skip", sessionId, wsPath, why: "flow-paused", flow: flow.flow })
      return { skipped: "flow-paused" }
    }
    if (flow.status === FLOW_STATUS.CANCELLED || flow.status === FLOW_STATUS.DONE) {
      mutate({ ...rt, flow: snapshotFlow(flow, rt) })
      log({ ev: "skip", sessionId, wsPath, why: `flow-${flow.status}`, flow: flow.flow })
      return { skipped: `flow-${flow.status}` }
    }

    const stepId = currentStepId(flow)
    const step = currentStep(flow, spec)
    if (!step) {
      log({ ev: "skip", sessionId, wsPath, why: "flow-exhausted", flow: flow.flow })
      return { skipped: "flow-exhausted" }
    }

    // ── Wait-user: only proceed once the user said the phrase ──
    if (step.do === "wait-user") {
      // When the flow arrived at this step: the moment it was recorded as
      // passed, or the flow's start. flow.updatedAt is recomputed on every
      // replay and would always be later than the message being tested.
      const since = rt.flow.since ?? rt.flow.startedAt ?? 0
      const satisfied = waitSatisfied({ ...step, since }, messages)
      if (!satisfied) {
        // Announced once. The awaiting flag silences later turns until the user
        // speaks, so a long pause produces one halt rather than one per turn.
        mutate({ ...rt, awaitingRuleId: stepId, flow: snapshotFlow(flow, rt) })
        log({ ev: "halt", sessionId, wsPath, step: stepId, why: "wait-user", expect: step.expect })
        return { action: "halt", ruleId: stepId, notifyText: step.prompt, expect: step.expect }
      }
      const passedAfterWait = [...new Set([...(rt.flow.passed ?? []), stepId])]
      flow = advance(flow, Date.now())
      // Continue to the next step in this same turn: the user already spoke, so
      // making them wait another turn to see the next prompt would be silly. The
      // loop is bounded — a flow cannot revisit a step — but the bound is stated
      // rather than left to the call stack, which overflowed when this recursed.
      rt = {
        ...rt,
        awaitingRuleId: null,
        flow: snapshotFlow(flow, { ...rt, flow: { ...rt.flow, passed: passedAfterWait, since: Date.now() } }, passedAfterWait),
      }
      mutate(rt)
      log({ ev: "advance", sessionId, wsPath, step: stepId, why: "user-spoke" })
      continue
    }

    // ── Stop: settle the flow and wait ──
    if (step.do === "stop") {
      // A stop sends nothing, so its progress has to be recorded here or the
      // replay would land on it again and halt the flow a second time.
      //
      // The pass is recorded, but the cursor must not move on this turn: the
      // next step waits for the user, and advancing now would make the loop
      // arrive at that step immediately, halt there, and produce a second pause
      // line for a pause the user has not answered yet.
      const passedAfterStop = [...new Set([...(rt.flow.passed ?? []), stepId])]
      mutate({
        ...rt,
        awaitingRuleId: stepId,
        flow: snapshotFlow(flow, {
          ...rt,
          flow: { ...rt.flow, passed: passedAfterStop, since: Date.now() },
        }, passedAfterStop),
      })
      log({ ev: "halt", sessionId, wsPath, step: stepId, why: "stop" })
      return { action: "halt", ruleId: stepId, notifyText: step.notifyText ?? "" }
    }

    // ── Send: the common case, no model involved ──
    if (step.do === "send") {
      const sent = await sendMessage({ agent, ctx, text: step.prompt, ruleId: stepId })
      if (!sent.ok) {
        mutate({ ...rt, failures: rt.failures + 1, flow: snapshotFlow(flow, rt) })
        log({ ev: "send-fail", sessionId, wsPath, step: stepId, err: sent.error })
        return { action: "error", error: sent.error }
      }
      flow = advance(flow, Date.now())
      mutate({
        ...rt,
        iterations: rt.iterations + 1,
        failures: 0,
        flow: snapshotFlow(flow, rt),
      })
      log({ ev: "send", sessionId, wsPath, step: stepId, iteration: rt.iterations + 1, messageId: sent.messageId })
      return { action: "send", ruleId: stepId, messageId: sent.messageId }
    }

    // ── Branch: the one place the model is consulted ──
    if (step.do === "branch") {
      const { state: input, stats } = buildState(messages, cfg, 8192)
      if (!input.trim()) {
        log({ ev: "skip", sessionId, wsPath, why: "empty-input" })
        return { skipped: "empty-input" }
      }

      const questions = { next: { type: "choice", instructions: step.question, criteria: step.options } }
      const result = await queue.run(() => judge({ state: input, cfg, questions }))

      log({
        ev: "judge",
        sessionId,
        wsPath,
        step: stepId,
        outcome: result.outcome,
        decision: result.decision,
        confidence: result.confidence,
        probabilities: result.probabilities,
        reason: result.reason,
        error: result.error,
        input: stats,
        msg: summarize(messages),
      })

      if (result.outcome === Outcome.ERROR) {
        const failures = rt.failures + 1
        const limit = cfg.failureRetryLimit ?? 3
        if (failures > limit) {
          mutate({ ...rt, failures, stoppedReason: `judge-failure:${failures}` })
          log({ ev: "stop", sessionId, wsPath, why: "judge-failure", failures })
          return { action: "stopped", reason: "judge-failure" }
        }
        mutate({ ...rt, failures, flow: snapshotFlow(flow, rt) })
        return { action: "error", error: result.error }
      }

      if (result.outcome === Outcome.UNCERTAIN) {
        // Uncertain at a branch: pause rather than guess a direction.
        mutate({ ...rt, awaitingRuleId: `branch:${stepId}`, flow: snapshotFlow(flow, rt) })
        log({ ev: "uncertain", sessionId, wsPath, step: stepId, reason: result.reason })
        return { action: "halt", reason: result.reason }
      }

      const target = step.options[result.decision]
      if (!target) {
        mutate({ ...rt, failures: rt.failures + 1, flow: snapshotFlow(flow, rt) })
        log({ ev: "skip", sessionId, wsPath, why: `branch-target-missing:${result.decision}`, step: stepId })
        return { action: "error", error: `branch target missing for ${result.decision}` }
      }

      const branches = { ...(rt.flow.branches ?? {}), [stepId]: target }
      flow = jumpTo(flow, target, Date.now())
      const nextRt = { ...rt, failures: 0, flow: snapshotFlow(flow, { ...rt, flow: { ...rt.flow, branches } }) }
      mutate(nextRt)
      log({ ev: "branch", sessionId, wsPath, step: stepId, choice: result.decision, target, confidence: result.confidence })
      return { action: "branch", ruleId: stepId, choice: result.decision, target }
    }

    // Unreachable: validateFlowSpec rejects every other kind.
    log({ ev: "skip", sessionId, wsPath, why: `unknown-kind:${step.do}`, step: stepId })
    return { skipped: `unknown-kind:${step.do}` }
  }

  // The loop is bounded by the flow's own step count; no flow can revisit a
  // step, so 64 passes is far beyond any real pipeline.
  log({ ev: "stop", sessionId, wsPath, why: "flow-loop-limit" })
  return { action: "stopped", reason: "flow-loop-limit" }
}

/**
 * The compact form of a flow that goes into the projection.
 *
 * Only what cannot be reconstructed from the step list is kept: the name, the
 * lifecycle, when it started, and how the branches went. The cursor and each
 * step's status are recomputed from the transcript on every turn, so storing
 * them would create a second copy that could disagree with the log.
 */
export function snapshotFlow(flow, rt, passed) {
  return {
    name: flow.flow,
    status: flow.status,
    startedAt: rt?.flow?.startedAt ?? flow.startedAt,
    branches: rt?.flow?.branches ?? {},
    passed: passed ?? rt?.flow?.passed ?? [],
    // When the flow arrived at the step it is now on. A wait-user step compares
    // against this, so it must survive every snapshot.
    since: rt?.flow?.since ?? 0,
    note: rt?.flow?.note ?? "",
  }
}

/** Start a flow and record it in the projection. */
export function beginFlow({ flowName, cfg, rt, mutate, now = Date.now(), note = "" }) {
  const spec = { steps: cfg.steps ?? {}, flows: cfg.flows ?? {} }
  if (!spec.flows[flowName]) return undefined
  const flow = replayFlow(flowName, spec, new Set(), { startedAt: now }, now)
  if (!flow) return undefined
  mutate({
    ...rt,
    flow: { name: flowName, status: FLOW_STATUS.ACTIVE, startedAt: now, since: now, branches: {}, passed: [], note },
    awaitingRuleId: null,
    failures: 0,
    iterations: 0,
    stoppedReason: null,
  })
  return flow
}

/**
 * Control a running flow from the panel.
 *
 * @param {object} p
 * @param {"pause"|"resume"|"cancel"} p.action what the user asked for
 * @param {object} p.rt current runtime snapshot
 * @param {Array} p.messages derived messages, to rebuild where the flow is
 * @param {object} p.cfg effective workspace config
 * @param {number} [p.now]
 * @returns {object} the runtime snapshot so the caller can persist it
 */
export function controlFlow({ action, rt, messages, cfg, now = Date.now() }) {
  if (!rt?.flow?.name) return rt
  const spec = { steps: cfg.steps ?? {}, flows: cfg.flows ?? {} }
  const flow = replayFlow(rt.flow.name, spec, sentStepIds(messages), {
    passedStepIds: new Set(rt.flow.passed ?? []),
    status: rt.flow.status,
    startedAt: rt.flow.startedAt,
    branchChoices: (id) => rt.flow.branches?.[id],
  }, now)
  if (!flow) return rt
  let next
  if (action === "pause") next = pauseFlow(flow, now)
  else if (action === "resume") next = resumeFlow(flow, now)
  else if (action === "cancel") next = cancelFlow(flow, now)
  else return rt
  return { ...rt, awaitingRuleId: null, flow: snapshotFlow(next, rt) }
}

/**
 * The flow state plus one row per step, ready for the panel.
 *
 * Rebuilt here rather than stored, for the same reason the cursor is.
 */
export function flowView({ rt, cfg, messages, locale = "en" }) {
  if (!rt?.flow?.name) return undefined
  const spec = { steps: cfg.steps ?? {}, flows: cfg.flows ?? {} }
  const flow = replayFlow(rt.flow.name, spec, sentStepIds(messages), {
    passedStepIds: new Set(rt.flow.passed ?? []),
    status: rt.flow.status,
    startedAt: rt.flow.startedAt,
    branchChoices: (id) => rt.flow.branches?.[id],
  }, Date.now())
  if (!flow) return undefined
  const specFlow = spec.flows[flow.flow]
  const label = specFlow?.label?.[locale] ?? specFlow?.label?.en ?? flow.flow
  return {
    flow: flow.flow,
    label,
    status: flow.status,
    note: rt.flow.note ?? "",
    done: flow.steps.filter((s) => s.status === "done").length,
    total: flow.steps.length,
    steps: flow.steps.map((s) => ({
      id: s.id,
      status: s.status,
      label: stepLabel(spec.steps[s.id], locale),
      current: s.id === currentStepId(flow),
    })),
  }
}
