/**
 * decision-orchestrator 宿主入口。
 *
 * 职责：
 *   1. 注册 sessionProjections 单元（每会话状态可从日志重建）
 *   2. 订阅 session/event，在 turn/end 时驱动主循环
 *   3. 暴露只读查询给 GUI
 */

import { Config, validateConfig } from "./lib/config.js"
import { handleTurnEnd } from "./lib/core.js"
import { SerialQueue } from "./lib/judge.js"
import { log } from "./lib/log.js"

export const name = "decision-orchestrator"
export const inject = ["agents", "sessions", "goals", "schedule", "sessionProjections", "tokenMeter"]
export { Config }

/** projection 单元定义。 */
const PROJECTION_KEY = "decision-orchestrator"

/**
 * 初始状态：由 header.cwd 定位工作区，把规则快照带进 projection。
 * apply 保持纯函数；配置通过 init 的闭包进入 state。
 */
function initialState(header, config) {
  let rulesEnabled = false
  let rulesView = []
  try {
    const wsPath = header?.cwd
    const ws = (config?.workspaces ?? []).find((w) => w?.path === wsPath)
    if (ws?.enabled === true) {
      rulesEnabled = true
      rulesView = (ws.rules ?? []).map((r) => ({
        id: r.id,
        when: r.when,
        scene: r.scene,
        action: r.action,
        prompt: r.prompt ?? "",
        notifyText: r.notifyText ?? "",
      }))
    }
  } catch { /* ignore */ }
  // projection 只放派生事实：运行期计数由主循环持有，不进这里
  return { rulesEnabled, rulesView }
}

/**
 * 纯同步的 projection apply：只做计数，不做任何 IO。
 * 忽略的事件必须返回同一引用。
 */
function applyEvent(state) {
  // 刻意恒等：不在此计数。
  //
  // iterations / failures 属于「运行期决定」，由主循环经 mutate 持有；
  // 若在这里也累加，同一个 turn/end 会被数两次（曾导致 limit=3 时只重试 1 次）。
  //
  // projection 只承载从日志能重建的派生事实 —— 当前是 init 里带出的工作区规则快照。
  // 恒等返回同一引用，也让 projection 缓存不因本单元产生任何写入。
  return state
}

/**
 * 投影状态 schema。
 *
 * 契约（dsh-session-projection）：
 *   - 热读：try { state = def.stateSchema.parse(row.val) } catch { continue }
 *          values[key] = def.wire.viewSchema.parse(def.wire.view(state))   ← 不在 try 内
 *   - 冷读：def.stateSchema.parse(row.val)                                ← 不在 try 内
 * 因此两者都必须存在且可 parse，否则直接抛错导致会话加载失败。
 *
 * 这里给出真正的结构校验：缺失或类型不符的字段回落到安全默认值，
 * 宁可丢一次计数，也不让整个会话读不出来。
 */
const stateSchema = {
  parse(value) {
    const v = value && typeof value === "object" ? value : {}
    return {
      rulesEnabled: v.rulesEnabled === true,
      rulesView: Array.isArray(v.rulesView) ? v.rulesView : [],
    }
  },
}

/** 视图 schema：wire.view 的输出必须能过这一层。 */
const viewSchema = {
  parse(value) {
    const v = value && typeof value === "object" ? value : {}
    return {
      enabled: v.enabled === true,
      rules: Array.isArray(v.rules) ? v.rules : [],
    }
  },
}

/**
 * 暴露给 Client 的视图。
 *
 * practices.md: "When the Client needs a value derived from a session,
 * declare wire.view on the Host projection."
 *
 * summary: true 让 view 的结果进入 client 的 session.projectionValues。
 * state.rulesView 由主循环在每次 turn/end 后写入该会话所属工作区的规则快照。
 */
function viewOf(state) {
  // 只暴露「从日志可重建」的事实：某工作区是否启用、规则是什么。
  // iterations / stopped 属于运行期状态，不在日志里，放进视图只会显示过期的 0。
  return {
    enabled: state?.rulesEnabled === true,
    rules: Array.isArray(state?.rulesView) ? state.rulesView : [],
  }
}

/** 从 agent 反查 session。 */
function sessionOf(agent) {
  return agent?.session ?? undefined
}

/** 对每个 live agent 找它对应的 session。 */
function agentForSession(ctx, session) {
  try {
    const list = ctx.agents.list()
    // 优先按引用匹配（同一实例）；session 被重建时引用会变，
    // 因此再用 session id 兜一层，否则插件会静默失效。
    for (const a of list) {
      if (a?.session === session) return a
    }
    const id = session?.id
    if (id !== undefined) {
      for (const a of list) {
        if (a?.session?.id === id) return a
      }
    }
  } catch { /* ignore */ }
  return undefined
}

export function apply(ctx, config) {
  const queue = new SerialQueue()
  const inflight = new Set()

  // apply 入口标记：用于区分「插件被加载过」与「旧进程残留」
  log({ ev: "apply", pid: process.pid })

  // 配置校验（不阻塞启动，只记录）
  try {
    const errors = validateConfig(config)
    if (errors.length) log({ ev: "config-invalid", errors })
  } catch (e) {
    log({ ev: "config-validate-fail", err: String(e?.message ?? e) })
  }

  // ── 注册 projection ──
  // register 返回 thenable：同步失败走 catch，异步失败要走 then 的 reject。
  // 注册失败只应让插件失效，绝不能影响 DSH 启动或会话读取。
  let projectionHandle
  try {
    projectionHandle = ctx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema,
      init: (header) => initialState(header, config),
      apply: applyEvent,
      wire: {
        viewSchema,
        view: viewOf,
        summary: true,
      },
    })
    log({ ev: "projection-registered", key: PROJECTION_KEY })
    // 异步装配失败：记日志并把句柄作废，后续 stateOf 回落到默认状态
    Promise.resolve(projectionHandle).then(
      () => log({ ev: "projection-ready", key: PROJECTION_KEY }),
      (e) => {
        log({ ev: "projection-async-fail", err: String(e?.message ?? e) })
        projectionHandle = undefined
      },
    )
  } catch (e) {
    log({ ev: "projection-fail", err: String(e?.message ?? e) })
    projectionHandle = undefined
  }

  /** 读取某 session 的 projection 状态。 */
  function stateOf(session) {
    const fallback = () => initialState(session?.header, config)
    try {
      return projectionHandle?.stateOf?.(session) ?? fallback()
    } catch {
      return fallback()
    }
  }

  /**
   * 写回 projection 状态。
   * projection 是纯派生结构，实际计数写在主循环的独立存储里；
   * 这里用 WeakMap 暂存写回值，重启后从日志重建到字符串序列化值时自然归零。
   */
  const runtimeOverrides = new WeakMap()
  function mutate(session, next) {
    if (session && typeof session === "object") runtimeOverrides.set(session, next)
  }
  function currentState(session) {
    return runtimeOverrides.get(session) ?? stateOf(session)
  }

  // ── 订阅 session/event ──
  async function onSessionEvent(session, event) {
    if (!event || event.type !== "turn/end") return

    const agent = agentForSession(ctx, session)
    if (!agent) return

    const sessionId = session?.id ?? "unknown"
    if (inflight.has(sessionId)) return
    inflight.add(sessionId)

    try {
      await handleTurnEnd({
        ctx,
        agent,
        session,
        turnEnd: event.data,
        config,
        state: currentState(session),
        mutate: (next) => mutate(session, next),
        queue,
      })
    } catch (e) {
      log({ ev: "unhandled", sessionId, err: String(e?.message ?? e) })
    } finally {
      inflight.delete(sessionId)
    }
  }

  try {
    ctx.on("session/event", onSessionEvent)
    log({ ev: "subscribed", event: "session/event" })
  } catch (e) {
    log({ ev: "subscribe-fail", err: String(e?.message ?? e) })
  }

  // ── 清理 ──
  try {
    ctx.effect?.(() => () => {
      try { projectionHandle?.dispose?.() } catch { /* ignore */ }
    })
  } catch { /* ignore */ }

  // ── 只读查询（供 client 使用）──
  return {
    /** 列出所有工作区配置。 */
    listWorkspaces() {
      return (config?.workspaces ?? []).map((ws) => ({
        path: ws.path,
        enabled: ws.enabled === true,
        rules: ws.rules ?? [],
      }))
    },
    /** 取某个工作区的配置。 */
    getWorkspace(path) {
      const ws = (config?.workspaces ?? []).find((w) => w.path === path)
      if (!ws) return { path, enabled: false, rules: [] }
      return { path: ws.path, enabled: ws.enabled === true, rules: ws.rules ?? [] }
    },
    /** 配置校验结果。 */
    validate() {
      try {
        return validateConfig(config)
      } catch (e) {
        return [String(e?.message ?? e)]
      }
    },
  }
}
