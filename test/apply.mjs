/**
 * 模拟 DSH 的 apply() 调用：用符合真实 API 形状的假 ctx。
 * 目的：挂载前确认 apply 不会抛错。
 */
const host = await import("../host.js")

const config = {
  model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 30000 },
  defaults: { maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.3, humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3 },
  workspaces: [{ path: "/tmp/dsh-decision-orchestrator-test-workspace", enabled: true, rules: [
    {id:"r1",when:"planning",scene:"s1",action:"send",prompt:"p1",notifyText: ""},
    {id:"r2",when:"waiting",scene:"s2",action:"stop",prompt:"",notifyText:"等你"},
  ]}],
}

let registered = null
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
  get: (k) => k === "tokenMeter" ? { estimateMessage: () => 10 } : undefined,
  on: () => {},
  effect: () => {},
}

let pass=0, fail=0
const t=(n,f)=>{try{f();pass++;console.log("  ✅ "+n)}catch(e){fail++;console.log("  ❌ "+n+" — "+e.message)}}
const assert=(c,m)=>{if(!c)throw new Error(m)}

console.log("=== apply() 模拟 ===")
t("apply 不抛错", () => { host.apply(ctx, config) })
t("projection 已注册", () => assert(registered, "未注册"))
t("projection 字段齐全", () => {
  for (const k of ["key","stateVersion","stateSchema","init","apply","wire"]) assert(registered[k] !== undefined, `缺 ${k}`)
  assert(registered.wire.viewSchema, "缺 wire.viewSchema")
  assert(typeof registered.wire.view === "function", "缺 wire.view")
})
t("stateSchema 可 parse 初始状态", () => {
  const s = registered.stateSchema.parse(registered.init({ cwd: "/x" }, 0))
  assert(typeof s.rulesEnabled === "boolean", "rulesEnabled")
  assert(Array.isArray(s.rulesView), "rulesView")
})
t("init 带工作区规则", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  assert(s.rulesEnabled === true, "rulesEnabled 应为 true")
  assert(s.rulesView.length === 2, `rulesView 应为 2 条，实际 ${s.rulesView.length}`)
})
t("rulesView 带全 client 分组渲染需要的字段", () => {
  // client 靠 when 分组、靠 notifyText 展示，任一字段丢失都会静默退化
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const r1 = s.rulesView.find((r) => r.id === "r1")
  assert(r1, "找不到 r1")
  assert(r1.when === "planning", `when 应为 planning，实际 ${r1.when}`)
  const r2 = s.rulesView.find((r) => r.id === "r2")
  assert(r2.when === "waiting", `when 应为 waiting，实际 ${r2.when}`)
  assert(r2.notifyText === "等你", `notifyText 应为 等你，实际 ${r2.notifyText}`)
})
t("view 输出能过 viewSchema", () => {
  const s = registered.init({ cwd: "/tmp/dsh-decision-orchestrator-test-workspace" }, 0)
  const v = registered.wire.viewSchema.parse(registered.wire.view(s))
  assert(v.enabled === true, "enabled")
  assert(Array.isArray(v.rules) && v.rules.length === 2, "rules")
})
t("apply 对非 turn/end 返回同一引用", () => {
  const s = { failures: 0 }
  assert(registered.apply(s, { type: "user/message" }) === s, "应返回同一引用")
})
t("apply 对 turn/end 不计数（防双重计数）", () => {
  // iterations / failures 由主循环经 mutate 持有；
  // 若 projection 也累加，同一个 turn/end 会被数两次，导致 limit=3 时只重试 1 次。
  const s = { failures: 0 }
  const n = registered.apply(s, { type: "turn/end", data: { reason: { kind: "error" } } })
  assert(n === s, "apply 必须恒等返回同一引用")
  assert(n.failures === 0, "不应在此累加 failures")
})
t("view 不含运行期字段", () => {
  const s = registered.init({ cwd: "/x" }, 0)
  const v = registered.wire.view(s)
  assert(!("iterations" in v), "视图不应暴露 iterations（永远不准）")
  assert(!("stopped" in v), "视图不应暴露 stopped（永远不准）")
})

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail?1:0)
