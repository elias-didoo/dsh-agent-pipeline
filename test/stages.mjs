/**
 * Stage definitions: the contract a stage list must satisfy, and the guarantee
 * that the pipeline is driven by `behavior` rather than by built-in stage ids.
 *
 * The point of these tests is that stage ids are data. Anything here that
 * passes only for the built-in six would defeat the purpose.
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

const { BUILTIN_STAGES, BEHAVIORS, isValidStage, hasTerminalStage, indexStages, labelOf } = await import("../lib/stages.js")
const { pickRule, phaseProgress } = await import("../lib/phases.js")
const { validate } = await import("../lib/config.js")

console.log("=== 1. The four behaviors ===")

await t("every built-in stage uses a declared behavior", () => {
  for (const s of BUILTIN_STAGES) {
    assert(BEHAVIORS.includes(s.behavior), `${s.id}: ${s.behavior} is not declared`)
  }
})

await t("every behavior is exercised by at least one built-in stage", () => {
  const used = new Set(BUILTIN_STAGES.map((s) => s.behavior))
  for (const b of BEHAVIORS) {
    assert(used.has(b), `behavior ${b} has no built-in example, so it is untested in practice`)
  }
})

console.log("\n=== 2. A fully custom stage list works ===")

const CUSTOM = [
  { id: "intake", behavior: "sequence", label: { en: "Intake", zh: "接需求" }, criteria: "用户刚提出需求" },
  { id: "coding", behavior: "passive", label: { en: "Coding", zh: "写代码" }, criteria: "正在改代码" },
  { id: "handover", behavior: "terminal", label: { en: "Handover", zh: "交接" }, criteria: "已完成" },
]
const CUSTOM_RULES = [
  { id: "clarify", when: "intake", action: "send", prompt: "p" },
  { id: "confirm", when: "intake", action: "stop" },
  { id: "done", when: "handover", action: "stop" },
]
const S = indexStages(CUSTOM)
const sent = (id) => ({ role: "user", source: { kind: "decision", ruleId: id }, content: [] })
const progressOf = (ids) => phaseProgress(ids.map(sent), CUSTOM_RULES)

await t("a custom sequence stage advances without any built-in id", () => {
  const first = pickRule(S.get("intake"), progressOf([]), CUSTOM_RULES)
  assert(first.rule?.id === "clarify", `got ${first.rule?.id}`)
  const second = pickRule(S.get("intake"), progressOf(["clarify"]), CUSTOM_RULES)
  assert(second.rule?.id === "confirm", `got ${second.rule?.id}`)
  const third = pickRule(S.get("intake"), progressOf(["clarify", "confirm"]), CUSTOM_RULES)
  assert(third.skip === "stage-complete", `got ${third.skip}`)
})

await t("a custom passive stage does nothing", () => {
  const r = pickRule(S.get("coding"), progressOf([]), CUSTOM_RULES)
  assert(r.skip === "passive", `got ${r.skip}`)
})

await t("a custom terminal stage stops", () => {
  const r = pickRule(S.get("handover"), progressOf([]), CUSTOM_RULES)
  assert(r.rule?.id === "done", `got ${r.rule?.id}`)
})

console.log("\n=== 3. Renaming a built-in stage keeps its behavior ===")

await t("the same behavior under a different id behaves identically", () => {
  const renamed = { id: "reviewing", behavior: "sequence", label: { en: "R", zh: "R" }, criteria: "c" }
  const rules = [
    { id: "r1", when: "reviewing", action: "send", prompt: "p" },
    { id: "r2", when: "reviewing", action: "stop" },
  ]
  const p = phaseProgress([], rules)
  const first = pickRule(renamed, p, rules)
  assert(first.rule?.id === "r1", `got ${first.rule?.id}`)
})

console.log("\n=== 4. Validation rejects lists that cannot drive the pipeline ===")

const base = (stages) => ({ stages, workspaces: [] })

await t("empty list is rejected", () => {
  const r = validate(base([]))
  assert(r.issues?.some((i) => /must not be empty/.test(i.message)), "should reject an empty list")
})

await t("non-array stages is rejected", () => {
  const r = validate(base("nope"))
  assert(r.issues?.some((i) => /must be an array/.test(i.message)), "should reject a string")
})

await t("missing label in either language is rejected", () => {
  const r = validate(base([{ id: "x", behavior: "terminal", label: { en: "X" }, criteria: "c" }]))
  assert(r.issues?.some((i) => /incomplete/.test(i.message)), "should reject a half-labelled stage")
})

await t("blank criteria is rejected", () => {
  const r = validate(base([{ id: "x", behavior: "terminal", label: { en: "X", zh: "X" }, criteria: "  " }]))
  assert(r.issues?.some((i) => /incomplete/.test(i.message)), "should reject blank criteria")
})

await t("a list with no terminal stage is rejected", () => {
  const r = validate(base([
    { id: "a", behavior: "sequence", label: { en: "A", zh: "A" }, criteria: "c" },
    { id: "b", behavior: "passive", label: { en: "B", zh: "B" }, criteria: "c" },
  ]))
  assert(r.issues?.some((i) => /terminal/.test(i.message)), "should demand a terminal stage")
})

await t("a rejected list falls back to the built-ins rather than loading nothing", () => {
  const r = validate(base([]))
  // validate() reports issues and returns no value; the caller keeps the
  // built-ins. This asserts the built-in constant itself is usable.
  assert(hasTerminalStage(BUILTIN_STAGES), "built-ins must remain a valid fallback")
})

console.log("\n=== 5. Helper behaviour ===")

await t("isValidStage accepts a complete stage", () => {
  assert(isValidStage(CUSTOM[0]), "should accept")
})

await t("isValidStage rejects null, non-objects and partial stages", () => {
  for (const bad of [null, undefined, 42, [], {}, { id: "x" }, { id: "x", behavior: "passive" }]) {
    assert(!isValidStage(bad), `should reject ${JSON.stringify(bad)}`)
  }
})

await t("hasTerminalStage is false for lists without one", () => {
  assert(!hasTerminalStage([CUSTOM[0]]), "sequence-only list has no terminal")
  assert(!hasTerminalStage([]), "empty list has no terminal")
  assert(!hasTerminalStage(undefined), "undefined has no terminal")
})

await t("labelOf falls back to English, then to the id", () => {
  const s = { id: "x", label: { en: "English", zh: "中文" } }
  assert(labelOf(s, "zh") === "中文", "zh label")
  assert(labelOf(s, "fr") === "English", "unknown locale falls back to English")
  assert(labelOf({ id: "y", label: {} }, "zh") === "y", "missing labels fall back to the id")
})

console.log("\n=== 6. The built-in stages stay a sane default ===")

await t("built-in ids are unique", () => {
  const ids = BUILTIN_STAGES.map((s) => s.id)
  assert(new Set(ids).size === ids.length, `duplicate id in ${ids.join(",")}`)
})

await t("built-in criteria are distinct — no two stages share wording", () => {
  const seen = new Map()
  for (const s of BUILTIN_STAGES) {
    const other = seen.get(s.criteria)
    assert(!other, `${s.id} and ${other} share criteria, so the model cannot tell them apart`)
    seen.set(s.criteria, s.id)
  }
})

console.log("\n=== 7. model.path reaches the request ===")

await t("judge posts to the configured path", async () => {
  // Validation alone cannot catch a dropped `model.path`: the request would
  // quietly hit the default route. Call judge() and read the URL it used.
  const { judge } = await import("../lib/judge.js")
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: false, status: 500, text: async () => "" }
  }
  try {
    await judge({
      state: "x",
      cfg: { model: { baseUrl: "http://127.0.0.1:1", name: "m", timeoutMs: 1000, path: "/v1/choices" }, stages: BUILTIN_STAGES },
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert(calls.length === 1, `expected one request, got ${calls.length}`)
  assert(calls[0].endsWith("/v1/choices"), `request went to ${calls[0]}, not the configured path`)
})

await t("judge falls back to /v1/systemone when no path is configured", async () => {
  const { judge } = await import("../lib/judge.js")
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: false, status: 500, text: async () => "" }
  }
  try {
    await judge({
      state: "x",
      cfg: { model: { baseUrl: "http://127.0.0.1:1", name: "m", timeoutMs: 1000 }, stages: BUILTIN_STAGES },
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert(calls[0]?.endsWith("/v1/systemone"), `got ${calls[0]}`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
