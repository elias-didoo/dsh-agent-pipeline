/**
 * 阶段进度：从日志推导「当前阶段走到第几步」。
 *
 * 设计要点：
 *   - 不新增状态存储。DSH 的哲学是「session log 是唯一真相」，
 *     而插件发过的每条消息都带 ruleId，数一遍就能算出进度。
 *   - Kev 只负责判「现在处于哪一大类」（6 选 1），
 *     阶段内的顺序（第几轮自检、该不该汇总）由这里的计数决定 ——
 *     这类「第几次」的信息不在对话文本里，模型判不出来。
 */

import { PLUGIN_SOURCE_KIND } from "./arbiter.js"

/**
 * 按规则 id 归类成进度。
 *
 * @param messages session.deriveMessages() 的结果
 * @param rules 当前工作区的规则（用来知道哪些 id 属于本插件）
 * @returns {{ byRuleId: Record<string, number>, selfCheckRound: number }}
 */
export function phaseProgress(messages, rules) {
  const known = new Set((rules ?? []).map((r) => r.id))
  /** @type {Record<string, number>} */
  const byRuleId = {}

  for (const m of messages ?? []) {
    if (m?.role !== "user") continue
    const src = m?.source
    if (!src || src.kind !== PLUGIN_SOURCE_KIND) continue
    const id = src.ruleId
    // 只统计当前配置里仍存在的规则，配置改过之后旧记录不会污染进度
    if (typeof id !== "string" || !known.has(id)) continue
    byRuleId[id] = (byRuleId[id] ?? 0) + 1
  }

  // 自检轮次 = 已发过的自检规则条数（自检1/2/3 各自一条）
  let selfCheckRound = 0
  for (const [id, n] of Object.entries(byRuleId)) {
    if (/^self[-_]?check/i.test(id)) selfCheckRound += n
  }

  return { byRuleId, selfCheckRound }
}

/**
 * 决定这一轮该发哪条规则。
 *
 * @param stage Kev 判出的阶段
 * @param progress phaseProgress() 的结果
 * @param rules 该工作区的规则
 * @returns 规则对象，或 { skip: 原因 }
 */
export function pickRule(stage, progress, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return { skip: "no-rules" }

  // 同一阶段内按配置顺序排列，用于「序号型」规则的递进
  const inStage = rules.filter((r) => r.when === stage && r.action !== "silent")

  if (stage === "implementing") {
    // agent 正在干活，不需要推它
    return { skip: "implementing" }
  }

  if (stage === "waiting") {
    const r = inStage.find((x) => x.action === "stop")
    return r ? { rule: r } : { skip: "no-stop-rule" }
  }

  if (stage === "finished") {
    const r = inStage.find((x) => x.action === "stop")
    return r ? { rule: r } : { skip: "no-stop-rule" }
  }

  if (stage === "conflict") {
    const r = inStage.find((x) => x.action === "send")
    return r ? { rule: r } : { skip: "no-send-rule" }
  }

  if (stage === "selfchecking") {
    // 自检阶段是固定顺序：自检1 → 自检2 → 自检3 → 推送
    const ordered = inStage.filter((r) => r.action === "send")
    const next = ordered[progress.selfCheckRound]
    if (next === undefined) return { skip: "selfcheck-complete" }
    return { rule: next }
  }

  if (stage === "planning") {
    const ordered = inStage.filter((r) => r.action === "send")
    if (ordered.length === 0) {
      const r = inStage.find((x) => x.action === "stop")
      return r ? { rule: r } : { skip: "no-rule" }
    }

    // planning 阶段的 send 规则按配置顺序推进：
    // 每条「发过一次就不再发」，靠日志里的 ruleId 计数判断。
    // 这样不必为每条规则起特殊名字（review/summarize）也能正确递进。
    for (const r of ordered) {
      const fired = progress.byRuleId?.[r.id] ?? 0
      if (fired > 0) continue
      return { rule: r }
    }

    // 该发的都发过了 → 转到 stop 规则，等用户拍板
    const halt = inStage.find((x) => x.action === "stop")
    if (halt) {
      const fired = progress.byRuleId?.[halt.id] ?? 0
      if (fired === 0) return { rule: halt }
    }
    return { skip: "planning-complete" }
  }

  return { skip: `unknown-stage:${stage}` }
}
