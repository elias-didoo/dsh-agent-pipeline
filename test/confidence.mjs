/**
 * Confidence normalization tests.
 *
 * Raw p_max depends on the option count (a blind guess lands at 1/2, 1/5, 1/6),
 * while after normalization 0.5 means the same thing regardless of count —
 * which is what makes a fixed threshold possible.
 */

const { confidenceOf } = await import("../lib/judge.js")

let pass = 0
let fail = 0
// Must await fn(): a synchronous runner cannot catch assertion failures
// inside async test bodies.
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
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps

console.log("=== 1. The normalization formula ===")

await t("2 options, p=0.55 → 0.10 (barely better than chance)", () => {
  const c = confidenceOf({ a: 0.55, b: 0.45 }, "a")
  assert(near(c, 0.1), `got ${c.toFixed(4)}`)
})

await t("2 options, p=0.90 → 0.80", () => {
  const c = confidenceOf({ a: 0.9, b: 0.1 }, "a")
  assert(near(c, 0.8), `got ${c.toFixed(4)}`)
})

await t("2 options, p=0.50 (exactly baseline) → 0", () => {
  const c = confidenceOf({ a: 0.5, b: 0.5 }, "a")
  assert(near(c, 0), `got ${c.toFixed(4)}`)
})

await t("5 options, p=0.20 (exactly baseline) → 0", () => {
  const probs = { a: 0.2, b: 0.2, c: 0.2, d: 0.2, e: 0.2 }
  const c = confidenceOf(probs, "a")
  assert(near(c, 0), `got ${c.toFixed(4)}`)
})

await t("5 options, p=0.926 → ≈0.907", () => {
  const probs = { implementing: 0.926, planning: 0.034, selfchecking: 0.015, waiting: 0.014, finished: 0.011 }
  const c = confidenceOf(probs, "implementing")
  assert(near(c, 0.907, 0.01), `got ${c.toFixed(4)}`)
})

await t("5 options, p=0.634 → ≈0.542", () => {
  const probs = { selfchecking: 0.634, finished: 0.159, waiting: 0.13, implementing: 0.041, planning: 0.035 }
  const c = confidenceOf(probs, "selfchecking")
  assert(near(c, 0.542, 0.01), `got ${c.toFixed(4)}`)
})

await t("5 options, p=0.279 (ambiguous case) → ≈0.099", () => {
  const probs = { planning: 0.279, waiting: 0.262, implementing: 0.197, finished: 0.159, selfchecking: 0.103 }
  const c = confidenceOf(probs, "planning")
  assert(near(c, 0.099, 0.01), `got ${c.toFixed(4)}`)
})

console.log("\n=== 2. Key property: decoupled from option count ===")

await t("equal certainty normalizes near 1 at any option count", () => {
  const c2 = confidenceOf({ a: 0.999, b: 0.001 }, "a")
  const c5 = confidenceOf({ a: 0.999, b: 0.00025, c: 0.00025, d: 0.00025, e: 0.00025 }, "a")
  assert(c2 > 0.99, `2 options ${c2}`)
  assert(c5 > 0.99, `5 options ${c5}`)
})

await t("the same lead over baseline normalizes similarly at any option count", () => {
  // 2 options: baseline 0.5, pick 0.55
  const c2 = confidenceOf({ a: 0.55, b: 0.45 }, "a")
  // 5 options: baseline 0.2, pick 0.24 (20% above baseline)
  const c5 = confidenceOf({ a: 0.24, b: 0.19, c: 0.19, d: 0.19, e: 0.19 }, "a")
  assert(near(c2, 0.1, 0.02), `2 options ${c2.toFixed(3)}`)
  assert(near(c5, 0.05, 0.02), `5 options ${c5.toFixed(3)}`)
})

console.log("\n=== 3. Boundaries and edge cases ===")

await t("probability below baseline → 0 (never negative)", () => {
  const c = confidenceOf({ a: 0.1, b: 0.5, c: 0.4 }, "a")
  assert(c === 0, `got ${c}`)
})

await t("unknown option → 0", () => {
  assert(confidenceOf({ a: 0.5, b: 0.5 }, "zzz") === 0, "should be 0")
})

await t("empty distribution → 0", () => {
  assert(confidenceOf({}, "a") === 0, "should be 0")
})

await t("single option → raw value (no baseline exists)", () => {
  const c = confidenceOf({ only: 0.8 }, "only")
  assert(near(c, 0.8), `got ${c}`)
})

await t("the result is always within 0..1", () => {
  for (const p of [0, 0.001, 0.5, 0.999, 1]) {
    const c = confidenceOf({ a: p, b: 1 - p }, "a")
    assert(c >= 0 && c <= 1, `p=${p} → ${c}`)
  }
})

console.log("\n=== 4. Threshold behaviour in practice ===")

await t("floor 0.3: ambiguous cases blocked, real judgements all pass", () => {
  const floor = 0.3
  // A "guess" sample: five options split almost evenly.
  const vague = confidenceOf({ planning: 0.25, waiting: 0.22, implementing: 0.2, finished: 0.18, selfchecking: 0.15 }, "planning")
  // Confidences measured on real sessions (all correct, varying certainty).
  const manifest = [
    confidenceOf({ planning: 0.62, selfchecking: 0.15, waiting: 0.12, finished: 0.08, conflict: 0.03 }, "planning"), // the 0.753 kind
    confidenceOf({ finished: 0.45, waiting: 0.25, selfchecking: 0.2, planning: 0.06, conflict: 0.04 }, "finished"), // the 0.318 kind
  ]
  assert(vague < floor, `ambiguous ${vague.toFixed(3)} should be < ${floor}`)
  for (const c of manifest) {
    assert(c >= floor, `correct real sample ${c.toFixed(3)} should be >= ${floor}`)
  }
})

await t("the 0.45 vs 0.3 trade-off is backed by real measurements", () => {
  // Confidences measured on real sessions (six samples, all correct).
  const samples = [0.753, 0.454, 0.529, 0.318, 0.498, 0.439]
  const pass45 = samples.filter((c) => c >= 0.45).length
  const pass30 = samples.filter((c) => c >= 0.3).length
  // 0.45 would drop two correct results at 0.318 and 0.439.
  assert(pass45 === 4, `floor 0.45 should pass 4, got ${pass45}`)
  assert(pass30 === 6, `floor 0.3 should pass 6, got ${pass30}`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
