/**
 * Progress derivation, idempotency, and the serial queue.
 *
 * The rule that matters here: a decision point fires once. The model reads the
 * conversation and picks whatever matches; if that is something already sent,
 * progress says so and nothing goes out.
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

const { decisionProgress, resolveDecision } = await import("../lib/progress.js")
const { SerialQueue } = await import("../lib/judge.js")

const D = (id, action = "send") => ({ id, when: `情形 ${id}`, do: action, prompt: "p", notifyText: "" })
const LIST = [D("a"), D("b"), D("c"), D("stop", "stop")]
const sent = (id) => ({ role: "user", source: { kind: "decision", ruleId: id }, content: [] })
const prog = (ids) => decisionProgress(ids.map(sent), LIST)

console.log("=== 1. Progress derivation ===")

await t("no plugin messages → nothing fired", () => {
  assert(Object.keys(prog([]).byDecisionId).length === 0, "should be empty")
})

await t("counts each id separately", () => {
  const p = prog(["a", "a", "b"])
  assert(p.byDecisionId.a === 2, `a: ${p.byDecisionId.a}`)
  assert(p.byDecisionId.b === 1, `b: ${p.byDecisionId.b}`)
})

await t("ignores non-plugin messages", () => {
  const p = decisionProgress([
    { role: "user", source: { kind: "user" }, content: [] },
    { role: "assistant", source: { kind: "model" }, content: [] },
    { role: "user", content: [] },
  ], LIST)
  assert(Object.keys(p.byDecisionId).length === 0, "should be empty")
})

await t("ignores ids not in the current config", () => {
  const p = prog(["retired", "a"])
  assert(!("retired" in p.byDecisionId), "stale ids must not count")
  assert(p.byDecisionId.a === 1, "current ids still count")
})

console.log("\n=== 2. A decision fires once ===")

await t("send fires while unfired", () => {
  assert(resolveDecision(LIST[0], prog([])).decision?.id === "a", "should fire")
})

await t("send does not repeat", () => {
  const r = resolveDecision(LIST[0], prog(["a"]))
  assert(!r.decision, "must not fire again")
  assert(r.skip === "already-sent", `got ${r.skip}`)
})

await t("walking the whole list fires each exactly once", () => {
  const fired = []
  for (let turn = 0; turn < 10; turn++) {
    const p = prog(fired)
    // The model keeps choosing the first point it has not yet triggered.
    const next = LIST.find((x) => (p.byDecisionId[x.id] ?? 0) === 0)
    if (!next) break
    const r = resolveDecision(next, p)
    if (!r.decision) break
    fired.push(r.decision.id)
  }
  assert(fired.join(",") === "a,b,c,stop", `got ${fired.join(",")}`)
  const dup = fired.filter((id, i) => fired.indexOf(id) !== i)
  assert(dup.length === 0, `no repeats allowed, got ${dup.join(",")}`)
})

await t("stop halts once, then stays quiet", () => {
  const stop = LIST[3]
  assert(resolveDecision(stop, prog([])).decision?.id === "stop", "should halt")
  const again = resolveDecision(stop, prog(["stop"]))
  assert(again.skip === "already-stopped", `got ${again.skip}`)
})

await t("silent never acts, however often chosen", () => {
  const s = D("quiet", "silent")
  assert(resolveDecision(s, prog([])).skip === "silent", "should skip")
  assert(resolveDecision(s, prog(["quiet"])).skip === "silent", "still skips")
})

console.log("\n=== 3. Serial queue ===")

const delay = (ms, v) => () => new Promise((r) => setTimeout(() => r(v), ms))

await t("runs one at a time, in submission order", async () => {
  // The model serves a single slot; overlapping requests would interleave it.
  const q = new SerialQueue()
  const done = []
  const task = (n, ms) => () => new Promise((r) => setTimeout(() => { done.push(n); r(n) }, ms))
  await Promise.all([q.run(task("a", 30)), q.run(task("b", 5)), q.run(task("c", 10))])
  assert(done.join(",") === "a,b,c", `finished ${done.join(",")}`)
})

await t("returns each task's own result", async () => {
  const q = new SerialQueue()
  const r = await Promise.all([q.run(delay(10, "first")), q.run(delay(1, "second"))])
  assert(r.join(",") === "first,second", `got ${r.join(",")}`)
})

await t("a throwing task rejects its caller but the queue keeps working", async () => {
  const q = new SerialQueue()
  let caught = null
  try { await q.run(() => { throw new Error("boom") }) } catch (e) { caught = e.message }
  assert(caught === "boom", `the caller should see the error, got ${caught}`)
  assert(await q.run(delay(1, "ok")) === "ok", "later tasks still run")
})

await t("a rejecting task does not poison the queue", async () => {
  const q = new SerialQueue()
  await q.run(() => Promise.reject(new Error("nope"))).catch(() => {})
  assert(await q.run(delay(1, "ok")) === "ok", "later tasks still run")
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
