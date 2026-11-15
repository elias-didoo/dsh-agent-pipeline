/**
 * End-to-end: a real model judgement driving the full main loop, using the
 * twelve decision points a real workspace actually configures.
 *
 * The assertion is "this situation → this decision point", not "something
 * happened". The latter passes vacuously: failing to match anything falls back
 * to the uncertain path, which is a legitimate outcome and would hide a broken
 * criteria set.
 *
 * The `when` texts here are the ones a user would write, so a failure here means
 * the prompts themselves need work — which is exactly what a live run would tell
 * you, only faster.
 */

// Route this run's logs to a temp dir so no invocation ever pollutes real logs.
process.env.DECISION_ORCHESTRATOR_LOG_DIR ??=
  new URL(`file://${(await import("node:os")).tmpdir()}/decision-orchestrator-test-logs`).pathname

const { readFileSync } = await import("node:fs")
const { join } = await import("node:path")

const { handleTurnEnd } = await import("../lib/core.js")

const ROOT = new URL("..", import.meta.url).pathname

const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/** A message the plugin sent earlier, tagged with the decision point that sent it. */
const PLUGIN = (ruleId, t) => ({
  role: "user",
  source: { kind: "decision", ruleId },
  content: [{ type: "text", text: t }],
  time: Date.now() - 30000,
})

/**
 * Build the workspace config from the fixture, which is the same file the
 * deployed profile carries.
 *
 * Parsed by hand rather than with a YAML library: the project has no
 * dependencies, and this file's shape is fixed — a decisions list of scalar
 * fields. A parser bug would show up as a missing decision point, which the
 * assertion on the count catches.
 */
function loadFixture() {
  const text = readFileSync(join(ROOT, "fixtures/brandu.yml"), "utf8")
  const decisions = []
  for (const chunk of text.split(/^\s*- id:\s*/m).slice(1)) {
    const id = chunk.split("\n")[0].trim()
    const field = (name) => {
      const m = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m").exec(chunk)
      return m ? m[1] : ""
    }
    const doWhat = field("do")
    decisions.push({ id, when: field("when"), do: doWhat, prompt: field("prompt"), notifyText: field("notifyText") })
  }
  assert(decisions.length > 0, "fixture produced no decision points")
  const pathMatch = /^\s*- path:\s*(.+)$/m.exec(text)
  return {
    path: pathMatch ? pathMatch[1].trim() : "",
    enabled: /^\s*enabled:\s*true$/m.test(text),
    decisions,
  }
}

const workspace = loadFixture()
const WS = workspace.path
const config = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 30000 },
  defaults: {
    maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.15,
    humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3,
  },
  workspaces: [workspace],
}

/**
 * One conversation: the user's opening message, whatever the plugin and agent
 * exchanged, then the reply being judged.
 *
 * Chronological, and the opening message is the caller's — a conflict scenario
 * does not start with a feature request, and padding it with one leaves the
 * model reading two unrelated threads.
 */
function mkSession(text, prior = [], opening = "先把 worktree 同步到最新 head，然后评估需求：加一个导出功能") {
  const now = Date.now()
  return {
    id: "session-e2e-0001",
    header: { cwd: WS },
    deriveMessages: () => [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: opening }], time: now - 600000 },
      ...prior,
      { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text }], time: now - 5000 },
    ],
  }
}

function mkAgent(session) {
  const sent = []
  return { sent, session, inbox: { nextTurn: [], nextStep: [] }, followup(m) { sent.push(m) }, whenIdle: async () => {} }
}

function mkCtx() {
  return {
    sessions: { flush: async () => true },
    goals: { get: () => undefined },
    get: (k) => (k === "tokenMeter" ? { estimateMessage: () => 20 } : undefined),
  }
}

const CASES = [
  {
    label: "bug 刚排查完",
    text: "我怀疑是 token 过期导致的，要去 console 看一下。",
    prior: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "报告bug：登录后白屏" }], time: Date.now() - 600000 }],
    expect: "bug_root",
  },
  {
    label: "需求刚给方案",
    text: "方案：改 3 个文件，导出处加一个 csv 库，导出范围是当前列表。",
    expect: "review",
  },
  {
    label: "评审完（没汇总）",
    text: "评审完成，影响 3 处，架构上不需要额外抽象。",
    prior: [PLUGIN("review", "该读的文档和代码都去读。二次确认下是否评估全了。")],
    expect: "summarize",
  },
  {
    label: "汇总完（等开干）",
    text: "1. 改 export.ts 2. 加 csv 依赖 3. 加测试",
    prior: [PLUGIN("review", "该读的文档和代码都去读。"), PLUGIN("summarize", "汇总列出你计划的改动点，要点列全")],
    expect: "confirm",
  },
  {
    label: "开干后改完",
    text: "代码改完了，改了 3 个文件，功能已实现。",
    prior: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "开干" }], time: Date.now() - 300000 },
    ],
    expect: "selfcheck_1",
  },
  {
    label: "第一轮自检完",
    text: "发现 2 处越界改动，已修正；还加了一个边界测试。",
    prior: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "开干" }], time: Date.now() - 300000 },
      PLUGIN("selfcheck_1", "仔细检查你刚改动的所有文件。"),
    ],
    expect: "selfcheck_2",
  },
  {
    label: "第二轮完·仍有问题",
    text: "又发现 1 处问题，边界条件没处理，已修复。",
    prior: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "开干" }], time: Date.now() - 300000 },
      PLUGIN("selfcheck_1", "仔细检查你刚改动的所有文件。"),
      PLUGIN("selfcheck_2", "该修的问题都修了吗？有问题就去修"),
    ],
    expect: "selfcheck_3",
  },
  {
    label: "第二轮完成·没问题",
    text: "全部检查通过，TS 和 lint 都是 0 error，没发现遗留问题。",
    prior: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "开干" }], time: Date.now() - 300000 },
      PLUGIN("selfcheck_1", "仔细检查你刚改动的所有文件。"),
      PLUGIN("selfcheck_2", "该修的问题都修了吗？有问题就去修"),
    ],
    expect: "push",
  },
  {
    label: "第三轮答复后",
    text: "还需要，重点应该放在边界条件上。",
    prior: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "开干" }], time: Date.now() - 300000 },
      PLUGIN("selfcheck_1", "仔细检查你刚改动的所有文件。"),
      PLUGIN("selfcheck_2", "该修的问题都修了吗？有问题就去修"),
      PLUGIN("selfcheck_3", "每次自检都能发现新问题，你觉得还需要下次自检吗？"),
    ],
    expect: "selfcheck_go",
  },
  {
    label: "已推送",
    text: "已推送，HEAD -> main，工作树干净。",
    expect: "finished",
  },
  {
    label: "agent 提问等你回答",
    text: "导出成 CSV 还是 Excel？范围是当前列表还是全部？",
    expect: "waiting",
  },
  {
    label: "冲突·确认为真→回评审",
    text: "确实有冲突，auth.ts 和 router.ts 两处，我手动合并了。",
    prior: [PLUGIN("conflict", "刚才rebase/merge最新 head 时是否有冲突，你是怎么解决的")],
    opening: "同步到最新 head",
    expect: "review",
  },
  {
    label: "冲突·确认没冲突",
    text: "没有冲突，直接 fast-forward 了。",
    prior: [PLUGIN("conflict", "刚才rebase/merge最新 head 时是否有冲突，你是怎么解决的")],
    opening: "同步到最新 head",
    expect: "waiting",
  },
  {
    label: "有冲突",
    text: "rebase 时 auth.ts 和 router.ts 有冲突，已手动合并两处。",
    opening: "同步到最新 head",
    expect: "conflict",
  },
]

// The fixture is only authoritative if the running profile agrees with it. When
// one is edited without the other, every assertion below passes against a
// configuration nobody deploys — which is exactly the drift this arrangement
// exists to prevent.
function checkProfileMatches() {
  const home = process.env.HOME
  if (!home) return "HOME is unset; skipped"
  const profilePath = join(home, ".dsh/profiles/desktop/cordis.patch.yml")
  let profile
  try {
    profile = readFileSync(profilePath, "utf8")
  } catch {
    return "no deployed profile on this machine; skipped"
  }
  const start = profile.indexOf("        workspaces:")
  assert(start > 0, "the deployed profile has no workspaces block")
  const end = profile.indexOf("\n\n- id:", start)
  const deployed = profile.slice(start, end > 0 ? end : undefined)

  const ids = (text) => text.split(/^\s*- id:\s*/m).slice(1).map((c) => c.split("\n")[0].trim())
  const deployedIds = ids(deployed)
  const fixtureIds = workspace.decisions.map((d) => d.id)
  assert(
    deployedIds.join(",") === fixtureIds.join(","),
    `decision points differ\n  deployed: ${deployedIds.join(",")}\n  fixture:  ${fixtureIds.join(",")}`,
  )

  // Every `when` must match too: the ids matching while the prose drifts would
  // leave the model reading texts that were never tested.
  for (const d of workspace.decisions) {
    const m = new RegExp(`- id: ${d.id}\\s*\\n\\s*when: (.+?)\\s*$`, "m").exec(deployed)
    assert(m, `decision ${d.id} is missing from the profile`)
    assert(m[1].trim() === d.when, `decision ${d.id} when differs\n  deployed: ${m[1].trim()}\n  fixture:  ${d.when}`)
  }
  return `matches ${deployedIds.length} decision points`
}

console.log("=== 部署配置与 fixture 一致 ===")
try {
  console.log("  " + checkProfileMatches())
} catch (e) {
  console.log("  ❌ " + e.message)
  process.exit(1)
}
console.log()

let ok = 0
console.log("=== 真实 Kev：12 条决策点端到端 ===")
for (const c of CASES) {
  const session = mkSession(c.text, c.prior ?? [], c.opening)
  const agent = mkAgent(session)
  const t0 = Date.now()
  let r
  try {
    r = await handleTurnEnd({
      ctx: mkCtx(), agent, session,
      turnEnd: { turn: 1, reason: { kind: "completed" } },
      config, state: {}, mutate: () => {}, queue: { run: (fn) => fn() },
    })
  } catch (e) {
    r = { action: "throw", error: e.message }
  }
  const ms = Date.now() - t0
  const got = r.ruleId ?? r.skipped ?? "-"
  const hit = got === c.expect
  if (hit) ok++
  console.log(`  ${hit ? "✅" : "❌"} ${c.label.padEnd(20)} want=${c.expect.padEnd(12)} got=${String(got).padEnd(12)} ${String(r.action ?? "skip").padEnd(7)} ${ms}ms`)
}

console.log(`\n=== ${ok}/${CASES.length} ===`)
process.exit(ok === CASES.length ? 0 : 1)
