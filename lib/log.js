/**
 * 运行日志：JSONL，按日分文件，便于排查。
 * 日志失败永不抛出，不影响主流程。
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// 测试可指向临时目录，避免污染真机日志
const LOG_DIR = process.env.DECISION_ORCHESTRATOR_LOG_DIR
  ?? join(homedir(), ".dsh", "decision-orchestrator", "logs")

function todayPath() {
  const d = new Date()
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  return join(LOG_DIR, `${ymd}.jsonl`)
}

export function log(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(todayPath(), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8")
  } catch { /* 静默 */ }
}

/** 消息摘要，避免日志存全文。 */
export function summarize(messages) {
  if (!Array.isArray(messages)) return { count: 0 }
  const byKind = {}
  for (const m of messages) {
    const k = m?.role === "assistant" ? "assistant" : (m?.source?.kind ?? "unknown")
    byKind[k] = (byKind[k] ?? 0) + 1
  }
  return { count: messages.length, byKind }
}

export { LOG_DIR }
