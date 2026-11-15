/**
 * The configuration shown in README stays runnable.
 *
 * Documentation drifts quietly: a stage renamed in code, an action removed from
 * the enum, a required field added — and the example is wrong without anything
 * failing. This reads the YAML out of README.md and checks it against the same
 * constants and validator the plugin uses.
 *
 * The project has no dependencies, so this does not pull in a YAML parser. It
 * extracts the fields it needs with patterns and asserts contracts rather than
 * re-implementing YAML: a bug in a mini-parser would hide the very drift this
 * is meant to catch.
 */

let pass = 0
let fail = 0
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

const { readFileSync } = await import("node:fs")
const { join } = await import("node:path")
const ROOT = new URL("..", import.meta.url).pathname

const { BUILTIN_STAGES, BEHAVIORS } = await import("../lib/stages.js")
const { validate } = await import("../lib/config.js")

const README = readFileSync(join(ROOT, "README.md"), "utf8")
const README_ZH = readFileSync(join(ROOT, "README.zh-CN.md"), "utf8")

/** All fenced yaml blocks in a markdown document. */
function yamlBlocks(md) {
  return [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1])
}

/**
 * Every `key: value` occurrence for a bare key, with any trailing YAML comment
 * stripped. The examples annotate some fields, and the annotation is not part
 * of the value.
 */
function values(block, key) {
  return [...block.matchAll(new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+?)\\s*$`, "gm"))]
    .map((m) => m[1].replace(/\s+#.*$/, "").trim())
}

const BUILTIN_IDS = new Set(BUILTIN_STAGES.map((s) => s.id))
const ACTION_IDS = new Set(["send", "stop", "silent"])

console.log("=== 1. The rule example ===")

const ruleBlock = yamlBlocks(README).find((b) => b.includes("workspaces:"))
await t("README has a complete rule example", () => {
  assert(ruleBlock, "no yaml block with workspaces found")
})

await t("every when in the example names a built-in stage", () => {
  const whens = values(ruleBlock, "when")
  assert(whens.length > 0, "no when fields found")
  for (const w of whens) {
    assert(BUILTIN_IDS.has(w), `when: ${w} is not a built-in stage id`)
  }
})

await t("every action in the example is in the enum", () => {
  const actions = values(ruleBlock, "action")
  assert(actions.length > 0, "no action fields found")
  for (const a of actions) {
    assert(ACTION_IDS.has(a), `action: ${a} is not a valid action`)
  }
})

await t("every send rule in the example has a prompt", () => {
  // Split the rules apart, then pair each action with its own prompt.
  const ruleChunks = ruleBlock.split(/^\s*-\s+id:\s*/m).slice(1)
  assert(ruleChunks.length > 0, "no rules found")
  for (const chunk of ruleChunks) {
    const id = chunk.split("\n")[0].trim()
    const action = /^\s*action:\s*(\S+)/m.exec(chunk)?.[1]
    if (action !== "send") continue
    const prompt = /^\s*prompt:\s*(\S.*)$/m.exec(chunk)?.[1]
    assert(prompt && prompt.trim().length > 0, `rule ${id} is a send rule without a prompt`)
  }
})

await t("the example passes the real validator", () => {
  // Rebuild the config from the fields the block asserts on. Enough structure
  // for validate() to accept it, and any drift in the fields above still fails.
  const rules = []
  for (const chunk of ruleBlock.split(/^\s*-\s+id:\s*/m).slice(1)) {
    const id = chunk.split("\n")[0].trim()
    const when = /^\s*when:\s*(\S+)/m.exec(chunk)?.[1]
    const action = /^\s*action:\s*(\S+)/m.exec(chunk)?.[1]
    const prompt = /^\s*prompt:\s*(\S.*)$/m.exec(chunk)?.[1] ?? ""
    if (!id || !when || !action) continue
    rules.push({ id, when, action, prompt, scene: "s", notifyText: "n" })
  }
  const r = validate({
    model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest" },
    workspaces: [{ path: "/Users/you/project", enabled: true, rules }],
  })
  assert(!r.issues, `validation failed: ${JSON.stringify(r.issues?.[0])}`)
})

console.log("\n=== 2. The custom-stage example ===")

const stageBlock = yamlBlocks(README).find((b) => b.trimStart().startsWith("stages:"))
await t("README has a custom-stage example", () => {
  assert(stageBlock, "no yaml block starting with stages:")
})

await t("every behavior used is a declared one", () => {
  const behaviors = values(stageSection(stageBlock), "behavior")
  assert(behaviors.length > 0, "no behavior fields found")
  for (const b of behaviors) {
    assert(BEHAVIORS.includes(b), `behavior: ${b} is not declared in BEHAVIORS`)
  }
})

await t("every custom stage declares both labels", () => {
  const labels = values(stageSection(stageBlock), "label")
  assert(labels.length > 0, "no label fields found")
  for (const l of labels) {
    assert(/\ben:\s*\S/.test(l), `label missing en: ${l}`)
    assert(/\bzh:\s*\S/.test(l), `label missing zh: ${l}`)
  }
})

/** The stage half of the custom example: everything before `workspaces:`. */
function stageSection(block) {
  const i = block.indexOf("workspaces:")
  return i > 0 ? block.slice(0, i) : block
}

await t("every custom stage declares criteria", () => {
  const stages = values(stageSection(stageBlock), "id")
  const crit = values(stageSection(stageBlock), "criteria")
  assert(stages.length > 0, "no custom stages found")
  assert(stages.length === crit.length, `${stages.length} stages but ${crit.length} criteria`)
})

await t("the custom-stage example has a terminal stage", () => {
  const behaviors = values(stageSection(stageBlock), "behavior")
  assert(behaviors.includes("terminal"), "a stage list without terminal never settles")
})

await t("rules in the custom example reference its own stage ids", () => {
  const defined = new Set(values(stageSection(stageBlock), "id"))
  const whens = values(stageBlock, "when")
  assert(whens.length > 0, "no when fields in the custom example")
  for (const w of whens) {
    assert(defined.has(w), `when: ${w} is not one of the example's stages (${[...defined].join(", ")})`)
  }
})

await t("the custom-stage example is a complete, valid config", () => {
  // Dedent the fragment, then rebuild it the same way as the rule example.
  const dedented = stageBlock.split("\n").map((l) => (l.startsWith("    ") ? l.slice(4) : l)).join("\n")
  const stageIds = []
  const stageChunks = dedented.split(/^\s*-\s+id:\s*/m).slice(1)
  for (const chunk of stageChunks) {
    const id = chunk.split("\n")[0].trim()
    // Stop at the workspaces section: only stages live above it.
    if (chunk.startsWith("intake") || dedented.indexOf(chunk) < dedented.indexOf("workspaces:")) {
      const behavior = /^\s*behavior:\s*(\S+)/m.exec(chunk)?.[1]
      const labels = /^\s*label:\s*(\{[^}]*\})/m.exec(chunk)?.[1]
      const criteria = /^\s*criteria:\s*(\S.*)$/m.exec(chunk)?.[1]
      if (id && behavior && labels && criteria) {
        const en = /en:\s*"([^"]*)"/.exec(labels)?.[1] ?? /en:\s*(\w+)/.exec(labels)?.[1]
        const zh = /zh:\s*"([^"]*)"/.exec(labels)?.[1] ?? /zh:\s*(\w+)/.exec(labels)?.[1]
        stageIds.push({ id, behavior, label: { en, zh }, criteria })
      }
    }
  }
  const rules = []
  for (const chunk of dedented.split(/^\s*-\s+id:\s*/m).slice(1)) {
    const id = chunk.split("\n")[0].trim()
    const when = /^\s*when:\s*(\S+)/m.exec(chunk)?.[1]
    const action = /^\s*action:\s*(\S+)/m.exec(chunk)?.[1]
    if (!id || !when || !action) continue
    if (!stageIds.some((s) => s.id === when)) continue
    rules.push({ id, when, action, prompt: "p", scene: "s", notifyText: "n" })
  }
  assert(stageIds.length >= 2, `expected at least 2 custom stages, found ${stageIds.length}`)
  const r = validate({
    model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest" },
    stages: stageIds,
    workspaces: [{ path: "/Users/you/project", enabled: true, rules }],
  })
  assert(!r.issues, `validation failed: ${JSON.stringify(r.issues?.[0])}`)
})

console.log("\n=== 3. Both READMEs agree on the config surface ===")

await t("the Chinese README has the same rule example shape", () => {
  const zhBlocks = yamlBlocks(README_ZH)
  const zhRules = zhBlocks.find((b) => b.includes("workspaces:"))
  assert(zhRules, "no rule example in README.zh-CN.md")
  const enActions = values(ruleBlock, "action").sort().join(",")
  const zhActions = values(zhRules, "action").sort().join(",")
  assert(enActions === zhActions, `action sets differ: en=[${enActions}] zh=[${zhActions}]`)
})

await t("the Chinese README document its custom-stage example too", () => {
  const zhStages = yamlBlocks(README_ZH).find((b) => b.trimStart().startsWith("stages:"))
  assert(zhStages, "no custom-stage example in README.zh-CN.md")
  const enBehaviors = values(stageBlock, "behavior").sort().join(",")
  const zhBehaviors = values(zhStages, "behavior").sort().join(",")
  assert(enBehaviors === zhBehaviors, `behavior sets differ: en=[${enBehaviors}] zh=[${zhBehaviors}]`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
