/**
 * Simulate DSH's apply() call with a fake ctx shaped like the real API.
 * Goal: confirm apply() does not throw, before ever mounting it.
 */
const host = await import("../host.js")

const config = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 30000 },
  defaults: { maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.3, humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3 },
  workspaces: [{
    path: "/tmp/dsh-decision-orchestrator-test-workspace",
    enabled: true,
    steps: {
      plan: { id: "plan", do: "send", prompt: "p1" },
      wait: { id: "wait", do: "stop", notifyText: "等你" },
    },
    flows: { demo: { label: { en: "Demo", zh: "演示" }, steps: ["plan", "wait"] } },
  }],
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
let apis
t("apply does not throw", () => { apis = host.apply(ctx, config) })
/** The read-only surface apply returns; used by the workspace tests below. */
const hostApis = () => apis
t("projection registered", () => assert(registered, "not registered"))
t("projection has every required field", () => {
  for (const k of ["key","stateVersion","stateSchema","init","apply","wire"]) assert(registered[k] !== undefined, `missing ${k}`)
  assert(registered.wire.viewSchema, "missing wire.viewSchema")
  assert(typeof registered.wire.view === "function", "missing wire.view")
})
t("stateSchema parses the initial state", () => {
  const s = registered.stateSchema.parse(registered.init({ cwd: "/x" }, 0))
  assert(typeof s.enabled === "boolean", "enabled")
  assert(s.flow === null, "no flow before one starts")
})
t("init marks the workspace enabled", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  assert(s.enabled === true, "enabled should be true")
})

t("stateSchema keeps a recorded flow and drops a malformed one", () => {
  // The projection is read back from a checkpoint after a restart; a row
  // written by a different version must not take the whole session down.
  const good = registered.stateSchema.parse({ enabled: true, flow: {
    name: "demo", status: "paused", startedAt: 5, since: 7, note: "n",
    branches: { b: "plan" }, passed: ["wait"],
  } })
  assert(good.flow.name === "demo", "name kept")
  assert(good.flow.status === "paused", "status kept")
  assert(good.flow.passed[0] === "wait", "passed kept")

  for (const bad of [null, {}, { name: 42 }, { name: "" }]) {
    const s = registered.stateSchema.parse({ enabled: true, flow: bad })
    assert(s.flow === null, `malformed flow ${JSON.stringify(bad)} should be dropped`)
  }
})

t("view output passes viewSchema", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const v = registered.wire.viewSchema.parse(registered.wire.view(s))
  assert(v.enabled === true, "enabled")
  assert(v.flow === null, "no flow yet")
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

await t("the workspace description carries the flows and their steps", () => {
  // This is what the panel reads to render a flow's step list before any flow
  // has started. An enabled workspace with no flows here renders as an empty
  // panel with nothing explaining why.
  const ws = hostApis().getWorkspace("/tmp/dsh-decision-orchestrator-test-workspace")
  assert(ws.enabled === true, "workspace should be enabled")
  assert(Array.isArray(ws.flows) && ws.flows.length === 1, `expected one flow, got ${ws.flows?.length}`)
  const flow = ws.flows[0]
  assert(flow.name === "demo", `flow name lost: ${flow.name}`)
  assert(flow.steps.join(",") === "plan,wait", `flow steps lost: ${flow.steps}`)
  assert(ws.steps.plan.prompt === "p1", "step prompt lost")
  assert(ws.steps.wait.notifyText === "等你", "step notifyText lost")
})

await t("an unknown workspace reads as disabled rather than missing", () => {
  const ws = hostApis().getWorkspace("/nowhere")
  assert(ws.enabled === false, "should be disabled")
  assert(Array.isArray(ws.flows) && ws.flows.length === 0, "should carry no flows")
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
