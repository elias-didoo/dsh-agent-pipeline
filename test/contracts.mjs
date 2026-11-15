/**
 * Regression tests: DSH runtime contracts.
 *
 * Background: a projection once shipped without stateSchema/viewSchema,
 *   "Cannot read properties of undefined (reading 'parse')"
 * which made every session fail to load. These tests pin the lesson down.
 *
 * Run: node test/contracts.mjs
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const hostSrc = readFileSync(join(ROOT, "host.js"), "utf8")
const clientSrc = readFileSync(join(ROOT, "client.js"), "utf8")

let pass = 0
let fail = 0
// Must await fn(): a synchronous try/catch cannot catch assertion failures
// inside async bodies,
// which would make failing cases report as passing.
const t = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name} — ${e.message}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const has = (src, re, msg) => assert(re.test(src), msg)

console.log("=== 1. projection contract (dsh-session-projection) ===")
// warm read: values[key] = wire.viewSchema.parse(wire.view(state))  ← outside the try
// cold read: stateSchema.parse(row.val)                              ← outside the try
await t("stateSchema declared", () => has(hostSrc, /^\s*stateSchema,\s*$/m, "register is missing stateSchema"))
await t("wire.viewSchema declared", () => has(hostSrc, /^\s*viewSchema,\s*$/m, "wire is missing viewSchema"))
await t("wire.view declared", () => has(hostSrc, /^\s*view:\s*viewOf,\s*$/m, "missing wire.view"))
await t("stateVersion is a safe integer", () => has(hostSrc, /stateVersion:\s*\d+/, "stateVersion missing or not a constant"))
await t("init and apply present", () => {
  has(hostSrc, /^\s*init:\s*\(header\)/m, "missing init")
  has(hostSrc, /^\s*apply:\s*applyEvent,\s*$/m, "missing apply")
})

console.log("\n=== 2. contextMenus contract ===")
await t("target/id/order/resolve all present", () => {
  has(clientSrc, /target:\s*"workspace"/, "missing target")
  has(clientSrc, /id:\s*"workspace\.decisionOrchestrator"/, "missing id")
  has(clientSrc, /order:\s*\d+/, "missing order")
  has(clientSrc, /resolve:\s*\(\{[^}]*\}\)\s*=>/, "missing resolve")
})

console.log("\n=== 3. slots contract ===")
await t("slots.inject uses the generator form", () =>
  has(clientSrc, /slots\.inject\("shell\.overlay",\s*function\s*\*/, "slots.inject callback must be a generator"))
await t("the component is register's second argument", () =>
  has(clientSrc, /slots\.register\([\s\S]*?\},\s*PanelHost\s*,?\s*\)/, "component must be register's second argument"))
await t("register definition has name/id/inject", () => {
  const m = /slots\.register\(([\s\S]*?)\},\s*PanelHost/.exec(clientSrc)
  assert(m, "register call not found")
  for (const k of ["name", "id", "inject"]) {
    assert(new RegExp(`\\b${k}\\s*:`).test(m[1]), `register definition missing ${k}`)
  }
})

console.log("\n=== 4. Client ModuleLoader contract ===")
await t("id equals the package name", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert(clientSrc.includes(`id: "${pkg.name}"`), `ModuleLoader id must equal package.json name (${pkg.name})`)
})
await t("factory yields { inject, apply }", () => {
  const m = /return\s*\{[\s\S]*?inject:\s*\[([^\]]*)\]/.exec(clientSrc)
  assert(m, "factory inject declaration not found")
  assert(m[1].includes('"slots"'), "inject is missing slots")
  has(clientSrc, /apply\(ctx\)/, "missing apply")
})

console.log("\n=== 4b. client inject covers every service used ===")
await t("every ctx.<service> used is declared in inject", () => {
  // Cordis' Proxy throws for any ctx.xxx not injected; if a try/catch swallows
  // it, the plugin degrades silently (this once left the GUI permanently
  // showing "no session in this workspace").
  const decl = /inject:\s*\[([^\]]+)\]/.exec(clientSrc)
  assert(decl, "inject declaration not found")
  const declared = new Set(
    decl[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
  )
  // Strip comments so a ctx.xxx mentioned in prose is not read as a real call.
  const code = clientSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
  const used = new Set()
  for (const m of code.matchAll(/ctx\.([a-zA-Z]+)/g)) used.add(m[1])
  // These are not Cordis services.
  for (const notService of ["effect", "on", "get", "logger"]) used.delete(notService)
  const missing = [...used].filter((k) => !declared.has(k))
  assert(missing.length === 0, `inject is missing: ${missing.join(", ")}`)
})

console.log("\n=== 4c. client and config stage definitions stay in sync ===")

await t("client STAGE_ORDER === config.STAGES", async () => {
  // The two definitions are independent; when they drift the client renders
  // rules under the wrong stage.
  const { STAGES } = await import("../lib/config.js")
  const m = /const STAGE_ORDER = (\[[^\]]*\])/.exec(clientSrc)
  assert(m, "STAGE_ORDER not found")
  const order = JSON.parse(m[1])
  assert(
    JSON.stringify(order) === JSON.stringify(STAGES),
    `client ${JSON.stringify(order)} does not match config ${JSON.stringify(STAGES)}`,
  )
})

await t("client STAGE_TEXT covers every stage", async () => {
  const { STAGES } = await import("../lib/config.js")
  const m = /const STAGE_TEXT = \{([\s\S]*?)\}/.exec(clientSrc)
  assert(m, "STAGE_TEXT not found")
  const keys = [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1])
  for (const st of STAGES) {
    assert(keys.includes(st), `STAGE_TEXT is missing ${st}`)
  }
  assert(keys.length === STAGES.length, `STAGE_TEXT has extra keys: ${keys.filter((k) => !STAGES.includes(k))}`)
})

await t("renderStages groups unknown stages separately (never folds into planning)", async () => {
  const m = /function renderStages\(rules\) \{[\s\S]*?\n    \}/.exec(clientSrc)
  assert(m, "renderStages not found")
  // Confirm at source level that the "unknown means planning" fallback is gone.
  assert(
    !/STAGE_ORDER\.includes\(r\.when\)\s*\?\s*r\.when\s*:\s*"planning"/.test(m[0]),
    "renderStages still silently folds unknown stages into planning",
  )
  assert(/unknown\.length > 0/.test(m[0]), "renderStages does not group unknown stages separately")
})

console.log("\n=== 4d. The test harness itself ===")

await t("every test file's t() awaits fn()", async () => {
  // A synchronous t() cannot catch assertion failures in async bodies and
  // would report failures as passing.
  // This bit both phase.mjs and contracts.mjs before.
  const { readdirSync } = await import("node:fs")
  const dir = new URL(".", import.meta.url).pathname
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "all.mjs")
  const bad = []
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8")
    const m = /const t = (?:async )?\([^)]*\) => \{([\s\S]*?)\n\}/.exec(src)
    if (!m) continue
    if (!/await [^;]*\(/.test(m[1])) bad.push(f)
  }
  assert(bad.length === 0, `these files do not await in t(), so async assertion failures vanish: ${bad.join(", ")}`)
})

await t("client ACTION_TEXT covers every config action", async () => {
  // The two definitions are independent; out of sync, the panel shows the raw
  // action name straight to the user.
  const src = readFileSync(join(ROOT, "lib/config.js"), "utf8")
  const m = /const ACTIONS = new Set\((\[[^\]]*\])\)/.exec(src)
  assert(m, "ACTIONS not found")
  const actions = JSON.parse(m[1])
  const cm = /const ACTION_TEXT = \{([\s\S]*?)\n    \}/.exec(clientSrc)
  assert(cm, "ACTION_TEXT not found")
  const keys = [...cm[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1])
  for (const a of actions) assert(keys.includes(a), `ACTION_TEXT is missing ${a}`)
  assert(keys.length === actions.length, `ACTION_TEXT has extra keys: ${keys.filter((k) => !actions.includes(k))}`)
})

console.log("\n=== 5. v4 message-source contract ===")
const actionSrc = readFileSync(join(ROOT, "lib/action.js"), "utf8")
const arbiterSrc = readFileSync(join(ROOT, "lib/arbiter.js"), "utf8")
await t('source.kind is not "plugin"', () => {
  const combined = actionSrc + arbiterSrc
  assert(!/kind:\s*["']plugin["']/.test(combined), 'still uses kind: "plugin", which v4 rejects')
})
await t('source.kind = "decision"', () => has(arbiterSrc, /PLUGIN_SOURCE_KIND\s*=\s*"decision"/, "kind should be decision"))
await t("uses the local createUserMessage", () => has(actionSrc, /from\s+"\.\/message\.js"/, "should use the local message.js"))
await t("waits for durability after sending", () => has(actionSrc, /await ctx\.sessions\.flush\(/, "missing sessions.flush"))

console.log("\n=== 6. Zero external dependencies ===")
await t("does not import @deepseek-ai/*", () => {
  for (const f of ["host.js", "client.js", "lib/action.js", "lib/arbiter.js", "lib/config.js", "lib/context.js", "lib/core.js", "lib/judge.js", "lib/log.js", "lib/message.js", "lib/phases.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8")
    const bad = /^\s*import\s+[^;]*from\s+["']@deepseek-ai\//m.exec(src)
    assert(!bad, `${f} still imports an external package: ${bad?.[0]?.trim()}`)
  }
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
