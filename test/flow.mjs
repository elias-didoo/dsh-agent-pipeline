/**
 * Integration tests: run the whole handleTurnEnd flow against a fake
 * ctx/agent/session.
 *
 * Goal: exercise every branch of the main loop without mounting DSH.
 * The fakes follow the real API shapes closely (established by probe runs).
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

// Route this run's logs to a temp dir so no invocation ever pollutes real logs.
process.env.DECISION_ORCHESTRATOR_LOG_DIR ??=
  new URL(`file://${(await import("node:os")).tmpdir()}/decision-orchestrator-test-logs`).pathname

const { handleTurnEnd } = await import("../lib/core.js")

// ── Test fixtures ──
const WS = "/tmp/dsh-decision-orchestrator-test-workspace"

function makeConfig(overrides = {}) {
  return {
    model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 5000 },
    defaults: {
      maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.15,
      humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3,
      ...overrides,
    },
    workspaces: [{
      path: WS,
      enabled: true,
      decisions: [
        { id: "selfcheck_1", when: "用户刚说开干，agent 已改完代码，插件还没发过自检要求", do: "send", prompt: "请继续。", notifyText: "" },
        { id: "selfcheck_2", when: "插件发过第一轮自检，agent 已回复检查结果", do: "send", prompt: "继续第二轮。", notifyText: "" },
        { id: "needs_user_input", when: "agent 在正文里直接向用户提问、请求批准或索要信息", do: "stop", prompt: "", notifyText: "需要你拍板" },
        { id: "finished", when: "agent 已推送完成，或明确宣告需求全部结束", do: "stop", prompt: "", notifyText: "已完成" },
      ],
    }],
  }
}

function makeSession({ cwd = WS, messages = [] } = {}) {
  return {
    id: "session-test-0001",
    header: { cwd },
    deriveMessages: () => messages,
  }
}

function makeAgent({ goal = undefined, inbox = [] } = {}) {
  const sent = []
  const session = makeSession()
  return {
    sent,
    session,
    inbox: { nextTurn: inbox, nextStep: [] },
    followup(msg) { sent.push(msg) },
    whenIdle: async () => {},
    _goal: goal,
  }
}

function makeCtx({ goal, flushOk = true } = {}) {
  return {
    sessions: { flush: async () => flushOk },
    goals: { get: () => goal },
    get(key) {
      if (key === "tokenMeter") return { estimateMessage: () => 20 }
      return undefined
    },
  }
}

function makeQueue() {
  return { run: (fn) => fn() }
}

function baseMessages(text = "我在继续做，接下来写 API 部分。") {
  const now = Date.now()
  return [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我改项目" }], time: now - 300000 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text }], time: now - 10000 },
  ]
}

const turnEnd = (kind = "completed") => ({
  turn: 1,
  reason: kind === "error" ? { kind: "error", error: { code: "TRANSPORT" } } : { kind },
})

console.log("=== 1. Workspaces that are not enabled ===")
await t("workspace not in config → not-enabled", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ cwd: "/tmp/other" }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "not-enabled", `actual: ${JSON.stringify(r)}`)
})

await t("workspace with enabled:false → not-enabled", async () => {
  const cfg = makeConfig()
  cfg.workspaces[0].enabled = false
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent: makeAgent(), session: makeSession(),
    turnEnd: turnEnd(), config: cfg, state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "not-enabled", `actual: ${JSON.stringify(r)}`)
})

console.log("\n=== 2. Interrupt-style reasons ===")
for (const kind of ["aborted", "interrupted"]) {
  await t(`${kind} → skipped`, async () => {
    const agent = makeAgent()
    const r = await handleTurnEnd({
      ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
      turnEnd: turnEnd(kind), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
    })
    assert(r.skipped === kind, `actual: ${JSON.stringify(r)}`)
    assert(agent.sent.length === 0, "must not send")
  })
}

console.log("\n=== 3. Arbitration blocks ===")
await t("goal active+armed → silent", async () => {
  const agent = makeAgent({ goal: { phase: "active", activation: "armed" } })
  const r = await handleTurnEnd({
    ctx: makeCtx({ goal: { phase: "active", activation: "armed" } }), agent,
    session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "goal-active", `actual: ${JSON.stringify(r)}`)
  assert(agent.sent.length === 0, "must not send")
})

await t("human spoke recently → cooling down", async () => {
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你继续" }], time: Date.now() - 1000 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "好的" }], time: Date.now() },
  ]
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: msgs }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "human-cooldown", `actual: ${JSON.stringify(r)}`)
})

await t("a human message is queued in the inbox → wait", async () => {
  const agent = makeAgent({ inbox: [{ role: "user", source: { kind: "user" }, content: [] }] })
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "human-waiting", `actual: ${JSON.stringify(r)}`)
})

await t("another agent just relayed → yield", async () => {
  const now = Date.now()
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我改项目" }], time: now - 300000 },
    { role: "user", source: { kind: "agent-message", senderSessionId: "other" }, content: [{ type: "text", text: "子 agent 完成" }], time: now - 5000 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "已汇总子 agent 结果" }], time: now - 3000 },
  ]
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent: makeAgent(), session: makeSession({ messages: msgs }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "agent-message", `actual: ${JSON.stringify(r)}`)
})

console.log("\n=== 3b. pending schedule → yield ===")
await t("a schedule targets this session → schedule-pending", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx()
  ctx.schedule = {
    list: async () => ({ items: [{ pendingDelivery: { targetSessionId: session.id } }] }),
  }
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "schedule-pending", `actual: ${JSON.stringify(r)}`)
  assert(agent.sent.length === 0, "must not send")
})

await t("a schedule targeting another session → pass through", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx()
  ctx.schedule = {
    list: async () => ({ items: [{ pendingDelivery: { targetSessionId: "other-session" } }] }),
  }
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped !== "schedule-pending", `should not be blocked by schedule: ${JSON.stringify(r)}`)
})

await t("active but not yet due → not silenced (a next-week run must not block forever)", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx()
  ctx.schedule = {
    list: async () => ({ items: [{ status: "active", involvedSessionIds: [session.id] }] }),
  }
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped !== "schedule-pending", `should not be silenced: ${JSON.stringify(r)}`)
})

await t("schedule.list throws → treated as none, never blocks", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx()
  ctx.schedule = { list: async () => { throw new Error("boom") } }
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped !== "schedule-pending", `an exception must not block: ${JSON.stringify(r)}`)
})

await t("no schedule service → never blocks", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx() // no schedule service
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped !== "schedule-pending", `actual: ${JSON.stringify(r)}`)
})

console.log("\n=== 4. Stopped sessions ===")
await t("stoppedReason set → no further action", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { stoppedReason: "failure-limit:3" }, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped?.includes("stopped"), `actual: ${JSON.stringify(r)}`)
})

console.log("\n=== 4b. Paused, waiting for the user ===")
await t("paused and the user has not spoken → stays quiet", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { awaitingRuleId: "needs_user_input" }, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "awaiting-user", `actual: ${JSON.stringify(r)}`)
})

await t("an already-paused session stays paused", async () => {
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { awaitingRuleId: "uncertain" }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.skipped === "awaiting-user", `actual: ${JSON.stringify(r)}`)
  // A held-back turn must not rewrite state, or it would churn the projection.
  assert(mutated === null, `state should not change on a skipped turn, got ${JSON.stringify(mutated)}`)
})

await t("paused but the user has spoken → unpause and continue", async () => {
  const agent = makeAgent()
  let mutated = null
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "我来处理" }], time: Date.now() - 60000 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "好的" }], time: Date.now() - 5000 },
  ]
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: msgs }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { awaitingRuleId: "needs_user_input" }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  // After unpausing, judging continues. Which decision point the model lands on
  // depends on how it reads a vague reply, so the assertion is on the invariant
  // rather than on a particular id: a send must never carry a pause, and any
  // pause that is set must name a real decision point or the uncertain marker.
  assert(r.skipped !== "awaiting-user", `should have unpaused: ${JSON.stringify(r)}`)
  if (r.action === "send") {
    assert(!mutated?.awaitingRuleId, `a send must not pause: ${JSON.stringify(mutated)}`)
  } else {
    assert(
      mutated?.awaitingRuleId === "needs_user_input"
        || mutated?.awaitingRuleId === "finished"
        || mutated?.awaitingRuleId === "uncertain",
      `should pause at a known point, got ${JSON.stringify(mutated)}`,
    )
  }
})

await t("an action=stop rule → no message, only the paused state", async () => {
  const agent = makeAgent()
  let mutated = null
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "有两种方案，你选哪个？" }], time: Date.now() - 60000 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "改动点已汇总。请确认用 A 还是 B？" }], time: Date.now() - 5000 },
  ]
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: msgs }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  // When an action=stop rule fires the return value is `halt` — the config enum
  // `stop` and the runtime outcome `halt` are two different layers.
  if (r.action === "halt" && r.ruleId === "needs_user_input") {
    assert(agent.sent.length === 0, `stop must not send, but ${agent.sent.length} message(s) went out`)
    assert(mutated?.awaitingRuleId === "needs_user_input", "should enter the paused state")
  } else {
    // The model landing on another decision point is legitimate; still at most one send.
    assert(agent.sent.length <= 1, "at most one message")
  }
})

console.log("\n=== 5. Iteration limit reached ===")
await t("iterations hit the cap → stop", async () => {
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { iterations: 20 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `actual: ${JSON.stringify(r)}`)
  assert(mutated?.stoppedReason?.includes("iteration-limit"), "should record a stop reason")
})

console.log("\n=== 5c. Each decision point fires at most once ===")
await t("the same state repeatedly triggered never resends the same prompt", async () => {
  // pickRule advances by byRuleId, and a send rule is never returned again
  // once fired — so the same prompt cannot go out twice.
  const agent = makeAgent()
  const ruleIds = []
  let state = {}
  // Use explicit self-check text so the run really enters selfchecking and
  // actually fires a rule.
  let msgs = baseMessages("TS/lint/build 全部 0 error。自查发现 3 处越界，已修正。")
  // Simulate the real loop: append each sent message to the stream as a plugin
  // message.
  for (let i = 0; i < 4; i++) {
    const r = await handleTurnEnd({
      ctx: makeCtx(), agent,
      session: makeSession({ messages: msgs }),
      turnEnd: turnEnd(), config: makeConfig({ maxIterations: 100 }),
      state, mutate: (n) => { state = n }, queue: makeQueue(),
    })
    if (r.action === "send") {
      ruleIds.push(r.ruleId)
      msgs = [...msgs, { role: "user", source: { kind: "decision", ruleId: r.ruleId }, content: [{ type: "text", text: "x" }], time: Date.now() - 1000 }]
    } else {
      break
    }
  }
  assert(ruleIds.length > 0, "should send at least once, otherwise dedupe is untested")
  const dup = ruleIds.filter((id, i) => ruleIds.indexOf(id) !== i)
  assert(dup.length === 0, `the same rule must not send twice, got ${JSON.stringify(ruleIds)}`)
})

console.log("\n=== 6. Empty input ===")
await t("no readable messages → empty-input", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: [] }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "empty-input", `actual: ${JSON.stringify(r)}`)
})

console.log("\n=== 7. Error path (network retry) ===")
await t("TRANSPORT under the limit → resend", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd("error"), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.action === "retry", `actual: ${JSON.stringify(r)}`)
  assert(agent.sent.length === 1, "should send exactly one retry message")
  assert(agent.sent[0].source.kind === "decision", "source.kind should be decision")
  assert(typeof agent.sent[0].id === "string", "the message must carry an id")
})

await t("over the limit → stop", async () => {
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd("error"), config: makeConfig(),
    state: { failures: 3 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `actual: ${JSON.stringify(r)}`)
  assert(String(mutated?.stoppedReason).startsWith("failure-limit"), `should record failure-limit, got ${mutated?.stoppedReason}`)
})

console.log("\n=== 5b. iterations accumulate per session ===")
await t("iterations only grow: the session stops at the cap", async () => {
  // Pins the behaviour: iterations is a per-session safety valve and does not
  // reset when the user speaks.
  // A long-lived session reused across tasks therefore accumulates; only a DSH
  // restart resets it (it lives in an in-process WeakMap).
  // Preset iterations in state to hit the cap branch directly, instead of
  // relying on the model picking a particular decision point.
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent,
    session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig({ maxIterations: 2 }),
    state: { iterations: 2 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `should stop, got ${JSON.stringify(r)}`)
  assert(r.reason === "iteration-limit", `reason should be iteration-limit, got ${r.reason}`)
  assert(String(mutated?.stoppedReason).startsWith("iteration-limit"), `stoppedReason should start with iteration-limit, got ${mutated?.stoppedReason}`)
  assert(agent.sent.length === 0, "hitting the cap must not send again")
})

console.log("\n=== 7b. Decision service fails repeatedly up to the limit ===")
await t("model unreachable and over the limit → stops with stoppedReason + log", async () => {
  const agent = makeAgent()
  let mutated = null
  // Point at a dead port to produce a judge ERROR.
  const cfg = makeConfig({ failureRetryLimit: 0 })
  cfg.model = { baseUrl: "http://127.0.0.1:9", name: "kev-latest", timeoutMs: 300 }

  // Record the log line count before the call; only new lines matter after.
  const { readFileSync, existsSync } = await import("node:fs")
  const { join: pjoin } = await import("node:path")
  const d0 = new Date()
  const ymd = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`
  const logPath = pjoin(process.env.DECISION_ORCHESTRATOR_LOG_DIR, `${ymd}.jsonl`)
  const before = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").length : 0

  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: cfg,
    state: { failures: 5 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `should stop, got ${JSON.stringify(r)}`)
  assert(r.reason === "judge-failure", `reason should be judge-failure, got ${r.reason}`)
  assert(String(mutated?.stoppedReason).startsWith("judge-failure"), `stoppedReason should start with judge-failure, got ${mutated?.stoppedReason}`)
  assert(agent.sent.length === 0, "stopping must not send")

  // Nothing surfaces this to the user at runtime, so the log is the only
  // place this can be observed.
  // Only new lines count: the log file accumulates, and historical entries
  // would let the assertion pass vacuously.
  const all = readFileSync(logPath, "utf8").trim().split("\n")
  const fresh = all.slice(before).map((l) => JSON.parse(l))
  const hit = fresh.filter((e) => e.ev === "stop" && e.why === "judge-failure")
  assert(hit.length > 0, `expected a new ev=stop why=judge-failure line, got ${fresh.map((e) => e.ev).join(",") || "none"}`)
})

console.log("\n=== 7c. The retry prompt follows the UI language ===")

for (const [locale, needle] of [["zh", "请继续"], ["en", "Please continue"], [undefined, "Please continue"]]) {
  await t(`retry prompt with locale=${locale ?? "unset"}`, async () => {
    const agent = makeAgent()
    const cfg = makeConfig()
    if (locale !== undefined) cfg.locale = locale
    else delete cfg.locale
    const r = await handleTurnEnd({
      ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
      turnEnd: turnEnd("error"), config: cfg, state: {}, mutate: () => {}, queue: makeQueue(),
    })
    assert(r.action === "retry", `should retry, got ${JSON.stringify(r)}`)
    const text = agent.sent[0]?.content?.[0]?.text ?? ""
    assert(text.includes(needle), `prompt should contain "${needle}", got "${text}"`)
  })
}

console.log("\n=== 8. flush failure is observable ===")
await t("flush returns false → reports failure", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx({ flushOk: false }), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd("error"), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.action !== "retry", `should not report success: ${JSON.stringify(r)}`)
  assert(r.error?.includes("durability"), `error should explain the cause: ${r.error}`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
