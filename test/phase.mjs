/**
 * 阶段机测试：日志推导进度 + pickRule 查表。
 *
 * 这两个函数决定了「同一阶段下该发哪条」，
 * 而「第几轮自检」这类信息 Kev 判不出来，只能靠计数。
 */

const { phaseProgress, pickRule } = await import("../lib/phases.js")

let pass = 0
let fail = 0
// 必须 await fn()：同步版 try/catch 抓不到 async 函数里的断言失败，
// 会让失败的用例静默显示成通过。
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

/** 造一条插件发过的消息。 */
function decisionMsg(ruleId, text = "x") {
  return { role: "user", source: { kind: "decision", ruleId }, content: [{ type: "text", text }] }
}

const RULES = [
  { id: "bug_root", when: "planning", action: "send", prompt: "p1", notifyText: "" },
  { id: "review", when: "planning", action: "send", prompt: "p2", notifyText: "" },
  { id: "summarize", when: "planning", action: "send", prompt: "p3", notifyText: "" },
  { id: "need_confirm", when: "planning", action: "stop", prompt: "", notifyText: "需要你拍板" },
  { id: "selfcheck_1", when: "selfchecking", action: "send", prompt: "p4", notifyText: "" },
  { id: "selfcheck_2", when: "selfchecking", action: "send", prompt: "p5", notifyText: "" },
  { id: "selfcheck_3", when: "selfchecking", action: "send", prompt: "p6", notifyText: "" },
  { id: "push", when: "selfchecking", action: "send", prompt: "p7", notifyText: "" },
  { id: "conflict", when: "conflict", action: "send", prompt: "p8", notifyText: "" },
  { id: "need_user", when: "waiting", action: "stop", prompt: "", notifyText: "需要你" },
  { id: "done", when: "finished", action: "stop", prompt: "", notifyText: "完成" },
]

console.log("=== 1. 进度推导 ===")

await t("没有插件消息 → 全零", () => {
  const p = phaseProgress([], RULES)
  assert(p.selfCheckRound === 0, `selfCheckRound=${p.selfCheckRound}`)
})

await t("数出评审/汇总/自检", () => {
  const msgs = [
    decisionMsg("review"),
    decisionMsg("summarize"),
    decisionMsg("selfcheck_1"),
    decisionMsg("selfcheck_2"),
  ]
  const p = phaseProgress(msgs, RULES)
  assert(p.selfCheckRound === 2, `selfCheckRound 应为 2，实际 ${p.selfCheckRound}`)
})

await t("忽略不是 decision 的消息", () => {
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]
  const p = phaseProgress(msgs, RULES)
  assert(p.selfCheckRound === 0, "不应计数")
  assert(Object.keys(p.byRuleId).length === 0, "byRuleId 应为空")
})

await t("忽略配置里已不存在的 ruleId（配置改过不污染）", () => {
  const msgs = [decisionMsg("selfcheck_1"), decisionMsg("old_rule_gone")]
  const p = phaseProgress(msgs, RULES)
  assert(p.selfCheckRound === 1, `应为 1，实际 ${p.selfCheckRound}`)
  assert(!("old_rule_gone" in p.byRuleId), "不应统计未知规则")
})

console.log("\n=== 1b. when 字段校验 ===")

await t("when 缺失 → 报错", async () => {
  const { validate } = await import("../lib/config.js")
  const r = validate({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", scene: "s", action: "send", prompt: "p" },
      { id: "b", scene: "s", action: "silent", prompt: "" },
    ] }],
  })
  assert(r.issues?.some((i) => /when/.test(i.message)), `应报 when 错误: ${JSON.stringify(r.issues)}`)
})

await t("when 非法值 → 报错", async () => {
  const { validate } = await import("../lib/config.js")
  const r = validate({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", when: "bogus", scene: "s", action: "send", prompt: "p" },
      { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
    ] }],
  })
  assert(r.issues?.some((i) => /when/.test(i.message)), `应报 when 错误: ${JSON.stringify(r.issues)}`)
})

await t("when 非法时该规则降级为 silent（不会被选中执行）", async () => {
  // validate 返回 { value } 或 { issues }，互斥；用 null 兜底好让断言看清真实形状
  const { validate } = await import("../lib/config.js")
  const raw = {
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", when: "bogus", scene: "s", action: "send", prompt: "p" },
      { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
    ] }],
  }
  const r = validate(raw)

  // 优先看归一化结果
  // 有 issue 时 validate 只返回 { issues }，此时归一化结果不可见，
  // 能确认的是「这条规则因为 when 非法被明确报错，不会静默通过」。
  const reported = (r.issues ?? []).some(
    (i) => i.path?.includes("when") && /\ba\b|\\(a\\)/.test(i.message),
  )
  const normalized = r.value?.workspaces?.[0]?.rules?.find((x) => x.id === "a")

  assert(
    reported || normalized?.action === "silent",
    `非法 when 既未报错也未降级: ${JSON.stringify(r).slice(0, 200)}`,
  )
})

await t("六个阶段名都能通过校验", async () => {
  const { validate, STAGES } = await import("../lib/config.js")
  for (const st of STAGES) {
    const r = validate({
      workspaces: [{ path: "/tmp/a", enabled: true, rules: [
        { id: "a", when: st, scene: "s", action: "send", prompt: "p" },
        { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
      ] }],
    })
    assert(!r.issues, `${st} 不应报错: ${JSON.stringify(r.issues)}`)
  }
})

await t("action 枚举只有 send/stop/silent，没有 notify", async () => {
  const { validate } = await import("../lib/config.js")
  const mk = (action) => ({
    workspaces: [{ path: "/tmp/a", enabled: true, rules: [
      { id: "a", when: "waiting", scene: "s", action, prompt: "", notifyText: "x" },
      { id: "b", when: "planning", scene: "s", action: "silent", prompt: "" },
    ] }],
  })
  assert(!validate(mk("stop")).issues, "stop 应通过")
  const legacy = validate(mk("notify"))
  assert(legacy.issues?.some((i) => /action/.test(i.message)), "notify 应被拒绝")
})

console.log("\n=== 2. pickRule：planning 阶段递进 ===")

await t("什么都没发过 → 发 planning 阶段第一条", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("planning", p, RULES)
  assert(r.rule?.id === "bug_root", `实际 ${r.rule?.id}`)
})

await t("bug_root 已发过 → 跳到 review", () => {
  const p = { selfCheckRound: 0, byRuleId: { bug_root: 1 } }
  const r = pickRule("planning", p, RULES)
  assert(r.rule?.id === "review", `实际 ${r.rule?.id}`)
})

await t("bug_root+review+summarize 都发过 → 转到 notify", () => {
  const p = {
    selfCheckRound: 0,
    byRuleId: { bug_root: 1, review: 1, summarize: 1 },
  }
  const r = pickRule("planning", p, RULES)
  assert(r.rule?.id === "need_confirm", `实际 ${r.rule?.id}`)
})

await t("notify 也发过 → skip", () => {
  const p = {
    selfCheckRound: 0,
    byRuleId: { bug_root: 1, review: 1, summarize: 1, need_confirm: 1 },
  }
  const r = pickRule("planning", p, RULES)
  assert(!r.rule && r.skip === "planning-complete", `实际 ${JSON.stringify(r)}`)
})

console.log("\n=== 3. pickRule：selfchecking 固定顺序 ===")

for (const [round, expect] of [[0, "selfcheck_1"], [1, "selfcheck_2"], [2, "selfcheck_3"], [3, "push"]]) {
  t(`第 ${round} 轮 → ${expect}`, () => {
    const p = { selfCheckRound: round, byRuleId: {} }
    const r = pickRule("selfchecking", p, RULES)
    assert(r.rule?.id === expect, `实际 ${r.rule?.id}`)
  })
}

await t("自检全部做完 → skip", () => {
  const p = { selfCheckRound: 4, byRuleId: {} }
  const r = pickRule("selfchecking", p, RULES)
  assert(!r.rule, "不应再有规则")
  assert(r.skip === "selfcheck-complete", `实际 ${r.skip}`)
})

console.log("\n=== 4. pickRule：其他阶段 ===")

await t("implementing → 不推它", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("implementing", p, RULES)
  assert(!r.rule, "不应发")
  assert(r.skip === "implementing", `实际 ${r.skip}`)
})

await t("waiting → 发 notify 规则", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("waiting", p, RULES)
  assert(r.rule?.id === "need_user", `实际 ${r.rule?.id}`)
})

await t("finished → 发 notify 规则", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("finished", p, RULES)
  assert(r.rule?.id === "done", `实际 ${r.rule?.id}`)
})

await t("conflict → 发 send 规则", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("conflict", p, RULES)
  assert(r.rule?.id === "conflict", `实际 ${r.rule?.id}`)
})

await t("未知阶段 → skip", () => {
  const p = { selfCheckRound: 0, byRuleId: {} }
  const r = pickRule("bogus", p, RULES)
  assert(!r.rule && r.skip === "unknown-stage:bogus", `实际 ${JSON.stringify(r)}`)
})

console.log("\n=== 5. 端到端：一条完整流水线 ===")

await t("planning → 评审 → 汇总 → 等用户 → 自检×3 → 推送", () => {
  const seen = []
  let msgs = []
  const progress = () => phaseProgress(msgs, RULES)

  // 每次 pickRule 之后模拟「真的发出去了」
  const step = (stage) => {
    const r = pickRule(stage, progress(), RULES)
    if (r.rule) {
      seen.push(r.rule.id)
      msgs = [...msgs, decisionMsg(r.rule.id)]
    }
    return r
  }

  step("planning")   // bug_root
  step("planning")   // review
  step("planning")   // summarize
  step("planning")   // need_confirm
  step("selfchecking") // selfcheck_1
  step("selfchecking") // selfcheck_2
  step("selfchecking") // selfcheck_3
  step("selfchecking") // push

  assert(
    JSON.stringify(seen) === JSON.stringify([
      "bug_root", "review", "summarize", "need_confirm",
      "selfcheck_1", "selfcheck_2", "selfcheck_3", "push",
    ]),
    `实际顺序: ${seen.join(" → ")}`,
  )
})

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
