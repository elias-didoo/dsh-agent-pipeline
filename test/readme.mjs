/**
 * The configuration shown in README stays runnable.
 *
 * Documentation drifts quietly: an action removed from the enum, a required
 * field added, a key renamed — and the example is wrong without anything
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

const { DECISION_ACTIONS } = await import("../lib/decisions.js")
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

/**
 * The decision list inside a config block.
 *
 * `- id:` also introduces the plugin entry itself, so the block is cut down to
 * the `decisions:` section first; otherwise the plugin's own id reads as a
 * decision point with no `when`.
 */
function decisionSection(block) {
  if (!block) return ""
  const start = block.search(/^\s*decisions:\s*$/m)
  return start < 0 ? "" : block.slice(start)
}

/** Split a decisions section into its `- id:` items. */
function items(block) {
  return decisionSection(block).split(/^\s*-\s+id:\s*/m).slice(1).map((chunk) => ({
    id: chunk.split("\n")[0].trim(),
    chunk,
  }))
}

const ACTION_IDS = new Set(DECISION_ACTIONS)

console.log("=== 1. The example config ===")

const cfgBlock = yamlBlocks(README).find((b) => b.includes("workspaces:"))
await t("README has a complete config example", () => {
  assert(cfgBlock, "no yaml block with workspaces found")
})

await t("the example uses `decisions`, not the retired `rules`", () => {
  assert(/^\s*decisions:/m.test(cfgBlock), "the example must use decisions")
  assert(!/^\s*rules:/m.test(cfgBlock), "rules is no longer a config key")
})

await t("every do value is a real action", () => {
  const dos = values(decisionSection(cfgBlock), "do")
  assert(dos.length > 0, "no do fields found")
  for (const a of dos) assert(ACTION_IDS.has(a), `do: ${a} is not an action`)
})

await t("every when is prose, not an id", () => {
  // A short word here would mean the example still assumes an enum of stages.
  const whens = values(decisionSection(cfgBlock), "when")
  assert(whens.length > 0, "no when fields found")
  for (const w of whens) {
    assert(w.split(/\s+/).length >= 4, `when "${w}" reads like an id, not a description`)
  }
})

await t("every send has a prompt", () => {
  const entries = items(cfgBlock)
  assert(entries.length > 0, "no decision points found")
  for (const { id, chunk } of entries) {
    const action = /^\s*do:\s*(\S+)/m.exec(chunk)?.[1]
    if (action !== "send") continue
    const prompt = /^\s*prompt:\s*(\S.*)$/m.exec(chunk)?.[1]
    assert(prompt && prompt.trim(), `decision ${id} is a send without a prompt`)
  }
})

await t("ids are unique", () => {
  const ids = items(cfgBlock).map((e) => e.id)
  assert(new Set(ids).size === ids.length, `duplicate id in ${ids.join(",")}`)
})

await t("the example passes the real validator", () => {
  const decisions = items(cfgBlock).map(({ id, chunk }) => ({
    id,
    when: /^\s*when:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "",
    do: /^\s*do:\s*(\S+)/m.exec(chunk)?.[1] ?? "",
    prompt: /^\s*prompt:\s*(\S.*)$/m.exec(chunk)?.[1] ?? "",
    notifyText: /^\s*notifyText:\s*(\S.*)$/m.exec(chunk)?.[1] ?? "",
  }))
  const r = validate({
    model: { baseUrl: "http://127.0.0.1:8080", name: "kev-latest" },
    workspaces: [{ path: "/Users/you/project", enabled: true, decisions }],
  })
  assert(!r.issues, `validation failed: ${JSON.stringify(r.issues?.[0])}`)
})

console.log("\n=== 2. The documented field table matches the code ===")

await t("every action the code accepts is documented", () => {
  // The table row lists them as `send` / `stop` / `silent` inside one cell, so
  // match the bare word inside the field table rather than a standalone code span.
  const start = README.indexOf("## Anatomy of a decision point")
  assert(start > 0, "the field table is missing")
  const table = README.slice(start, README.indexOf("###", start + 10))
  for (const action of DECISION_ACTIONS) {
    assert(new RegExp(`\\b${action}\\b`).test(table), `action ${action} is not documented`)
  }
})

await t("the documented required fields are the ones validation enforces", () => {
  // If one side gains a field the other does not know about, the docs mislead.
  const r = validate({
    model: { baseUrl: "http://127.0.0.1:8080" },
    workspaces: [{ path: "/x", enabled: true, decisions: [{ id: "a" }, { id: "b", do: "stop" }] }],
  })
  // A decision with only an id must be rejected; the docs say when and do are required.
  assert(r.issues?.some((i) => /when/.test(i.message)), "when must be required")
  assert(r.issues?.some((i) => /do/.test(i.message)), "do must be required")
})

console.log("\n=== 3. Both READMEs agree ===")

await t("the Chinese README documents the same actions", () => {
  const zhBlock = yamlBlocks(README_ZH).find((b) => b.includes("workspaces:"))
  assert(zhBlock, "no config example in README.zh-CN.md")
  const enDos = values(cfgBlock, "do").sort().join(",")
  const zhDos = values(zhBlock, "do").sort().join(",")
  assert(enDos === zhDos, `action sets differ: en=[${enDos}] zh=[${zhDos}]`)
})

await t("the Chinese README also uses decisions", () => {
  const zhBlock = yamlBlocks(README_ZH).find((b) => b.includes("workspaces:"))
  assert(/^\s*decisions:/m.test(zhBlock), "the zh example must use decisions")
})

await t("neither README still explains the retired stage model", () => {
  for (const [name, md] of [["README.md", README], ["README.zh-CN.md", README_ZH]]) {
    assert(!/^## Customizing stages/m.test(md), `${name} still has a stages chapter`)
    assert(!/^\s*behavior:/m.test(md), `${name} still documents a behavior field`)
  }
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
