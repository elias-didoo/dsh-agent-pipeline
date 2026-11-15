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

import { validateFlowSpec } from "./flow-spec.js"

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
    // A config written against the previous shape still parses as valid YAML,
    // so without this it would load with no steps and no flows and the plugin
    // would silently do nothing.
    if (Array.isArray(w.decisions) && w.steps === undefined) {
      issues.push({
        message: `workspaces[${wi}] uses "decisions", which this version does not read — replace it with a "steps" table plus "flows" that reference those steps`,
        path: ["workspaces", wi, "decisions"],
      })
      continue
    }

    // Flows are an array of { name, label, steps }; the validator wants them
    // keyed by name, so this converts as it collects.
    const rawFlows = {}
    if (Array.isArray(w.flows)) {
      for (const [fi, f] of w.flows.entries()) {
        if (!f || typeof f !== "object") {
          issues.push({ message: `workspaces[${wi}].flows[${fi}] must be an object`, path: ["workspaces", wi, "flows", fi] })
          continue
        }
        const name = str(f.name, "").trim()
        if (!name) {
          issues.push({ message: `workspaces[${wi}].flows[${fi}] needs a name`, path: ["workspaces", wi, "flows", fi, "name"] })
          continue
        }
        if (name in rawFlows) {
          issues.push({ message: `workspaces[${wi}].flows has two entries named "${name}"`, path: ["workspaces", wi, "flows", fi, "name"] })
          continue
        }
        rawFlows[name] = { label: f.label, steps: f.steps }
      }
    } else if (w.flows !== undefined) {
      issues.push({ message: `workspaces[${wi}].flows must be an array`, path: ["workspaces", wi, "flows"] })
    }

    // The validator accepts steps as an object or an array of { id, ... }; the
    // fixture writes a list because a table of prompts reads better that way.
    let rawSteps = w.steps
    if (Array.isArray(w.steps)) {
      rawSteps = {}
      for (const [si, step] of w.steps.entries()) {
        if (!step || typeof step !== "object") {
          issues.push({ message: `workspaces[${wi}].steps[${si}] must be an object`, path: ["workspaces", wi, "steps", si] })
          continue
        }
        const id = str(step.id, "").trim()
        if (!id) {
          issues.push({ message: `workspaces[${wi}].steps[${si}] needs an id`, path: ["workspaces", wi, "steps", si, "id"] })
          continue
        }
        if (id in rawSteps) {
          issues.push({ message: `workspaces[${wi}].steps has two entries named "${id}"`, path: ["workspaces", wi, "steps", si, "id"] })
          continue
        }
        const rest = { ...step }
        delete rest.id
        rawSteps[id] = rest
      }
    }

    const built = validateFlowSpec({ steps: rawSteps ?? {}, flows: rawFlows })
    if (built.issues) {
      for (const message of built.issues) {
        issues.push({ message: `workspaces[${wi}]: ${message}`, path: ["workspaces", wi] })
      }
      continue
    }

    // An enabled workspace with no flow would run nothing; that is a
    // configuration mistake, not a choice, because the plugin exists to walk a
    // pipeline and there is nothing else for it to do.
    if (enabled && Object.keys(built.flows).length === 0) {
      issues.push({
        message: `workspaces[${wi}] is enabled but defines no flows`,
        path: ["workspaces", wi, "flows"],
      })
      continue
    }

    workspaces.push({ path, enabled, steps: built.steps, flows: built.flows })
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
    steps: ws.steps ?? {},
    flows: ws.flows ?? {},
    model: config.model,
    locale: config.locale ?? "en",
  }
}

/** Validate all workspaces, returning issue messages as strings. */
export function validateConfig(config) {
  const r = validate(config)
  return r.issues ? r.issues.map((i) => i.message) : []
}
