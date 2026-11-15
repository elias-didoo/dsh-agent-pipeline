/**
 * Decision call: POST /v1/systemone.
 *
 * Server constraints verified against a running instance:
 *   - yes/no questions must use `type: "noul"` ("boolean" returns 400)
 *   - `noul` must carry both `criteria.true` and `criteria.false`,
 *     otherwise the answer comes back inverted
 *   - the model runs with `-np 1`, so calls must be serialized
 */

import { buildQuestions } from "./context.js"

/** Outcome of a judgement. */
export const Outcome = {
  /** A stage was decided; the concrete action comes from phases.pickRule. */
  STAGE: "stage",
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
 * Normalized confidence.
 *
 * The model returns an already-normalized distribution (sums to 1), so the
 * meaning of raw `p_max` depends entirely on the option count: a blind guess
 * lands at 1/2, 1/5, 1/6 … for 2, 5, 6 options. Thresholding on raw `p_max`
 * therefore makes the threshold drift with the number of options.
 *
 * This maps the random baseline to 0 and certainty to 1:
 *   normalized = (p - 1/n) / (1 - 1/n)
 * After normalization 0.5 means the same thing regardless of option count,
 * which is what makes a fixed threshold possible.
 *
 * @param probabilities the model's distribution
 * @param choice the option the model picked
 * @returns 0..1; 0 means no better than chance, 1 means certain
 */
export function confidenceOf(probabilities, choice) {
  const p = probabilities?.[choice]
  if (typeof p !== "number" || !Number.isFinite(p)) return 0

  const n = probabilities && typeof probabilities === "object" ? Object.keys(probabilities).length : 0
  if (n < 2) return Math.max(0, Math.min(1, p))

  const base = 1 / n
  if (p <= base) return 0
  const span = 1 - base
  if (span <= 0) return 0
  return Math.min(1, (p - base) / span)
}

/**
 * Call the decision model.
 * @returns {Promise<{ outcome: string, probabilities?: object, confidence?: number,
 *   rawConfidence?: number, stage?: string, error?: string, code?: string, reason?: string }>}
 *
 * @param {object} p
 * @param {string} p.state decision context
 * @param {object} p.cfg effective workspace config
 * @param {AbortSignal} [p.signal] optional cancellation signal
 */
export async function judge({ state, cfg, signal = undefined }) {
  const model = cfg?.model ?? {}
  const url = new URL("/v1/systemone", model.baseUrl ?? "http://127.0.0.1:8080").href
  const body = {
    model: model.name ?? "kev-latest",
    state,
    questions: buildQuestions(),
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
 * Interpret the model response. The stage it returns is turned into an action
 * by the user-configured `rule.action`.
 */
export function interpret(data, cfg) {
  const answers = data?.answers
  if (!answers) return { outcome: Outcome.ERROR, error: "response missing answers", code: "INVALID_RESPONSE" }

  const next = answers.next
  if (!next || next.type !== "choice" || !next.choice) {
    return { outcome: Outcome.ERROR, error: "missing a valid next.choice", code: "INVALID_RESPONSE" }
  }

  // The model answers with a *stage*, not a rule. Which rule to fire within
  // that stage is decided by phases.pickRule from log-derived progress.
  const stage = next.choice
  const probabilities = next.probabilities ?? {}
  const confidence = confidenceOf(probabilities, stage)
  // Keep raw p_max too: the normalized value compares across runs, the raw
  // value lets you sanity-check against the model's own output.
  const rawConfidence = typeof probabilities[stage] === "number" ? probabilities[stage] : 0
  const floor = cfg?.confidenceFloor ?? 0.3

  const stats = { stage, probabilities, confidence, rawConfidence, usage: data.usage }

  if (confidence < floor) {
    return {
      outcome: Outcome.UNCERTAIN,
      ...stats,
      reason: `confidence ${confidence.toFixed(3)} < ${floor} (raw ${rawConfidence.toFixed(3)})`,
    }
  }

  return { outcome: Outcome.STAGE, ...stats }
}

/** Error codes worth retrying. */
const RETRYABLE = new Set(["TRANSPORT", "TIMEOUT", "SERVER"])

/** Whether this error is worth retrying (transport / timeout / server). */
export function isRetryable(code) {
  return typeof code === "string" && RETRYABLE.has(code)
}
