/**
 * Simulate DSH's apply() call with a fake ctx shaped like the real API.
 * Goal: confirm apply() does not throw, before ever mounting it.
 */
const host = await import("../host.js")

const config = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 30000 },
  defaults: { maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.3, humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3 },
  workspaces: [{ path: "/tmp/dsh-decision-orchestrator-test-workspace", enabled: true, rules: [
    {id:"r1",when:"planning",scene:"s1",action:"send",prompt:"p1",notifyText: ""},
    {id:"r2",when:"waiting",scene:"s2",action:"stop",prompt:"",notifyText:"等你"},
  ]}],
}

let registered = null
const ctx = {
  agents: { list: () => [] },
  sessions: { flush: async () => true },
  goals: { get: () => undefined },
  sessionProjections: {
    register(def) {
      registered = def
      return { stateOf: () => def.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0), dispose: async () => {} }
    },
  },
  get: (k) => k === "tokenMeter" ? { estimateMessage: () => 10 } : undefined,
  on: () => {},
  effect: () => {},
}

let pass=0, fail=0
const t=(n,f)=>{try{f();pass++;console.log("  ✅ "+n)}catch(e){fail++;console.log("  ❌ "+n+" — "+e.message)}}
const assert=(c,m)=>{if(!c)throw new Error(m)}

console.log("=== apply() simulation ===")
t("apply does not throw", () => { host.apply(ctx, config) })
t("projection registered", () => assert(registered, "not registered"))
t("projection has every required field", () => {
  for (const k of ["key","stateVersion","stateSchema","init","apply","wire"]) assert(registered[k] !== undefined, `missing ${k}`)
  assert(registered.wire.viewSchema, "missing wire.viewSchema")
  assert(typeof registered.wire.view === "function", "missing wire.view")
})
t("stateSchema parses the initial state", () => {
  const s = registered.stateSchema.parse(registered.init({ cwd: "/x" }, 0))
  assert(typeof s.rulesEnabled === "boolean", "rulesEnabled")
  assert(Array.isArray(s.rulesView), "rulesView")
})
t("init carries the workspace rules", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  assert(s.rulesEnabled === true, "rulesEnabled should be true")
  assert(s.rulesView.length === 2, `rulesView should hold 2 entries, got ${s.rulesView.length}`)
})
t("rulesView carries every field the client needs to group and render", () => {
  // The client groups on `when` and displays `notifyText`; losing either
  // degrades silently.
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const r1 = s.rulesView.find((r) => r.id === "r1")
  assert(r1, "r1 not found")
  assert(r1.when === "planning", `when should be planning, got ${r1.when}`)
  const r2 = s.rulesView.find((r) => r.id === "r2")
  assert(r2.when === "waiting", `when should be waiting, got ${r2.when}`)
  assert(r2.notifyText === "等你", `notifyText should be 等你, got ${r2.notifyText}`)
})
t("view output passes viewSchema", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const v = registered.wire.viewSchema.parse(registered.wire.view(s))
  assert(v.enabled === true, "enabled")
  assert(Array.isArray(v.rules) && v.rules.length === 2, "rules")
})
t("apply returns the same reference for non turn/end events", () => {
  const s = { failures: 0 }
  assert(registered.apply(s, { type: "user/message" }) === s, "should return the same reference")
})
t("apply does not count on turn/end (guards against double counting)", () => {
  // iterations / failures are held by the main loop through mutate. If the
  // projection counted them too, one turn/end would be counted twice.
  const s = { failures: 0 }
  const n = registered.apply(s, { type: "turn/end", data: { reason: { kind: "error" } } })
  assert(n === s, "apply must return the identical reference")
  assert(n.failures === 0, "failures must not accumulate here")
})
t("view excludes runtime-only fields", () => {
  const s = registered.init({ cwd: "/x" }, 0)
  const v = registered.wire.view(s)
  assert(!("iterations" in v), "view must not expose iterations (always stale)")
  assert(!("stopped" in v), "view must not expose stopped (always stale)")
})

console.log("\n=== schemas do not drop fields ===")

await t("stateSchema preserves every field initialState produces", () => {
  // A hand-written parse that forgets a field drops it silently: nothing throws,
  // the value just quietly becomes empty downstream.
  const initial = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const parsed = registered.stateSchema.parse(initial)
  for (const key of Object.keys(initial)) {
    assert(key in parsed, `stateSchema drops ${key}`)
    assert(
      JSON.stringify(parsed[key]) === JSON.stringify(initial[key]),
      `stateSchema alters ${key}`,
    )
  }
})

await t("viewSchema preserves every field viewOf produces", () => {
  const initial = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const view = registered.wire.view(initial)
  const parsed = registered.wire.viewSchema.parse(view)
  for (const key of Object.keys(view)) {
    assert(key in parsed, `viewSchema drops ${key}`)
    assert(
      JSON.stringify(parsed[key]) === JSON.stringify(view[key]),
      `viewSchema alters ${key}`,
    )
  }
})

await t("the view carries stage definitions, not just rules", () => {
  // Without stages the client cannot group rules by stage at all.
  const initial = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const view = registered.wire.viewSchema.parse(registered.wire.view(initial))
  assert(Array.isArray(view.stages), "view.stages must be an array")
  assert(view.stages.length > 0, "view.stages must not be empty for an enabled workspace")
  for (const st of view.stages) {
    assert(typeof st.id === "string" && st.id.length > 0, "each stage needs an id")
    assert(st.label && st.label.en && st.label.zh, `stage ${st.id} needs both labels`)
    assert(typeof st.behavior === "string", `stage ${st.id} needs a behavior`)
  }
})

console.log("\n=== apply survives a broken host ===")

const BASE_CFG = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 1000, path: "/v1/systemone" },
  defaults: {
    maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.3,
    humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3,
  },
  workspaces: [],
}

function ctxWith(over = {}) {
  return {
    agents: { list: () => [] },
    sessions: { flush: async () => true },
    goals: { get: () => undefined },
    sessionProjections: { register: () => ({ stateOf: () => ({}), dispose: async () => {} }) },
    get: () => undefined,
    on: () => {},
    effect: () => {},
    ...over,
  }
}

const BROKEN_HOSTS = [
  ["a projection registry that throws", () => ctxWith({ sessionProjections: { register: () => { throw new Error("no") } } })],
  ["a projection registry that rejects", () => ctxWith({ sessionProjections: { register: () => Promise.reject(new Error("no")) } })],
  ["no projection service at all", () => ctxWith({ sessionProjections: undefined })],
  ["an event bus that throws", () => ctxWith({ on: () => { throw new Error("no") } })],
  ["no effect helper", () => ctxWith({ effect: undefined })],
  ["no settings service", () => ctxWith({ get: () => undefined })],
  ["a settings service that throws", () => ctxWith({ get: (k) => (k === "settings" ? { describe: () => { throw new Error("no") } } : undefined) })],
]

for (const [label, mk] of BROKEN_HOSTS) {
  await t(`apply with ${label} does not throw`, () => {
    // A fault in the host must disable this plugin at worst. Throwing here
    // would take down DSH startup or session reads.
    host.apply(mk(), BASE_CFG)
  })
}

await t("apply with a null config does not throw", () => {
  host.apply(ctxWith(), null)
})

await t("apply with a non-object config does not throw", () => {
  host.apply(ctxWith(), "garbage")
})

await t("apply with garbage workspaces does not throw", () => {
  host.apply(ctxWith(), { ...BASE_CFG, workspaces: "not an array" })
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail?1:0)
