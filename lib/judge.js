/**
 * Decision call: POST /v1/systemone.
 *
 * Server constraints verified against a running instance:
 *   - yes/no questions must use `type: "noul"` ("boolean" returns 400)
 *   - `noul` must carry both `criteria.true` and `criteria.false`,
 *     otherwise the answer comes back inverted
 *   - the model runs with `-np 1`, so calls must be serialized
 */

/** Outcome of a judgement. */
export const Outcome = {
  /** An option was chosen; core.js turns it into a branch target. */
  DECISION: "decision",
  UNCERTAIN: "uncertain",
  ERROR: "error",
}

/**
 * Serial queue: keeps at most one decision request in flight.
 */
export class SerialQueue {
  #tail = Promise.resolve()

  run(fn) {
    const result = this.#tail.then(fn, fn)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * Confidence of a choice: the probability the model put on it.
 *
 * This is raw `p_max`, not a normalized value. Normalization maps the random
 * baseline 1/n to 0, which keeps a fixed threshold meaningful across differing
 * option counts — but it also compresses the whole useful range as options grow.
 * With eleven decision points the normalized value of a correct answer fell
 * into the same band as a guess, so no threshold separated them.
 *
 * Raw `p_max` does separate them, provided the threshold is calibrated for the
 * option count actually in use. `confidenceFloor` is therefore expressed in the
 * same units the model reports, and the log carries both the value and the full
 * distribution so it can be re-calibrated from real sessions.
 *
 * @param probabilities the model's distribution
 * @param choice the option the model picked
 * @returns 0..1
 */
export function confidenceOf(probabilities, choice) {
  const p = probabilities?.[choice]
  if (typeof p !== "number" || !Number.isFinite(p)) return 0
  return Math.max(0, Math.min(1, p))
}

/**
 * Call the decision model.
 * @returns {Promise<{ outcome: string, decision?: string, probabilities?: object,
 *   confidence?: number, error?: string, code?: string, reason?: string }>}
 *
 * @param {object} p
 * @param {string} p.state decision context
 * @param {object} p.cfg effective workspace config
 * @param {object} [p.questions] the question set to ask; a branch supplies one
 * @param {AbortSignal} [p.signal] optional cancellation signal
 */
export async function judge({ state, cfg, questions, signal = undefined }) {
  const model = cfg?.model ?? {}
  const url = new URL(model.path ?? "/v1/systemone", model.baseUrl ?? "http://127.0.0.1:8080").href
  const body = {
    model: model.name ?? "kev-latest",
    state,
    // The only question this plugin asks is a branch's, and the caller builds
    // it. Without one there is nothing to decide, which is a programming error
    // rather than a runtime condition.
    questions,
  }

  const timeoutMs = model.timeoutMs ?? 30000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs)
  const onAbort = () => ac.abort(signal?.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { outcome: Outcome.ERROR, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, code: res.status >= 500 ? "SERVER" : "INVALID_REQUEST" }
    }
    const data = await res.json()
    return interpret(data, cfg)
  } catch (e) {
    const aborted = e?.name === "AbortError"
    return {
      outcome: Outcome.ERROR,
      error: aborted ? "timeout" : String(e?.message ?? e),
      code: aborted ? "TIMEOUT" : "TRANSPORT",
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", onAbort)
  }
}

/**
 * Interpret the model response. The decision point it returns is turned into an action
 * by the user-configured `rule.action`.
 */
export function interpret(data, cfg) {
  const answers = data?.answers
  if (!answers) return { outcome: Outcome.ERROR, error: "response missing answers", code: "INVALID_RESPONSE" }

  const next = answers.next
  if (!next || next.type !== "choice" || !next.choice) {
    return { outcome: Outcome.ERROR, error: "missing a valid next.choice", code: "INVALID_RESPONSE" }
  }

  // The model answers with the option it considers current. What that option
  // means is the caller's business, not the model's.
  const decision = next.choice
  const probabilities = next.probabilities ?? {}
  const confidence = confidenceOf(probabilities, decision)
  const floor = cfg?.confidenceFloor ?? 0.15

  const stats = { decision, probabilities, confidence, usage: data.usage }

  if (confidence < floor) {
    return {
      outcome: Outcome.UNCERTAIN,
      ...stats,
      reason: `confidence ${confidence.toFixed(3)} < ${floor}`,
    }
  }

  return { outcome: Outcome.DECISION, ...stats }
}

/** Error codes worth retrying. */
const RETRYABLE = new Set(["TRANSPORT", "TIMEOUT", "SERVER"])

/** Whether this error is worth retrying (transport / timeout / server). */
export function isRetryable(code) {
  return typeof code === "string" && RETRYABLE.has(code)
}
