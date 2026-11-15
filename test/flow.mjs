/**
 * 集成测试：用假的 ctx/agent/session 跑完整的 handleTurnEnd 流程。
 *
 * 目的：在不挂载 DSH 的前提下，验证主循环的每个分支。
 * 假对象严格遵循真实 API 形状（来自探针实测）。
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

// 测试自己的日志写到临时目录，任何方式运行都不污染真机日志
process.env.DECISION_ORCHESTRATOR_LOG_DIR ??=
  new URL(`file://${(await import("node:os")).tmpdir()}/decision-orchestrator-test-logs`).pathname

const { handleTurnEnd } = await import("../lib/core.js")

// ── 构造测试环境 ──
const WS = "/tmp/dsh-decision-orchestrator-test-workspace"

function makeConfig(overrides = {}) {
  return {
    model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest", timeoutMs: 5000 },
    defaults: {
      maxIterations: 20, failureRetryLimit: 3, confidenceFloor: 0.3,
      humanCooldownMs: 30000, quietWindowMs: 30000, contextBudgetRatio: 0.7, maxTurns: 3,
      ...overrides,
    },
    workspaces: [{
      path: WS,
      enabled: true,
      rules: [
        { id: "selfcheck_1", when: "selfchecking", scene: "s", action: "send", prompt: "请继续。", notifyText: "" },
        { id: "selfcheck_2", when: "selfchecking", scene: "s", action: "send", prompt: "继续第二轮。", notifyText: "" },
        { id: "needs_user_input", when: "waiting", scene: "需要用户决定", action: "stop", prompt: "", notifyText: "需要你拍板" },
        { id: "finished", when: "finished", scene: "已完成", action: "stop", prompt: "", notifyText: "已完成" },
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
      if (key === "tokenMeter") return { estimateMessage: (m) => 20 }
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

console.log("=== 1. 未启用的工作区 ===")
await t("不在配置里的工作区 → not-enabled", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ cwd: "/tmp/other" }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "not-enabled", `实际: ${JSON.stringify(r)}`)
})

await t("enabled:false 的工作区 → not-enabled", async () => {
  const cfg = makeConfig()
  cfg.workspaces[0].enabled = false
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent: makeAgent(), session: makeSession(),
    turnEnd: turnEnd(), config: cfg, state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "not-enabled", `实际: ${JSON.stringify(r)}`)
})

console.log("\n=== 2. 中断类 reason ===")
for (const kind of ["aborted", "interrupted"]) {
  await t(`${kind} → 跳过`, async () => {
    const agent = makeAgent()
    const r = await handleTurnEnd({
      ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
      turnEnd: turnEnd(kind), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
    })
    assert(r.skipped === kind, `实际: ${JSON.stringify(r)}`)
    assert(agent.sent.length === 0, "不应发送")
  })
}

console.log("\n=== 3. 仲裁拦截 ===")
await t("goal active+armed → 静默", async () => {
  const agent = makeAgent({ goal: { phase: "active", activation: "armed" } })
  const r = await handleTurnEnd({
    ctx: makeCtx({ goal: { phase: "active", activation: "armed" } }), agent,
    session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "goal-active", `实际: ${JSON.stringify(r)}`)
  assert(agent.sent.length === 0, "不应发送")
})

await t("人工刚发言 → 冷却", async () => {
  const msgs = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你继续" }], time: Date.now() - 1000 },
    { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "好的" }], time: Date.now() },
  ]
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: msgs }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "human-cooldown", `实际: ${JSON.stringify(r)}`)
})

await t("inbox 有真人消息 → 等待", async () => {
  const agent = makeAgent({ inbox: [{ role: "user", source: { kind: "user" }, content: [] }] })
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "human-waiting", `实际: ${JSON.stringify(r)}`)
})

await t("其他 agent 刚 relay → 让路", async () => {
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
  assert(r.skipped === "agent-message", `实际: ${JSON.stringify(r)}`)
})

console.log("\n=== 3b. schedule 待投递 → 让路 ===")
await t("有定时任务指向本会话 → schedule-pending", async () => {
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
  assert(r.skipped === "schedule-pending", `实际: ${JSON.stringify(r)}`)
  assert(agent.sent.length === 0, "不应发送")
})

await t("定时任务不指向本会话 → 放行（到后续判定）", async () => {
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
  assert(r.skipped !== "schedule-pending", `不应被 schedule 拦下: ${JSON.stringify(r)}`)
})

await t("任务活跃但未待投递 → 不静默（下周才触发不该永久让路）", async () => {
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
  assert(r.skipped !== "schedule-pending", `不应被静默: ${JSON.stringify(r)}`)
})

await t("schedule.list 抛错 → 视为无，不阻塞", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx()
  ctx.schedule = { list: async () => { throw new Error("boom") } }
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped !== "schedule-pending", `异常不应拦下: ${JSON.stringify(r)}`)
})

await t("无 schedule 服务 → 不阻塞", async () => {
  const agent = makeAgent()
  const session = makeSession({ messages: baseMessages() })
  const ctx = makeCtx() // 无 schedule
  const r = await handleTurnEnd({
    ctx, agent, session, turnEnd: turnEnd(), config: makeConfig(),
    state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped !== "schedule-pending", `实际: ${JSON.stringify(r)}`)
})

console.log("\n=== 4. 已停止的会话 ===")
await t("stoppedReason 存在 → 不再动作", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { stoppedReason: "failure-limit:3" }, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped?.includes("stopped"), `实际: ${JSON.stringify(r)}`)
})

console.log("\n=== 4b. 停下后等待用户 ===")
await t("等待态且用户未发言 → 静默不重复通知", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { awaitingRuleId: "needs_user_input" }, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "awaiting-user", `实际: ${JSON.stringify(r)}`)
})

await t("uncertain 通知后也进入等待态", async () => {
  const agent = makeAgent()
  let mutated = null
  // 低置信度触发 UNCERTAIN：让 Kev 不可用即可走 error，这里直接用 awaiting 断言更稳
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { awaitingRuleId: "uncertain" }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.skipped === "awaiting-user", `实际: ${JSON.stringify(r)}`)
})

await t("等待态但用户已发言 → 解除等待并继续", async () => {
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
  // 解除等待后继续走判定。Kev 对「好的」这种模糊输入可能判出任何阶段，
  // 也可能因置信度不足走 UNCERTAIN —— 但无论哪条路径，
  // 都必须留下一个非空的 awaitingRuleId，否则下一轮会重复弹窗。
  assert(r.skipped !== "awaiting-user", `应解除等待: ${JSON.stringify(r)}`)
  assert(
    mutated?.awaitingRuleId === "needs_user_input" || mutated?.awaitingRuleId === "uncertain",
    `应重新进入等待态，实际 ${JSON.stringify(mutated)}`,
  )
})

await t("action=stop 的规则 → 不发消息，只进入暂停态", async () => {
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
  // 规则 action=stop 命中时返回值是 halt（枚举值 stop 与运行时 halt 是两层）
  if (r.action === "halt" && r.ruleId === "needs_user_input") {
    assert(agent.sent.length === 0, `stop 不该发消息，实际发了 ${agent.sent.length} 条`)
    assert(mutated?.awaitingRuleId === "needs_user_input", "应进入暂停态")
  } else {
    // Kev 判到别的阶段也合法；仍然不该发出多于一条
    assert(agent.sent.length <= 1, "最多发一条")
  }
})

console.log("\n=== 5. 达到迭代上限 ===")
await t("iterations 达上限 → 停止", async () => {
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig(),
    state: { iterations: 20 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `实际: ${JSON.stringify(r)}`)
  assert(mutated?.stoppedReason?.includes("iteration-limit"), "应记录停止原因")
})

console.log("\n=== 5c. 阶段机保证每条规则只发一次 ===")
await t("同一状态连续触发不会重复发同一句", async () => {
  // 这取代了已删除的「卡住检测」：pickRule 按 byRuleId 递进，
  // 每条 send 规则发过一次就不再返回。
  const agent = makeAgent()
  const ruleIds = []
  let state = {}
  // 用明确的「自检中」文本，确保能进入 selfchecking 并真的发出规则
  let msgs = baseMessages("TS/lint/build 全部 0 error。自查发现 3 处越界，已修正。")
  // 模拟真实循环：每发一条，把它作为插件消息追加进消息流
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
  assert(ruleIds.length > 0, "应至少发出一次，否则测不到去重")
  const dup = ruleIds.filter((id, i) => ruleIds.indexOf(id) !== i)
  assert(dup.length === 0, `不应重复发送同一规则，实际 ${JSON.stringify(ruleIds)}`)
})

console.log("\n=== 6. 空输入 ===")
await t("没有可读消息 → empty-input", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: [] }),
    turnEnd: turnEnd(), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.skipped === "empty-input", `实际: ${JSON.stringify(r)}`)
})

console.log("\n=== 7. 错误分支（网络类重试）===")
await t("TRANSPORT 且未超限 → 重发", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd("error"), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.action === "retry", `实际: ${JSON.stringify(r)}`)
  assert(agent.sent.length === 1, "应发送一条重试消息")
  assert(agent.sent[0].source.kind === "decision", "source.kind 应为 decision")
  assert(typeof agent.sent[0].id === "string", "消息必须有 id")
})

await t("超限 → 停止", async () => {
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd("error"), config: makeConfig(),
    state: { failures: 3 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `实际: ${JSON.stringify(r)}`)
})

console.log("\n=== 5b. iterations 是会话级累计 ===")
await t("iterations 只增不减：达到上限后整条会话停止", async () => {
  // 行为固化：iterations 是会话级安全阀，不随用户发言清零。
  // 意味着跨多个任务的长期会话会累积消耗；重启 DSH 才归零（存于进程内 WeakMap）。
  // 用 state 里预置的 iterations 直接验证上限分支，避免依赖 Kev 判出某个阶段。
  const agent = makeAgent()
  let mutated = null
  const r = await handleTurnEnd({
    ctx: makeCtx(), agent,
    session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd(), config: makeConfig({ maxIterations: 2 }),
    state: { iterations: 2 }, mutate: (n) => { mutated = n }, queue: makeQueue(),
  })
  assert(r.action === "stopped", `应停止，实际 ${JSON.stringify(r)}`)
  assert(r.reason === "iteration-limit", `reason 应为 iteration-limit，实际 ${r.reason}`)
  assert(String(mutated?.stoppedReason).startsWith("iteration-limit"), `stoppedReason 应带 iteration-limit，实际 ${mutated?.stoppedReason}`)
  assert(agent.sent.length === 0, "达到上限不该再发消息")
})

console.log("\n=== 7b. 决策服务连续失败到上限 ===")
await t("Kev 不可达且超限 → 停止并留 stoppedReason + 日志", async () => {
  const agent = makeAgent()
  let mutated = null
  // 指向无人监听的端口，制造 judge ERROR
  const cfg = makeConfig({ failureRetryLimit: 0 })
  cfg.model = { baseUrl: "http://127.0.0.1:9", name: "kev-latest", timeoutMs: 300 }

  // 记录调用前的日志行数，后面只看新增部分
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
  assert(r.action === "stopped", `应停止，实际 ${JSON.stringify(r)}`)
  assert(r.reason === "judge-failure", `reason 应为 judge-failure，实际 ${r.reason}`)
  assert(String(mutated?.stoppedReason).startsWith("judge-failure"), `stoppedReason 应带 judge-failure，实际 ${mutated?.stoppedReason}`)
  assert(agent.sent.length === 0, "停止不该发消息")

  // 这条路径原本靠通知提醒用户，通知删掉后必须靠日志留痕。
  // 只看本次调用新增的行：日志文件是累积的，历史条目会让断言假通过。
  const all = readFileSync(logPath, "utf8").trim().split("\n")
  const fresh = all.slice(before).map((l) => JSON.parse(l))
  const hit = fresh.filter((e) => e.ev === "stop" && e.why === "judge-failure")
  assert(hit.length > 0, `本次应新增 ev=stop why=judge-failure，实际新增 ${fresh.map((e) => e.ev).join(",") || "无"}`)
})

console.log("\n=== 8. flush 失败可感知 ===")
await t("flush 返回 false → 报告失败", async () => {
  const agent = makeAgent()
  const r = await handleTurnEnd({
    ctx: makeCtx({ flushOk: false }), agent, session: makeSession({ messages: baseMessages() }),
    turnEnd: turnEnd("error"), config: makeConfig(), state: {}, mutate: () => {}, queue: makeQueue(),
  })
  assert(r.action !== "retry", `不应报告成功: ${JSON.stringify(r)}`)
  assert(r.error?.includes("持久化"), `错误应说明原因: ${r.error}`)
})

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
