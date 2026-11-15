/**
 * 上下文构建测试：预算分配与最后一条优先。
 *
 * 决策依据几乎全在 agent 最后一条回复里：实测同一条输入，
 * 只给 120 字会判错阶段，给完整内容判对。所以最后一条必须优先拿到额度；
 * 但它超长时也不能把历史吃干净，否则「开干」这类锚点会丢失。
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

console.log("=== 1. token 估算 ===")

await t("1000 汉字 ≈ 1000 token", () => {
  const n = estimateTokens("中".repeat(1000))
  assert(n === 1000, `实际 ${n}`)
})

await t("1000 ASCII ≈ 250 token", () => {
  const n = estimateTokens("x".repeat(1000))
  assert(n === 250, `实际 ${n}`)
})

await t("空文本 → 0", () => {
  assert(estimateTokens("") === 0, "应为 0")
})

console.log("\n=== 2. 最后一条优先完整保留 ===")

await t("最后一条不超预算时完整保留", () => {
  const { state, stats } = buildState(mkMsgs(5, 100), CFG, 8192)
  assert(state.includes("开头标记"), "应含开头")
  assert(state.includes("结尾标记"), "应含结尾")
  assert(stats.lastTruncated === false, "不应截断")
})

await t("历史轮次受 maxTurns 限制", () => {
  const { state, stats } = buildState(mkMsgs(10, 100), CFG, 8192)
  assert(stats.turns <= 3, `turns 应为 <=3，实际 ${stats.turns}`)
  assert(countHist(state) <= 3, `历史条数应 <=3，实际 ${countHist(state)}`)
})

console.log("\n=== 3. 最后一条超预算时的取舍 ===")

await t("超预算时截断最后一条，但保留头尾", () => {
  const { state, stats } = buildState(mkMsgs(10, 20000), CFG, 8192)
  assert(stats.lastTruncated === true, "应标记截断")
  assert(state.includes("开头标记"), "截断后应保留开头")
  assert(state.includes("结尾标记"), "截断后应保留结尾")
})

await t("超预算时仍给历史留出额度（不把预算吃光）", () => {
  // 这条是回归守卫：早期实现让最后一条独占预算，历史一条都进不来
  const { state } = buildState(mkMsgs(10, 20000), CFG, 8192)
  assert(countHist(state) > 0, `历史应为非空，实际 ${countHist(state)} 条`)
})

await t("不超预算时不标记截断", () => {
  const { stats } = buildState(mkMsgs(10, 3000), CFG, 8192)
  assert(stats.lastTruncated === false, "3000 字不该触发截断")
})

await t("预算用量不超过上限", () => {
  for (const len of [100, 3000, 8000, 20000]) {
    const { stats } = buildState(mkMsgs(10, len), CFG, 8192)
    assert(stats.used <= stats.budget, `末条 ${len} 字时 used ${stats.used} > budget ${stats.budget}`)
  }
})

console.log("\n=== 4. 消息过滤与标签 ===")

await t("只保留白名单来源的用户消息", () => {
  const msgs = [
    { role: "user", source: { kind: "skill-catalog" }, content: [{ type: "text", text: "噪声" }], time: now - 1000 },
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "真实用户" }], time: now - 900 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "回复" }], time: now - 500 },
  ]
  const { state } = buildState(msgs, CFG, 8192)
  assert(!state.includes("噪声"), "skill-catalog 应被过滤")
  assert(state.includes("真实用户"), "真人消息应保留")
})

await t("用户与插件消息的标签不同", () => {
  const msgs = [
    { role: "user", source: { kind: "decision", ruleId: "r1" }, content: [{ type: "text", text: "插件发的" }], time: now - 900 },
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "人发的" }], time: now - 800 },
  ]
  const { state } = buildState(msgs, CFG, 8192)
  assert(state.includes("【插件】"), "应有【插件】标签")
  assert(state.includes("【用户】"), "应有【用户】标签")
})

await t("空消息列表返回空状态", () => {
  const { state, stats } = buildState([], CFG, 8192)
  assert(state === "", `应为空串，实际 ${JSON.stringify(state)}`)
  assert(stats.eligible === 0, "eligible 应为 0")
})

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
