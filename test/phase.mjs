/**
 * Stage machine: deriving progress from the log, and the behavior dispatch that
 * turns a stage into the rule for this round.
 *
 * Nothing here names a stage id when testing selection — the behaviour is what
 * drives selection, and stage ids are user-replaceable data.
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

const { pickRule, phaseProgress } = await import("../lib/phases.js")
const { BUILTIN_STAGES, BEHAVIORS, isValidStage, hasTerminalStage, stageById } = await import("../lib/stages.js")
const { validate, STAGES } = await import("../lib/config.js")

const S = { get: (id) => stageById(BUILTIN_STAGES, id) }

/** Build one plugin-sent message. */
function sent(ruleId) {
  return { role: "user", source: { kind: "decision", ruleId }, content: [{ type: "text", text: "x" }], time: 0 }
}

const RULES = [
  { id: "bug_root", when: "planning", action: "send", prompt: "p" },
  { id: "review", when: "planning", action: "send", prompt: "p" },
  { id: "summarize", when: "planning", action: "send", prompt: "p" },
  { id: "need_confirm", when: "planning", action: "stop", notifyText: "需要你拍板" },
  { id: "selfcheck_1", when: "selfchecking", action: "send", prompt: "p" },
  { id: "selfcheck_2", when: "selfchecking", action: "send", prompt: "p" },
  { id: "selfcheck_3", when: "selfchecking", action: "send", prompt: "p" },
  { id: "push", when: "selfchecking", action: "send", prompt: "p" },
  { id: "conflict", when: "conflict", action: "send", prompt: "p" },
  { id: "waiting", when: "waiting", action: "stop", notifyText: "需要你" },
  { id: "finished", when: "finished", action: "stop", notifyText: "完成" },
]

const progressOf = (ids) => phaseProgress(ids.map(sent), RULES)

console.log("=== 1. Progress derivation ===")

await t("no plugin messages → all zero", () => {
  const p = progressOf([])
  assert(Object.keys(p.byRuleId).length === 0, "byRuleId should be empty")
})

await t("counts review / summary / self-check", () => {
  const p = progressOf(["review", "summarize", "selfcheck_1", "selfcheck_2"])
  assert(p.byRuleId.review === 1, `review should be 1, got ${p.byRuleId.review}`)
  assert(p.byRuleId.summarize === 1, `summarize should be 1, got ${p.byRuleId.summarize}`)
  assert(p.byRuleId.selfcheck_1 === 1, `selfcheck_1 should be 1`)
  assert(p.byRuleId.selfcheck_2 === 1, `selfcheck_2 should be 1`)
})

await t("ignores messages that are not ours", () => {
  const p = phaseProgress([
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "yo" }] },
  ], RULES)
  assert(Object.keys(p.byRuleId).length === 0, "byRuleId should be empty")
})

await t("ignores ruleIds no longer in config (edits do not pollute)", () => {
  const p = phaseProgress([sent("selfcheck_1"), sent("old_rule_gone")], RULES)
  assert(p.byRuleId.selfcheck_1 === 1, `should be 1, got ${p.byRuleId.selfcheck_1}`)
  assert(!("old_rule_gone" in p.byRuleId), "unknown rules must not be counted")
})

console.log("\n=== 2. behavior: sequence ===")

const SEQ_CASES = [
  { sent: [], want: "bug_root" },
  { sent: ["bug_root"], want: "review" },
  { sent: ["bug_root", "review"], want: "summarize" },
  { sent: ["bug_root", "review", "summarize"], want: "need_confirm" },
  { sent: ["bug_root", "review", "summarize", "need_confirm"], want: null },
]

for (const c of SEQ_CASES) {
  await t(`planning with ${c.sent.length} sent → ${c.want ?? "skip"}`, () => {
    const r = pickRule(S.get("planning"), progressOf(c.sent), RULES)
    if (c.want === null) {
      assert(!r.rule, "should not pick a rule")
      assert(r.skip === "stage-complete", `skip should be stage-complete, got ${r.skip}`)
    } else {
      assert(r.rule?.id === c.want, `should pick ${c.want}, got ${r.rule?.id}`)
    }
  })
}

const SC_CASES = [
  { sent: [], want: "selfcheck_1" },
  { sent: ["selfcheck_1"], want: "selfcheck_2" },
  { sent: ["selfcheck_1", "selfcheck_2"], want: "selfcheck_3" },
  { sent: ["selfcheck_1", "selfcheck_2", "selfcheck_3"], want: "push" },
  { sent: ["selfcheck_1", "selfcheck_2", "selfcheck_3", "push"], want: null },
]

for (const c of SC_CASES) {
  await t(`selfchecking with ${c.sent.length} sent → ${c.want ?? "skip"}`, () => {
    const r = pickRule(S.get("selfchecking"), progressOf(c.sent), RULES)
    if (c.want === null) {
      assert(r.skip === "stage-complete", `skip should be stage-complete, got ${r.skip}`)
    } else {
      assert(r.rule?.id === c.want, `should pick ${c.want}, got ${r.rule?.id}`)
    }
  })
}

await t("sequence fires each rule once — no rule repeats", () => {
  const seen = []
  const sentIds = []
  for (let i = 0; i < 8; i++) {
    const r = pickRule(S.get("selfchecking"), progressOf(sentIds), RULES)
    if (!r.rule) break
    seen.push(r.rule.id)
    sentIds.push(r.rule.id)
  }
  const dup = seen.filter((id, i) => seen.indexOf(id) !== i)
  assert(dup.length === 0, `no rule should fire twice, got ${JSON.stringify(seen)}`)
  assert(seen.length === 4, `should fire exactly the 4 send rules, got ${seen.length}`)
})

console.log("\n=== 3. behavior: the other three ===")

await t("passive → skip:passive", () => {
  const r = pickRule(S.get("implementing"), progressOf([]), RULES)
  assert(!r.rule, "must not pick a rule")
  assert(r.skip === "passive", `got ${r.skip}`)
})

for (const id of ["waiting", "finished"]) {
  await t(`terminal ${id} → fires its stop rule`, () => {
    const r = pickRule(S.get(id), progressOf([]), RULES)
    assert(r.rule?.id === id, `should pick ${id}, got ${r.rule?.id}`)
    assert(r.rule.action === "stop", "terminal must hand over to a stop rule")
  })
  await t(`terminal ${id} with its stop already fired → skip`, () => {
    const r = pickRule(S.get(id), progressOf([id]), RULES)
    assert(!r.rule, "should not pick again")
    assert(r.skip === "already-stopped", `got ${r.skip}`)
  })
}

await t("once → first send rule", () => {
  const r = pickRule(S.get("conflict"), progressOf([]), RULES)
  assert(r.rule?.id === "conflict", `got ${r.rule?.id}`)
})

await t("once with it already fired → skip", () => {
  const r = pickRule(S.get("conflict"), progressOf(["conflict"]), RULES)
  assert(!r.rule, "should not pick again")
  assert(r.skip === "already-fired", `got ${r.skip}`)
})

console.log("\n=== 4. Unknown and edge cases ===")

await t("unknown behavior → skip with reason", () => {
  const r = pickRule({ id: "x", behavior: "bogus" }, progressOf([]), RULES)
  assert(r.skip === "unknown-behavior:bogus", `got ${r.skip}`)
})

await t("no rules → skip:no-rules", () => {
  const r = pickRule(S.get("planning"), progressOf([]), [])
  assert(r.skip === "no-rules", `got ${r.skip}`)
})

await t("a stage with no rules in it → skip, never picks another stage's rule", () => {
  const r = pickRule({ id: "reviewing", behavior: "sequence" }, progressOf([]), RULES)
  assert(!r.rule, "must not pick a rule from another stage")
  assert(r.skip === "stage-complete", `got ${r.skip}`)
})

await t("bare stage id (no definition) → skip:unknown-behavior", () => {
  const r = pickRule("planning", progressOf([]), RULES)
  assert(!r.rule, "a bare id carries no behavior, so nothing can be chosen")
})

console.log("\n=== 5. Stage definitions ===")

await t("built-in stages are all valid", () => {
  for (const s of BUILTIN_STAGES) assert(isValidStage(s), `${s.id} is incomplete`)
})

await t("built-in stages have at least one terminal", () => {
  assert(hasTerminalStage(BUILTIN_STAGES), "built-ins must settle")
})

await t("every behavior in use is declared", () => {
  for (const s of BUILTIN_STAGES) {
    assert(BEHAVIORS.includes(s.behavior), `${s.id} has unknown behavior ${s.behavior}`)
  }
})

await t("every built-in stage carries both labels and criteria", () => {
  for (const s of BUILTIN_STAGES) {
    assert(s.label.en && s.label.zh, `${s.id} needs both labels`)
    assert(s.criteria.trim().length > 0, `${s.id} needs criteria`)
  }
})

console.log("\n=== 6. Config: stages and rules ===")

const rule = (o) => ({ scene: "s", ...o })

await t("absent stages → built-in list", () => {
  const r = validate({ workspaces: [] })
  assert(!r.issues, JSON.stringify(r.issues))
  assert(r.value.stages.length === STAGES.length, `should be ${STAGES.length}`)
})

await t("custom stages replace the built-ins wholesale", () => {
  const r = validate({
    stages: [
      { id: "drafting", behavior: "sequence", label: { en: "Drafting", zh: "起草" }, criteria: "c" },
      { id: "done", behavior: "terminal", label: { en: "Done", zh: "完成" }, criteria: "c" },
    ],
    workspaces: [],
  })
  assert(!r.issues, JSON.stringify(r.issues))
  assert(r.value.stages.map((s) => s.id).join(",") === "drafting,done", "should replace, not merge")
})

await t("a stage without criteria is rejected", () => {
  const r = validate({
    stages: [{ id: "x", behavior: "terminal", label: { en: "X", zh: "X" } }],
    workspaces: [],
  })
  assert(r.issues?.some((i) => /stages\[0\]/.test(i.message)), "should report the bad stage")
})

await t("a stage with an unknown behavior is rejected", () => {
  const r = validate({
    stages: [{ id: "x", behavior: "bogus", label: { en: "X", zh: "X" }, criteria: "c" }],
    workspaces: [],
  })
  assert(r.issues?.some((i) => /stages\[0\]/.test(i.message)), "should report the bad behavior")
})

await t("duplicate stage ids are rejected", () => {
  const r = validate({
    stages: [
      { id: "x", behavior: "terminal", label: { en: "X", zh: "X" }, criteria: "c" },
      { id: "x", behavior: "terminal", label: { en: "X", zh: "X" }, criteria: "c" },
    ],
    workspaces: [],
  })
  assert(r.issues?.some((i) => /duplicated/.test(i.message)), "should report the duplicate")
})

await t("stage list without a terminal stage is rejected", () => {
  const r = validate({
    stages: [{ id: "x", behavior: "sequence", label: { en: "X", zh: "X" }, criteria: "c" }],
    workspaces: [],
  })
  assert(r.issues?.some((i) => /terminal/.test(i.message)), "must require a terminal stage")
})

await t("a rule may reference a custom stage", () => {
  const r = validate({
    stages: [
      { id: "drafting", behavior: "sequence", label: { en: "D", zh: "D" }, criteria: "c" },
      { id: "done", behavior: "terminal", label: { en: "E", zh: "E" }, criteria: "c" },
    ],
    workspaces: [{
      path: "/x",
      enabled: true,
      rules: [
        rule({ id: "a", when: "drafting", action: "send", prompt: "p" }),
        rule({ id: "b", when: "done", action: "stop" }),
      ],
    }],
  })
  assert(!r.issues, JSON.stringify(r.issues))
  const rules = r.value.workspaces[0].rules
  assert(rules[0].when === "drafting", "custom stage id must survive validation")
})

await t("a rule referencing an undefined stage is reported", () => {
  const r = validate({
    stages: [{ id: "done", behavior: "terminal", label: { en: "E", zh: "E" }, criteria: "c" }],
    workspaces: [{
      path: "/x",
      enabled: true,
      rules: [
        rule({ id: "a", when: "planning", action: "send", prompt: "p" }),
        rule({ id: "b", when: "done", action: "stop" }),
      ],
    }],
  })
  assert(r.issues?.some((i) => /when/.test(i.message)), "should report the unknown when")
})

console.log("\n=== 7. Config: model path and action enum ===")

await t("model.path defaults to /v1/systemone", () => {
  const r = validate({ workspaces: [] })
  assert(r.value.model.path === "/v1/systemone", `got ${r.value.model.path}`)
})

await t("model.path is overridable", () => {
  const r = validate({ model: { path: "/v1/choices" }, workspaces: [] })
  assert(r.value.model.path === "/v1/choices", `got ${r.value.model.path}`)
})

await t("the action enum is send/stop/silent only — notify is gone", () => {
  const mk = (action) => ({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      rule({ id: "a", when: "waiting", action, notifyText: "x" }),
      rule({ id: "b", when: "planning", action: "silent" }),
    ] }],
  })
  assert(!validate(mk("stop")).issues, "stop should pass")
  const legacy = validate(mk("notify"))
  assert(legacy.issues?.some((i) => /action/.test(i.message)), "notify should be rejected")
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
