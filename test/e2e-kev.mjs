/**
 * End-to-end: the real model driving the full main loop, against the flows a
 * real workspace configures.
 *
 * Two things are asserted, and they fail for different reasons:
 *
 *   the pipeline   given a conversation and a flow position, does the loop do
 *                  the next thing the flow says? A send is deterministic, so a
 *                  failure here is a state-machine bug.
 *
 *   the branch     given a conversation sitting on a fork, does the model pick
 *                  the right way? A failure here means the question or its
 *                  criteria need work.
 *
 * The branch cases are the ones worth watching, because they are the only place
 * a model is consulted.
 */

// Route this run's logs to a temp dir so no invocation ever pollutes real logs.
process.env.AGENT_PIPELINE_LOG_DIR ??=
  new URL(`file://${(await import("node:os")).tmpdir()}/agent-pipeline-test-logs`).pathname

const { readFileSync } = await import("node:fs")
const { join } = await import("node:path")

const { handleTurnEnd, beginFlow } = await import("../lib/core.js")
const { validate, effectiveConfig } = await import("../lib/config.js")

const ROOT = new URL("..", import.meta.url).pathname

const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/**
 * Read the fixture through the same validator the plugin uses at load.
 *
 * No hand-written parser: one that disagrees with the real validator would test
 * a configuration nobody runs, which is the drift this file exists to catch.
 * The fixture is a fragment of cordis.patch.yml indented under `config:`.
 */
function loadFixture() {
  // A minimal YAML reader for this file's shape: the project has no
  // dependencies, and the fixture is nested maps, lists and scalars only.
  const source = readFileSync(join(ROOT, "fixtures/brandu.yml"), "utf8")
  const parsed = parseYamlFragment(source)
  const r = validate({ model: { baseUrl: "http://127.0.0.1:8080" }, workspaces: parsed.workspaces })
  assert(!r.issues, `fixture does not validate: ${r.issues?.map((i) => i.message).join("; ")}`)
  return { config: r.value, workspace: r.value.workspaces[0] }
}

/**
 * Parse the fixture's narrow YAML subset.
 *
 * Supports nested maps, `- key: value` list items, and block sequences written
 * inline as `[a, b]`. Anything else would be a shape this file does not use.
 */
function parseYamlFragment(text) {
  const lines = []
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() })
  }
  let i = 0
  const unsquote = (v) => {
    const t = v.trim()
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      // Inline flow collections: { en: X, zh: Y } and [a, b].
      const inner = t.slice(1, -1).trim()
      if (!inner) return t.startsWith("[") ? [] : {}
      if (t.startsWith("[")) return inner.split(",").map((x) => unsquote(x))
      const out = {}
      for (const pair of inner.split(/,\s*(?=\w+:)/)) {
        const at = pair.indexOf(":")
        out[pair.slice(0, at).trim()] = unsquote(pair.slice(at + 1))
      }
      return out
    }
    // Scalars: booleans and numbers, so `enabled: true` is not the string
    // "true" — a validator that checks `=== true` would reject it.
    if (t === "true") return true
    if (t === "false") return false
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return t
  }
  const block = (indent) => {
    const out = lines[i] && lines[i].text.startsWith("- ") ? [] : {}
    while (i < lines.length) {
      const { indent: ind, text: t } = lines[i]
      if (ind < indent) break
      if (ind > indent) break
      if (t.startsWith("- ")) {
        if (!Array.isArray(out)) break
        i++
        const rest = t.slice(2)
        // `- id: x` opens a map whose remaining keys are indented deeper.
        if (/^\w[\w-]*:/.test(rest)) {
          const item = {}
          i-- // rewind so the generic map reader sees the first key
          lines[i] = { indent: ind + 2, text: rest }
          Object.assign(item, block(ind + 2))
          out.push(item)
        } else {
          out.push(unsquote(rest))
        }
        continue
      }
      if (Array.isArray(out)) break
      const at = t.indexOf(":")
      const key = t.slice(0, at).trim()
      const tail = t.slice(at + 1).trim()
      i++
      if (tail) {
        out[key] = unsquote(tail)
      } else {
        const childIndent = lines[i]?.indent ?? ind + 2
        out[key] = block(childIndent)
      }
    }
    return out
  }
  const first = lines[0]?.indent ?? 0
  return block(first)
}

const { config: fixtureConfig, workspace } = loadFixture()
const WS = workspace.path

/** A message the plugin sent earlier, with the text it actually sends. */
const PLUGIN = (stepId) => {
  const step = workspace.steps[stepId]
  if (!step) throw new Error(`PLUGIN(${stepId}): no such step`)
  return {
    role: "user",
    source: { kind: "decision", ruleId: stepId },
    content: [{ type: "text", text: step.prompt }],
    time: Date.now() - 30000,
  }
}

/** A message from the user. */
const HUMAN = (text, ageMs = 200000) => ({
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
  time: Date.now() - ageMs,
})

/** A message from the agent. */
const AGENT = (text) => ({
  role: "assistant",
  source: { kind: "model" },
  content: [{ type: "text", text }],
  time: Date.now() - 5000,
})

function mkSession(messages) {
  return { id: "session-e2e", header: { cwd: WS }, deriveMessages: () => messages }
}

function mkAgent(session) {
  const sent = []
  return {
    sent,
    session,
    inbox: { nextTurn: [], nextStep: [] },
    followup(msg) { sent.push(msg) },
    whenIdle: async () => {},
  }
}

function mkCtx() {
  return { sessions: { flush: async () => true }, get: () => undefined }
}

/** Turn arbitration off so the pipeline itself is what is being measured. */
function fastConfig() {
  return {
    ...fixtureConfig,
    defaults: { ...fixtureConfig.defaults, humanCooldownMs: 0, quietWindowMs: 0, maxIterations: 100 },
  }
}

console.log("=== 0. The fixture is the configuration that ships ===")

/**
 * The fixture is only authoritative if the deployed profile agrees with it.
 * When one is edited without the other, every assertion below passes against a
 * configuration nobody deploys.
 */
/**
 * Read one scalar field out of a YAML block, joining folded continuation lines.
 *
 * A block scalar may be wrapped across several indented lines; the value is the
 * join of them. Stopping at the first line would compare a truncated string.
 */
function yamlScalar(block, field) {
  const lines = block.split("\n")
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s*${field}:`).test(l))
  if (startIdx < 0) return ""
  const first = lines[startIdx].replace(new RegExp(`^\\s*${field}:\\s*`), "")
  const parts = [first]
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    // A new `key:` at the same or lower indent ends the value.
    if (/^\s*[a-zA-Z]+:/.test(l) || l.trim() === "") break
    parts.push(l.trim())
  }
  return parts.join(" ").trim()
}

function checkProfileMatches() {
  const home = process.env.HOME
  if (!home) return "HOME is unset; skipped"
  let profileText
  try {
    profileText = readFileSync(join(home, ".dsh/profiles/desktop/cordis.patch.yml"), "utf8")
  } catch {
    return "no profile; skipped"
  }
  const at = profileText.indexOf("- id: agent-pipeline")
  if (at < 0) return "plugin not in profile; skipped"
  const chunk = profileText.slice(at)
  const wsAt = chunk.indexOf("workspaces:")
  if (wsAt < 0) return "no workspaces in profile; skipped"
  // The workspace block sits at 8 spaces under `config:`. Anything at 4 or less
  // that is not blank starts the next plugin entry — `- id: forge` and the like
  // — so that is where the block ends.
  const body = []
  for (const line of chunk.slice(wsAt).split("\n")) {
    if (body.length > 0 && line.trim()) {
      const indent = line.length - line.trimStart().length
      if (indent <= 4) break
    }
    body.push(line)
  }
  const text = body.join("\n")

  // Compare the shapes the runtime actually reads, not the text: the profile is
  // indented under `config:` and carries keys the fixture does not, so a
  // text-level compare reports a mismatch on files describing the same thing.
  const problems = []

  // Steps: `- id:` items, each compared on every prose field and its options.
  const blocks = text.split(/^\s*- id:\s*/m).slice(1)
  const byId = new Map()
  for (const block of blocks) {
    // A flow entry uses `- name:` so it never lands here.
    const id = block.split("\n")[0].trim()
    if (!id) continue
    byId.set(id, block)
  }
  for (const [id, step] of Object.entries(workspace.steps)) {
    const block = byId.get(id)
    if (!block) { problems.push(`step ${id} is missing from the profile`); continue }
    for (const field of ["do", "prompt", "notifyText", "expect", "question"]) {
      const found = yamlScalar(block, field)
      if ((step[field] ?? "") !== found) problems.push(`step ${id}.${field} differs`)
    }
    if (step.do === "branch") {
      const opts = optionsOf(block)
      if (JSON.stringify(step.options ?? {}) !== JSON.stringify(opts)) {
        problems.push(`step ${id}.options differs`)
      }
    }
  }
  for (const id of byId.keys()) {
    if (!(id in workspace.steps)) problems.push(`step ${id} is in the profile but not the fixture`)
  }

  // Flows: name and step order.
  const flowBlocks = text.split(/^\s*- name:\s*/m).slice(1)
  const deployed = new Map()
  for (const block of flowBlocks) {
    const name = block.split("\n")[0].trim()
    const list = /^\s*steps:\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? ""
    deployed.set(name, list.split(",").map((x) => x.trim()).filter(Boolean))
  }
  for (const [name, flow] of Object.entries(workspace.flows)) {
    const steps = deployed.get(name)
    if (!steps) { problems.push(`flow ${name} is missing from the profile`); continue }
    if (flow.steps.join(",") !== steps.join(",")) problems.push(`flow ${name}.steps differs`)
  }
  for (const name of deployed.keys()) {
    if (!(name in workspace.flows)) problems.push(`flow ${name} is in the profile but not the fixture`)
  }

  return problems.length ? problems.join("; ") : ""
}

/** Read a branch's `options:` map out of one step block. */
function optionsOf(block) {
  const lines = block.split("\n")
  const at = lines.findIndex((l) => /^\s*options:\s*$/.test(l))
  if (at < 0) return {}
  const indent = lines[at].length - lines[at].trimStart().length
  const out = {}
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const deeper = line.length - line.trimStart().length
    if (deeper <= indent) break
    const m = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

{
  const problem = checkProfileMatches()
  if (problem) {
    console.log(`  ${problem.startsWith("skipped") || problem.includes("skipped") ? "⚠️ " : "❌"} ${problem}`)
    if (!problem.includes("skipped")) process.exitCode = 1
  } else {
    console.log("  ✅ the deployed profile matches the fixture")
  }
}

console.log("\n=== 1. The pipeline advances without the model ===")

/**
 * Walk a flow from the start, feeding back each message the plugin sends, and
 * record the sequence of steps it fired.
 *
 * @param {string} flowName
 * @param {Array} opening messages before the flow starts
 * @param {object} opts
 * @param {number} [opts.turns] how many turn-ends to simulate
 * @param {(turn: object, state: object) => void} [opts.onHalt] hook after a halt
 */
async function walk(flowName, opening, { turns = 6, onHalt, settled = true } = {}) {
  let state = {}
  const mutate = (next) => { state = next }
  // Share the array with the caller so onHalt can append to it.
  const messages = opening
  const fired = []
  beginFlow({ flowName, cfg: effectiveConfig(fastConfig(), WS), rt: state, mutate })
  const agent = mkAgent(mkSession(messages))
  for (let n = 0; n < turns; n++) {
    messages.push(AGENT("我处理完了。"))
    const r = await handleTurnEnd({
      ctx: mkCtx(),
      agent,
      session: mkSession(messages),
      turnEnd: { turn: n + 1, reason: { kind: "completed" } },
      config: fastConfig(),
      state,
      mutate,
      queue: { run: (fn) => fn() },
    })
    if (r.action === "send") {
      fired.push(r.ruleId)
      messages.push(PLUGIN(r.ruleId))
    } else {
      onHalt?.(r, state)
      if (r.action !== "halt" && r.action !== "branch") break
      if (r.action === "branch") console.log(`      branch → ${r.target}`)
    }
  }
  return { fired, state, messages }
}

let ok = 0
let total = 0
const check = (label, cond, detail) => {
  total++
  if (cond) { ok++; console.log(`  ✅ ${label}`) } else { console.log(`  ❌ ${label} — ${detail}`) }
}

{
  const { fired } = await walk("requirement", [HUMAN("评估如下需求，仅评估不要动仓库：加导出")], { turns: 3 })
  check("the requirement flow opens with review then summarize",
    fired.join(",") === "review,summarize", `got ${fired.join(",")}`)
}

{
  const { fired } = await walk("bug", [HUMAN("报告bug，你彻底排查根因，不要动仓库：按钮位置不对")], { turns: 4 })
  check("the bug flow opens with the root-cause question",
    fired.join(",") === "bug_root,review,summarize", `got ${fired.join(",")}`)
}

{
  const { fired } = await walk("conflict", [HUMAN("同步到最新 head")], { turns: 4 })
  check("the conflict flow opens with the conflict question",
    fired.join(",") === "conflict,review,summarize", `got ${fired.join(",")}`)
}

{
  // confirm is a stop: the flow must hold there and send nothing after it.
  const { fired } = await walk("requirement", [HUMAN("评估需求")], { turns: 6 })
  check("the flow holds at confirm instead of running on",
    fired.join(",") === "review,summarize", `got ${fired.join(",")}`)
}

{
  // The single turn that reaches the stop must record it, not run past it.
  // Three sends bring the flow to confirm: review, summarize, then the stop.
  const { fired, state } = await walk(
    "requirement",
    [HUMAN("评估需求"), PLUGIN("review"), AGENT("方案如下。"), PLUGIN("summarize"), AGENT("1. 改 a.ts")],
    { turns: 1 },
  )
  check("the turn that reaches the stop pauses there", state.awaitingRuleId === "confirm",
    `awaiting=${state.awaitingRuleId}, fired=${fired.join(",")}`)
}

{
  // The user says something that is not the phrase: still held.
  const { fired } = await walk("requirement", [
    HUMAN("评估需求"),
    PLUGIN("review"),
    AGENT("方案如下。"),
    PLUGIN("summarize"),
    AGENT("1. 改 a.ts"),
    HUMAN("待定事项按你认为合理的来"),
  ], { turns: 2 })
  check("a reply that is not the go phrase keeps the flow parked",
    fired.join(",") === "", `got ${fired.join(",")}`)
}

{
  // The phrase has to be written after the flow reaches the wait step — an
  // earlier "go" belonged to a previous task and must not satisfy this one.
  // walk() feeds messages back with fresh timestamps, so the hook below adds
  // the phrase at the moment the flow pauses on it.
  const opening = [
    HUMAN("评估需求", 400000),
    PLUGIN("review"),
    AGENT("方案如下。"),
    PLUGIN("summarize"),
    AGENT("1. 改 a.ts"),
    HUMAN("待定事项按你认为合理的来"),
  ]
  let saidGo = false
  const { fired } = await walk("requirement", opening, {
    turns: 4,
    onHalt: (r) => {
      if (r.ruleId === "start_work" && !saidGo) {
        saidGo = true
        opening.push(HUMAN("开干。注释按 agents.md 的规范来", 0))
      }
    },
  })
  check("saying the go phrase resumes the flow", fired.includes("selfcheck_1"), `got ${fired.join(",")}`)
}

console.log("\n=== 2. The branch decides direction ===")

/**
 * Put a flow on its branch and ask the model which way to go.
 *
 * @param {string} flowName
 * @param {Array} opening messages that lead up to the branch
 * @param {string} reply the agent's answer to the second self-check
 */
async function atBranch(flowName, opening, reply) {
  const flow = workspace.flows[flowName]
  const branchAt = flow.steps.indexOf("selfcheck_branch")
  const sent = flow.steps.slice(0, branchAt).filter((id) => workspace.steps[id].do === "send")
  const passed = flow.steps.slice(0, branchAt).filter((id) => {
    const kind = workspace.steps[id].do
    return kind === "stop" || kind === "wait-user"
  })
  const messages = [...opening, ...sent.map((id) => PLUGIN(id)), AGENT(reply)]
  const state = {
    flow: { name: flowName, status: "active", startedAt: Date.now() - 100000, since: 0, branches: {}, passed, note: "" },
  }
  const agent = mkAgent(mkSession(messages))
  const r = await handleTurnEnd({
    ctx: mkCtx(),
    agent,
    session: mkSession(messages),
    turnEnd: { turn: 1, reason: { kind: "completed" } },
    config: fastConfig(),
    state,
    mutate: () => {},
    queue: { run: (fn) => fn() },
  })
  return r
}

const BRANCH_CASES = [
  {
    label: "clean self-check → push",
    reply: "TS + lint + build 全部 0 error 0 warning。没有越界改动，注释和文档符合核范。没有遗留问题。",
    want: "push",
  },
  {
    label: "problems remain → another round",
    reply: "发现 3 处问题：a.ts 有个未处理的分支，b.ts 的类型是 any，还有两处注释没按核范写。我会继续修。",
    want: "selfcheck_3",
  },
  {
    label: "problems fixed this round but more remain → another round",
    reply: "这一轮修了 2 处，但还剩 1 处没处理完：c.ts 的边界情况我还没想清楚。",
    want: "selfcheck_3",
  },
]

for (const c of BRANCH_CASES) {
  const r = await atBranch("requirement", [HUMAN("评估需求")], c.reply)
  const got = r.target ?? r.skipped ?? r.action ?? "-"
  const hit = got === c.want
  if (hit) ok++
  total++
  const conf = typeof r.confidence === "number" ? `${(r.confidence * 100).toFixed(0)}%` : "-"
  console.log(`  ${hit ? "✅" : "❌"} ${c.label.padEnd(44)} want=${c.want.padEnd(13)} got=${String(got).padEnd(13)} ${conf}`)
}

console.log("\n=== 3. The flow is a stop, not a loop ===")

{
  // Every flow must come to rest: a send that keeps firing would be a cursor
  // bug that only shows up after many turns.
  const { fired } = await walk("requirement", [HUMAN("评估需求")], { turns: 12 })
  const dup = fired.filter((id, i) => fired.indexOf(id) !== i)
  check("no step fires twice within one flow", dup.length === 0, `repeats: ${dup.join(",")}`)
  check("the walk comes to rest instead of looping", fired.length <= 10, `fired ${fired.length} steps: ${fired.join(",")}`)
}

console.log(`\n=== ${ok}/${total} ===`)
process.exit(ok === total && !process.exitCode ? 0 : 1)
