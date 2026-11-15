/**
 * 仲裁：决定这次 turn 结束后，插件该不该动作。
 *
 * 优先级（高 → 低），任一成立即静默：
 *   1. 人工消息在 inbox 等待
 *   2. 人工冷却期内发过消息
 *   3. 其他 agent 刚 relay
 *   4. goal 处于 active + armed
 */

export const Decision = {
  ALLOW: "allow",
  HUMAN_WAITING: "human-waiting",
  HUMAN_COOLDOWN: "human-cooldown",
  SCHEDULE_PENDING: "schedule-pending",
  GOAL_ACTIVE: "goal-active",
  AGENT_MESSAGE: "agent-message",
  NOT_ENABLED: "not-enabled",
}

/** 本插件发送的消息 kind。 */
export const PLUGIN_SOURCE_KIND = "decision"

function timeOf(m) {
  const t = m?.time ?? m?.timestamp ?? 0
  const n = Number(t)
  return Number.isFinite(n) ? n : 0
}

/**
 * 最近一条真人消息的时间戳。
 * 只认 kind === "user"：本插件的 "decision" 不会被误判成人工活动。
 */
export function lastHumanAt(messages) {
  let last = 0
  for (const m of messages ?? []) {
    if (m?.role !== "user") continue
    if (m?.source?.kind !== "user") continue
    const t = timeOf(m)
    if (t > last) last = t
  }
  return last
}

/**
 * 最近一条「其他 agent relay」的时间戳。
 * 必须排除本插件自己发的消息，否则会自我抑制。
 */
export function lastAgentMessageAt(messages, selfSessionId) {
  let last = 0
  for (const m of messages ?? []) {
    if (m?.role !== "user") continue
    if (m?.source?.kind !== "agent-message") continue
    if (selfSessionId !== undefined && m?.source?.senderSessionId === selfSessionId) continue
    const t = timeOf(m)
    if (t > last) last = t
  }
  return last
}

/** inbox 里是否有待处理的人工消息。 */
export function hasPendingHuman(agent) {
  try {
    const inbox = agent?.inbox
    if (!inbox) return false
    for (const list of [inbox.nextTurn, inbox.nextStep]) {
      if (!Array.isArray(list)) continue
      for (const m of list) {
        if (m?.source?.kind === "user") return true
      }
    }
  } catch { /* ignore */ }
  return false
}

/**
 * goal 是否处于「会自己继续」的状态。
 *
 * 实测（dsh-goal）：phase ∈ {active, paused, blocked, complete}
 *                   activation ∈ {armed, disarmed}
 * 只有 active + armed 由 goal 自己推进；blocked/paused/complete 交给插件。
 */
export function isGoalDriving(ctx, agent) {
  try {
    const g = ctx?.goals?.get?.(agent)
    if (!g) return false
    return g.phase === "active" && g.activation === "armed"
  } catch {
    return false
  }
}

/**
 * 是否有定时任务即将投递到本会话。
 *
 * schedule 到点会自己发一条消息触发 agent，插件必须让路，
 * 否则两边同时推进。查询失败一律视为「无」，不让异常阻塞主流程。
 */
export async function hasPendingSchedule(ctx, session) {
  try {
    // cordis 的 Proxy 对未注入的服务直接抛错（cannot get property ... without inject）。
    // 先看服务表里有没有；服务表本身不可用时（如测试替身）直接读，由外层 catch 兜底。
    let schedule
    try {
      const props = ctx?.reflect?.props
      if (props !== undefined && props.schedule === undefined) return false
      schedule = ctx.schedule
    } catch {
      return false
    }
    if (!schedule || typeof schedule.list !== "function") return false

    const sessionId = session?.id
    if (sessionId === undefined) return false

    // 判据是 pendingDelivery（schedule 已经决定要投给谁），不是 active 状态：
    // 一个「活跃但下周才触发」的定时任务不该让插件永久静默。
    const result = await schedule.list({ active: true, limit: 500 })
    const items = Array.isArray(result?.items) ? result.items : []
    for (const item of items) {
      if (item?.pendingDelivery?.targetSessionId === sessionId) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 主仲裁。
 * 返回 { allow, reason, detail? }。
 */
export async function arbitrate({ ctx, agent, session, messages, cfg, now = Date.now() }) {
  if (!cfg) return { allow: false, reason: Decision.NOT_ENABLED }

  if (hasPendingHuman(agent)) {
    return { allow: false, reason: Decision.HUMAN_WAITING }
  }

  const humanAt = lastHumanAt(messages)
  const cooldown = cfg.humanCooldownMs ?? 30000
  if (humanAt && now - humanAt < cooldown) {
    return { allow: false, reason: Decision.HUMAN_COOLDOWN, detail: { agoMs: now - humanAt, cooldown } }
  }

  // schedule 即将投递 → 让路（先于 goal 判定，与计划顺序一致）
  if (await hasPendingSchedule(ctx, session)) {
    return { allow: false, reason: Decision.SCHEDULE_PENDING }
  }

  const agentAt = lastAgentMessageAt(messages, session?.id)
  const quiet = cfg.quietWindowMs ?? 30000
  if (agentAt && now - agentAt < quiet) {
    return { allow: false, reason: Decision.AGENT_MESSAGE, detail: { agoMs: now - agentAt, quiet } }
  }

  if (isGoalDriving(ctx, agent)) {
    return { allow: false, reason: Decision.GOAL_ACTIVE }
  }

  return { allow: true, reason: Decision.ALLOW }
}
