/**
 * Test entry point: node test/all.mjs [--fast]
 *
 *   --fast  skip the live-model end-to-end suite (needs a local model running)
 */

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const fast = process.argv.includes("--fast")

// Type check first (it is a bash script, not a node script)
{
  console.log("\n▶  Type check (allowJs + checkJs)")
  const r = spawnSync("bash", [join(HERE, "typecheck.sh")], { stdio: "inherit" })
  if (r.status !== 0) {
    console.log("\n❌ Type check failed; remaining suites still run")
  }
}

const suites = [
  ["contracts.mjs", "DSH runtime contracts (projection/slots/ModuleLoader/v4 sources)"],
  ["client.mjs", "Client rendering (menu, panel, decisions, language)"],
  ["readme.mjs", "README examples stay runnable"],
  ["apply.mjs", "apply() wiring (projection registration and schemas)"],
  ["context.mjs", "Context budget and last-message priority"],
  ["confidence.mjs", "Confidence (raw p_max) and the uncertain path"],
  ["decisions.mjs", "Decision points: contract, question, validation"],
  ["progress.mjs", "Progress derivation, idempotency, serial queue"],
  ["flow.mjs", "Main loop branches (fake ctx, never the real host)"],
  ["e2e-kev.mjs", "Live model end-to-end", !fast],
]

let failed = 0
for (const [file, label, enabled = true] of suites) {
  if (!enabled) {
    console.log(`\n⏭  ${label} — skipped (--fast)`)
    continue
  }
  console.log(`\n▶  ${label}`)
  const r = spawnSync(process.execPath, [join(HERE, file)], {
    stdio: "inherit",
    env: { ...process.env, DECISION_ORCHESTRATOR_LOG_DIR: join(tmpdir(), "decision-orchestrator-test-logs") },
  })
  if (r.status !== 0) failed++
}

console.log(`\n${failed === 0 ? "✅ All suites passed" : `❌ ${failed} suite(s) failed`}`)
process.exit(failed ? 1 : 0)
