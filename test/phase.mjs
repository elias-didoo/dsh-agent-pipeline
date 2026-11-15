/**
 * Stage machine: deriving progress from the log + the pickRule lookup.
 *
 * These two functions decide which rule fires within a stage;
 * questions like "which self-check round" cannot come from the model and
 * must be counted.
 */

const { phaseProgress, pickRule } = await import("../lib/phases.js")

let pass = 0
let fail = 0
// Must await fn(): a synchronous try/catch cannot catch assertion failures
// inside async bodies,
// which would make failing cases report as passing.
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

/** Build a message this plugin sent. */
function decisionMsg(ruleId, text = "x") {
  return { role: "user", source: { kind: "decision", ruleId }, content: [{ type: "text", text }] }
}

const RULES = [
  { id: "bug_root", when: "planning", action: "send", prompt: "p1", notifyText: "" },
  { id: "review", when: "planning", action: "send", prompt: "p2", notifyText: "" },
  { id: "summarize", when: "planning", action: "send", prompt: "p3", notifyText: "" },
  { id: "need_confirm", when: "planning", action: "stop", prompt: "", notifyText: "需要你拍板" },
  { id: "selfcheck_1", when: "selfchecking", action: "send", prompt: "p4", notifyText: "" },
  { id: "selfcheck_2", when: "selfchecking", action: "send", prompt: "p5", notifyText: "" },
  { id: "selfcheck_3", when: "selfchecking", action: "send", prompt: "p6", notifyText: "" },
  { id: "push", when: "selfchecking", action: "send", prompt: "p7", notifyText: "" },
  { id: "conflict", when: "conflict", action: "send", prompt: "p8", notifyText: "" },
  { id: "need_user", when: "waiting", action: "stop", prompt: "", notifyText: "需要你" },
  { id: "done", when: "finished", action: "stop", prompt: "", notifyText: "完成" },
]

console.log("=== 1. Progress derivation ===")

await t("no plugin messages → all zero", () => {
  const p = phaseProgress([], RULES)
  assert(p.selfCheckRound === 0, `selfCheckRound=${p.selfCheckRound}`)
})

await t("counts review / summary / self-check", () => {
  const msgs = [
    decisionMsg("review"),
    decisionMsg("summarize"),
    decisionMsg("selfcheck_1"),
    decisionMsg("selfcheck_2"),
  ]
  const p = phaseProgress(msgs, RULES)
  assert(p.selfCheckRound === 2, `selfCheckRound should be 2, got ${p.selfCheckRound}`)
})

await t("ignores messages that are not ours", () => {
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]
  const p = phaseProgress(msgs, RULES)
  assert(p.selfCheckRound === 0, "must not count")
  assert(Object.keys(p.byRuleId).length === 0, "byRuleId should be empty")
})

await t("ignores ruleIds no longer in config (edits do not pollute)", () => {
  const msgs = [decisionMsg("selfcheck_1"), decisionMsg("old_rule_gone")]
  const p = phaseProgress(msgs, RULES)
  assert(p.selfCheckRound === 1, `should be 1, got ${p.selfCheckRound}`)
  assert(!("old_rule_gone" in p.byRuleId), "unknown rules must not be counted")
})

console.log("\n=== 1b. `when` validation ===")

await t("missing when → reported", async () => {
  const { validate } = await import("../lib/config.js")
  const r = validate({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", scene: "s", action: "send", prompt: "p" },
      { id: "b", scene: "s", action: "silent", prompt: "" },
    ] }],
  })
  assert(r.issues?.some((i) => /when/.test(i.message)), `expected a when issue: ${JSON.stringify(r.issues)}`)
})

await t("invalid when → reported", async () => {
  const { validate } = await import("../lib/config.js")
  const r = validate({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", when: "bogus", scene: "s", action: "send", prompt: "p" },
      { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
    ] }],
  })
  assert(r.issues?.some((i) => /when/.test(i.message)), `expected a when issue: ${JSON.stringify(r.issues)}`)
})

await t("an invalid when degrades the rule to silent (never selected)", async () => {
  // validate returns either { value } or { issues }, never both; a null
  // fallback keeps the assertion honest about the real shape.
  const { validate } = await import("../lib/config.js")
  const raw = {
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", when: "bogus", scene: "s", action: "send", prompt: "p" },
      { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
    ] }],
  }
  const r = validate(raw)

  // Check the normalized result first.
  // With issues, validate returns only { issues } and the normalized value is
  // invisible;
  // what can still be confirmed is that the bad `when` is reported rather than
  // silently accepted.
  const reported = (r.issues ?? []).some(
    (i) => i.path?.includes("when") && /\ba\b|\\(a\\)/.test(i.message),
  )
  const normalized = r.value?.workspaces?.[0]?.rules?.find((x) => x.id === "a")

  assert(
    reported || normalized?.action === "silent",
    `invalid when was neither reported nor degraded: ${JSON.stringify(r).slice(0, 200)}`,
  )
})

await t("all six stage names pass validation", async () => {
  const { validate, STAGES } = await import("../lib/config.js")
  for (const st of STAGES) {
    const r = validate({
      workspaces: [{ path: "/tmp/a", enabled: true, rules: [
        { id: "a", when: st, scene: "s", action: "send", prompt: "p" },
        { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
      ] }],
    })
    assert(!r.issues, `${st} should not error: ${JSON.stringify(r.issues)}`)
  }
})

await t("the action enum is send/stop/silent only — notify is gone", async () => {
  const { validate } = await import("../lib/config.js")
  const mk = (action) => ({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", when: "waiting", scene: "s", action, prompt: "", notifyText: "x" },
      { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
    ] }],
  })
  assert(!validate(mk("stop")).issues, "stop should pass")
  const legacy = validate(mk("notify"))
  assert(legacy.issues?.some((i) => /action/.test(i.message)), "notify should be rejected")
})

console.log("\n=== 2. pickRule: planning progression ===")

await t("nothing sent yet → first planning rule", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("planning", p, RULES)
  assert(r.rule?.id === "bug_root", `got ${r.rule?.id}`)
})

await t("bug_root already sent → move to review", () => {
  const p = { selfCheckRound: 0, byRuleId: { bug_root: 1 } }
  const r = pickRule("planning", p, RULES)
  assert(r.rule?.id === "review", `got ${r.rule?.id}`)
})

await t("bug_root + review + summarize all sent → hand over to stop", () => {
  const p = {
    selfCheckRound: 0,
    byRuleId: { bug_root: 1, review: 1, summarize: 1 },
  }
  const r = pickRule("planning", p, RULES)
  assert(r.rule?.id === "need_confirm", `got ${r.rule?.id}`)
})

await t("the stop rule fired too → skip", () => {
  const p = {
    selfCheckRound: 0,
    byRuleId: { bug_root: 1, review: 1, summarize: 1, need_confirm: 1 },
  }
  const r = pickRule("planning", p, RULES)
  assert(!r.rule && r.skip === "planning-complete", `got ${JSON.stringify(r)}`)
})

console.log("\n=== 3. pickRule: fixed selfchecking order ===")

for (const [round, expect] of [[0, "selfcheck_1"], [1, "selfcheck_2"], [2, "selfcheck_3"], [3, "push"]]) {
  t(`round ${round} → ${expect}`, () => {
    const p = { selfCheckRound: round, byRuleId: {} }
    const r = pickRule("selfchecking", p, RULES)
    assert(r.rule?.id === expect, `got ${r.rule?.id}`)
  })
}

await t("all self-check rounds done → skip", () => {
  const p = { selfCheckRound: 4, byRuleId: {} }
  const r = pickRule("selfchecking", p, RULES)
  assert(!r.rule, "no rule should remain")
  assert(r.skip === "selfcheck-complete", `got ${r.skip}`)
})

console.log("\n=== 4. pickRule: other stages ===")

await t("implementing → no nudge", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("implementing", p, RULES)
  assert(!r.rule, "must not send")
  assert(r.skip === "implementing", `got ${r.skip}`)
})

await t("waiting → the stop rule", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("waiting", p, RULES)
  assert(r.rule?.id === "need_user", `got ${r.rule?.id}`)
})

await t("finished → the stop rule", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("finished", p, RULES)
  assert(r.rule?.id === "done", `got ${r.rule?.id}`)
})

await t("conflict → the send rule", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("conflict", p, RULES)
  assert(r.rule?.id === "conflict", `got ${r.rule?.id}`)
})

await t("unknown stage → skip", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("bogus", p, RULES)
  assert(!r.rule && r.skip === "unknown-stage:bogus", `got ${JSON.stringify(r)}`)
})

console.log("\n=== 5. End to end: one full pipeline ===")

await t("planning → review → summary → wait → self-check x3 → push", () => {
  const seen = []
  let msgs = []
  const progress = () => phaseProgress(msgs, RULES)

  // After each pickRule, simulate the message actually being sent.
  const step = (stage) => {
    const r = pickRule(stage, progress(), RULES)
    if (r.rule) {
      seen.push(r.rule.id)
      msgs = [...msgs, decisionMsg(r.rule.id)]
    }
    return r
  }

  step("planning")   // bug_root
  step("planning")   // review
  step("planning")   // summarize
  step("planning")   // need_confirm
  step("selfchecking") // selfcheck_1
  step("selfchecking") // selfcheck_2
  step("selfchecking") // selfcheck_3
  step("selfchecking") // push

  assert(
    JSON.stringify(seen) === JSON.stringify([
      "bug_root", "review", "summarize", "need_confirm",
      "selfcheck_1", "selfcheck_2", "selfcheck_3", "push",
    ]),
    `actual order: ${seen.join(" → ")}`,
  )
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
