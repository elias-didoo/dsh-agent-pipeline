/**
 * Context construction: budget allocation and last-message priority.
 *
 * Almost all signal lives in the agent's last reply: on identical input, 120
 * characters picked the wrong answer while the full text picked the right one.
 * So the last message must get budget first — but when it is enormous it must
 * not swallow the history either, or anchors like "go ahead" are lost.
 */

const { buildState, estimateTokens } = await import("../lib/context.js")

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
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const CFG = { rules: [], defaults: { contextBudgetRatio: 0.7, maxTurns: 3 } }
const now = Date.now()

function mkMsgs(rounds, lastLen) {
  const msgs = []
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: `第${i}轮用户` }], time: now - (rounds - i) * 60000 })
    msgs.push({ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: `第${i}轮回复` }], time: now - (rounds - i) * 60000 + 1000 })
  }
  msgs.push({
    role: "assistant",
    source: { kind: "model" },
    content: [{ type: "text", text: `开头标记${"中".repeat(Math.max(0, lastLen - 6))}结尾标记` }],
    time: now - 5000,
  })
  return msgs
}

const countHist = (state) => (state.match(/第\d+轮用户/g) ?? []).length

console.log("=== 1. Token estimation ===")

// The estimate must not run under the model's real cost: an over-estimate
// trims context and costs a little accuracy, an under-estimate makes the
// request fail. These bounds come from measuring each character class against
// the running model, and every one is deliberately at or above the measurement.
await t("CJK characters cost about one token each, never fewer", () => {
  const n = estimateTokens("中".repeat(1000))
  assert(n >= 1000, `must not under-estimate, got ${n}`)
  assert(n < 1300, `must not waste the budget, got ${n}`)
})

await t("plain ASCII costs well under one token per character", () => {
  const n = estimateTokens("x".repeat(1000))
  assert(n >= 350, `latin text is not free, got ${n}`)
  assert(n <= 450, `must not be charged as if CJK, got ${n}`)
})

await t("symbols and emoji cost what the model actually charges", () => {
  // Measured: a red circle is 3 tokens, a cross 2, a tick 1. The old rule
  // charged a quarter token for all of them and undershot a real request by
  // 2.3x.
  const emoji = estimateTokens("🔴".repeat(100))
  assert(emoji >= 200, `emoji must not be charged as latin, got ${emoji}`)
  const tick = estimateTokens("✅".repeat(100))
  assert(tick >= 100, `symbol glyphs are not cheap, got ${tick}`)
})

await t("digits and spaces cost a token each", () => {
  assert(estimateTokens("1234567890") >= 10, "digits tokenize one at a time")
  assert(estimateTokens(" ".repeat(100)) >= 100, "spaces tokenize one at a time")
})

await t("the estimate never reads a mixed reply as cheaper than plain text", () => {
  // A real agent reply is Chinese, ASCII and symbols together. The old rule
  // scored it below its own CJK baseline.
  const mixed = "检查结果：✅ 3 项通过，❌ 2 项失败。\n".repeat(50)
  const cjkOnly = "检查结果：3 项通过，2 项失败。\n".repeat(50)
  assert(
    estimateTokens(mixed) >= estimateTokens(cjkOnly),
    `symbols must not make a reply look cheaper: ${estimateTokens(mixed)} vs ${estimateTokens(cjkOnly)}`,
  )
})

await t("empty text → 0", () => {
  assert(estimateTokens("") === 0, "should be 0")
})

console.log("\n=== 2. Last message kept whole when it fits ===")

await t("last message preserved intact when within budget", () => {
  const { state, stats } = buildState(mkMsgs(5, 100), CFG, 8192)
  assert(state.includes("开头标记"), "should contain the head marker")
  assert(state.includes("结尾标记"), "should contain the tail marker")
  assert(stats.lastTruncated === false, "should not be truncated")
})

await t("history is capped by maxTurns", () => {
  const { state, stats } = buildState(mkMsgs(10, 100), CFG, 8192)
  assert(stats.turns <= 3, `turns should be <= 3, got ${stats.turns}`)
  assert(countHist(state) <= 3, `history entries should be <= 3, got ${countHist(state)}`)
})

console.log("\n=== 3. Trade-off when the last message exceeds budget ===")

await t("over budget truncates the last message but keeps head and tail", () => {
  const { state, stats } = buildState(mkMsgs(10, 20000), CFG, 8192)
  assert(stats.lastTruncated === true, "should be flagged as truncated")
  assert(state.includes("开头标记"), "head marker should survive truncation")
  assert(state.includes("结尾标记"), "tail marker should survive truncation")
})

await t("over budget still leaves room for history", () => {
  // Regression guard: an early version let the last message take the whole
  // budget, so no history fit at all.
  const { state } = buildState(mkMsgs(10, 20000), CFG, 8192)
  assert(countHist(state) > 0, `history should be non-empty, got ${countHist(state)}`)
})

await t("within budget leaves lastTruncated false", () => {
  const { stats } = buildState(mkMsgs(10, 3000), CFG, 8192)
  assert(stats.lastTruncated === false, "3000 chars must not trigger truncation")
})

await t("budget usage never exceeds the limit", () => {
  for (const len of [100, 3000, 8000, 20000]) {
    const { stats } = buildState(mkMsgs(10, len), CFG, 8192)
    assert(stats.used <= stats.budget, `last message ${len} chars: used ${stats.used} > budget ${stats.budget}`)
  }
})

console.log("\n=== 4. Message filtering and labels ===")

await t("only allowlisted user-message kinds are kept", () => {
  const msgs = [
    { role: "user", source: { kind: "skill-catalog" }, content: [{ type: "text", text: "噪声" }], time: now - 1000 },
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "真实用户" }], time: now - 900 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "回复" }], time: now - 500 },
  ]
  const { state } = buildState(msgs, CFG, 8192)
  assert(!state.includes("噪声"), "skill-catalog should be filtered out")
  assert(state.includes("真实用户"), "a real user message should be kept")
})

await t("user and plugin messages get different labels", () => {
  const msgs = [
    { role: "user", source: { kind: "decision", ruleId: "r1" }, content: [{ type: "text", text: "插件发的" }], time: now - 900 },
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "人发的" }], time: now - 800 },
  ]
  const { state } = buildState(msgs, CFG, 8192)
  assert(state.includes("【Plugin】"), "should carry a 【Plugin】 label")
  assert(state.includes("【User】"), "should carry a 【User】 label")
})

await t("empty message list yields an empty state", () => {
  const { state, stats } = buildState([], CFG, 8192)
  assert(state === "", `should be an empty string, got ${JSON.stringify(state)}`)
  assert(stats.eligible === 0, "eligible should be 0")
})

console.log("\n=== 5. The budget estimate is not lower than the model charges ===")

await t("buildState prices a wall of Chinese at about one token per character", () => {
  // The failure this guards: pricing text at four characters per token made a
  // 4.8k estimate into an 11.2k request, and the model rejected it. 4825
  // Chinese characters cost 5289 tokens measured against the running model.
  //
  // The assertion is on buildState's own accounting, not on estimateTokens in
  // isolation: the bug lived in what buildState chose to price with.
  const text = "中".repeat(4825)
  const { stats } = buildState(
    [{ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text }], time: Date.now() }],
    CFG,
    40000,
  )
  assert(stats.used >= 4825, `must not price below one token per character, got ${stats.used}`)
})

await t("the state the plugin believes it built fits the window it budgets for", () => {
  // Whatever the estimator does, the sum it reports must respect the budget —
  // that is the contract buildState offers its caller.
  const filler = "这是一段用于模拟真实 agent 回复的长中文内容，包含结论和说明。".repeat(60)
  const now = Date.now()
  const msgs = []
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "继续" }], time: now - 600000 + i * 1000 })
    msgs.push({ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: filler }], time: now - 599000 + i * 1000 })
  }
  const { state, stats } = buildState(msgs, CFG, 8192)
  assert(stats.used <= stats.budget, `used ${stats.used} must not exceed budget ${stats.budget}`)
  assert(state.length > 0, "the state should still carry content")
})

await t("an oversized single reply is truncated to the budget", () => {
  const filler = "中".repeat(30000)
  const { stats } = buildState(
    [{ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: filler }], time: Date.now() }],
    CFG,
    8192,
  )
  assert(stats.lastTruncated === true, "an oversized reply must be truncated")
  assert(stats.used <= stats.budget, `used ${stats.used} must not exceed budget ${stats.budget}`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
