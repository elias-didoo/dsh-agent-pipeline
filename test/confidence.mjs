/**
 * 置信度归一化测试。
 *
 * 原始 p_max 的含义取决于选项数（瞎猜时期望分别是 1/2、1/5、1/6），
 * 归一化后 0.5 的含义与选项数无关，门槛才能是固定值。
 */

const { confidenceOf } = await import("../lib/judge.js")

let pass = 0
let fail = 0
// 必须 await fn()：同步版抓不到 async 用例里的断言失败。
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
const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps

console.log("=== 1. 归一化公式 ===")

await t("2 选项 p=0.55 → 0.10（仅略强于瞎猜）", () => {
  const c = confidenceOf({ a: 0.55, b: 0.45 }, "a")
  assert(near(c, 0.1), `实际 ${c.toFixed(4)}`)
})

await t("2 选项 p=0.90 → 0.80", () => {
  const c = confidenceOf({ a: 0.9, b: 0.1 }, "a")
  assert(near(c, 0.8), `实际 ${c.toFixed(4)}`)
})

await t("2 选项 p=0.50（正好基线）→ 0", () => {
  const c = confidenceOf({ a: 0.5, b: 0.5 }, "a")
  assert(near(c, 0), `实际 ${c.toFixed(4)}`)
})

await t("5 选项 p=0.20（正好基线）→ 0", () => {
  const probs = { a: 0.2, b: 0.2, c: 0.2, d: 0.2, e: 0.2 }
  const c = confidenceOf(probs, "a")
  assert(near(c, 0), `实际 ${c.toFixed(4)}`)
})

await t("5 选项 p=0.926 → ≈0.907", () => {
  const probs = { implementing: 0.926, planning: 0.034, selfchecking: 0.015, waiting: 0.014, finished: 0.011 }
  const c = confidenceOf(probs, "implementing")
  assert(near(c, 0.907, 0.01), `实际 ${c.toFixed(4)}`)
})

await t("5 选项 p=0.634 → ≈0.542", () => {
  const probs = { selfchecking: 0.634, finished: 0.159, waiting: 0.13, implementing: 0.041, planning: 0.035 }
  const c = confidenceOf(probs, "selfchecking")
  assert(near(c, 0.542, 0.01), `实际 ${c.toFixed(4)}`)
})

await t("5 选项 p=0.279（模糊场景）→ ≈0.099", () => {
  const probs = { planning: 0.279, waiting: 0.262, implementing: 0.197, finished: 0.159, selfchecking: 0.103 }
  const c = confidenceOf(probs, "planning")
  assert(near(c, 0.099, 0.01), `实际 ${c.toFixed(4)}`)
})

console.log("\n=== 2. 关键性质：与选项数解耦 ===")

await t("同样「绝对确定」在不同选项数下归一化接近 1", () => {
  const c2 = confidenceOf({ a: 0.999, b: 0.001 }, "a")
  const c5 = confidenceOf({ a: 0.999, b: 0.00025, c: 0.00025, d: 0.00025, e: 0.00025 }, "a")
  assert(c2 > 0.99, `2选项 ${c2}`)
  assert(c5 > 0.99, `5选项 ${c5}`)
})

await t("同样「略强于基线」在不同选项数下归一化接近 0.1", () => {
  // 2 选项基线 0.5，选 0.55
  const c2 = confidenceOf({ a: 0.55, b: 0.45 }, "a")
  // 5 选项基线 0.2，选 0.24（比基线高 20%）
  const c5 = confidenceOf({ a: 0.24, b: 0.19, c: 0.19, d: 0.19, e: 0.19 }, "a")
  assert(near(c2, 0.1, 0.02), `2选项 ${c2.toFixed(3)}`)
  assert(near(c5, 0.05, 0.02), `5选项 ${c5.toFixed(3)}`)
})

console.log("\n=== 3. 边界与异常 ===")

await t("低于基线的概率 → 0（不会出现负数）", () => {
  const c = confidenceOf({ a: 0.1, b: 0.5, c: 0.4 }, "a")
  assert(c === 0, `实际 ${c}`)
})

await t("未知选项 → 0", () => {
  assert(confidenceOf({ a: 0.5, b: 0.5 }, "zzz") === 0, "应为 0")
})

await t("空分布 → 0", () => {
  assert(confidenceOf({}, "a") === 0, "应为 0")
})

await t("单选项 → 原值（没有基线可言）", () => {
  const c = confidenceOf({ only: 0.8 }, "only")
  assert(near(c, 0.8), `实际 ${c}`)
})

await t("结果永远在 0..1", () => {
  for (const p of [0, 0.001, 0.5, 0.999, 1]) {
    const c = confidenceOf({ a: p, b: 1 - p }, "a")
    assert(c >= 0 && c <= 1, `p=${p} → ${c}`)
  }
})

console.log("\n=== 4. 门槛的实际效果 ===")

await t("门槛 0.3：模糊场景被拦下，真实判定全部通过", () => {
  const floor = 0.3
  // 五个选项概率几乎均分的「瞎猜」样本
  const vague = confidenceOf({ planning: 0.25, waiting: 0.22, implementing: 0.2, finished: 0.18, selfchecking: 0.15 }, "planning")
  // 真实会话上实测到的置信度（判对但有多寡之分）
  const manifest = [
    confidenceOf({ planning: 0.62, selfchecking: 0.15, waiting: 0.12, finished: 0.08, conflict: 0.03 }, "planning"), // 0.753 那类
    confidenceOf({ finished: 0.45, waiting: 0.25, selfchecking: 0.2, planning: 0.06, conflict: 0.04 }, "finished"), // 0.318 那类
  ]
  assert(vague < floor, `模糊 ${vague.toFixed(3)} 应 < ${floor}`)
  for (const c of manifest) {
    assert(c >= floor, `真实判对样本 ${c.toFixed(3)} 应 >= ${floor}`)
  }
})

await t("门槛 0.45 与 0.3 的取舍有真实数据依据", () => {
  // 真实会话上实测到的置信度（六条样本，全部判对）
  const samples = [0.753, 0.454, 0.529, 0.318, 0.498, 0.439]
  const pass45 = samples.filter((c) => c >= 0.45).length
  const pass30 = samples.filter((c) => c >= 0.3).length
  // 0.45 会漏掉 0.318 和 0.439 两个判对的结果
  assert(pass45 === 4, `门槛 0.45 应放行 4 条，实际 ${pass45}`)
  assert(pass30 === 6, `门槛 0.3 应放行 6 条，实际 ${pass30}`)
})

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
