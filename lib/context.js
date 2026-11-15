/**
 * 决策上下文构建。
 *
 * 依据真实会话数据（22,963 行 / 3152 条 assistant 消息）：
 *   - 单 turn 内 assistant/message 常达 100+ 条，其中约 36% 无文本
 *   - user/message 里 93% 是系统噪声（skill-catalog 单条 8370 字符等）
 * 因此必须：收敛同 turn 的过程消息 + 按 source.kind 白名单过滤。
 */

/** 允许进入决策输入的 user 消息 kind。 */
const ALLOWED_USER_KINDS = new Set([
  "user",          // 真人
  "decision",      // 本插件发送
  "agent-message", // 其他 agent relay
  "goal",          // goal 自动轮
])

/** 从消息对象取纯文本。 */
export function messageText(msg) {
  const content = msg?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

/** 一条消息是否属于决策白名单。 */
export function isEligible(msg) {
  if (!msg || typeof msg !== "object") return false
  if (msg.role === "assistant") return messageText(msg).trim().length > 0
  if (msg.role === "user") {
    const kind = msg.source?.kind
    return typeof kind === "string" && ALLOWED_USER_KINDS.has(kind)
  }
  return false
}

/**
 * 把相邻的 assistant 过程消息收敛为最后一条。
 *
 * deriveMessages 返回的 assistant 消息不带 turn 字段（实测），
 * 但同一 turn 内的 assistant 消息在 surface 中相邻，因此「相邻合并」等价于「按 turn 收敛」。
 */
export function collapseAssistant(messages) {
  const out = []
  let lastAssistantIndex = -1
  for (const m of messages ?? []) {
    if (m?.role !== "assistant") {
      out.push(m)
      lastAssistantIndex = -1
      continue
    }
    if (lastAssistantIndex >= 0) out[lastAssistantIndex] = m
    else {
      out.push(m)
      lastAssistantIndex = out.length - 1
    }
  }
  return out
}

/** 粗略 token 估算（作为 tokenMeter 不可用时的退化路径）。 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3040 && cp <= 0x30ff)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 首尾截断，保留开头与结尾。 */
export function truncateHeadTail(text, maxTokens) {
  if (!text) return ""
  const total = estimateTokens(text)
  if (total <= maxTokens) return text
  const keepChars = Math.max(60, Math.floor(text.length * (maxTokens / total) * 0.8))
  const head = Math.floor(keepChars * 0.5)
  const tail = keepChars - head
  return `${text.slice(0, head)}\n…（已省略 ${text.length - keepChars} 字符）…\n${text.slice(-tail)}`
}

/** 构造问题载荷的 token 估算（用于扣减预算）。 */
export function estimateQuestionTokens(rules) {
  let n = 40
  for (const r of rules ?? []) {
    n += estimateTokens(r.id) + estimateTokens(r.scene) + 4
  }
  return n
}

/**
 * 构建决策输入。
 *
 * @param messages   deriveMessages() 的输出（时间升序）
 * @param cfg        有效配置
 * @param contextWindow 模型上下文窗口（token）
 * @param measure    可选：官方 tokenMeter.estimateMessage
 */
export function buildState(messages, cfg, contextWindow = 8192, measure) {
  const measureOne = typeof measure === "function" ? measure : (m) => estimateTokens(messageText(m)) + 8

  const raw = messages ?? []
  const collapsed = collapseAssistant(raw)
  const eligible = collapsed.filter(isEligible)

  const questionTokens = estimateQuestionTokens(cfg?.rules)
  const budget = Math.max(256, Math.floor(contextWindow * (cfg?.contextBudgetRatio ?? 0.7)) - questionTokens)

  const stats = {
    raw: raw.length,
    collapsed: collapsed.length,
    eligible: eligible.length,
    budget,
    questionTokens,
    used: 0,
    turns: 0,
    lastTruncated: false,
  }

  if (eligible.length === 0) return { state: "", stats }

  const maxTurns = cfg?.maxTurns ?? 3

  // 决策依据几乎全在最后一条 agent 回复里：实测同一条输入，
  // 只给 120 字判错，给完整内容判对。所以先给最后一条留足额度，
  // 再拿剩下的预算去装更早的轮次。
  const lastIdx = eligible.length - 1
  const lastText = messageText(eligible[lastIdx])
  const lastCost = measureOne(eligible[lastIdx])

  const picked = []
  let remaining = budget

  if (lastText.trim()) {
    if (lastCost <= remaining) {
      picked.unshift({ role: eligible[lastIdx].role, text: lastText, cost: lastCost, sourceKind: eligible[lastIdx].source?.kind })
      remaining -= lastCost
    } else {
      // 连最后一条都放不下，只截它。
      // truncateHeadTail 内部只保留目标额度的约 80%，剩下的自然留给历史。
      const cut = truncateHeadTail(lastText, Math.max(64, remaining - 16))
      const c = estimateTokens(cut) + 8
      picked.unshift({ role: eligible[lastIdx].role, text: cut, cost: c, sourceKind: eligible[lastIdx].source?.kind })
      remaining -= c
      // 最后一条已被裁剪，但它仍完整承载「当前在说什么」，
      // 历史轮次照常往前填。
      stats.lastTruncated = true
    }
    if (eligible[lastIdx].role === "user") stats.turns++
  }

  // 之前的轮次按预算从近到远填
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (stats.turns > maxTurns) break

    const msg = eligible[i]
    const text = messageText(msg)
    if (!text.trim()) continue

    const cost = measureOne(msg)
    if (cost > remaining) break

    picked.unshift({ role: msg.role, text, cost, sourceKind: msg.source?.kind })
    remaining -= cost
    if (msg.role === "user") {
      stats.turns++
      if (stats.turns > maxTurns) {
        picked.shift()
        stats.turns--
        break
      }
    }
  }

  stats.used = budget - remaining
  stats.lastTruncated = Boolean(stats.lastTruncated)
  stats.turns = Math.min(stats.turns, maxTurns)

  const lines = []
  for (const p of picked) {
    lines.push(`【${labelOf(p)}】\n${p.text}`)
  }
  return { state: lines.join("\n\n"), stats }
}

/**
 * 消息在状态里的标签。
 *
 * 区分「用户亲手说的」和「插件代发的」很重要：插件发的提示词看起来
 * 也像用户指令，混成一个标签会让模型误以为流程刚被用户推动过。
 */
function labelOf(p) {
  if (p.role === "assistant") return "Agent"
  if (p.sourceKind === "decision") return "插件"
  if (p.sourceKind === "goal") return "Goal"
  if (p.sourceKind === "agent-message") return "其他Agent"
  return "用户"
}

/**
 * 构建 /v1/systemone 的 questions 载荷。
 * 用户自定义的 scene 直接作为 criteria —— 插件不认识任何业务语义。
 */
/**
 * 阶段判据的默认措辞。
 *
 * 实测：判据写成互斥短句时置信度 0.42，写成「含排他条件」时 0.78。
 * 所以默认值刻意把每个阶段和其它阶段的分界线写出来。
 */
const STAGE_CRITERIA = {
  planning: "用户尚未说开干，agent 在讨论需求、评估方案或汇总改动点，从未修改过任何代码文件",
  implementing: "用户已说开干，agent 正在修改代码，尚未开始自检",
  selfchecking: "agent 正在或刚完成自检：回复里在讲检查了什么、发现了几个问题、修了哪些，且没有推送记录",
  waiting: "agent 正文里直接向用户提出了问题、请求批准、或索要更多信息，没有继续工作的下一步",
  finished: "agent 已经推送完毕（回复里出现已推送 / push / HEAD -> main），或宣告整个需求结束",
  conflict: "rebase 或 merge 最新 head 时发生冲突，或 agent 在说明如何解决冲突",
}

/**
 * 构造 Kev 的问题载荷。
 *
 * 只让模型在「阶段」层面做选择，不让它判「第几轮自检」
 * 「该发评审还是汇总」这类靠计数的信息 —— 那些由 phases.pickRule 负责。
 * 规则的 scene 不参与判定，只用于展示和估算 token。
 */
export function buildQuestions() {
  // 始终发送全部六个阶段，不按当前配置裁剪。
  // 归一化置信度按 1/n 折算基线，选项数一旦随配置变化，
  // 同一个 0.5 在不同工作区就代表不同把握 —— 这会让门槛失去意义。
  // 用户没配规则的阶段不会被选中执行：pickRule 会返回 skip。
  return {
    next: {
      type: "choice",
      instructions: "根据对话判断 agent 当前处于哪个阶段。",
      criteria: { ...STAGE_CRITERIA },
    },
  }
}
