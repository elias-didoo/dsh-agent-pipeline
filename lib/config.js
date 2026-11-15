/**
 * Lightweight Config schema.
 *
 * Cordis' resolveConfig only requires Config to expose `"~standard".validate(value)`:
 *   function resolveConfig(runtime, config) {
 *     if (!runtime.Config) return config
 *     const result = runtime.Config["~standard"].validate(config)
 *     if ("then" in result) throw new TypeError(...)
 *     if (result.issues) throw new ValidationError(result.issues)
 *     else return result.value
 *   }
 *
 * So schemastery is not needed (external plugins cannot resolve dependencies
 * inside app.asar). What follows is a minimal Standard Schema implementation
 * that fills in defaults and reports issues.
 */

import { BUILTIN_STAGES, BEHAVIORS, isValidStage, hasTerminalStage } from "./stages.js"

const DEFAULT_MODEL = {
  baseUrl: "http://127.0.0.1:8080",
  name: "kev-latest",
  timeoutMs: 30000,
  path: "/v1/systemone",
}

const DEFAULT_DEFAULTS = {
  maxIterations: 20,
  failureRetryLimit: 3,
  confidenceFloor: 0.3,
  humanCooldownMs: 30000,
  quietWindowMs: 30000,
  contextBudgetRatio: 0.7,
  maxTurns: 3,
}

const ACTIONS = new Set(["send", "stop", "silent"])

/** The stage list used when a workspace does not define its own. */
export const STAGES = BUILTIN_STAGES.map((s) => s.id)

/** Stage id set derived from the effective stage list, for fast `when` checks. */
function stageIdSet(stages) {
  return new Set((stages ?? []).map((s) => s.id))
}

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function str(v, fallback) {
  return typeof v === "string" ? v : fallback
}

/**
 * Resolve the effective stage list.
 *
 * An absent list means the built-in stages. A present list replaces it
 * wholesale — there is no merging, so a workspace that wants one extra stage
 * states all of them. That keeps "what stages exist" a single readable answer
 * instead of a default-plus-patch puzzle.
 *
 * @returns {Array} effective stages (built-in when absent or unusable)
 */
function resolveStages(raw, issues) {
  if (raw === undefined || raw === null) return BUILTIN_STAGES

  if (!Array.isArray(raw)) {
    issues.push({ message: "stages must be an array", path: ["stages"] })
    return BUILTIN_STAGES
  }
  if (raw.length === 0) {
    issues.push({ message: "stages must not be empty", path: ["stages"] })
    return BUILTIN_STAGES
  }

  const out = []
  const seen = new Set()
  let fatal = false

  for (const [i, s] of raw.entries()) {
    if (!isValidStage(s)) {
      issues.push({
        message: `stages[${i}] is incomplete: needs id, behavior (${BEHAVIORS.join(" / ")}), label.en, label.zh and criteria`,
        path: ["stages", i],
      })
      fatal = true
      continue
    }
    if (seen.has(s.id)) {
      issues.push({ message: `stages[${i}].id "${s.id}" is duplicated`, path: ["stages", i, "id"] })
      fatal = true
      continue
    }
    seen.add(s.id)
    out.push({
      id: s.id,
      behavior: s.behavior,
      label: { en: s.label.en, zh: s.label.zh },
      criteria: s.criteria,
    })
  }

  // A list with no terminal stage can never settle: a sequence stage that has
  // fired all its rules would skip forever.
  if (!fatal && !hasTerminalStage(out)) {
    issues.push({
      message: "stages needs at least one stage with behavior \"terminal\", otherwise the pipeline never settles",
      path: ["stages"],
    })
    fatal = true
  }

  return fatal ? BUILTIN_STAGES : out
}

/**
 * Validate and normalize config.
 * @returns {{ value?: object, issues?: Array<{ message: string, path: string[] }> }}
 */
export function validate(raw) {
  const issues = []
  const input = raw && typeof raw === "object" ? raw : {}

  // model
  const rawModel = input.model && typeof input.model === "object" ? input.model : {}
  const model = {
    baseUrl: str(rawModel.baseUrl, DEFAULT_MODEL.baseUrl),
    name: str(rawModel.name, DEFAULT_MODEL.name),
    timeoutMs: num(rawModel.timeoutMs, DEFAULT_MODEL.timeoutMs),
    path: str(rawModel.path, DEFAULT_MODEL.path),
  }
  if (!/^https?:\/\//.test(model.baseUrl)) {
    issues.push({ message: `model.baseUrl must be an http(s) URL, got ${JSON.stringify(model.baseUrl)}`, path: ["model", "baseUrl"] })
  }

  // defaults
  const rawDefaults = input.defaults && typeof input.defaults === "object" ? input.defaults : {}
  const defaults = {}
  for (const [k, d] of Object.entries(DEFAULT_DEFAULTS)) defaults[k] = num(rawDefaults[k], d)
  if (defaults.maxIterations < 1) issues.push({ message: "defaults.maxIterations must be >= 1", path: ["defaults", "maxIterations"] })
  if (defaults.failureRetryLimit < 0) issues.push({ message: "defaults.failureRetryLimit must be >= 0", path: ["defaults", "failureRetryLimit"] })
  if (defaults.confidenceFloor < 0 || defaults.confidenceFloor > 1) {
    issues.push({ message: "defaults.confidenceFloor must be within 0..1", path: ["defaults", "confidenceFloor"] })
  }

  // stages — validated before rules, because rules reference stage ids
  const stages = resolveStages(input.stages, issues)
  const STAGE_SET = stageIdSet(stages)

  // workspaces
  const rawWs = Array.isArray(input.workspaces) ? input.workspaces : []
  const workspaces = []
  for (const [wi, w] of rawWs.entries()) {
    if (!w || typeof w !== "object") {
      issues.push({ message: `workspaces[${wi}] must be an object`, path: ["workspaces", wi] })
      continue
    }
    const path = str(w.path, "")
    if (!path.startsWith("/")) {
      issues.push({ message: `workspaces[${wi}].path must be an absolute path`, path: ["workspaces", wi, "path"] })
      continue
    }
    const enabled = w.enabled === true
    const rawRules = Array.isArray(w.rules) ? w.rules : []
    const rules = []
    const seen = new Set()
    for (const [ri, r] of rawRules.entries()) {
      const where = `workspaces[${wi}].rules[${ri}]`
      if (!r || typeof r !== "object") {
        issues.push({ message: `${where} must be an object`, path: ["workspaces", wi, "rules", ri] })
        continue
      }
      const id = str(r.id, "")
      if (!id.trim()) {
        issues.push({ message: `${where}.id must not be empty`, path: ["workspaces", wi, "rules", ri, "id"] })
        continue
      }
      if (seen.has(id)) issues.push({ message: `${where}.id "${id}" is duplicated`, path: ["workspaces", wi, "rules", ri, "id"] })
      seen.add(id)

      const when = str(r.when, "")
      if (!STAGE_SET.has(when)) {
        issues.push({
          message: `${where} (${id}).when must be one of ${STAGES.join(" / ")}, got ${JSON.stringify(when)}`,
          path: ["workspaces", wi, "rules", ri, "when"],
        })
      }

      const action = str(r.action, "")
      if (!ACTIONS.has(action)) {
        issues.push({ message: `${where}.action must be send / stop / silent, got ${JSON.stringify(action)}`, path: ["workspaces", wi, "rules", ri, "action"] })
      }
      const scene = str(r.scene, "")
      if (!scene.trim()) issues.push({ message: `${where} (${id}).scene must not be empty`, path: ["workspaces", wi, "rules", ri, "scene"] })
      const prompt = str(r.prompt, "")
      if (action === "send" && !prompt.trim()) {
        issues.push({ message: `${where} (${id}): action=send requires a prompt`, path: ["workspaces", wi, "rules", ri, "prompt"] })
      }

      // notifyText is optional; it only labels in the panel what this stop means.
      const notifyText = str(r.notifyText, "")

      // An incomplete rule degrades to silent: a `send` rule without a prompt
      // has nothing to say, and silence beats a half-formed message.
      let effectiveAction = ACTIONS.has(action) ? action : "silent"
      if (effectiveAction === "send" && !prompt.trim()) effectiveAction = "silent"
      // An invalid stage means the rule can never be selected — degrade too.
      if (!STAGE_SET.has(when)) effectiveAction = "silent"

      rules.push({
        id,
        when: STAGE_SET.has(when) ? when : stages[0].id,
        scene,
        action: effectiveAction,
        prompt,
        // The label is written by the user directly on the rule. The plugin
        // imposes no business semantics and never special-cases a rule id.
        notifyText,
      })
    }

    if (enabled && rules.length > 0 && rules.length < 2) {
      issues.push({ message: `workspaces[${wi}] needs at least 2 rules once enabled (1 is not a choice)`, path: ["workspaces", wi, "rules"] })
    }

    workspaces.push({ path, enabled, rules })
  }

  if (issues.length > 0) return { issues }
  return { value: { model, defaults, stages, workspaces } }
}

/** Standard Schema interface. */
export const Config = {
  "~standard": {
    version: 1,
    vendor: "decision-orchestrator",
    validate(value) {
      return validate(value)
    },
  },
}

/** Find a workspace by path. */
export function findWorkspace(config, workspacePath) {
  for (const ws of config?.workspaces ?? []) {
    if (ws?.path === workspacePath) return ws
  }
  return undefined
}

/** Effective config for one workspace; null when not enabled. */
export function effectiveConfig(config, workspacePath) {
  const ws = findWorkspace(config, workspacePath)
  if (!ws || ws.enabled !== true) return null
  return {
    ...config.defaults,
    rules: ws.rules ?? [],
    stages: config.stages ?? BUILTIN_STAGES,
    model: config.model,
    locale: config.locale ?? "en",
  }
}

/** Validate all workspaces, returning issue messages as strings. */
export function validateConfig(config) {
  const r = validate(config)
  return r.issues ? r.issues.map((i) => i.message) : []
}
