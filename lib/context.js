/**
 * Decision context construction.
 *
 * Measured on real session data (22,963 lines / 3152 assistant messages):
 *   - a single turn often carries 100+ assistant/message entries, ~36% of
 *     them without text
 *   - 93% of user/message entries are system noise (a single skill-catalog
 *     entry is 8370 characters)
 * Hence both are required: collapse intra-turn process messages, and filter
 * user messages through a `source.kind` allowlist.
 */

import { buildDecisionQuestion } from "./decisions.js"

/** User-message kinds allowed into the decision input. */
const ALLOWED_USER_KINDS = new Set([
  "user",          // a human
  "decision",      // sent by this plugin
  "agent-message", // relayed by another agent
  "goal",          // an automatic goal round
])

/** Extract plain text from a message object. */
export function messageText(msg) {
  const content = msg?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

/** Whether one message passes the decision allowlist. */
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
 * Collapse runs of adjacent assistant process messages, keeping the last.
 *
 * Assistant messages from deriveMessages carry no turn field (measured), but
 * messages from the same turn are adjacent in the surface, so "merge adjacent"
 * is equivalent to "merge by turn".
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

/**
 * Per-character token cost, measured against the running model.
 *
 * A single uniform "four characters per token" rule is wrong for Chinese, and
 * badly wrong for the symbols agent replies are full of: a red circle costs
 * three tokens, a cross two, a digit one. Estimating those at a quarter token
 * each undershot a real request by 2.3x, which put a request the plugin
 * believed was 4.8k tokens at 11.2k and the model rejected it outright.
 *
 * Measured by sending each character repeated 100 times and dividing out the
 * fixed overhead. Anything not listed costs like ordinary Latin text.
 */
const CHAR_COST = new Map([
  [" ", 1], // spaces tokenize one at a time, same as digits
  ["\n", 0.1],
  ["\t", 0.25],
])

/** Cost per character for text the table does not name. */
const DEFAULT_ASCII_COST = 0.4

/**
 * True for characters the model charges a full token or more for.
 *
 * Only the ranges that were measured or that cover the symbols agent replies
 * actually use. Charging an unmeasured range as wide would inflate the estimate
 * for text that is mostly Latin; the default is already on the safe side.
 */
function isWide(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK ideographs — measured at 1 token
    (cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
    (cp >= 0x2190 && cp <= 0x21ff) || // arrows — measured at 1 token
    (cp >= 0x25a0 && cp <= 0x27bf) || // geometric shapes, dingbats — measured at 2-3
    (cp >= 0x1f000 && cp <= 0x1faff) // emoji — measured at 1-3
  )
}

/**
 * Token estimate used for every budget decision.
 *
 * Deliberately errs high: an over-estimate trims context and costs a little
 * accuracy, an under-estimate makes the request fail outright.
 *
 * The host's `tokenMeter` is not used for this. Its own README says it prices
 * text at four characters per token, that "CJK text and JSON schemas underprice
 * badly" at that rate, that occupancy is "a reference figure, not a billing
 * record", and that "nothing in the harness makes decisions from it". Measured
 * against the running model, 4825 Chinese characters cost 5289 tokens while the
 * meter priced them at 1215 — a 4.35x shortfall that put a request the plugin
 * believed was 4.8k tokens at 11.2k, and the model rejected it.
 */
export function estimateTokens(text) {
  if (!text) return 0
  let total = 0
  for (const ch of text) {
    const named = CHAR_COST.get(ch)
    if (named !== undefined) {
      total += named
      continue
    }
    const cp = ch.codePointAt(0)
    if (isWide(cp)) {
      // Emoji clusters and symbol glyphs run up to three tokens each. Charge
      // two as the working average; it keeps the estimate on the safe side
      // without trebling the cost of ordinary CJK text.
      total += cp >= 0x1f000 || (cp >= 0x25a0 && cp <= 0x27bf) ? 2.5 : 1.2
    } else if (cp >= 0x30 && cp <= 0x39) {
      total += 1 // digits tokenize one at a time
    } else {
      total += DEFAULT_ASCII_COST
    }
  }
  return Math.ceil(total)
}

/** Truncate keeping both the head and the tail. */
export function truncateHeadTail(text, maxTokens) {
  if (!text) return ""
  const total = estimateTokens(text)
  if (total <= maxTokens) return text
  const keepChars = Math.max(60, Math.floor(text.length * (maxTokens / total) * 0.8))
  const head = Math.floor(keepChars * 0.5)
  const tail = keepChars - head
  return `${text.slice(0, head)}\n…(${text.length - keepChars} chars elided)…\n${text.slice(-tail)}`
}

/**
 * Token estimate for the question payload, subtracted from the budget.
 *
 * Each decision point contributes its id and its `when` text, because that is
 * what `buildDecisionQuestion` puts into the request. Leaving this out does not
 * shave a little off the estimate — it lets the payload grow outside the budget
 * the plugin thinks it is enforcing, and the request then exceeds the model's
 * window and fails.
 */
export function estimateQuestionTokens(decisions) {
  let n = 40
  for (const d of decisions ?? []) {
    n += estimateTokens(d.id) + estimateTokens(d.when) + 4
  }
  return n
}

/**
 * Build the decision input.
 *
 * @param messages      output of deriveMessages() (ascending time)
 * @param cfg           effective config
 * @param contextWindow model context window in tokens
 */
export function buildState(messages, cfg, contextWindow = 8192) {
  // Every cost below comes from estimateTokens. See its comment for why the
  // host's tokenMeter is not consulted.
  const measureOne = (m) => estimateTokens(messageText(m)) + 8

  const raw = messages ?? []
  const collapsed = collapseAssistant(raw)
  const eligible = collapsed.filter(isEligible)

  const questionTokens = estimateQuestionTokens(cfg?.decisions)
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

  // Almost all signal lives in the agent's last reply: measured on identical
  // input, 120 characters produced the wrong stage while the full text produced
  // the right one. So reserve for the last message first, then spend what is
  // left on earlier turns.
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
      // Not even the last message fits — truncate it alone.
      // truncateHeadTail only keeps ~80% of the target, leaving the rest
      // for history.
      const cut = truncateHeadTail(lastText, Math.max(64, remaining - 16))
      const c = estimateTokens(cut) + 8
      picked.unshift({ role: eligible[lastIdx].role, text: cut, cost: c, sourceKind: eligible[lastIdx].source?.kind })
      remaining -= c
      // The last message is truncated but still carries what is happening
      // right now, so history keeps filling in front of it as usual.
      stats.lastTruncated = true
    }
    if (eligible[lastIdx].role === "user") stats.turns++
  }

  // Earlier turns fill in nearest-first, within budget.
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
 * Label used for a message inside the state text.
 *
 * Distinguishing what the user actually said from what the plugin sent on
 * their behalf matters: plugin prompts also read like user instructions, and
 * one shared label would make the model think the user just pushed the flow.
 */
function labelOf(p) {
  if (p.role === "assistant") return "Agent"
  if (p.sourceKind === "decision") return "Plugin"
  if (p.sourceKind === "goal") return "Goal"
  if (p.sourceKind === "agent-message") return "OtherAgent"
  return "User"
}


/**
 * Build the question payload for the model.
 *
 * The model is asked one thing: which decision point describes the situation
 * right now. Each option carries the user's own `when` text, so the choice is
 * exactly the set of situations the workspace defined.
 *
 * Counting still belongs to progress.js — it knows which decision points have
 * already fired, and the model is not asked to keep track of that. The
 * conversation does show the sent prompts, so the model usually can tell; it
 * simply is not relied on to.
 *
 * @param decisions effective decision points (see decisions.js)
 */
export function buildQuestions(decisions) {
  return { next: buildDecisionQuestion(decisions) }
}

