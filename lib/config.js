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

import { decisionIssues } from "./decisions.js"

const DEFAULT_MODEL = {
  baseUrl: "http://127.0.0.1:8080",
  name: "kev-latest",
  timeoutMs: 30000,
  path: "/v1/systemone",
}

const DEFAULT_DEFAULTS = {
  maxIterations: 20,
  failureRetryLimit: 3,
  confidenceFloor: 0.15,
  humanCooldownMs: 30000,
  quietWindowMs: 30000,
  contextBudgetRatio: 0.7,
  maxTurns: 3,
}


function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function str(v, fallback) {
  return typeof v === "string" ? v : fallback
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
    const rawDecisions = Array.isArray(w.decisions) ? w.decisions : []
    const decisions = []
    const seen = new Set()
    for (const [di, d] of rawDecisions.entries()) {
      const where = `workspaces[${wi}].decisions[${di}]`
      const problems = decisionIssues(d)
      if (problems.length > 0) {
        for (const problem of problems) {
          issues.push({ message: `${where}: ${problem}`, path: ["workspaces", wi, "decisions", di] })
        }
        continue
      }
      const id = d.id.trim()
      if (seen.has(id)) {
        issues.push({ message: `${where}.id "${id}" is duplicated`, path: ["workspaces", wi, "decisions", di, "id"] })
        continue
      }
      seen.add(id)
      decisions.push({
        id,
        when: d.when.trim(),
        do: d.do,
        prompt: str(d.prompt, "").trim(),
        // The label is the user's own words for what stopping here means. The
        // plugin imposes no semantics and never special-cases an id.
        notifyText: str(d.notifyText, ""),
      })
    }

    // One decision point is not a choice — the model would always pick it, and
    // the workspace would be better served by leaving the plugin off.
    if (enabled && decisions.length > 0 && decisions.length < 2) {
      issues.push({
        message: `workspaces[${wi}] needs at least 2 decision points once enabled`,
        path: ["workspaces", wi, "decisions"],
      })
    }

    workspaces.push({ path, enabled, decisions })
  }

  if (issues.length > 0) return { issues }
  return { value: { model, defaults, workspaces } }
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
    decisions: ws.decisions ?? [],
    model: config.model,
    locale: config.locale ?? "en",
  }
}

/** Validate all workspaces, returning issue messages as strings. */
export function validateConfig(config) {
  const r = validate(config)
  return r.issues ? r.issues.map((i) => i.message) : []
}
