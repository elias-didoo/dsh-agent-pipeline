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

const { decisionProgress, resolveDecision, bestRemaining } = await import("../lib/progress.js")
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

console.log("\n=== 2b. Falling back when the first choice is spent ===")

await t("bestRemaining skips what already fired", () => {
  const p = prog(["a"])
  const best = bestRemaining(LIST, { a: 0.5, b: 0.3, c: 0.2 }, p)
  assert(best?.id === "b", `should take b, got ${best?.id}`)
})

await t("bestRemaining stops at a flat distribution", () => {
  // The fallback floor is lower than confidenceFloor — the first answer already
  // proved the conversation matched something — but a 12-way split must still
  // pick nothing rather than take whichever id happens to win by noise.
  // Twelve options, the size of the real set: a flat split lands at 1/12.
  const twelve = Array.from({ length: 12 }, (_, i) => D(`d${i}`))
  const flat = Object.fromEntries(twelve.map((d) => [d.id, 1 / 12]))
  const best = bestRemaining(twelve, flat, prog([]))
  assert(best === undefined, `a flat distribution must pick nothing, got ${best?.id}`)
})

await t("bestRemaining accepts a neighbour the normal floor would reject", () => {
  // Measured: a third-round reply scored 11.1% on the next round down, below
  // the 15% first-answer floor. Refusing it stalls the pipeline on a tie the
  // model cannot break.
  const best = bestRemaining(LIST, { a: 0.5, b: 0.11 }, prog(["a"]))
  assert(best?.id === "b", `should accept 0.11 as a fallback, got ${best?.id}`)
})

await t("bestRemaining ignores silent points", () => {
  const list = [D("a"), D("quiet", "silent")]
  const best = bestRemaining(list, { a: 0.5, quiet: 0.4 }, prog(["a"]))
  assert(best === undefined, `silent must never be chosen, got ${best?.id}`)
})

await t("a spent choice hands over to the next one", () => {
  // Two adjacent points can score within a point of each other. The first is
  // the same situation one round earlier; the second is the one to act on.
  const r = resolveDecision(LIST[0], prog(["a"]), LIST[1])
  assert(r.decision?.id === "b", `should fall back to b, got ${r.decision?.id}`)
  assert(r.fellBackFrom === "a", "the log needs to show this was a fallback")
})

await t("no fallback when the alternative is also spent", () => {
  const r = resolveDecision(LIST[0], prog(["a", "b"]), LIST[1])
  assert(!r.decision, "must not fire a spent alternative")
  assert(r.skip === "already-sent", `got ${r.skip}`)
})

await t("a spent stop does not fall back to a send", () => {
  // Stopping is a decision to wait, not a step in a sequence — substituting a
  // send for it would act against what the model judged.
  const r = resolveDecision(LIST[3], prog(["stop"]), LIST[0])
  assert(!r.decision, "a spent stop must not turn into a send")
  assert(r.skip === "already-stopped", `got ${r.skip}`)
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
