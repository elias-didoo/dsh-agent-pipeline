/**
 * dsh-agent-pipeline host entry point.
 *
 * Responsibilities:
 *   1. Register the sessionProjections unit (per-session state, rebuildable
 *      from the log)
 *   2. Subscribe to session/event and drive the main loop on turn/end
 *   3. Expose read-only queries to the GUI
 */

import { resolveUiLocale } from "./lib/host-locale.js"
import { Config, effectiveConfig, validate, validateConfig } from "./lib/config.js"
import { handleTurnEnd, beginFlow, controlFlow } from "./lib/core.js"
import { registerFlowTools } from "./lib/flow-tools.js"
import { describeFlow, flowNames } from "./lib/flow-spec.js"
import { SerialQueue } from "./lib/judge.js"
import { log } from "./lib/log.js"

export const name = "dsh-agent-pipeline"
// Services this plugin actually reads. `tokenMeter` used to be here and is not
// any more: the context budget is priced by this plugin (see estimateTokens for
// why the host's meter is not trusted). A declared service is a hard
// prerequisite — a profile without it leaves the plugin inactive — so keeping
// one that is never read would block loading for nothing.
// `systemPrompt` is required, not optional: without it the plugin registers a
// tool the agent never learns about, and nothing in the harness makes a model
// look for a tool it has not been told exists.
export const inject = ["agents", "sessions", "goals", "schedule", "sessionProjections", "systemPrompt"]
export { Config }

/** Projection unit definition. */
const PROJECTION_KEY = "agent-pipeline"

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
    // `effectiveConfig` is the same view the runtime walks, so the panel lists
    // exactly the steps a run would take instead of a second reading of the raw
    // config. It returns null for a workspace that is off or absent — the same
    // condition `enabled` reports.
    const cfg = effectiveConfig(config, header?.cwd)
    if (!cfg) return { enabled: false, definition: null }
    // The definition rides beside `enabled` because both answer one question —
    // what does this workspace's pipeline do? — and both are fixed at load
    // time, so folding them into init costs nothing per event. `apply` stays
    // identity; a flow's position is derived from the transcript instead.
    return { enabled: true, definition: { steps: cfg.steps, flows: cfg.flows } }
  } catch {
    return { enabled: false, definition: null }
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
      // Kept whole: a flow definition is plain config JSON, and the panel reads
      // it from the view rather than from a second parse.
      definition: v.definition && typeof v.definition === "object" ? v.definition : null,
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
      definition: v.definition && typeof v.definition === "object" ? v.definition : null,
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
    definition: state?.definition ?? null,
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

  // Validate and adopt the normalized config.
  //
  // The patch layer writes `flows` as a list because it reads better; the
  // runtime indexes flows by name, and `validate` is what turns one into the
  // other. Keeping the raw value would make every flow lookup miss and the
  // pipeline never start — validation that only logs is validation that does
  // not happen.
  //
  // A config that fails validation is not adopted: the errors are logged and
  // the previous shape stands, so a broken edit leaves the feature off rather
  // than half-configured.
  let configValid = false
  try {
    const result = validate(config)
    if (result.issues) {
      log({ ev: "config-invalid", errors: result.issues.map((i) => i.message) })
    } else {
      config = { ...result.value, locale: effectiveLocale }
      configValid = true
    }
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
      stateVersion: 5,
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
    // Nothing to control: without this the command reported "paused" for a
    // session that never started a pipeline.
    if (!currentState(session)?.flow?.name) return false
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
  // Only a validated config has a shape `flows` can be read from: the raw one
  // carries a list, whose keys are indices. Without this guard an invalid
  // config registers a tool offering a flow called "0".
  // One traversal, so the flow names and the workspaces that offer them cannot
  // disagree: a prompt naming a workspace whose pipelines were left out — or the
  // reverse — would send an agent at a tool that refuses.
  const pipelineWorkspaces = configValid
    ? workspacesOf(config).filter((w) => w.enabled === true)
    : []
  const allFlowNames = [...new Set(pipelineWorkspaces.flatMap((w) => Object.keys(w.flows ?? {})))]
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

  // ── Tell the agent the pipelines exist ──
  // Registering `start_flow` is not enough. Nothing in the harness makes a model
  // go looking for a tool it has never heard of, so without this line the tool
  // sits unused and the plugin does nothing at all — a whole flow engine that
  // never starts, which is exactly what happened before this section existed.
  //
  // Only when a workspace actually offers one: an agent told about pipelines it
  // cannot start would call a tool that always fails.
  // The section is static — `section()` takes no per-session filter — so it has
  // to say which workspace the pipelines belong to. Without that, an agent
  // working in any other workspace is told about flows and calls a tool that
  // refuses, which is worse than saying nothing.
  if (allFlowNames.length > 0) {
    try {
      ctx.systemPrompt.section({
        name: "agent-pipeline",
        // After the goal tool (2400) and before schedule (2500): this is the
        // same kind of instruction — start a long-running thing — so it belongs
        // beside them rather than in the tool-listing block.
        order: 2450,
        text: [
          `The workspace ${pipelineWorkspaces.map((w) => w.path).join(", ")} has fixed review pipelines: ${allFlowNames.join(", ")}.`,
          "In that workspace, call start_flow when the user asks for a requirement, reports a bug, or asks about a rebase conflict.",
          "Do not start one for a plain question, a general discussion, or a change that is none of those, and do not try in any other workspace.",
        ].join(" "),
      })
      log({ ev: "prompt-registered", flows: allFlowNames })
    } catch (e) {
      log({ ev: "prompt-fail", err: String(e?.message ?? e) })
    }
  }

  // ── The /flow command ──
  // Runtime only: a flow name starts one, the control words steer a running one.
  //
  // This command has no "show the rules" case on purpose. The client intercepts
  // any command that declares `input` to collect an argument — it checks
  // `desc.input !== undefined` without looking at whether anything was typed —
  // so a bare `/flow` never reaches this handler. Reading the rules is the
  // workspace menu's job; a branch here would be a promise the interface cannot
  // keep.
  //
  // Control is user-only — an agent that could park its own pipeline could also
  // skip a self-check — but starting is offered to both callers, and it shares
  // beginFlow with the `start_flow` tool so the two cannot diverge.
  const CONTROL_WORDS = ["pause", "resume", "cancel"]
  let disposeCommands = () => {}
  try {
    const commands = ctx.get?.("commands")
    if (configValid && commands && typeof commands.register === "function") {
      disposeCommands = commands.register({
        name: "flow",
        description: "Run or control this workspace's pipeline.",
        input: { hint: `${allFlowNames.join(" | ")} | pause | resume | cancel` },
        handler: ({ agent, rawInput }) => {
          const session = agent?.session
          const cfg = session ? effectiveConfig(config, session.header?.cwd) : null
          const arg = String(rawInput ?? "").trim()
          const zh = (config.locale ?? "en") === "zh"
          if (!cfg) {
            return { kind: "error", text: zh ? "这个工作区没有启用 agent-pipeline。" : "agent-pipeline is not enabled for this workspace." }
          }
          const spec = { steps: cfg.steps ?? {}, flows: cfg.flows ?? {} }
          const names = flowNames(spec)

          // An empty argument still arrives here when the command is invoked
          // programmatically; it reports the usage rather than inventing a
          // second meaning for a bare `/flow`.

          // Control words win over flow names: they are a closed set, and a
          // flow that happens to share one would be unreachable rather than
          // silently swapped.
          if (CONTROL_WORDS.includes(arg)) {
            const ok = flowControl(session, arg)
            const said = { pause: "paused", resume: "resumed", cancel: "cancelled" }[arg]
            return ok
              ? { kind: "success", text: zh ? `流程已${{ pause: "暂停", resume: "继续", cancel: "取消" }[arg]}。` : `Flow ${said}.` }
              : { kind: "error", text: zh ? "现在没有运行中的流程。" : "No running flow to control." }
          }

          if (!names.includes(arg)) {
            const usage = zh
              ? `用法：/flow ${names.join(" | ")}（启动）| /flow pause|resume|cancel（控制）`
              : `Usage: /flow ${names.join(" | ")} (start) | /flow pause|resume|cancel (control)`
            return { kind: "error", text: (zh ? `没有叫 "${arg}" 的流程。\n` : `No flow named "${arg}".\n`) + usage }
          }

          const running = currentState(session)?.flow
          if (running?.name === arg && running.status === "active") {
            return { kind: "error", text: zh ? `「${arg}」已经在跑了。` : `The ${arg} flow is already running.` }
          }
          const rt = { ...currentState(session) }
          const started = beginFlow({ flowName: arg, cfg, rt, mutate: (next) => mutate(session, next) })
          if (!started) {
            return { kind: "error", text: zh ? `无法启动「${arg}」。` : `Could not start the ${arg} flow.` }
          }
          log({ ev: "flow-start", sessionId: session?.id, flow: arg, via: "command" })
          return {
            kind: "success",
            text: (zh ? `已启动「${arg}」，共 ${started.steps.length} 步。` : `Started the ${arg} flow (${started.steps.length} steps).`)
              + "\n\n" + describeFlow(spec, arg, zh ? "zh" : "en", { stepId: started.steps[0]?.id, done: 0, total: started.steps.length }),
          }
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
