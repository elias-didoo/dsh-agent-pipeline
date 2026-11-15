/**
 * 决策调用：POST /v1/systemone。
 *
 * 已验证的服务端约束：
 *   - need_human 类问题必须用 type: "noul"（"boolean" 会 400）
 *   - noul 必须同时提供 criteria.true / criteria.false，否则判断会反向
 *   - Kev 以 -np 1 运行，调用必须串行
 */

import { buildQuestions } from "./context.js"

/** 判定结果。 */
export const Outcome = {
  /** Kev 判出了阶段，具体动作由 phases.pickRule 决定 */
  STAGE: "stage",
  UNCERTAIN: "uncertain",
  ERROR: "error",
}

/**
 * 串行队列：保证同一时刻只有一个决策请求在飞。
 */
export class SerialQueue {
  #tail = Promise.resolve()

  run(fn) {
    const result = this.#tail.then(fn, fn)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * 归一化置信度。
 *
 * Kev 返回的是已归一化的概率分布（总和为 1），所以原始 p_max 的含义
 * 完全取决于选项数：瞎猜时期望分别是 1/2、1/5、1/6……
 * 直接用 p_max 设门槛，等于门槛随选项数漂移。
 *
 * 这里把「随机基线」压到 0、把「绝对确定」拉到 1：
 *   normalized = (p - 1/n) / (1 - 1/n)
 * 归一化后 0.5 的含义与选项数无关，门槛才能是固定值。
 *
 * @param probabilities 模型的概率分布
 * @param choice 模型选中的项
 * @returns 0..1，0 表示不优于随机，1 表示确定
 */
export function confidenceOf(probabilities, choice) {
  const p = probabilities?.[choice]
  if (typeof p !== "number" || !Number.isFinite(p)) return 0

  const n = probabilities && typeof probabilities === "object" ? Object.keys(probabilities).length : 0
  if (n < 2) return Math.max(0, Math.min(1, p))

  const base = 1 / n
  if (p <= base) return 0
  const span = 1 - base
  if (span <= 0) return 0
  return Math.min(1, (p - base) / span)
}

/**
 * 调用决策模型。
 * 返回 { outcome, rule?, ruleId?, probabilities?, confidence?, stats?, error?, code?, reason? }。
 *
 * @param {object} p
 * @param {string} p.state 决策上下文
 * @param {object} p.cfg 工作区有效配置
 * @param {AbortSignal} [p.signal] 可选取消信号
 */
export async function judge({ state, cfg, signal = undefined }) {
  const model = cfg?.model ?? {}
  const url = new URL("/v1/systemone", model.baseUrl ?? "http://127.0.0.1:8080").href
  const body = {
    model: model.name ?? "kev-latest",
    state,
    questions: buildQuestions(),
  }

  const timeoutMs = model.timeoutMs ?? 30000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs)
  const onAbort = () => ac.abort(signal?.reason)
  signal?.addEventListener?.("abort", onAbort, { once: true })

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { outcome: Outcome.ERROR, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, code: res.status >= 500 ? "SERVER" : "INVALID_REQUEST" }
    }
    const data = await res.json()
    return interpret(data, cfg)
  } catch (e) {
    const aborted = e?.name === "AbortError"
    return {
      outcome: Outcome.ERROR,
      error: aborted ? "timeout" : String(e?.message ?? e),
      code: aborted ? "TIMEOUT" : "TRANSPORT",
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", onAbort)
  }
}

/**
 * 解释模型返回：状态 → 动作由用户配置的 rule.action 决定。
 */
export function interpret(data, cfg) {
  const answers = data?.answers
  if (!answers) return { outcome: Outcome.ERROR, error: "响应缺少 answers", code: "INVALID_RESPONSE" }

  const next = answers.next
  if (!next || next.type !== "choice" || !next.choice) {
    return { outcome: Outcome.ERROR, error: "缺少有效的 next.choice", code: "INVALID_RESPONSE" }
  }

  // Kev 回答的是「阶段」，不是「规则」。
  // 阶段内该发哪条由 phases.pickRule 依据日志进度决定。
  const stage = next.choice
  const probabilities = next.probabilities ?? {}
  const confidence = confidenceOf(probabilities, stage)
  // 原始 p_max 也留一份：归一化值便于比较，原值便于对照模型输出
  const rawConfidence = typeof probabilities[stage] === "number" ? probabilities[stage] : 0
  const floor = cfg?.confidenceFloor ?? 0.3

  const stats = { stage, probabilities, confidence, rawConfidence, usage: data.usage }

  if (confidence < floor) {
    return {
      outcome: Outcome.UNCERTAIN,
      ...stats,
      reason: `置信度 ${confidence.toFixed(3)} < ${floor}（原始 ${rawConfidence.toFixed(3)}）`,
    }
  }

  return { outcome: Outcome.STAGE, ...stats }
}

/** 可重发的错误码。 */
const RETRYABLE = new Set(["TRANSPORT", "TIMEOUT", "SERVER"])

/** 该错误是否值得重发（网络/超时/服务端）。 */
export function isRetryable(code) {
  return typeof code === "string" && RETRYABLE.has(code)
}
