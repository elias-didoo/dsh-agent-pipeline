/**
 * Flow specification: the fixed pipelines a workspace runs, and the steps they
 * are built from.
 *
 * A flow is an ordered list of step ids. A step is one thing the plugin does
 * when the flow reaches it: send a message, stop and wait, wait for the user to
 * say a particular thing, or ask the model a two-way question.
 *
 * Steps live in one table and flows reference them by id. Defining `review`
 * once and using it from the requirement flow, the bug flow and the conflict
 * flow is what keeps three near-identical pipelines from drifting apart — the
 * drift that already cost this project a debugging session when the fixture and
 * the deployed profile disagreed.
 *
 * The steps here are data, not code: retuning a prompt is an edit to the config,
 * and the machine that walks them never mentions a step id.
 */

/** How a step acts when the flow reaches it. */
export const STEP_KINDS = ["send", "stop", "wait-user", "branch"]

/** Longest prose accepted for a prompt or a branch question. */
const MAX_TEXT = 4000

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0

/**
 * Why one step is unusable, in one pass.
 *
 * @param {string} id step id, for context in the message
 * @param {object} step raw step
 * @returns {string[]} empty when the step is fine
 */
export function stepIssues(id, step) {
  if (!isPlainObject(step)) return [`step "${id}" must be an object`]
  const out = []
  const kind = step.do
  if (!STEP_KINDS.includes(kind)) {
    out.push(`step "${id}": do must be one of ${STEP_KINDS.join(" / ")}, got ${JSON.stringify(kind)}`)
    return out
  }

  if (kind === "send") {
    if (!nonEmpty(step.prompt)) out.push(`step "${id}": do=send requires a prompt`)
    else if (step.prompt.length > MAX_TEXT) out.push(`step "${id}": prompt must be at most ${MAX_TEXT} characters`)
  }

  if (kind === "stop") {
    // notifyText is optional; it only labels why the flow paused.
    if (step.notifyText !== undefined && typeof step.notifyText !== "string") {
      out.push(`step "${id}": notifyText must be a string`)
    }
  }

  if (kind === "wait-user") {
    if (!nonEmpty(step.prompt)) out.push(`step "${id}": do=wait-user requires a prompt — the message that tells the user what to say`)
    if (step.expect !== undefined && typeof step.expect !== "string") {
      out.push(`step "${id}": expect must be a string when given`)
    }
  }

  if (kind === "branch") {
    if (!nonEmpty(step.question)) out.push(`step "${id}": do=branch requires a question`)
    else if (step.question.length > MAX_TEXT) out.push(`step "${id}": question must be at most ${MAX_TEXT} characters`)
    const options = step.options
    if (!isPlainObject(options)) {
      out.push(`step "${id}": do=branch requires an options object mapping answer to step id`)
    } else {
      const keys = Object.keys(options)
      if (keys.length !== 2) {
        // A two-way question is what the model answers reliably; three or more
        // is a decision point list again, which is what this design removes.
        out.push(`step "${id}": options must have exactly 2 entries, got ${keys.length}`)
      }
      for (const [answer, target] of Object.entries(options)) {
        if (!nonEmpty(target)) out.push(`step "${id}": options.${answer} must be a step id`)
      }
    }
  }

  return out
}

/**
 * Validate a whole flow specification.
 *
 * @param {object} raw config section: `{ steps, flows }`
 * @returns {{ steps?: object, flows?: object, issues?: string[] }}
 */
export function validateFlowSpec(raw) {
  const issues = []
  const input = isPlainObject(raw) ? raw : {}
  const rawSteps = input.steps
  const rawFlows = input.flows

  if (!isPlainObject(rawSteps)) {
    issues.push("steps must be an object mapping step id to its definition")
  }
  if (!isPlainObject(rawFlows)) {
    issues.push("flows must be an object mapping flow name to its step list")
  }
  if (issues.length > 0) return { issues }

  // Steps first: flows are validated against the table.
  const steps = {}
  for (const [id, step] of Object.entries(rawSteps)) {
    const problems = stepIssues(id, step)
    if (problems.length > 0) {
      issues.push(...problems)
      continue
    }
    steps[id] = normalizeStep(id, step)
  }

  const flows = {}
  for (const [name, flow] of Object.entries(rawFlows)) {
    if (!isPlainObject(flow)) {
      issues.push(`flows.${name} must be an object`)
      continue
    }
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
      issues.push(`flows.${name}.steps must be a non-empty array of step ids`)
      continue
    }
    const seen = new Set()
    let broken = false
    for (const [i, stepId] of flow.steps.entries()) {
      if (!nonEmpty(stepId)) {
        issues.push(`flows.${name}.steps[${i}] must be a step id`)
        broken = true
        continue
      }
      if (!(stepId in steps)) {
        issues.push(`flows.${name}.steps[${i}] refers to "${stepId}", which is not defined in steps`)
        broken = true
        continue
      }
      if (seen.has(stepId)) {
        // Repeating a step id would make progress ambiguous: the log can only
        // say "this prompt was sent", not which visit sent it.
        issues.push(`flows.${name} lists "${stepId}" more than once`)
        broken = true
      }
      seen.add(stepId)
    }
    if (broken) continue

    for (const stepId of flow.steps) {
      const step = steps[stepId]
      if (step.do !== "branch") continue
      for (const [answer, target] of Object.entries(step.options)) {
        if (!flow.steps.includes(target)) {
          issues.push(`flows.${name}: step "${stepId}" option "${answer}" points to "${target}", which is not in this flow`)
        }
        if (target === stepId) {
          issues.push(`flows.${name}: step "${stepId}" option "${answer}" points to itself`)
        }
      }
    }

    // A flow that never reaches a stop or a wait would run to its last step and
    // then have nowhere to go.
    const settles = flow.steps.some((id) => steps[id].do === "stop" || steps[id].do === "wait-user")
    if (!settles) {
      issues.push(`flows.${name}: needs at least one stop or wait-user step, otherwise it never pauses for the user`)
    }

    flows[name] = {
      label: normalizeLabel(flow.label, name),
      steps: [...flow.steps],
    }
  }

  if (issues.length > 0) return { issues }
  return { steps, flows }
}

/** Normalize a validated step into its canonical shape. */
function normalizeStep(id, step) {
  const base = { id, do: step.do }
  // A label is what the panel shows. Without one it falls back to the first
  // line of the prose, which is how the user wrote the step and therefore what
  // they will recognise.
  if (isPlainObject(step.label)) base.label = normalizeLabel(step.label, id)
  if (step.do === "send") return { ...base, prompt: step.prompt.trim() }
  if (step.do === "stop") return { ...base, notifyText: typeof step.notifyText === "string" ? step.notifyText : "" }
  if (step.do === "wait-user") {
    return {
      ...base,
      prompt: step.prompt.trim(),
      // What the user is expected to say. Empty accepts any user message.
      expect: typeof step.expect === "string" ? step.expect : "",
    }
  }
  // branch
  return { ...base, question: step.question.trim(), options: { ...step.options } }
}

/** Labels fall back to the flow name when the config gives none. */
function normalizeLabel(label, fallback) {
  if (isPlainObject(label) && (nonEmpty(label.en) || nonEmpty(label.zh))) {
    return { en: nonEmpty(label.en) ? label.en : fallback, zh: nonEmpty(label.zh) ? label.zh : fallback }
  }
  return { en: fallback, zh: fallback }
}

/**
 * Look up one step, or undefined when the flow does not contain it.
 * @param {object} spec result of validateFlowSpec()
 * @param {string} flowName
 * @param {string} stepId
 */
export function stepInFlow(spec, flowName, stepId) {
  const flow = spec?.flows?.[flowName]
  if (!flow || !flow.steps.includes(stepId)) return undefined
  return spec.steps?.[stepId]
}

/** Human label for a step, falling back to its first line of prose, then its id. */
export function stepLabel(step, locale) {
  if (!step) return ""
  if (isPlainObject(step.label)) return step.label[locale] ?? step.label.en ?? step.id
  const text = step.prompt ?? step.question ?? step.notifyText ?? ""
  const first = String(text).split("\n")[0].trim()
  if (!first) return step.id
  return first.length > 24 ? `${first.slice(0, 24)}…` : first
}

/** Names of the flows a workspace defines, in config order. */
export function flowNames(spec) {
  return Object.keys(spec?.flows ?? {})
}
