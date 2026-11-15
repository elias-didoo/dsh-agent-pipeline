/**
 * Decision points.
 *
 * A decision point is one thing the plugin may do next, described in the terms
 * a human would use to recognise it. The decision model reads the conversation
 * and picks one; the plugin only executes what it picked.
 *
 * That is the whole mechanism. There is no stage list, no behaviour table and no
 * condition expression here, because the model already understands "still says
 * it found a problem" better than any pattern would. A decision point is:
 *
 *   id        stable name, also the message source tag
 *   when      the situation this applies to, in prose — sent as model input
 *   do        send | stop | silent
 *   prompt    what to send, when do is send
 *   notifyText  panel label for a stop
 *
 * `when` is prose on purpose. It is the criteria for the model, not a value the
 * plugin matches against.
 */

/** The actions a decision point can take. */
export const DECISION_ACTIONS = ["send", "stop", "silent"]

/** Longest `when` accepted, to keep the prompt within a sane size. */
const MAX_WHEN_LENGTH = 500

/**
 * @typedef {object} Decision
 * @property {string} id
 * @property {string} when
 * @property {"send"|"stop"|"silent"} do
 * @property {string} prompt
 * @property {string} notifyText
 */

/** True when a value can serve as a decision point. */
export function isValidDecision(d) {
  if (!d || typeof d !== "object") return false
  if (typeof d.id !== "string" || !d.id.trim()) return false
  if (typeof d.when !== "string" || !d.when.trim()) return false
  if (!DECISION_ACTIONS.includes(d.do)) return false
  if (d.do === "send" && (typeof d.prompt !== "string" || !d.prompt.trim())) return false
  return true
}

/**
 * Every reason a decision point is unusable, in one pass.
 *
 * Reporting only the first problem makes the user fix one field, reload, and
 * discover the next — so this collects them all.
 *
 * @returns {string[]} empty when the decision point is fine
 */
export function decisionIssues(d) {
  if (!d || typeof d !== "object") return ["must be an object"]
  const out = []
  if (typeof d.id !== "string" || !d.id.trim()) out.push("id must not be empty")
  if (typeof d.when !== "string" || !d.when.trim()) {
    out.push("when must describe the situation in words, and must not be empty")
  } else if (d.when.length > MAX_WHEN_LENGTH) {
    out.push(`when must be at most ${MAX_WHEN_LENGTH} characters`)
  }
  if (!DECISION_ACTIONS.includes(d.do)) {
    out.push(`do must be one of ${DECISION_ACTIONS.join(" / ")}, got ${JSON.stringify(d.do)}`)
  } else if (d.do === "send" && (typeof d.prompt !== "string" || !d.prompt.trim())) {
    out.push("do=send requires a prompt")
  }
  return out
}

/** The first problem with a decision point, or null when it is fine. */
export function decisionProblem(d) {
  const issues = decisionIssues(d)
  return issues.length > 0 ? issues[0] : null
}

/** Find one decision point by id. */
export function decisionById(decisions, id) {
  return (decisions ?? []).find((d) => d?.id === id)
}

/** Ids of the decision points that can send a message. */
export function sendableIds(decisions) {
  return new Set((decisions ?? []).filter((d) => d?.do === "send").map((d) => d.id))
}

/**
 * Build the model's question from a decision list.
 *
 * Every decision contributes its `when` as a criteria entry, so the options the
 * model sees are exactly the situations the user described. More decisions means
 * more options, which is why the confidence threshold is calibrated separately.
 *
 * @param {Decision[]} decisions
 */
export function buildDecisionQuestion(decisions) {
  const criteria = {}
  for (const d of decisions ?? []) {
    if (!d?.id || typeof d.when !== "string") continue
    criteria[d.id] = d.when
  }
  return {
    type: "choice",
    instructions: "根据对话判断目前处在哪种情形，选出最符合的一条。",
    criteria,
  }
}
