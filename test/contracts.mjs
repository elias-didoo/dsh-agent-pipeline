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
  has(clientSrc, /slots\.register\([\s\S]*?\},\s*makePanelHost\([^)]*\)\s*,?\s*\)/, "component must be register's second argument"))
await t("register definition has name/id/inject", () => {
  const m = /slots\.register\(([\s\S]*?)\},\s*makePanelHost/.exec(clientSrc)
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

console.log("\n=== 4c. client holds no stage or action table of its own ===")

await t("client reads stage order from the projection, not a hardcoded list", () => {
  // A hardcoded copy in the client is a second source of truth: it drifts from
  // config and the panel then groups rules under the wrong heading.
  assert(!/const STAGE_ORDER\s*=/.test(clientSrc), "client must not hardcode a stage order")
  assert(!/const STAGE_TEXT\s*=/.test(clientSrc), "client must not hardcode stage labels")
  assert(/info\.stages/.test(clientSrc) || /rules, stages, t, locale/.test(clientSrc), "client must render stages from the projection")
})

await t("client action labels come from the dictionary, not a local table", () => {
  assert(!/const ACTION_TEXT\s*=/.test(clientSrc), "client must not hardcode action text")
  assert(/t\(`action\.\$\{r\.action\}`\)/.test(clientSrc), "action label must be translated by key")
})

await t("client registers a dictionary for every language the host ships", async () => {
  const m = /const DICT = \{([\s\S]*?)\n    \}/.exec(clientSrc)
  assert(m, "DICT not found")
  const langs = [...m[1].matchAll(/(\bzh|\ben):\s*\{/g)].map((x) => x[1])
  assert(langs.includes("zh"), "dictionary must cover zh")
  assert(langs.includes("en"), "dictionary must cover en")
  assert(/localeSvc\?\.register\?\.\(NS, id, dict\)/.test(clientSrc), "dictionary must be registered with the locale service")
})

await t("renderStages groups undefined stages separately (never folds into a known one)", () => {
  const m = /function renderStages\(rules, stages, t, locale\) \{[\s\S]*?\n    \}/.exec(clientSrc)
  assert(m, "renderStages not found")
  assert(/unknown\.length > 0/.test(m[0]), "renderStages must group unknown stages separately")
  assert(/unknown/.test(m[0]) && /t\("stage\.unknown"\)/.test(m[0]), "unknown group must be labelled")
})

await t("client never hardcodes a stage id", async () => {
  const { STAGES } = await import("../lib/config.js")
  for (const st of STAGES) {
    const re = new RegExp(`["'\`]${st}["'\`]`)
    assert(!re.test(clientSrc), `client must not hardcode the stage id ${st}`)
  }
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

await t("the action enum has one owner", () => {
  const src = readFileSync(join(ROOT, "lib/config.js"), "utf8")
  const m = /const ACTIONS = new Set\((\[[^\]]*\])\)/.exec(src)
  assert(m, "ACTIONS not found")
  const actions = JSON.parse(m[1])
  const cm = /const DICT = \{([\s\S]*?)\n    \}/.exec(clientSrc)
  assert(cm, "DICT not found")
  for (const a of actions) {
    assert(cm[1].includes(`"action.${a}"`), `dictionary is missing action.${a}`)
  }
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
