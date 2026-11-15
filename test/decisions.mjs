/**
 * Decision points: the contract, and turning the model's choice into an action.
 *
 * The interesting property is that `when` is prose. These tests treat it as
 * opaque text — nothing here asserts that a particular sentence means a
 * particular thing, because that is the model's job.
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

const {
  DECISION_ACTIONS, isValidDecision, decisionProblem, decisionById,
  sendableIds, buildDecisionQuestion,
} = await import("../lib/decisions.js")
const { decisionProgress, resolveDecision } = await import("../lib/progress.js")
const { validate, effectiveConfig } = await import("../lib/config.js")

const WS = "/tmp/dsh-decision-orchestrator-test-workspace"

/** A decision point; overrides replace fields. */
const d = (o) => ({ id: "x", when: "某个情形", do: "send", prompt: "p", notifyText: "", ...o })

console.log("=== 1. The contract ===")

await t("a complete decision point is valid", () => {
  assert(isValidDecision(d()), "should accept")
})

await t("there are exactly three actions", () => {
  assert(DECISION_ACTIONS.join(",") === "send,stop,silent", `got ${DECISION_ACTIONS.join(",")}`)
})

await t("a decision point without when is rejected", () => {
  assert(decisionProblem(d({ when: "" })), "empty when must be rejected")
  assert(decisionProblem(d({ when: "   " })), "blank when must be rejected")
})

await t("a decision point without id is rejected", () => {
  assert(decisionProblem(d({ id: "" })), "empty id must be rejected")
})

await t("send without a prompt is rejected", () => {
  assert(decisionProblem(d({ do: "send", prompt: "" })), "send needs a prompt")
})

await t("stop and silent need no prompt", () => {
  assert(!decisionProblem(d({ do: "stop", prompt: "" })), "stop is fine without one")
  assert(!decisionProblem(d({ do: "silent", prompt: "" })), "silent is fine without one")
})

await t("an unknown action is rejected", () => {
  assert(decisionProblem(d({ do: "notify" })), "notify is not an action")
})

await t("an overlong when is rejected", () => {
  assert(decisionProblem(d({ when: "x".repeat(501) })), "should cap the length")
})

await t("lookup by id finds the point, and misses cleanly", () => {
  const list = [d({ id: "a" }), d({ id: "b" })]
  assert(decisionById(list, "b").id === "b", "should find b")
  assert(decisionById(list, "zzz") === undefined, "missing id returns undefined")
  assert(decisionById(undefined, "a") === undefined, "no list returns undefined")
})

await t("sendableIds lists only send points", () => {
  const ids = sendableIds([d({ id: "a" }), d({ id: "b", do: "stop" }), d({ id: "c", do: "silent" })])
  assert([...ids].join(",") === "a", `got ${[...ids].join(",")}`)
})

console.log("\n=== 2. The question sent to the model ===")

await t("every decision becomes one option, keyed by id", () => {
  const q = buildDecisionQuestion([d({ id: "a", when: "情形甲" }), d({ id: "b", when: "情形乙" })])
  assert(q.type === "choice", "must be a choice question")
  assert(Object.keys(q.criteria).join(",") === "a,b", `got ${Object.keys(q.criteria).join(",")}`)
})

await t("the criteria text is the when text, verbatim", () => {
  // The prose is model input. Rewriting it here would silently change what the
  // user configured.
  const prose = "agent 仍说发现了问题，需要继续修"
  const q = buildDecisionQuestion([d({ id: "a", when: prose })])
  assert(q.criteria.a === prose, `got ${JSON.stringify(q.criteria.a)}`)
})

await t("an empty list yields an empty criteria map", () => {
  const q = buildDecisionQuestion([])
  assert(Object.keys(q.criteria).length === 0, "should be empty")
})

console.log("\n=== 3. Progress is derived from the log ===")

const sent = (id) => ({ role: "user", source: { kind: "decision", ruleId: id }, content: [] })
const LIST = [d({ id: "a" }), d({ id: "b" }), d({ id: "c", do: "stop" })]

await t("no messages → nothing has fired", () => {
  assert(Object.keys(decisionProgress([], LIST).byDecisionId).length === 0, "should be empty")
})

await t("counts what this plugin sent", () => {
  const p = decisionProgress([sent("a"), sent("a"), sent("b")], LIST)
  assert(p.byDecisionId.a === 2, `a should be 2, got ${p.byDecisionId.a}`)
  assert(p.byDecisionId.b === 1, `b should be 1`)
})

await t("ignores messages from anyone else", () => {
  const p = decisionProgress([
    { role: "user", source: { kind: "user" }, content: [] },
    { role: "assistant", source: { kind: "model" }, content: [] },
  ], LIST)
  assert(Object.keys(p.byDecisionId).length === 0, "should be empty")
})

await t("ignores ids no longer in the config", () => {
  // A decision point removed from the config must not leave a count behind that
  // makes a same-named new one look spent.
  const p = decisionProgress([sent("gone"), sent("a")], LIST)
  assert(!("gone" in p.byDecisionId), "stale id must not be counted")
  assert(p.byDecisionId.a === 1, "current ids still count")
})

console.log("\n=== 4. The model's choice becomes an action ===")

const prog = (ids) => decisionProgress(ids.map(sent), LIST)

await t("a fresh send fires", () => {
  const r = resolveDecision(LIST[0], prog([]))
  assert(r.decision?.id === "a", `got ${r.decision?.id}`)
})

await t("a send that already fired does not repeat", () => {
  const r = resolveDecision(LIST[0], prog(["a"]))
  assert(!r.decision, "must not fire twice")
  assert(r.skip === "already-sent", `got ${r.skip}`)
})

await t("a fresh stop halts", () => {
  const r = resolveDecision(LIST[2], prog([]))
  assert(r.decision?.id === "c", `got ${r.decision?.id}`)
})

await t("a stop that already fired stays quiet", () => {
  const r = resolveDecision(LIST[2], prog(["c"]))
  assert(r.skip === "already-stopped", `got ${r.skip}`)
})

await t("silent never acts", () => {
  const r = resolveDecision(d({ do: "silent" }), prog([]))
  assert(r.skip === "silent", `got ${r.skip}`)
})

await t("an unknown action skips with the action named", () => {
  const r = resolveDecision(d({ do: "bogus" }), prog([]))
  assert(r.skip === "unknown-action:bogus", `got ${r.skip}`)
})

await t("a missing decision point skips cleanly", () => {
  assert(resolveDecision(undefined, prog([])).skip === "no-decision", "undefined should skip")
  assert(resolveDecision(null, prog([])).skip === "no-decision", "null should skip")
})

console.log("\n=== 5. Config validation ===")

const ws = (decisions) => ({ workspaces: [{ path: WS, enabled: true, decisions }] })

await t("a workspace with decision points validates", () => {
  const r = validate(ws([d({ id: "a" }), d({ id: "b", do: "stop" })]))
  assert(!r.issues, JSON.stringify(r.issues?.[0]))
  assert(r.value.workspaces[0].decisions.length === 2, "both survive")
})

await t("when is prose, not an enum — any non-empty text validates", () => {
  const r = validate(ws([d({ id: "a", when: "任何我想要的描述都可以" }), d({ id: "b", do: "stop", when: "另一种" })]))
  assert(!r.issues, JSON.stringify(r.issues?.[0]))
})

await t("a blank when is reported with its path", () => {
  const r = validate(ws([d({ id: "a", when: "" }), d({ id: "b", do: "stop" })]))
  assert(r.issues?.length > 0, "should fail")
  assert(/decisions\[0\]/.test(r.issues[0].message), `got ${r.issues[0].message}`)
})

await t("a duplicate id is reported", () => {
  const r = validate(ws([d({ id: "a" }), d({ id: "a" })]))
  assert(r.issues?.some((i) => /duplicated/.test(i.message)), "should detect the duplicate")
})

await t("an enabled workspace needs at least two points", () => {
  const r = validate(ws([d({ id: "only" })]))
  assert(r.issues?.some((i) => /at least 2/.test(i.message)), "one point is not a choice")
})

await t("a disabled workspace may define none", () => {
  const r = validate({ workspaces: [{ path: WS, enabled: false, decisions: [] }] })
  assert(!r.issues, JSON.stringify(r.issues?.[0]))
})

await t("a config still using `rules` fails loudly", () => {
  // Parsing succeeds either way, so without an explicit check a stale config
  // would load with zero decision points and the plugin would do nothing while
  // looking enabled.
  const r = validate({ workspaces: [{ path: WS, enabled: true, rules: [{ id: "a", when: "x", scene: "s", action: "send", prompt: "p" }] }] })
  assert(r.issues?.some((i) => /rules/.test(i.message)), "should name the stale field")
  assert(r.value === undefined, "must not hand back a config that does nothing")
})

await t("effectiveConfig exposes decisions, not rules", () => {
  const r = validate(ws([d({ id: "a" }), d({ id: "b", do: "stop" })]))
  const eff = effectiveConfig(r.value, WS)
  assert(Array.isArray(eff.decisions), "decisions should be present")
  assert(eff.decisions.length === 2, `got ${eff.decisions.length}`)
  assert(!("rules" in eff), "rules should be gone")
})

await t("the default confidence floor suits p_max", () => {
  const r = validate({ workspaces: [] })
  assert(r.value.defaults.confidenceFloor === 0.15, `got ${r.value.defaults.confidenceFloor}`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
