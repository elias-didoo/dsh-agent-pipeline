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
import { handleTurnEnd, beginFlow, controlFlow } from "./lib/core.js"
import { registerFlowTools } from "./lib/flow-tools.js"
import { effectiveConfig } from "./lib/config.js"
import { SerialQueue } from "./lib/judge.js"
import { log } from "./lib/log.js"

export const name = "decision-orchestrator"
export const inject = ["agents", "sessions", "goals", "schedule", "sessionProjections", "tokenMeter"]
export { Config }

/** Projection unit definition. */
const PROJECTION_KEY = "decision-orchestrator"

/**
 * Initial state: locate the workspace via `header.cwd`.
 *
 * The projection carries only what cannot be rebuilt from the transcript: which
 * flow this session is running, its lifecycle, and how its branches went. The
 * cursor and each step's status are recomputed from the messages on every turn,
 * so storing them here would be a second copy that could disagree with the log.
 */
function initialState(header, config) {
  try {
    const ws = workspacesOf(config).find((w) => w?.path === header?.cwd)
    return { enabled: ws?.enabled === true }
  } catch {
    return { enabled: false }
  }
}

/**
 * Purely synchronous projection `apply`.
 *
 * Deliberately identity: iterations, failures and the flow cursor are runtime
 * decisions the main loop owns through `mutate`. Counting them here as well
 * would count one turn/end twice, and a flow position derived here would have
 * to agree with the one derived from the transcript.
 */
function applyEvent(state) {
  return state
}

/**
 * Projection state schema.
 *
 * Contract (dsh-session-projection):
 *   - warm read: try { state = def.stateSchema.parse(row.val) } catch { continue }
 *   - cold read: def.stateSchema.parse(row.val)
 * So the schema must exist and be parseable; otherwise the throw takes down
 * session loading. This performs real structural validation: a missing or
 * mistyped field falls back to a safe default. Better to lose one field than to
 * make a whole session unreadable.
 */
const stateSchema = {
  parse(value) {
    const v = value && typeof value === "object" ? value : {}
    return {
      enabled: v.enabled === true,
      flow: normalizeFlow(v.flow),
    }
  },
}

/** Keep only the fields the panel and the machine need. */
function normalizeFlow(flow) {
  if (!flow || typeof flow !== "object" || typeof flow.name !== "string" || !flow.name) return null
  return {
    name: flow.name,
    status: typeof flow.status === "string" ? flow.status : "active",
    startedAt: Number.isFinite(flow.startedAt) ? flow.startedAt : 0,
    since: Number.isFinite(flow.since) ? flow.since : 0,
    note: typeof flow.note === "string" ? flow.note : "",
    branches: flow.branches && typeof flow.branches === "object" ? { ...flow.branches } : {},
    passed: Array.isArray(flow.passed) ? flow.passed.filter((x) => typeof x === "string") : [],
  }
}

/**
 * View schema: whatever `wire.view` returns must survive this layer.
 *
 * Every field `viewOf` produces has to be listed here. A field missing from this
 * parse is dropped silently — the client then renders against an empty value
 * with nothing indicating why.
 */
const viewSchema = {
  parse(value) {
    const v = value && typeof value === "object" ? value : {}
    return {
      enabled: v.enabled === true,
      flow: v.flow && typeof v.flow === "object" ? v.flow : null,
    }
  },
}

/**
 * The view exposed to the client.
 *
 * practices.md: "When the Client needs a value derived from a session, declare
 * wire.view on the Host projection." `summary: true` puts the result into the
 * client's `session.projectionValues`.
 */
function viewOf(state) {
  return {
    enabled: state?.enabled === true,
    flow: state?.flow ?? null,
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
      stateVersion: 4,
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

  /**
   * Apply one control action to a session's flow.
   *
   * Shared by the panel command and the returned API so the two cannot drift:
   * there is one implementation of what "pause" means.
   */
  function flowControl(session, action) {
    const cfg = effectiveConfig(config, session?.header?.cwd)
    if (!cfg) return false
    let messages = []
    try {
      messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : []
    } catch { /* ignore */ }
    const next = controlFlow({ action, rt: currentState(session), messages, cfg })
    mutate(session, next)
    log({ ev: "flow-control", sessionId: session?.id, action })
    return true
  }

  // ── Flow tools ──
  // One workspace means one `start_flow`; with several, the tool unions their
  // flow names and resolves the workspace from the session it is called in.
  const allFlowNames = [...new Set(workspacesOf(config)
    .filter((w) => w.enabled === true)
    .flatMap((w) => Object.keys(w.flows ?? {})))]
  const labelFor = (name) => {
    for (const ws of workspacesOf(config)) {
      const f = ws?.flows?.[name]
      if (f?.label) return f.label[config?.locale === "zh" ? "zh" : "en"] ?? f.label.en ?? name
    }
    return name
  }
  let disposeTools = () => {}
  try {
    disposeTools = registerFlowTools(ctx, {
      flowNames: allFlowNames,
      labelFor,
      start: async (flowName, agent, note) => {
        const session = agent?.session
        if (!session) return undefined
        const cfg = effectiveConfig(config, session.header?.cwd)
        if (!cfg) return undefined
        const rt = { ...currentState(session) }
        const started = beginFlow({ flowName, cfg, rt, mutate: (next) => mutate(session, next), note })
        log({ ev: "flow-start", sessionId: session.id, flow: flowName })
        return started
      },
    })
    log({ ev: "tools-registered", flows: allFlowNames })
  } catch (e) {
    log({ ev: "tools-fail", err: String(e?.message ?? e) })
  }

  // ── Panel commands ──
  // pause/resume/cancel are user-only actions, so they are commands rather than
  // tools: the agent could otherwise park its own pipeline and skip a
  // self-check. The panel reaches them through `ctx.remote.commands.execute()`.
  let disposeCommands = () => {}
  try {
    const commands = ctx.get?.("commands")
    if (commands && typeof commands.register === "function") {
      disposeCommands = commands.register({
        name: "flow",
        description: "Control the running review flow: pause, resume or cancel.",
        input: { hint: "pause | resume | cancel" },
        handler: ({ agent, rawInput }) => {
          const action = String(rawInput ?? "").trim()
          if (!["pause", "resume", "cancel"].includes(action)) {
            return { kind: "error", text: `Unknown action "${action}". Use pause, resume or cancel.` }
          }
          const session = agent?.session
          const ok = flowControl(session, action)
          return ok
            ? { kind: "success", text: `Flow ${action}d.` }
            : { kind: "error", text: "No running flow to control." }
        },
      })
      log({ ev: "commands-registered", name: "flow" })
    }
  } catch (e) {
    log({ ev: "commands-fail", err: String(e?.message ?? e) })
  }

  // ── Teardown ──
  try {
    ctx.effect?.(() => () => {
      try { projectionHandle?.dispose?.() } catch { /* ignore */ }
      try { disposeTools() } catch { /* ignore */ }
      try { disposeCommands() } catch { /* ignore */ }
    })
  } catch { /* ignore */ }

  // ── Read-only queries (used by the client) ──
  return {
    /** List every workspace config. */
    listWorkspaces() {
      return workspacesOf(config).map(describeWorkspace)
    },
    /** Get the config of one workspace. */
    getWorkspace(path) {
      const ws = workspacesOf(config).find((w) => w.path === path)
      return ws ? describeWorkspace(ws) : { path, enabled: false, flows: [], steps: {} }
    },
    /**
     * Start a flow directly, bypassing the agent.
     *
     * The panel offers this so a user can start a pipeline without going
     * through the model; the agent's route is the `start_flow` tool.
     */
    startFlow(session, flowName, note) {
      const cfg = effectiveConfig(config, session?.header?.cwd)
      if (!cfg) return false
      const rt = { ...currentState(session) }
      const started = beginFlow({ flowName, cfg, rt, mutate: (next) => mutate(session, next), note })
      if (started) log({ ev: "flow-start", sessionId: session?.id, flow: flowName, via: "panel" })
      return Boolean(started)
    },
    /** Pause, resume or cancel the running flow. */
    controlFlow(session, action) {
      return flowControl(session, action)
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

/**
 * The workspace list, defensively.
 *
 * A profile can carry a config this plugin did not write — an older version, a
 * hand edit, a truncated patch. `apply` throwing there would take down plugin
 * loading rather than leaving one feature off, so every read goes through this.
 */
function workspacesOf(config) {
  const list = config?.workspaces
  return Array.isArray(list) ? list.filter((w) => w && typeof w === "object") : []
}

/** The shape the client reads for one workspace. */
function describeWorkspace(ws) {
  return {
    path: ws.path,
    enabled: ws.enabled === true,
    flows: Object.entries(ws.flows ?? {}).map(([name, f]) => ({ name, label: f.label, steps: f.steps })),
    steps: ws.steps ?? {},
  }
}
