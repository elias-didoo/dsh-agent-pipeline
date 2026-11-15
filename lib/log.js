/**
 * Run log: JSONL, one file per day, for after-the-fact inspection.
 * Logging never throws — it must not affect the main flow.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// Tests may point this at a temp dir so they never pollute real logs.
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
  } catch { /* silent by design */ }
}

/** Message digest, so the log never stores full text. */
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
