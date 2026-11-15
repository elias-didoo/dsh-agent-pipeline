/**
 * End-to-end: a real model judgement driving the full main loop.
 * The closest thing to a live run, with only DSH's agent/session faked.
 *
 * The assertion is "stage → which rule fired", not "something happened".
 * The latter passes vacuously when rules are misconfigured, because failing to
 * select a rule just falls back to the UNCERTAIN path.
 */

// Route this run's logs to a temp dir so no invocation ever pollutes real logs.
process.env.DECISION_ORCHESTRATOR_LOG_DIR ??=
  new URL(`file://${(await import("node:os")).tmpdir()}/decision-orchestrator-test-logs`).pathname

const { handleTurnEnd } = await import("../lib/core.js")

const WS = "/tmp/dsh-decision-orchestrator-test-workspace"

const config = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 30000 },
  defaults: {
    maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.3,
    humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3,
  },
  workspaces: [{
    path: WS,
    enabled: true,
    rules: [
      { id: "review", when: "planning", scene: "s", action: "send", prompt: "二次确认方案。", notifyText: "" },
      { id: "summarize", when: "planning", scene: "s", action: "send", prompt: "汇总改动点。", notifyText: "" },
      { id: "selfcheck_1", when: "selfchecking", scene: "s", action: "send", prompt: "仔细检查改动。", notifyText: "" },
      { id: "selfcheck_2", when: "selfchecking", scene: "s", action: "send", prompt: "该修的修了吗？", notifyText: "" },
      { id: "waiting", when: "waiting", scene: "s", action: "stop", prompt: "", notifyText: "需要你拍板" },
      { id: "finished", when: "finished", scene: "s", action: "stop", prompt: "", notifyText: "需求已完成" },
    ],
  }],
}

function mkSession(text, importedMessages) {
  const now = Date.now()
  return {
    id: "session-e2e-0001",
    header: { cwd: WS },
    deriveMessages: () => [
      ...importedMessages,
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我完善这个项目的文档" }], time: now - 600000 },
      { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text }], time: now - 5000 },
    ],
  }
}

function mkAgent(session) {
  const sent = []
  return {
    sent, session,
    inbox: { nextTurn: [], nextStep: [] },
    followup(m) { sent.push(m) },
    whenIdle: async () => {},
  }
}

const ctx = {
  sessions: { flush: async () => true },
  goals: { get: () => undefined },
  get: () => ({ estimateMessage: () => 30 }),
}
const queue = { run: (fn) => fn() }

/** Build a message this plugin sent, to advance intra-stage progress. */
function pluginMsg(ruleId) {
  return {
    role: "user",
    source: { kind: "decision", ruleId },
    content: [{ type: "text", text: "x" }],
    time: Date.now() - 30000,
  }
}

const cases = [
  {
    label: "讨论方案",
    text: "# 繁体中文支持评估\n先给结论：这活比上一门语言轻。读完的真实调用链：i18n/routing.ts → lib/router.ts。需要先定 locale 码。",
    imported: [],
    expectStage: "planning",
    expectRule: "review",
    expectAction: "send",
  },
  {
    label: "自检首轮",
    text: "TS/lint/build 全部 0 error。自查发现 3 处越界，已修正。",
    imported: [pluginMsg("review"), pluginMsg("summarize")],
    expectStage: "selfchecking",
    expectRule: "selfcheck_1",
    expectAction: "send",
  },
  {
    label: "自检二轮",
    // Real self-check replies run to hundreds of characters of detail; a
    // one-liner gives the model nothing to judge on.
    text: "这一轮又发现了 4 处问题。\n\n## 最重要的发现：字幕模板在繁中下会全部不可选\n\n`lib/contracts/caption-template.ts` 的 `SCRIPT_OF_LANGUAGE` 表里没有 `zh-Hant` 分支，导致取不到脚本类型，模板筛选直接返回空。已补上映射并加了一个断言。\n\n## 其余三处\n\n1. `scripts/check-i18n.mjs` 从 routing.ts 正则取 locale 列表，加繁中后正则没覆盖，漏扫。\n2. `lib/seo-utils.ts` 的 OG_LOCALES 缺 zh_TW。\n3. 两处测试快照过期。\n\n这些都已修完并提交，等下一轮检查再看还有没有漏的。",
    imported: [pluginMsg("review"), pluginMsg("summarize"), pluginMsg("selfcheck_1")],
    expectStage: "selfchecking",
    expectRule: "selfcheck_2",
    expectAction: "send",
  },
  {
    label: "等用户决定",
    text: "有两种目录结构：按功能分，或按层分。你希望用哪种？",
    imported: [pluginMsg("review"), pluginMsg("summarize")],
    expectStage: "waiting",
    expectRule: "waiting",
    expectAction: "halt",
  },
  {
    label: "已完成",
    text: "推送完成。HEAD -> main，工作树干净，pnpm verify EXIT=0。",
    imported: [],
    expectStage: "finished",
    expectRule: "finished",
    expectAction: "halt",
  },
]

console.log("=== Live model end-to-end ===\n")
let pass = 0
const misses = []

for (const c of cases) {
  const session = mkSession(c.text, c.imported)
  const agent = mkAgent(session)
  const t0 = Date.now()

  const r = await handleTurnEnd({
    ctx, agent, session,
    turnEnd: { turn: 1, reason: { kind: "completed" } },
    config, state: {}, mutate: () => {}, queue,
  })
  const ms = Date.now() - t0

  const ruleOk = r.ruleId === c.expectRule
  const actionOk = r.action === c.expectAction
  const ok = ruleOk && actionOk
  if (ok) pass++
  else misses.push({ ...c, got: r.ruleId, action: r.action })

  console.log(
    `  ${ok ? "✅" : "❌"} ${c.label.padEnd(12)} expect=${c.expectRule.padEnd(12)} got=${String(r.ruleId ?? "-").padEnd(12)} action=${String(r.action).padEnd(8)} ${ms}ms`,
  )
  if (!ok) console.log(`       expected action=${c.expectAction}, reason=${r.reason ?? r.skipped ?? "-"}`)
}

console.log(`\n=== ${pass}/${cases.length} passed ===`)
if (misses.length) {
  console.log("\nFailures:")
  for (const m of misses) console.log(`  ${m.label}: expected ${m.expectRule}/${m.expectAction}, got ${m.got ?? "-"}/${m.action}`)
}
process.exit(pass === cases.length ? 0 : 1)
