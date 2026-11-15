/**
 * Arbitration: decide whether the plugin should act after this turn.
 *
 * Precedence (high → low); any single hit means stay silent:
 *   1. a human message is queued in the inbox
 *   2. a human spoke within the cooldown window
 *   3. another agent relayed recently
 *   4. a goal is active + armed
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

/** `source.kind` used on messages this plugin sends. */
export const PLUGIN_SOURCE_KIND = "decision"

function timeOf(m) {
  const t = m?.time ?? m?.timestamp ?? 0
  const n = Number(t)
  return Number.isFinite(n) ? n : 0
}

/**
 * Timestamp of the most recent human message.
 * Only `kind === "user"` counts, so this plugin's own "decision"
 * messages are never mistaken for human activity.
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
 * Timestamp of the most recent relay from *another* agent.
 * This plugin's own messages must be excluded, otherwise it suppresses itself.
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

/** Whether the inbox holds a human message still waiting to be processed. */
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
 * Whether a goal is in a state that advances itself.
 *
 * Measured against dsh-goal: phase ∈ {active, paused, blocked, complete},
 *                            activation ∈ {armed, disarmed}.
 * Only active + armed advances on its own; blocked/paused/complete are
 * left to this plugin.
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
 * Whether a scheduled task is about to be delivered to this session.
 *
 * A due schedule injects its own message to trigger the agent, so the plugin
 * must yield or both would advance at once. Any lookup failure is treated as
 * "none" — an exception must never block the main flow.
 */
export async function hasPendingSchedule(ctx, session) {
  try {
    // Cordis wraps services in a Proxy that throws for anything not injected
    // ("cannot get property ... without inject"). Check the service table first;
    // when the table itself is unavailable (test doubles) read directly and let
    // the outer catch handle it.
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

    // The signal is `pendingDelivery` (schedule has decided where to deliver),
    // not the active flag: a task that is active but does not fire until next
    // week must not silence the plugin forever.
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
 * Main arbitration entry point.
 * @returns {Promise<{ allow: boolean, reason: string, detail?: object }>}
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

  // A pending schedule wins → yield (checked before goal, matching precedence).
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
