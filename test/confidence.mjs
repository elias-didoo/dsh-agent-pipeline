/**
 * Confidence and the uncertain path.
 *
 * `confidenceFloor` is compared against raw `p_max`, the probability the model
 * put on the option it chose. Normalization was tried first and dropped: it maps
 * the random baseline 1/n to 0, but with many options it also compresses a
 * correct answer into the same band as a guess, so no threshold separated them.
 * These tests pin the raw semantics so the threshold means what the config says.
 */

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name} — ${e.message}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const { confidenceOf, interpret, Outcome } = await import("../lib/judge.js")

/** A model response with the given distribution. */
const answer = (choice, probabilities) => ({ answers: { next: { type: "choice", choice, probabilities } } })

console.log("=== 1. confidenceOf reports p_max verbatim ===")

await t("returns the probability of the chosen option", () => {
  assert(confidenceOf({ a: 0.9, b: 0.1 }, "a") === 0.9, "should be 0.9")
})

await t("does not normalize against the option count", () => {
  // The same 0.9 means the same thing whether there are 2 options or 20.
  const many = Object.fromEntries([["a", 0.9], ...Array.from({ length: 19 }, (_, i) => [`o${i}`, 0.1 / 19])])
  assert(Math.abs(confidenceOf(many, "a") - 0.9) < 1e-9, `got ${confidenceOf(many, "a")}`)
})

await t("a below-chance guess stays low rather than becoming 0", () => {
  // 0.2 of 5 options is exactly chance. Raw keeps it at 0.2, below the floor.
  assert(confidenceOf({ a: 0.2, b: 0.2, c: 0.2, d: 0.2, e: 0.2 }, "a") === 0.2, "should stay 0.2")
})

await t("a missing or non-numeric probability is 0", () => {
  assert(confidenceOf({}, "a") === 0, "missing")
  assert(confidenceOf(undefined, "a") === 0, "no distribution")
  assert(confidenceOf({ a: "high" }, "a") === 0, "non-numeric")
  assert(confidenceOf({ a: NaN }, "a") === 0, "NaN")
})

await t("out-of-range values are clamped", () => {
  assert(confidenceOf({ a: 1.7 }, "a") === 1, "above 1")
  assert(confidenceOf({ a: -0.3 }, "a") === 0, "below 0")
})

console.log("\n=== 2. The floor decides between DECISION and UNCERTAIN ===")

await t("a confident answer is a decision", () => {
  const r = interpret(answer("a", { a: 0.8, b: 0.2 }), { confidenceFloor: 0.15 })
  assert(r.outcome === Outcome.DECISION, `got ${r.outcome}`)
  assert(r.decision === "a", `got ${r.decision}`)
})

await t("a guess is uncertain", () => {
  const r = interpret(answer("a", { a: 0.09, b: 0.3, c: 0.3, d: 0.31 }), { confidenceFloor: 0.15 })
  assert(r.outcome === Outcome.UNCERTAIN, `got ${r.outcome}`)
  assert(/confidence/.test(r.reason), `reason should explain: ${r.reason}`)
})

await t("the default floor is 0.15", () => {
  // Calibrated from measurement: correct answers landed at 0.21 and up, guesses
  // at 0.14 and below.
  const justAbove = interpret(answer("a", { a: 0.16, b: 0.84 }), {})
  assert(justAbove.outcome === Outcome.DECISION, "0.16 should pass the default")
  const justBelow = interpret(answer("a", { a: 0.14, b: 0.86 }), {})
  assert(justBelow.outcome === Outcome.UNCERTAIN, "0.14 should fail the default")
})

await t("the floor is configurable", () => {
  const strict = interpret(answer("a", { a: 0.5, b: 0.5 }), { confidenceFloor: 0.9 })
  assert(strict.outcome === Outcome.UNCERTAIN, "0.5 should fail a 0.9 floor")
})

console.log("\n=== 3. Malformed responses ===")

await t("no answers is an error", () => {
  const r = interpret({}, {})
  assert(r.outcome === Outcome.ERROR, `got ${r.outcome}`)
  assert(r.code === "INVALID_RESPONSE", `got ${r.code}`)
})

await t("a missing choice is an error", () => {
  const r = interpret({ answers: { next: { type: "choice" } } }, {})
  assert(r.outcome === Outcome.ERROR, `got ${r.outcome}`)
})

await t("a non-choice answer is an error", () => {
  const r = interpret({ answers: { next: { type: "noul", noul: 0.9 } } }, {})
  assert(r.outcome === Outcome.ERROR, `got ${r.outcome}`)
})

await t("the distribution is kept for later re-calibration", () => {
  // A threshold that turns out wrong is only fixable if the raw numbers are in
  // the log.
  const probs = { a: 0.6, b: 0.4 }
  const r = interpret(answer("a", probs), { confidenceFloor: 0.15 })
  assert(r.probabilities === probs, "the distribution should ride along unchanged")
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
