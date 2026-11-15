/**
 * decision-orchestrator host entry point.
 *
 * Responsibilities:
 *   1. Register the sessionProjections unit (per-session state, rebuildable
 *      from the log)
 *   2. Subscribe to session/event and drive the main loop on turn/end
 *   3. Expose read-only queries to the GUI
 */

import { resolveUiLocale } from "./lib/host-locale.js"
import { Config, validateConfig } from "./lib/config.js"
import { BUILTIN_STAGES } from "./lib/stages.js"
import { handleTurnEnd } from "./lib/core.js"
import { SerialQueue } from "./lib/judge.js"
import { log } from "./lib/log.js"

export const name = "decision-orchestrator"
export const inject = ["agents", "sessions", "goals", "schedule", "sessionProjections", "tokenMeter"]
export { Config }

/** Projection unit definition. */
const PROJECTION_KEY = "decision-orchestrator"

/**
 * Initial state: locate the workspace via `header.cwd` and carry a snapshot of
 * its rules into the projection. `apply` stays pure; config reaches the state
 * through the closure created in `init`.
 */
function initialState(header, config) {
  let rulesEnabled = false
  let rulesView = []
  let stagesView = []
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
  // Stage definitions the client renders its group headings from. Read once at
  // init: they come from the same config the rules do.
  try {
    // Same fallback effectiveConfig uses: an absent `stages` means the
    // built-ins, not "no stages". Without this the panel would receive an empty
    // list and show every rule under "unrecognized stage".
    stagesView = (config?.stages ?? BUILTIN_STAGES).map((st) => ({
      id: st.id,
      behavior: st.behavior,
      label: { en: st.label?.en ?? st.id, zh: st.label?.zh ?? st.id },
    }))
  } catch { /* ignore */ }
  // The projection holds derived facts only; runtime counters belong to the
  // main loop and never go here.
  return { rulesEnabled, rulesView, stagesView }
}

/**
 * Purely synchronous projection `apply`: counting only, no IO whatsoever.
 * An ignored event must return the same reference.
 */
function applyEvent(state) {
  // Deliberately identity: no counting happens here.
  //
  // iterations / failures are runtime decisions held by the main loop through
  // `mutate`. Counting them here as well would count one turn/end twice.
  //
  // The projection carries only facts rebuildable from the log — currently the
  // workspace rule snapshot taken in `init`. Returning the same reference also
  // keeps this unit from ever writing to the projection cache.
  return state
}

/**
 * Projection state schema.
 *
 * Contract (dsh-session-projection):
 *   - warm read: try { state = def.stateSchema.parse(row.val) } catch { continue }
 *                values[key] = def.wire.viewSchema.parse(def.wire.view(state))  ← outside the try
 *   - cold read: def.stateSchema.parse(row.val)                               ← outside the try
 * So both schemas must exist and be parseable; otherwise the throw takes down
 * session loading.
 *
 * This performs real structural validation: missing or mistyped fields fall back
 * to safe defaults. Better to lose one count than to make a whole session
 * unreadable.
 */
const stateSchema = {
  parse(value) {
    const v = value && typeof value === "object" ? value : {}
    return {
      rulesEnabled: v.rulesEnabled === true,
      rulesView: Array.isArray(v.rulesView) ? v.rulesView : [],
      stagesView: Array.isArray(v.stagesView) ? v.stagesView : [],
    }
  },
}

/**
 * View schema: whatever `wire.view` returns must survive this layer.
 *
 * Every field `viewOf` produces has to be listed here. A field missing from
 * this parse is dropped silently — the client then renders against an empty
 * value with nothing indicating why.
 */
const viewSchema = {
  parse(value) {
    const v = value && typeof value === "object" ? value : {}
    return {
      enabled: v.enabled === true,
      rules: Array.isArray(v.rules) ? v.rules : [],
      stages: Array.isArray(v.stages) ? v.stages : [],
    }
  },
}

/**
 * The view exposed to the client.
 *
 * practices.md: "When the Client needs a value derived from a session,
 * declare wire.view on the Host projection."
 *
 * `summary: true` puts the view's result into the client's
 * `session.projectionValues`. `state.rulesView` is written by the main loop
 * after each turn/end with the rule snapshot of the session's workspace.
 */
function viewOf(state) {
  // Expose only facts rebuildable from the log: whether a workspace is enabled
  // and what its rules are. iterations / stopped are runtime state that never
  // reaches the log, so exposing them would show a stale 0.
  return {
    enabled: state?.rulesEnabled === true,
    rules: Array.isArray(state?.rulesView) ? state.rulesView : [],
    stages: Array.isArray(state?.stagesView) ? state.stagesView : [],
  }
}

/** Find the session behind each live agent. */
function agentForSession(ctx, session) {
  try {
    const list = ctx.agents.list()
    // Match by reference first (same instance). References change when a
    // session is rebuilt, so session id is the fallback — without it the plugin
    // would silently stop working.
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

  // Apply-entry marker: distinguishes "plugin loaded" from "stale process".
  log({ ev: "apply", pid: process.pid })

  // The UI language drives the prompts sent to the agent and the panel text.
  // Settings win over the config field, so following the DSH setting is the
  // default behaviour rather than something the user must duplicate.
  const effectiveLocale = resolveUiLocale(ctx)
  config = { ...(config && typeof config === "object" ? config : {}), locale: effectiveLocale }
  log({ ev: "locale", resolved: effectiveLocale })

  // Config validation (never blocks startup, logs only)
  try {
    const errors = validateConfig(config)
    if (errors.length) log({ ev: "config-invalid", errors })
  } catch (e) {
    log({ ev: "config-validate-fail", err: String(e?.message ?? e) })
  }

  // ── Register the projection ──
  // `register` returns a thenable: synchronous failures hit `catch`, async ones
  // reject through `then`. A registration failure must disable only this plugin —
  // it must never affect DSH startup or session reads.
  let projectionHandle
  try {
    projectionHandle = ctx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 2,
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
    // Async wiring failed: log it and drop the handle so later stateOf calls
    // fall back to the default state.
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

  /** Read the projection state of one session. */
  function stateOf(session) {
    const fallback = () => initialState(session?.header, config)
    try {
      return projectionHandle?.stateOf?.(session) ?? fallback()
    } catch {
      return fallback()
    }
  }

  /**
   * Write the projection state back.
   * The projection is a purely derived structure, so actual counters live in the
   * main loop's own store. This WeakMap only caches the written value; after a
   * restart it is rebuilt from the log and naturally resets to defaults.
   */
  const runtimeOverrides = new WeakMap()
  function mutate(session, next) {
    if (session && typeof session === "object") runtimeOverrides.set(session, next)
  }
  function currentState(session) {
    return runtimeOverrides.get(session) ?? stateOf(session)
  }

  // ── Subscribe to session/event ──
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

  // ── Teardown ──
  try {
    ctx.effect?.(() => () => {
      try { projectionHandle?.dispose?.() } catch { /* ignore */ }
    })
  } catch { /* ignore */ }

  // ── Read-only queries (used by the client) ──
  return {
    /** List every workspace config. */
    listWorkspaces() {
      return (config?.workspaces ?? []).map((ws) => ({
        path: ws.path,
        enabled: ws.enabled === true,
        rules: ws.rules ?? [],
      }))
    },
    /** Get the config of one workspace. */
    getWorkspace(path) {
      const ws = (config?.workspaces ?? []).find((w) => w.path === path)
      if (!ws) return { path, enabled: false, rules: [] }
      return { path: ws.path, enabled: ws.enabled === true, rules: ws.rules ?? [] }
    },
    /** Config validation result. */
    validate() {
      try {
        return validateConfig(config)
      } catch (e) {
        return [String(e?.message ?? e)]
      }
    },
  }
}
