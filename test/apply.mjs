/**
 * Simulate DSH's apply() call with a fake ctx shaped like the real API.
 * Goal: confirm apply() does not throw, before ever mounting it.
 */
// Point the run log at a temp directory *before* importing the host: the module
// reads the path when it loads, and this file calls apply() many times. Left
// alone, every test run appends to the real ~/.dsh/agent-pipeline/logs, which is
// how a test's `apply` ends up looking like a real load to anyone reading them.
process.env.AGENT_PIPELINE_LOG_DIR ??= (await import("node:os")).tmpdir() + "/agent-pipeline-test-logs"

const host = await import("../host.js")
const { Config, validate } = await import("../lib/config.js")

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
    // A list, like the patch layer writes and like the profile carries. A map
    // here would fail validation and every test would exercise the
    // feature-off path instead of the one it names.
    flows: [{ name: "demo", label: { en: "Demo", zh: "演示" }, steps: ["plan", "wait"] }],
  }],
}

let registered = null
/** Tools and commands the plugin registers; both are its agent- and user-facing entry points. */
const registeredTools = []
const registeredCommands = []
const registeredSections = []

/**
 * A fresh recording context.
 *
 * apply() registers one tool and one command per call, so a test that needs its
 * own pair gets its own context rather than reading whatever the last apply left
 * behind.
 */
function ctxWithRecording() {
  // Host writes flow state through `mutate`, which is a WeakMap in production;
  // recording it per session is what lets a test read back what a path wrote.
  const written = new WeakMap()
  const api = {}
  const ctx = {
    __stateOf(session) {
      return written.get(session) ?? {}
    },
    agents: { list: () => [] },
    sessions: { flush: async () => true },
    goals: { get: () => undefined },
    sessionProjections: {
      register(def) {
        // Keep the definition: the panel's view is produced through it, and a
        // schema that drops a field is invisible everywhere else.
        api.__projectionDef = def
        return {
          stateOf: (session) => written.get(session) ?? def.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0),
          dispose: async () => {},
        }
      },
    },
    tools: { register: (def) => { registeredTools.push(def); return () => {} } },
    systemPrompt: { section: (def) => { registeredSections.push(def); return () => {} } },
    get: (k) => {
      if (k === "commands") return { register: (def) => { registeredCommands.push(def); return () => {} } }
      return undefined
    },
    on: () => {},
    effect: () => {},
  }
  api.__projectionDef = undefined
  // Expose the captured definition through the object the tests already use.
  Object.defineProperty(ctx, "__projectionDef", { get: () => api.__projectionDef })
  return ctx
}

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
  tools: {
    register: (def) => { registeredTools.push(def); return () => {} },
  },
  get: (k) => {
    if (k === "tokenMeter") return { estimateMessage: () => 10 }
    if (k === "commands") {
      return { register: (def) => { registeredCommands.push(def); return () => {} } }
    }
    return undefined
  },
  on: () => {},
  effect: () => {},
}

let pass=0, fail=0
/**
 * Run one test, awaiting the body.
 *
 * The await matters: several bodies are async, and a synchronous runner counts
 * the pass as soon as the promise is created — an assertion inside that body
 * then fails into an unhandled rejection and the suite reports green.
 */
const t = async (n, f) => {
  try {
    await f()
    pass++
    console.log("  ✅ " + n)
  } catch (e) {
    fail++
    console.log("  ❌ " + n + " — " + e.message)
  }
}
const assert=(c,m)=>{if(!c)throw new Error(m)}

console.log("=== apply() simulation ===")
let apis
await t("apply does not throw", () => { apis = host.apply(ctx, config) })
/** What that one apply() registered, before any later test adds to the arrays. */
const FIRST_APPLY_TOOLS = registeredTools.length
const FIRST_APPLY_COMMANDS = registeredCommands.length
/** The read-only surface apply returns; used by the workspace tests below. */
const hostApis = () => apis
await t("projection registered", () => assert(registered, "not registered"))
await t("projection has every required field", () => {
  for (const k of ["key","stateVersion","stateSchema","init","apply","wire"]) assert(registered[k] !== undefined, `missing ${k}`)
  assert(registered.wire.viewSchema, "missing wire.viewSchema")
  assert(typeof registered.wire.view === "function", "missing wire.view")
})
await t("stateSchema parses the initial state", () => {
  const s = registered.stateSchema.parse(registered.init({ cwd: "/x" }, 0))
  assert(typeof s.enabled === "boolean", "enabled")
  assert(s.flow === null, "no flow before one starts")
})
await t("init marks the workspace enabled", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  assert(s.enabled === true, "enabled should be true")
})

await t("stateSchema keeps a recorded flow and drops a malformed one", () => {
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

await t("view output passes viewSchema", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const v = registered.wire.viewSchema.parse(registered.wire.view(s))
  assert(v.enabled === true, "enabled")
  assert(v.flow === null, "no flow yet")
})

await t("the view carries a running flow through to the client", () => {
  // The panel renders `view.flow`. Dropping it here leaves an empty dock with
  // nothing indicating why, and the flow would appear to have never started.
  const state = registered.stateSchema.parse({
    enabled: true,
    flow: { name: "demo", status: "active", startedAt: 100, since: 200, note: "n", branches: {}, passed: [] },
  })
  const v = registered.wire.viewSchema.parse(registered.wire.view(state))
  assert(v.flow !== null, "the flow must survive the view")
  assert(v.flow.name === "demo", `name lost: ${v.flow.name}`)
  assert(v.flow.status === "active", `status lost: ${v.flow.status}`)
})
await t("apply returns the same reference for non turn/end events", () => {
  const s = { failures: 0 }
  assert(registered.apply(s, { type: "user/message" }) === s, "should return the same reference")
})
await t("apply does not count on turn/end (guards against double counting)", () => {
  // iterations / failures are held by the main loop through mutate. If the
  // projection counted them too, one turn/end would be counted twice.
  const s = { failures: 0 }
  const n = registered.apply(s, { type: "turn/end", data: { reason: { kind: "error" } } })
  assert(n === s, "apply must return the identical reference")
  assert(n.failures === 0, "failures must not accumulate here")
})
await t("view excludes runtime-only fields", () => {
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

console.log("\n=== 4d. The plugin adopts the validated config, not the raw one ===")

await t("a config written with flows as a list still starts a flow", async () => {
  // The patch layer writes `flows` as a list; the runtime indexes it by name.
  // `validate` is the only thing that converts one to the other, so if apply
  // keeps the raw value every lookup misses and start_flow can never work —
  // which is what happened, because validation only logged.
  const raw = {
    model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest" },
    defaults: { contextBudgetRatio: 0.7, maxTurns: 3 },
    workspaces: [{
      path: "/tmp/dsh-decision-orchestrator-test-workspace",
      enabled: true,
      steps: [
        { id: "plan", do: "send", prompt: "p1" },
        { id: "wait", do: "stop", notifyText: "等你" },
      ],
      flows: [{ name: "demo", label: { en: "Demo", zh: "演示" }, steps: ["plan", "wait"] }],
    }],
  }
  const ctx2 = ctxWithRecording()
  const live = host.apply(ctx2, raw)
  const tool = registeredTools.at(-1)
  const session = {
    id: "list-flows",
    header: { cwd: "/tmp/dsh-decision-orchestrator-test-workspace" },
    deriveMessages: () => [],
  }
  const r = await tool.execute({ flow: "demo" }, { agent: { session } })
  assert(!r.isError, `start_flow must succeed, got ${JSON.stringify(r.content[0].text)}`)
  assert(r.content[0].text.includes("Started"), `got ${r.content[0].text}`)
  // And the panel can control it, which means the flow really is running.
  const c = registeredCommands.at(-1).handler({ agent: { session }, rawInput: "pause" })
  assert(c.kind === "success", `pause should succeed, got ${JSON.stringify(c)}`)
  void live
})

await t("an invalid config leaves the feature off instead of half-configured", () => {
  // A step id the flow references but never defines. Logging it and carrying on
  // would run until it reached the missing step.
  const raw = {
    workspaces: [{
      path: "/tmp/dsh-decision-orchestrator-test-workspace",
      enabled: true,
      steps: [{ id: "plan", do: "send", prompt: "p1" }],
      flows: [{ name: "bad", steps: ["plan", "missing"] }],
    }],
  }
  const before = registeredTools.length
  host.apply(ctxWithRecording(), raw)
  assert(registeredTools.length === before, "an invalid config must not register a flow tool")
})

console.log("\n=== 4e. Validation is idempotent across the two callers ===")

await t("a config passes both the Config schema and the apply-time check", async () => {
  // Cordis calls `Config["~standard"].validate` before `apply` and hands apply
  // its *output*. This function normalizes flows from a list to a map, so the
  // second call sees a map. Requiring a list every time made every load fail
  // once validation started being applied — the plugin went inert silently,
  // because a failed validation leaves the feature off.
  const listForm = {
    workspaces: [{
      path: "/tmp/dsh-decision-orchestrator-test-workspace",
      enabled: true,
      steps: [{ id: "a", do: "send", prompt: "p" }, { id: "s", do: "stop" }],
      flows: [{ name: "f", steps: ["a", "s"] }],
    }],
  }

  const first = validate(listForm)
  assert(!first.issues, `the list form must validate: ${first.issues?.[0]?.message}`)

  const viaSchema = Config["~standard"].validate(listForm)
  assert(!viaSchema.issues, `the schema must accept it: ${viaSchema.issues?.[0]?.message}`)
  assert(!Array.isArray(viaSchema.value.workspaces[0].flows), "the schema normalizes flows to a map")

  const second = validate(viaSchema.value)
  assert(!second.issues, `the normalized form must validate too, got: ${second.issues?.[0]?.message}`)

  const third = validate(second.value)
  assert(!third.issues, `validation must be idempotent, got: ${third.issues?.[0]?.message}`)
})

await t("a map-form config is accepted directly", () => {
  const r = validate({
    workspaces: [{
      path: "/w", enabled: true,
      steps: { a: { do: "send", prompt: "p" }, s: { do: "stop" } },
      flows: { f: { steps: ["a", "s"] } },
    }],
  })
  assert(!r.issues, `the map form must validate: ${r.issues?.[0]?.message}`)
})

await t("a flows value that is neither a list nor a map is still rejected", () => {
  const r = validate({ workspaces: [{ path: "/w", enabled: true, steps: {}, flows: "nope" }] })
  assert(r.issues?.some((i) => /flows must be a list or a map/.test(i.message)), "should reject a scalar")
})

await t("apply registers flows when handed the schema's own output", async () => {
  // The exact load path: Cordis validates with Config, then calls apply with
  // `result.value`. Testing validate() alone misses the failure that made the
  // plugin inert, because the rejection happened inside apply, after the schema
  // had already rewritten flows into the shape apply used to refuse.
  const raw = {
    workspaces: [{
      path: "/tmp/dsh-decision-orchestrator-test-workspace",
      enabled: true,
      steps: [{ id: "plan", do: "send", prompt: "p1" }, { id: "wait", do: "stop" }],
      flows: [{ name: "demo", steps: ["plan", "wait"] }],
    }],
  }
  const resolved = Config["~standard"].validate(raw)
  assert(!resolved.issues, `schema refused it: ${resolved.issues?.[0]?.message}`)

  const ctx2 = ctxWithRecording()
  const before = registeredTools.length
  host.apply(ctx2, resolved.value)
  const added = registeredTools.slice(before)
  assert(added.length === 1, `apply registered ${added.length} tools, expected 1`)
  assert(added[0].parameters.properties.flow.enum.join(",") === "demo",
    `flows lost: ${JSON.stringify(added[0].parameters.properties.flow.enum)}`)
})

console.log("\n=== 5. The two entry points the panel and the agent use ===")

await t("the plugin registers exactly one tool, start_flow", () => {
  assert(FIRST_APPLY_TOOLS === 1, `expected 1 tool from the first apply, got ${FIRST_APPLY_TOOLS}`)
  assert(registeredTools[0].name === "start_flow", `got ${registeredTools[0].name}`)
})

await t("start_flow offers every flow the workspace defines", () => {
  const enumValues = registeredTools[0].parameters.properties.flow.enum
  assert(enumValues.join(",") === "demo", `got ${enumValues.join(",")}`)
})

await t("start_flow refuses a flow it does not have", async () => {
  const r = await registeredTools[0].execute({ flow: "nope" }, { agent: { session: { id: "s1" } } })
  assert(r.isError === true, "an unknown flow must be an error")
  assert(/Unknown flow/.test(r.content[0].text), `got ${r.content[0].text}`)
})

await t("the plugin registers the flow command", () => {
  assert(FIRST_APPLY_COMMANDS === 1, `expected 1 command from the first apply, got ${FIRST_APPLY_COMMANDS}`)
  assert(registeredCommands[0].name === "flow", `got ${registeredCommands[0].name}`)
})

await t("the flow command rejects an argument it does not know", () => {
  // The command resolves the workspace first, so the agent has to carry one.
  const agent = {
    session: { id: "s1", header: { cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, deriveMessages: () => [] },
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    whenIdle: async () => {},
  }
  const r = registeredCommands[0].handler({ agent, rawInput: "explode" })
  assert(r.kind === "error", `expected an error, got ${r.kind}`)
  assert(/No flow named "explode"/.test(r.text), `got ${r.text}`)
})

await t("the flow command spells every past tense correctly", async () => {
  // "cancel" + "d" is "canceld"; the reply is user-visible, so a built suffix is
  // a typo waiting to happen. A flow has to be running, or the handler takes the
  // error path and never produces the success text.
  const cfg = {
    ...config,
    workspaces: config.workspaces.map((ws) => ({
      ...ws,
      steps: {
        plan: { id: "plan", do: "send", prompt: "p1" },
        wait: { id: "wait", do: "stop", notifyText: "等你" },
      },
      flows: [{ name: "demo", label: { en: "Demo", zh: "演示" }, steps: ["plan", "wait"] }],
    })),
  }
  for (const [action, said] of [["pause", "paused"], ["resume", "resumed"], ["cancel", "cancelled"]]) {
    const live = host.apply(ctxWithRecording(), cfg)
    // Start a flow through the same tool the agent uses.
    const tool = registeredTools.at(-1)
    const session = {
      id: `cmd-${action}`,
      header: { cwd: "/tmp/dsh-decision-orchestrator-test-workspace" },
      deriveMessages: () => [],
    }
    const r0 = await tool.execute({ flow: "demo" }, { agent: { session } })
    assert(r0.content[0].text.includes("Started"), `flow should start: ${r0.content[0].text}`)

    const command = registeredCommands.at(-1)
    const r = command.handler({ agent: { session }, rawInput: action })
    assert(r.kind === "success", `${action} should succeed, got ${JSON.stringify(r)}`)
    assert(r.text.includes(said), `${action} should say "${said}", got "${r.text}"`)
    void live
  }
})


console.log("\n=== 6. The /flow command ===")

/** Run one /flow input against a live agent on the test workspace. */
function runFlowCommand(input, agent, command = registeredCommands.at(-1)) {
  return command.handler({ agent, rawInput: input })
}

/** A live agent bound to the test workspace. */
function flowAgent(id = "cmd-agent") {
  return {
    session: {
      id,
      header: { cwd: "/tmp/dsh-decision-orchestrator-test-workspace" },
      deriveMessages: () => [],
    },
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    whenIdle: async () => {},
  }
}

await t("/flow with no argument reports the usage rather than a listing", () => {
  // The client intercepts a command that declares `input` before an empty
  // submission reaches the host, so a bare `/flow` cannot be a view. Reading the
  // rules is the workspace menu's job; this path must not pretend otherwise.
  host.apply(ctxWithRecording(), config)
  const r = runFlowCommand("", flowAgent("bare"))
  assert(r.kind === "error", `got ${r.kind}: ${r.text}`)
  assert(/Usage/.test(r.text), `should name the usage: ${r.text}`)
})

await t("/flow <name> starts that flow", () => {
  host.apply(ctxWithRecording(), config)
  const agent = flowAgent("start")
  const r = runFlowCommand("demo", agent)
  assert(r.kind === "success", `got ${r.kind}: ${r.text}`)
  assert(/Started/i.test(r.text), `got ${r.text.slice(0, 60)}`)
})

await t("starting a second flow while one runs is refused", () => {
  host.apply(ctxWithRecording(), config)
  const agent = flowAgent("double")
  runFlowCommand("demo", agent)
  const again = runFlowCommand("demo", agent)
  assert(again.kind === "error", `should refuse, got ${again.kind}`)
  assert(/already running/i.test(again.text), `got ${again.text}`)
})

await t("/flow pause, resume and cancel each work in turn", () => {
  host.apply(ctxWithRecording(), config)
  const agent = flowAgent("control")
  runFlowCommand("demo", agent)
  for (const [input, said] of [["pause", "paused"], ["resume", "resumed"], ["cancel", "cancelled"]]) {
    const r = runFlowCommand(input, agent)
    assert(r.kind === "success", `${input} failed: ${r.text}`)
    assert(r.text.includes(said), `${input} should say "${said}", got "${r.text}"`)
  }
})

await t("controlling with no flow running reports an error, not a crash", () => {
  host.apply(ctxWithRecording(), config)
  const r = runFlowCommand("pause", flowAgent("no-flow-yet"))
  // flowControl returns true whenever the workspace resolves, even with nothing
  // to act on, so this asserts the reported text rather than the status alone.
  assert(/No running flow/i.test(r.text) || r.kind === "error",
    `should say there is nothing to control, got ${r.kind}: ${r.text}`)
})

await t("an unknown argument names the flows that do exist", () => {
  host.apply(ctxWithRecording(), config)
  const r = runFlowCommand("nope", flowAgent("unknown"))
  assert(r.kind === "error", `got ${r.kind}`)
  assert(/No flow named "nope"/.test(r.text), `got ${r.text}`)
  assert(/demo/.test(r.text), `should list the real flows: ${r.text}`)
})

await t("the command refuses to run in a workspace the plugin is not in", () => {
  host.apply(ctxWithRecording(), config)
  const agent = flowAgent("elsewhere")
  agent.session.header.cwd = "/tmp/some-other-workspace"
  const r = runFlowCommand("", agent)
  assert(r.kind === "error", `got ${r.kind}`)
})

console.log("\n=== 7. Both entry points start the same flow ===")

await t("both entry points accept the same flow names", async () => {
  // user-actions.md asks for one operation with two callers. The states those
  // callers write live in the host's own WeakMap, which a test cannot reach, so
  // what is asserted here is the contract that binds them: a name the tool
  // offers is a name the command accepts, and a name it rejects is rejected by
  // both. Divergence in the common case would show up as one route refusing a
  // flow the other starts.
  const ctxA = ctxWithRecording()
  host.apply(ctxA, config)
  const offered = registeredTools.at(-1).parameters.properties.flow.enum

  const agent = {
    session: { id: "both", header: { cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, deriveMessages: () => [] },
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    whenIdle: async () => {},
  }

  for (const name of offered) {
    const r = await registeredTools.at(-1).execute({ flow: name }, { agent })
    assert(!r.isError, `the tool refused ${name}: ${r.content[0].text}`)
    // Reset between names so "already running" does not mask a real refusal.
    runFlowCommand("cancel", agent)
  }

  const bogus = await registeredTools.at(-1).execute({ flow: "not-a-flow" }, { agent })
  assert(bogus.isError === true, "the tool should refuse an unknown flow")
  const bogusCmd = runFlowCommand("not-a-flow", agent)
  assert(bogusCmd.kind === "error", "the command should refuse an unknown flow")
})

console.log("\n=== the view the panel reads ===")

await t("the view carries the flow definition", () => {
  // The workspace menu opens a read-only panel from this value. Without it the
  // panel has nothing to show; a shape that differs from viewSchema is dropped
  // silently and the panel renders empty with no reason.
  host.apply(ctxWithRecording(), config)
  const ws = hostApis().getWorkspace("/tmp/dsh-decision-orchestrator-test-workspace")
  assert(ws.enabled === true, "workspace should be enabled")
  assert(ws.flows.length === 1, `flows=${ws.flows.length}`)
  assert(ws.steps.plan, "steps missing")
})

await t("viewSchema accepts the definition, so a session still loads", () => {
  // The projection's view is parsed on every read. A field the schema does not
  // pass through is dropped; a schema that throws makes the session unreadable.
  const mod = host
  assert(typeof mod.apply === "function", "apply missing")
  const spy = ctxWithRecording()
  host.apply(spy, config)
  const def = spy.__projectionDef
  assert(def, "projection definition captured")
  const state = def.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  assert(state.definition, `definition missing from init: ${JSON.stringify(state)}`)
  const view = def.wire.view(state)
  const parsed = def.wire.viewSchema.parse(view)
  assert(parsed.definition, "viewSchema dropped the definition")
  assert(parsed.definition.flows.demo, "the flow is missing from the parsed view")
  assert(parsed.definition.steps.plan, "the step is missing from the parsed view")
})

await t("the projection stateVersion was bumped for the new field", () => {
  const spy = ctxWithRecording()
  host.apply(spy, config)
  assert(spy.__projectionDef.stateVersion === 5, `stateVersion=${spy.__projectionDef.stateVersion}`)
})

await t("a workspace that is off carries no definition", () => {
  const spy = ctxWithRecording()
  host.apply(spy, { workspaces: [{ path: "/tmp/elsewhere", enabled: false, steps: {}, flows: [] }] })
  const def = spy.__projectionDef
  const state = def.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  assert(state.enabled === false, "should be off")
  assert(state.definition === null, `definition=${JSON.stringify(state.definition)}`)
})

await t("/flow no longer claims to show anything", () => {
  host.apply(ctxWithRecording(), config)
  const cmd = registeredCommands.at(-1)
  assert(/Run or control/.test(cmd.description), `description=${cmd.description}`)
  assert(!/Show/.test(cmd.description), `description still mentions Show: ${cmd.description}`)
})

await t("an empty /flow argument reports the usage instead of a listing", () => {
  // The client intercepts an `input` command before an empty submission, so this
  // path is only reachable programmatically — it must not pretend to be a view.
  host.apply(ctxWithRecording(), config)
  const agent = {
    session: { id: "empty", header: { cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, deriveMessages: () => [] },
    inbox: { nextTurn: [], nextStep: [] },
    followup() {},
    whenIdle: async () => {},
  }
  const r = registeredCommands.at(-1).handler({ agent, rawInput: "" })
  assert(r.kind === "error", `kind=${r.kind}`)
  assert(/Usage/.test(r.text), `should name the usage, got: ${r.text}`)
  assert(!/demo/.test(r.text.split("\n")[0]), "should not list the flows as a heading")
})

console.log("\n=== the agent is told the pipelines exist ===")

await t("apply tells the agent which flows it can start", () => {
  // Registering start_flow is not enough on its own: nothing makes a model go
  // looking for a tool it has never heard of. Without this section the flow
  // engine loads, registers, and then never runs — which is what happened.
  const before = registeredSections.length
  host.apply(ctxWithRecording(), config)
  const added = registeredSections.slice(before)
  assert(added.length === 1, `sections added: ${added.length}`)
  const section = added[0]
  assert(section.name === "agent-pipeline", `name=${section.name}`)
  // The host rejects a section without a finite order. A loose test stub would
  // accept it and the failure would only show up in a live install.
  assert(Number.isFinite(section.order), `order must be a finite number, got ${JSON.stringify(section.order)}`)
  assert(section.text.includes("start_flow"), "the prompt must name the tool")
  assert(section.text.includes("demo"), "the prompt must name the flows available here")
  // The section is static and reaches every workspace, so it has to say which
  // one the pipelines belong to; otherwise an agent elsewhere calls a tool that
  // refuses.
  assert(section.text.includes("/tmp/dsh-decision-orchestrator-test-workspace"),
    `the prompt must name the workspace: ${section.text}`)
})

await t("the prompt states when not to start one", () => {
  // A prompt that only lists the flows invites a flow on every message.
  const before = registeredSections.length
  host.apply(ctxWithRecording(), config)
  const section = registeredSections.slice(before)[0]
  assert(/Do not start one/i.test(section.text), `no boundary stated: ${section.text}`)
})

await t("a workspace with no flows gets no prompt", () => {
  // An agent told about pipelines it cannot start would call a tool that always
  // fails.
  const before = registeredSections.length
  host.apply(ctxWithRecording(), {
    workspaces: [{ path: "/tmp/dsh-decision-orchestrator-test-workspace", enabled: false, steps: {}, flows: [] }],
  })
  assert(registeredSections.length === before, "no section should be added")
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail?1:0)
