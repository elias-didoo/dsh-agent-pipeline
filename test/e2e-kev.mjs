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

const { handleTurnEnd } = await import("../lib/core.js")

const WS = "/tmp/dsh-decision-orchestrator-test-workspace"

/** A message the plugin sent earlier, tagged with the decision point that sent it. */
const PLUGIN = (ruleId, t) => ({
  role: "user",
  source: { kind: "decision", ruleId },
  content: [{ type: "text", text: t }],
  time: Date.now() - 30000,
})

const config = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 30000 },
  defaults: {
    maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.15,
    humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3,
  },
  workspaces: [{
    path: WS,
    enabled: true,
    decisions: [
      // Every `when` names a message the plugin itself sent, by its opening
      // words. That is what lets the model tell two adjacent situations apart:
      // "the agent produced a plan" is ambiguous, "and the review request has
      // not appeared yet" is not.
      { id: "bug_root", when: "用户在报 bug。对话里还没有出现「以上是你的猜测还是已经有证据证明的根因」这条插件消息。", do: "send", prompt: "以上是你的猜测还是已经有证据证明的根因？", notifyText: "" },
      { id: "review", when: "agent 第一次给出技术方案或评估结论。对话里还没有出现「该读的文档和代码都去读」这条插件消息。", do: "send", prompt: "该读的文档和代码都去读。", notifyText: "" },
      { id: "summarize", when: "对话里已经出现「该读的文档和代码都去读」，但 agent 的回复是一段评审结论而不是编号清单。还没有出现「汇总列出你计划的改动点」。", do: "send", prompt: "汇总列出你计划的改动点，要点列全", notifyText: "" },
      { id: "confirm", when: "对话里已经出现「汇总列出你计划的改动点」这条插件消息，agent 的回复是一条编号的改动清单。这是方案阶段的最后一步，等用户说开干。", do: "stop", prompt: "", notifyText: "方案已就绪，等你决定" },
      { id: "selfcheck_1", when: "用户说过开干，agent 已完成代码改动。还没有出现「仔细检查你刚改动的所有文件」。", do: "send", prompt: "仔细检查你刚改动的所有文件。", notifyText: "" },
      { id: "selfcheck_2", when: "对话里已经出现「仔细检查你刚改动的所有文件」，agent 刚回复检查结果。还没有出现「该修的问题都修」。", do: "send", prompt: "该修的问题都修了吗？有问题就去修", notifyText: "" },
      { id: "selfcheck_3", when: "对话里已经出现「该修的问题都修」，但还没有出现「每次自检都能发现新问题」。agent 回复说又发现新问题。", do: "send", prompt: "每次自检都能发现新问题，你觉得还需要下次自检吗？", notifyText: "" },
      { id: "selfcheck_go", when: "对话里已经出现「每次自检都能发现新问题」，agent 已经答复了那条问题，现在应该让它开始下一轮自检。", do: "send", prompt: "开始自检", notifyText: "" },
      { id: "push", when: "自检已经全部通过，agent 还没有推送。", do: "send", prompt: "推送", notifyText: "" },
      { id: "conflict", when: "rebase 或 merge 最新 head 时发生冲突，或 agent 正在说明如何解决冲突。", do: "send", prompt: "刚才 rebase/merge 最新 head 时是否有冲突，你是怎么解决的", notifyText: "" },
      { id: "waiting", when: "agent 在正文里直接向用户提问、请求批准或索要信息。", do: "stop", prompt: "", notifyText: "需要你拍板" },
      { id: "finished", when: "agent 已经把代码推到远端（回复里有 HEAD -> main 或 push 成功），或明确宣告整个需求结束。", do: "stop", prompt: "", notifyText: "需求已完成" },
    ],
  }],
}

function mkSession(text, prior = []) {
  const now = Date.now()
  return {
    id: "session-e2e-0001",
    header: { cwd: WS },
    // Chronological: the opening request, then whatever the plugin and agent
    // exchanged, then the reply being judged. An out-of-order log reads to the
    // model as a different conversation entirely.
    deriveMessages: () => [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "先把 worktree 同步到最新 head，然后评估需求：加一个导出功能" }], time: now - 600000 },
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
    label: "有冲突",
    text: "rebase 时 auth.ts 和 router.ts 有冲突，已手动合并两处。",
    expect: "conflict",
  },
]

let ok = 0
console.log("=== 真实 Kev：12 条决策点端到端 ===")
for (const c of CASES) {
  const session = mkSession(c.text, c.prior ?? [])
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
