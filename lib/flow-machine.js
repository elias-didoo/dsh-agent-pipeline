/**
 * Flow machine: walk a fixed pipeline, one step at a time.
 *
 * The whole state is plain JSON derived from two things — the flow definition
 * and the messages this plugin has already sent in the session. That is what
 * lets it survive a reload: the session log is the source of truth, and the
 * machine is a fold over it, not a second store that could disagree.
 *
 * Nothing here branches on a step id. A step's `do` decides what happens, which
 * is why the same machine drives every flow a workspace defines.
 */

import { stepLabel } from "./flow-spec.js"

/** Lifecycle of one flow instance. */
export const FLOW_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
  DONE: "done",
  CANCELLED: "cancelled",
}

/** Lifecycle of one step within a flow. */
export const STEP_STATUS = {
  PENDING: "pending",
  ONGOING: "ongoing",
  DONE: "done",
}

/**
 * Build a fresh state for a flow that has not started running yet.
 *
 * @param {string} flowName
 * @param {object} spec result of validateFlowSpec()
 * @param {number} now epoch milliseconds
 */
export function startFlow(flowName, spec, now) {
  const flow = spec?.flows?.[flowName]
  if (!flow) return undefined
  return {
    flow: flowName,
    status: FLOW_STATUS.ACTIVE,
    /// Index of the step the flow is waiting to run.
    cursor: 0,
    startedAt: now,
    updatedAt: now,
    steps: flow.steps.map((id) => ({ id, status: STEP_STATUS.PENDING })),
  }
}

/** The step the flow is positioned at, or undefined when it has run out. */
export function currentStepId(state) {
  if (!state || state.status !== FLOW_STATUS.ACTIVE) return undefined
  const entry = state.steps?.[state.cursor]
  return entry?.id
}

/** The step definition the flow is positioned at. */
export function currentStep(state, spec) {
  const id = currentStepId(state)
  if (!id) return undefined
  return spec?.steps?.[id]
}

/**
 * Mark the current step done and move to the next one.
 *
 * When the cursor runs past the last step the flow is done: the pipeline has
 * nothing left to send, and staying `active` would keep waking the plugin on
 * every turn for no reason.
 *
 * @param {object} state
 * @param {number} now
 * @returns {object} new state; the input is never mutated
 */
export function advance(state, now) {
  if (!state || state.status !== FLOW_STATUS.ACTIVE) return state
  const steps = state.steps.map((s, i) => (i === state.cursor ? { ...s, status: STEP_STATUS.DONE } : s))
  const cursor = state.cursor + 1
  if (cursor >= steps.length) {
    return { ...state, steps, cursor, status: FLOW_STATUS.DONE, updatedAt: now }
  }
  return { ...state, steps, cursor, updatedAt: now }
}

/**
 * Jump to another step, used by a branch.
 *
 * The branch names its target explicitly, so the cursor is not simply moved one
 * along — every step the branch skipped stays pending, which is what the panel
 * shows and what a reader would expect.
 *
 * @param {object} state
 * @param {string} targetId step id the branch chose
 * @param {number} now
 */
export function jumpTo(state, targetId, now) {
  if (!state || state.status !== FLOW_STATUS.ACTIVE) return state
  const index = state.steps.findIndex((s) => s.id === targetId)
  if (index < 0) return state
  const steps = state.steps.map((s, i) => (i === state.cursor ? { ...s, status: STEP_STATUS.DONE } : s))
  return { ...state, steps, cursor: index, updatedAt: now }
}

/** Mark the step at the cursor as the one being worked on. */
export function markOngoing(state) {
  if (!state || state.status !== FLOW_STATUS.ACTIVE) return state
  const entry = state.steps[state.cursor]
  if (!entry || entry.status !== STEP_STATUS.PENDING) return state
  const steps = state.steps.map((s, i) => (i === state.cursor ? { ...s, status: STEP_STATUS.ONGOING } : s))
  return { ...state, steps }
}

/** Pause: the plugin stops advancing, the agent keeps working. */
export function pauseFlow(state, now) {
  if (!state || state.status !== FLOW_STATUS.ACTIVE) return state
  return { ...state, status: FLOW_STATUS.PAUSED, updatedAt: now }
}

/** Resume a paused flow from where it stopped. */
export function resumeFlow(state, now) {
  if (!state || state.status !== FLOW_STATUS.PAUSED) return state
  return { ...state, status: FLOW_STATUS.ACTIVE, updatedAt: now }
}

/** Cancel: the flow is abandoned and the panel goes away. */
export function cancelFlow(state, now) {
  if (!state || state.status === FLOW_STATUS.DONE || state.status === FLOW_STATUS.CANCELLED) return state
  return { ...state, status: FLOW_STATUS.CANCELLED, updatedAt: now }
}

/** True when this plugin sent the message a step would send. */
function stepAlreadySent(sentStepIds, stepId) {
  return sentStepIds.has(stepId)
}

/**
 * Rebuild the state from what the log says has already happened.
 *
 * The log records which step sent each message, so replaying the flow against
 * that set reproduces where it stopped — without a second store to keep in
 * sync. A step whose message is already in the log is marked done and the
 * cursor moves past it.
 *
 * A stop or wait-user step sends nothing, so the log cannot show that it was
 * passed — without a record the replay would land on the stop again and halt
 * the flow a second time. The caller supplies those ids in `passedStepIds`.
 *
 * A branch is the same problem with two exits: which way it went is not in the
 * log, so the caller passes the recorded answer. Without one the replay stops
 * at the branch and waits for a fresh judgement.
 *
 * @param {string} flowName
 * @param {object} spec
 * @param {Set<string>} sentStepIds step ids whose message appears in the log
 * @param {object} [options]
 * @param {Set<string>} [options.passedStepIds] silent steps already passed
 * @param {string} [options.status] recorded lifecycle status
 * @param {number} [options.startedAt]
 * @param {Function} [options.branchChoices] (stepId) => target step id, for replayed branches
 * @param {number} now
 */
export function replayFlow(flowName, spec, sentStepIds, options = {}, now = 0) {
  let state = startFlow(flowName, spec, options.startedAt ?? now)
  if (!state) return undefined
  state = { ...state, updatedAt: now }

  for (let guard = 0; guard < state.steps.length + 1; guard++) {
    const id = currentStepId(state)
    if (!id) break
    const step = spec.steps[id]
    if (!step) break

    if (step.do === "branch") {
      const chosen = options.branchChoices?.(id)
      if (!chosen) break
      state = jumpTo(state, chosen, now)
      continue
    }
    // A silent step leaves no message; its progress is recorded separately.
    if (step.do === "stop" || step.do === "wait-user") {
      if (!options.passedStepIds?.has(id)) break
      state = advance(state, now)
      continue
    }
    if (!stepAlreadySent(sentStepIds, id)) break
    state = advance(state, now)
  }

  if (options.status === FLOW_STATUS.PAUSED) state = pauseFlow(state, now)
  if (options.status === FLOW_STATUS.CANCELLED) state = cancelFlow(state, now)
  return state
}

/**
 * What the panel needs: the flow's label, its progress, and one row per step.
 *
 * @param {object} state
 * @param {object} spec
 * @param {string} locale "zh" | "en"
 */
export function stepsView(state, spec, locale = "en") {
  if (!state) return undefined
  const flow = spec?.flows?.[state.flow]
  if (!flow) return undefined
  const label = flow.label?.[locale] ?? flow.label?.en ?? state.flow
  return {
    flow: state.flow,
    label,
    status: state.status,
    done: state.steps.filter((s) => s.status === STEP_STATUS.DONE).length,
    total: state.steps.length,
    steps: state.steps.map((s) => ({
      id: s.id,
      status: s.status,
      label: stepLabel(spec?.steps?.[s.id], locale),
    })),
  }
}
