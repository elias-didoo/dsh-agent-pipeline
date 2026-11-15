/**
 * 轻量 Config schema。
 *
 * cordis 的 resolveConfig 只要求 Config 暴露 `"~standard".validate(value)`：
 *   function resolveConfig(runtime, config) {
 *     if (!runtime.Config) return config
 *     const result = runtime.Config["~standard"].validate(config)
 *     if ("then" in result) throw new TypeError(...)
 *     if (result.issues) throw new ValidationError(result.issues)
 *     else return result.value
 *   }
 *
 * 因此不必依赖 @deepseek-ai/schemastery（外部插件无法解析 asar 内依赖），
 * 这里实现一个符合 Standard Schema 的最小校验器：补默认值 + 报告问题。
 */

const DEFAULT_MODEL = {
  baseUrl: "http://127.0.0.1:8080",
  name: "kev-latest",
  timeoutMs: 30000,
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

/**
 * 阶段：Kev 只需要在这 6 个里选一个，避免让模型做它做不好的事。
 *
 * 同一阶段下可以挂多条规则，由插件按日志推导的进度决定发哪条
 * —— 例如 selfchecking 阶段下的「自检1/2/3/推送」靠计数器，不靠模型判断。
 */
export const STAGES = ["planning", "implementing", "selfchecking", "waiting", "finished", "conflict"]
const STAGE_SET = new Set(STAGES)

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function str(v, fallback) {
  return typeof v === "string" ? v : fallback
}

/**
 * 校验并归一化配置。返回 { value } 或 { issues }。
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
  }
  if (!/^https?:\/\//.test(model.baseUrl)) {
    issues.push({ message: `model.baseUrl 必须是 http(s) 地址，收到 ${JSON.stringify(model.baseUrl)}`, path: ["model", "baseUrl"] })
  }

  // defaults
  const rawDefaults = input.defaults && typeof input.defaults === "object" ? input.defaults : {}
  const defaults = {}
  for (const [k, d] of Object.entries(DEFAULT_DEFAULTS)) defaults[k] = num(rawDefaults[k], d)
  if (defaults.maxIterations < 1) issues.push({ message: "defaults.maxIterations 必须 ≥ 1", path: ["defaults", "maxIterations"] })
  if (defaults.failureRetryLimit < 0) issues.push({ message: "defaults.failureRetryLimit 必须 ≥ 0", path: ["defaults", "failureRetryLimit"] })
  if (defaults.confidenceFloor < 0 || defaults.confidenceFloor > 1) {
    issues.push({ message: "defaults.confidenceFloor 必须在 0..1", path: ["defaults", "confidenceFloor"] })
  }

  // workspaces
  const rawWs = Array.isArray(input.workspaces) ? input.workspaces : []
  const workspaces = []
  for (const [wi, w] of rawWs.entries()) {
    if (!w || typeof w !== "object") {
      issues.push({ message: `workspaces[${wi}] 必须是对象`, path: ["workspaces", wi] })
      continue
    }
    const path = str(w.path, "")
    if (!path.startsWith("/")) {
      issues.push({ message: `workspaces[${wi}].path 必须是绝对路径`, path: ["workspaces", wi, "path"] })
      continue
    }
    const enabled = w.enabled === true
    const rawRules = Array.isArray(w.rules) ? w.rules : []
    const rules = []
    const seen = new Set()
    for (const [ri, r] of rawRules.entries()) {
      const where = `workspaces[${wi}].rules[${ri}]`
      if (!r || typeof r !== "object") {
        issues.push({ message: `${where} 必须是对象`, path: ["workspaces", wi, "rules", ri] })
        continue
      }
      const id = str(r.id, "")
      if (!id.trim()) {
        issues.push({ message: `${where}.id 不能为空`, path: ["workspaces", wi, "rules", ri, "id"] })
        continue
      }
      if (seen.has(id)) issues.push({ message: `${where}.id "${id}" 重复`, path: ["workspaces", wi, "rules", ri, "id"] })
      seen.add(id)

      const when = str(r.when, "")
      if (!STAGE_SET.has(when)) {
        issues.push({
          message: `${where} (${id}).when 必须是 ${STAGES.join(" / ")} 之一，收到 ${JSON.stringify(when)}`,
          path: ["workspaces", wi, "rules", ri, "when"],
        })
      }

      const action = str(r.action, "")
      if (!ACTIONS.has(action)) {
        issues.push({ message: `${where}.action 必须是 send / stop / silent，收到 ${JSON.stringify(action)}`, path: ["workspaces", wi, "rules", ri, "action"] })
      }
      const scene = str(r.scene, "")
      if (!scene.trim()) issues.push({ message: `${where} (${id}).scene 不能为空`, path: ["workspaces", wi, "rules", ri, "scene"] })
      const prompt = str(r.prompt, "")
      if (action === "send" && !prompt.trim()) {
        issues.push({ message: `${where} (${id}): action=send 必须提供 prompt`, path: ["workspaces", wi, "rules", ri, "prompt"] })
      }

      // notifyText 只用于面板展示「这条规则停下时说明什么」，选填。
      const notifyText = str(r.notifyText, "")

      // 规则自身不完整时降级为 silent：缺少 prompt 的 send 规则
      // 执行起来没有意义，静默比发一条半吊子消息好。
      let effectiveAction = ACTIONS.has(action) ? action : "silent"
      if (effectiveAction === "send" && !prompt.trim()) effectiveAction = "silent"
      // 阶段非法时规则无法被选中，同样降级
      if (!STAGE_SET.has(when)) effectiveAction = "silent"

      rules.push({
        id,
        when: STAGE_SET.has(when) ? when : "planning",
        scene,
        action: effectiveAction,
        prompt,
        // 通知副标题由用户直接写在规则上，插件不预设任何业务语义，
        // 也不把某个特定 rule id 认成特殊含义。
        notifyText,
      })
    }

    if (enabled && rules.length > 0 && rules.length < 2) {
      issues.push({ message: `workspaces[${wi}] 启用后至少需要 2 条规则（1 条不构成选择）`, path: ["workspaces", wi, "rules"] })
    }

    workspaces.push({ path, enabled, rules })
  }

  if (issues.length > 0) return { issues }
  return { value: { model, defaults, workspaces } }
}

/** Standard Schema 接口。 */
export const Config = {
  "~standard": {
    version: 1,
    vendor: "decision-orchestrator",
    validate(value) {
      return validate(value)
    },
  },
}

/** 按路径查找工作区。 */
export function findWorkspace(config, workspacePath) {
  for (const ws of config?.workspaces ?? []) {
    if (ws?.path === workspacePath) return ws
  }
  return undefined
}

/** 取某工作区的有效配置；未启用返回 null。 */
export function effectiveConfig(config, workspacePath) {
  const ws = findWorkspace(config, workspacePath)
  if (!ws || ws.enabled !== true) return null
  return {
    ...config.defaults,
    rules: ws.rules ?? [],
    model: config.model,
  }
}

/** 校验全部工作区，返回错误文本列表。 */
export function validateConfig(config) {
  const r = validate(config)
  return r.issues ? r.issues.map((i) => i.message) : []
}
