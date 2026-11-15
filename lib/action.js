/**
 * 动作执行：发送消息 / 通知人工 / 静默。
 *
 * 发送路径严格对齐官方 dsh-schedule：
 *   createUserMessage({ content, source })   ← 有 id、被冻结
 *   agent.followup(message)                  ← 同步
 *   await ctx.sessions.flush(session)        ← 等持久化确认
 *
 * source.kind 用 "decision"（自有语义，非 "plugin"）。
 * 实测 v4 校验器只拒绝 kind === "plugin" 与空字符串。
 */

import { createUserMessage } from "./message.js"
import { PLUGIN_SOURCE_KIND } from "./arbiter.js"

/**
 * 发送一条消息给 agent。
 * 返回 { ok, messageId?, error? }。
 */
export async function sendMessage({ agent, ctx, text, ruleId }) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "空消息" }
  }
  if (typeof agent?.followup !== "function") {
    return { ok: false, error: "agent.followup 不可用" }
  }

  let message
  try {
    message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: PLUGIN_SOURCE_KIND, ruleId },
    })
  } catch (e) {
    return { ok: false, error: `构造消息失败: ${String(e?.message ?? e)}` }
  }

  try {
    agent.followup(message)
  } catch (e) {
    return { ok: false, error: `followup 失败: ${String(e?.message ?? e)}` }
  }

  // 等持久化确认：官方 dsh-schedule 每次都等，失败必须可知
  try {
    const flushed = await ctx.sessions.flush(agent.session)
    if (flushed === false) {
      return { ok: false, messageId: message.id, error: "持久化未确认" }
    }
  } catch (e) {
    return { ok: false, messageId: message.id, error: `flush 失败: ${String(e?.message ?? e)}` }
  }

  return { ok: true, messageId: message.id }
}
