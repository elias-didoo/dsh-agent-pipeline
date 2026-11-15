/**
 * 主循环：turn/end → 仲裁 → 决策 → 动作。
 *
 * 状态放在 sessionProjections 里（官方推荐），而不是进程内存：
 * 重启后可从日志重建，且不订阅全量 session/event。
 */

import { arbitrate, lastHumanAt } from "./arbiter.js"
import { buildState } from "./context.js"
import { judge, Outcome, isRetryable } from "./judge.js"
import { phaseProgress, pickRule } from "./phases.js"
import { sendMessage } from "./action.js"
import { effectiveConfig } from "./config.js"
import { log, summarize } from "./log.js"

/**
 * 从 projection state 读取运行时状态。
 * projection 的 apply 只做纯计数，这里补齐派生判断。
 */
export function readRuntime(state) {
  return {
    iterations: state?.iterations ?? 0,
    failures: state?.failures ?? 0,
    stoppedReason: state?.stoppedReason ?? null,
    awaitingRuleId: state?.awaitingRuleId ?? null,
  }
}

/**
 * 处理一次 turn/end。
 *
 * @param {object} p
 * @param {object} p.ctx
 * @param {object} p.agent
 * @param {object} p.session
 * @param {object} p.turnEnd     event.data（{ turn, reason }）
 * @param {object} p.config      插件 Config（原始）
 * @param {object} p.state       projection 当前状态（可写回通过 mutate）
 * @param {Function} p.mutate    更新 projection 状态
 * @param {object} p.queue       串行队列
 * @returns {Promise<object>} 运行结果，`action` 取值：
 *   - `send`    发了一条提示词
 *   - `retry`   网络中断后自动重发「请继续」
 *   - `halt`    当前阶段走完或判定不确定，暂停自动推进等用户
 *   - `stopped` 因错误、迭代上限或判定卡住而终止（另有 `reason`）
 *   - `error`   本次执行出错但未到终止阈值
 *   或 `{ skipped }` 表示被拦下未动作
 */
export async function handleTurnEnd({ ctx, agent, session, turnEnd, config, state, mutate, queue }) {
  const sessionId = session?.id ?? "unknown"
  const wsPath = session?.header?.cwd
  const cfg = wsPath ? effectiveConfig(config, wsPath) : null
  if (!cfg) return { skipped: "not-enabled" }

  const reasonKind = turnEnd?.reason?.kind ?? "unknown"
  // 可变：解除等待时要同步更新这份快照，否则后续 mutate({...rt}) 会把旧值写回去。
  let rt = readRuntime(state)

  if (rt.stoppedReason) return { skipped: `stopped:${rt.stoppedReason}` }

  // 中断不算失败，直接跳过
  if (reasonKind === "aborted" || reasonKind === "interrupted") {
    log({ ev: "skip", sessionId, wsPath, why: reasonKind })
    return { skipped: reasonKind }
  }

  let messages = []
  try {
    messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : []
  } catch (e) {
    log({ ev: "skip", sessionId, why: "derive-failed", err: String(e?.message ?? e) })
    return { skipped: "derive-failed" }
  }

  // 已暂停并等待用户：用户真的发言后解除；否则保持静默，
  // 避免每个 turn 都重新判定。
  if (rt.awaitingRuleId) {
    const humanAt = lastHumanAt(messages)
    if (humanAt > 0 && Date.now() - humanAt < 5 * 60 * 1000) {
      rt = { ...rt, awaitingRuleId: null }
      mutate(rt)
    } else {
      log({ ev: "skip", sessionId, wsPath, why: `awaiting:${rt.awaitingRuleId}` })
      return { skipped: "awaiting-user" }
    }
  }

  // ── 错误分支：网络/超时类有限重发 ──
  if (reasonKind === "error") {
    const code = turnEnd?.reason?.error?.code ?? "UNKNOWN"
    const retryable = isRetryable(code)
    const failures = rt.failures + 1
    const limit = cfg.failureRetryLimit ?? 3

    log({ ev: "error", sessionId, wsPath, code, retryable, failures, limit })

    if (!retryable || failures > limit) {
      mutate({ ...rt, failures, stoppedReason: retryable ? `failure-limit:${failures}` : `non-retryable:${code}` })
      log({ ev: "stop", sessionId, wsPath, why: retryable ? "failure-limit" : "non-retryable" })
      return { action: "stopped", reason: code }
    }

    // 可重发：发一条「继续」让 agent 重试
    mutate({ ...rt, failures })
    const sent = await sendMessage({ agent, ctx, text: "刚才的请求似乎中断了，请继续。", ruleId: "retry" })
    log({ ev: "retry", sessionId, wsPath, ok: sent.ok, err: sent.error })
    return { action: sent.ok ? "retry" : "error", error: sent.error }
  }

  // ── 正常完成 ──
  const arb = await arbitrate({ ctx, agent, session, messages, cfg })
  if (!arb.allow) {
    log({ ev: "skip", sessionId, wsPath, why: arb.reason, detail: arb.detail })
    return { skipped: arb.reason }
  }

  if (rt.iterations >= (cfg.maxIterations ?? 20)) {
    mutate({ ...rt, stoppedReason: `iteration-limit:${rt.iterations}` })
    log({ ev: "stop", sessionId, wsPath, why: "iteration-limit" })
    return { action: "stopped", reason: "iteration-limit" }
  }

  // 构建输入
  const measure = makeMeasure(ctx)
  const { state: input, stats } = buildState(messages, cfg, 8192, measure)
  if (!input.trim()) {
    log({ ev: "skip", sessionId, wsPath, why: "empty-input" })
    return { skipped: "empty-input" }
  }

  // 决策（串行）
  const result = await queue.run(() => judge({ state: input, cfg }))

  log({
    ev: "judge",
    sessionId,
    wsPath,
    outcome: result.outcome,
    stage: result.stage,
    confidence: result.confidence,
    rawConfidence: result.rawConfidence,
    reason: result.reason,
    error: result.error,
    input: stats,
    msg: summarize(messages),
  })

  // 决策服务失败
  if (result.outcome === Outcome.ERROR) {
    const failures = rt.failures + 1
    const limit = cfg.failureRetryLimit ?? 3
    if (failures > limit) {
      mutate({ ...rt, failures, stoppedReason: `judge-failure:${failures}` })
      log({ ev: "stop", sessionId, wsPath, why: "judge-failure", failures })
      return { action: "stopped", reason: "judge-failure" }
    }
    mutate({ ...rt, failures })
    return { action: "error", error: result.error }
  }

  // 不确定 → 暂停自动推进，避免每轮都重新调 Kev
  if (result.outcome === Outcome.UNCERTAIN) {
    rt = { ...rt, awaitingRuleId: "uncertain" }
    mutate(rt)
    log({ ev: "uncertain", sessionId, wsPath, reason: result.reason })
    return { action: "halt", reason: result.reason }
  }

  // Kev 判出阶段后，由日志进度决定这一轮发哪条规则
  const stage = result.stage
  const progress = phaseProgress(messages, cfg.rules)
  const picked = pickRule(stage, progress, cfg.rules)

  if (!picked.rule) {
    log({ ev: "skip", sessionId, wsPath, stage, why: picked.skip, progress })
    return { skipped: `stage:${picked.skip}`, stage }
  }

  const rule = picked.rule
  log({ ev: "pick", sessionId, wsPath, stage, ruleId: rule.id, progress })

  // 该阶段走完 → 停下来等用户，不自动发送
  if (rule.action === "stop") {
    // 进入暂停态：避免后续每个 turn 都重新判定、重复停在同一处。
    // 用户真的发言后解除（见上方的 awaitingRuleId 判断）。
    mutate({ ...rt, awaitingRuleId: rule.id })
    log({ ev: "halt", sessionId, wsPath, ruleId: rule.id })
    return { action: "halt", ruleId: rule.id }
  }

  // 发送
  const sent = await sendMessage({ agent, ctx, text: rule.prompt, ruleId: rule.id })
  if (!sent.ok) {
    mutate({ ...rt, failures: rt.failures + 1 })
    log({ ev: "send-fail", sessionId, wsPath, ruleId: rule.id, err: sent.error })
    return { action: "error", error: sent.error }
  }

  mutate({
    ...rt,
    iterations: rt.iterations + 1,
    failures: 0,
  })
  log({ ev: "send", sessionId, wsPath, ruleId: rule.id, iteration: rt.iterations + 1, messageId: sent.messageId })
  return { action: "send", ruleId: rule.id, messageId: sent.messageId }
}

/** 用 tokenMeter 做精确估算，不可用时返回 undefined 走退化路径。 */
function makeMeasure(ctx) {
  try {
    const tm = ctx.get("tokenMeter")
    if (tm && typeof tm.estimateMessage === "function") {
      return (msg) => tm.estimateMessage(msg) + 8
    }
  } catch { /* ignore */ }
  return undefined
}


