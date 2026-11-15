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
/**
 * client.js with comments stripped.
 *
 * Structural checks match code, and the file's header comment quotes the very
 * `slots.register({ name, id, locale, inject }, Component)` shape those checks
 * look for — matching the whole file would pass or fail on a doc example.
 */
const clientCode = clientSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1")

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

console.log("\n=== 2. The client registers into the dock, not a menu ===")

await t("the client no longer registers a context menu", () => {
  // The old panel opened from a workspace right-click. The flow is now a
  // standing panel; a menu entry that opens a second view of the same state
  // would be two places to keep in step.
  assert(!/contextMenus/.test(clientCode), "client must not register a context menu")
})

console.log("\n=== 3. slots contract ===")

await t("slots.inject targets the composer dock and uses the generator form", () => {
  has(clientCode, /slots\.inject\(\s*"conversation\.composer\.dock"\s*,\s*function\s*\*/, 'slots.inject must target "conversation.composer.dock" with a generator')
})

/** The source text of the object literal passed to slots.register(). */
function registerDefinition() {
  const at = clientCode.indexOf("slots.register(")
  assert(at >= 0, "register call not found")
  const open = clientCode.indexOf("{", at)
  let depth = 0
  for (let i = open; i < clientCode.length; i++) {
    if (clientCode[i] === "{") depth++
    else if (clientCode[i] === "}") { depth--; if (depth === 0) return clientCode.slice(open, i + 1) }
  }
  throw new Error("register definition is unbalanced")
}

await t("the register definition names the entry and gives it an id", () => {
  const def = registerDefinition()
  for (const k of ["name", "id"]) {
    assert(new RegExp(`\\b${k}\\s*:`).test(def), `register definition missing ${k}`)
  }
})

await t("the dock entry gives itself an id of its own", () => {
  // Reusing a shipped id would replace that entry rather than sit beside it.
  const id = /\bid:\s*"([^"]+)"/.exec(registerDefinition())?.[1]
  assert(id === "flow", `dock entry id should be "flow", got ${id}`)
})

console.log("\n=== 4. Client ModuleLoader contract ===")
await t("id equals the package name", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert(clientSrc.includes(`id: "${pkg.name}"`), `ModuleLoader id must equal package.json name (${pkg.name})`)
})
await t("factory returns { apply, inject }", () => {
  const m = /return\s*\{[^}]*apply[^}]*\}/.exec(clientSrc)
  assert(m, "factory must return the apply entry point")
  has(clientSrc, /function applyClient\(ctx\)/, "missing applyClient")
})

console.log("\n=== 4c. The client renders the view the host computed ===")

await t("the client reads the flow from the projection", () => {
  // A hardcoded copy in the client is a second source of truth: it drifts from
  // the machine and the panel then shows something the pipeline will never do.
  assert(!/const STAGE_ORDER\s*=/.test(clientSrc), "client must not hardcode an order")
  assert(/useProjection\?\.\(\s*PROJECTION_KEY\s*\)/.test(clientCode), "client must read the projection")
  assert(/view\?\.flow/.test(clientCode), "client must read the flow from the projection view")
})

await t("the client never writes flow state itself", () => {
  // The host owns the flow. A client-side write would be a second copy that
  // the next projection overwrites, so the button would appear to do nothing.
  assert(!/status:\s*"paused"/.test(clientCode), "client must not construct a state")
  assert(/remote\?\.commands/.test(clientCode), "control must go through the host command")
})

await t("status marks are distinct", () => {
  const marks = new Set([/done[^\n]*"\\u25CF"|"\\u25CF"/.exec(clientSrc)?.[0], /"\\u25D0"/.exec(clientSrc)?.[0], /"\\u25CB"/.exec(clientSrc)?.[0]])
  assert(marks.size === 3, "done, ongoing and pending need three different marks")
})

await t("client registers a dictionary for every language the host ships", () => {
  const m = /const DICT = \{([\s\S]*?)\n    \}/.exec(clientSrc)
  assert(m, "DICT not found")
  const langs = [...m[1].matchAll(/(\bzh|\ben):\s*\{/g)].map((x) => x[1])
  assert(langs.includes("zh"), "dictionary must cover zh")
  assert(langs.includes("en"), "dictionary must cover en")
  assert(/localeSvc\?\.register\?\.\(NS, id, dict\)/.test(clientSrc), "dictionary must be registered with the locale service")
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

await t("the step kinds have one owner", async () => {
  // STEP_KINDS is what the config validator enforces and what the client
  // colour-codes; a kind added to one and not the other renders as unknown.
  const { STEP_KINDS } = await import("../lib/flow-spec.js")
  assert(STEP_KINDS.length === 4, `expected four kinds, got ${STEP_KINDS.length}`)
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
  for (const f of ["host.js", "client.js", "lib/action.js", "lib/arbiter.js", "lib/config.js", "lib/context.js", "lib/core.js", "lib/flow-machine.js", "lib/flow-spec.js", "lib/flow-tools.js", "lib/judge.js", "lib/log.js", "lib/message.js", "lib/host-locale.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8")
    const bad = /^\s*import\s+[^;]*from\s+["']@deepseek-ai\//m.exec(src)
    assert(!bad, `${f} still imports an external package: ${bad?.[0]?.trim()}`)
  }
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
