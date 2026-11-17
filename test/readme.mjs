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

/**
 * Read the two entries of a branch's `options:` block.
 *
 * The block is a nested map, so the parser takes every indented `key: value`
 * line that follows it and stops at the first line back at the item's indent.
 */
function branchOptions(chunk) {
  const lines = chunk.split("\n")
  const at = lines.findIndex((l) => /^\s*options:\s*$/.test(l))
  if (at < 0) return {}
  const out = {}
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") continue
    const m = /^\s{10,}(\w+):\s*(\S+)\s*$/.exec(line)
    if (!m) break
    out[m[1]] = m[2]
  }
  return out
}

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

const { STEP_KINDS, validateFlowSpec } = await import("../lib/flow-spec.js")

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
const KIND_IDS = new Set(STEP_KINDS)

console.log("=== 1. The example config ===")

const cfgBlock = yamlBlocks(README).find((b) => b.includes("workspaces:"))
await t("README has a complete config example", () => {
  assert(cfgBlock, "no yaml block with workspaces found")
})

await t("the example uses `steps` and `flows`, not the retired `decisions`", () => {
  assert(/^\s*steps:/m.test(cfgBlock), "the example must define steps")
  assert(/^\s*flows:/m.test(cfgBlock), "the example must define flows")
  assert(!/^\s*decisions:/m.test(cfgBlock), "decisions is no longer a config key")
  assert(!/^\s*rules:/m.test(cfgBlock), "rules is no longer a config key")
})

await t("every do value is a real step kind", () => {
  const dos = values(cfgBlock, "do")
  assert(dos.length > 0, "no do fields found")
  for (const k of dos) assert(KIND_IDS.has(k), `do: ${k} is not a step kind`)
})

await t("every send has a prompt", () => {
  // Chunk per step so a prompt in the next entry cannot cover for a missing one.
  const chunks = cfgBlock.split(/^\s*-\s+id:\s*/m).slice(1)
  assert(chunks.length > 0, "no steps found")
  for (const chunk of chunks) {
    const id = chunk.split("\n")[0].trim()
    const kind = /^\s*do:\s*(\S+)/m.exec(chunk)?.[1]
    if (kind !== "send" && kind !== "wait-user") continue
    const prompt = /^\s*prompt:\s*(\S.*)$/m.exec(chunk)?.[1]
    assert(prompt && prompt.trim(), `step ${id} (${kind}) has no prompt`)
  }
})

await t("every branch states a question and two options", () => {
  const chunks = cfgBlock.split(/^\s*-\s+id:\s*/m).slice(1)
  const branches = chunks.filter((c) => /^\s*do:\s*branch/m.test(c))
  for (const chunk of branches) {
    const id = chunk.split("\n")[0].trim()
    assert(/^\s*question:/m.test(chunk), `branch ${id} has no question`)
    const count = Object.keys(branchOptions(chunk)).length
    assert(count === 2, `branch ${id} should name exactly 2 options, found ${count}`)
  }
})

await t("the example passes the real validator", () => {
  // Rebuild what the yaml block declares and run it through the same validator
  // the plugin uses at load, so a doc edit that breaks a reference fails here.
  const steps = {}
  for (const chunk of cfgBlock.split(/^\s*-\s+id:\s*/m).slice(1)) {
    const id = chunk.split("\n")[0].trim()
    if (!id) continue
    const kind = /^\s*do:\s*(\S+)/m.exec(chunk)?.[1] ?? ""
    // Only the items above `flows:` are steps; the flow entries have a name.
    if (!kind || !KIND_IDS.has(kind)) continue
    steps[id] = {
      do: kind,
      prompt: /^\s*prompt:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "",
      notifyText: /^\s*notifyText:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "",
      expect: /^\s*expect:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "",
      question: /^\s*question:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "",
    }
    if (kind === "branch") steps[id].options = branchOptions(chunk)
  }
  const flowsSrc = /^\s*flows:\s*\n([\s\S]*)$/m.exec(cfgBlock)?.[1] ?? ""
  const flows = {}
  for (const chunk of flowsSrc.split(/^\s*-\s+name:\s*/m).slice(1)) {
    const name = chunk.split("\n")[0].trim()
    const list = /^\s*steps:\s*\[([^\]]*)\]/m.exec(chunk)?.[1] ?? ""
    flows[name] = {
      label: { en: name, zh: name },
      steps: list.split(",").map((x) => x.trim()).filter(Boolean),
    }
  }
  const r = validateFlowSpec({ steps, flows })
  assert(!r.issues, `validation failed: ${JSON.stringify(r.issues?.[0])}`)
})

console.log("\n=== 2. The documented field table matches the code ===")

await t("every step kind the code accepts is documented", () => {
  const start = README.indexOf("## Anatomy of a step")
  assert(start > 0, "the field table is missing")
  const table = README.slice(start, README.indexOf("###", start + 10))
  for (const kind of STEP_KINDS) {
    assert(new RegExp(`\\b${kind}\\b`).test(table), `kind ${kind} is not documented`)
  }
})

await t("the documented required fields are the ones validation enforces", () => {
  const r = validateFlowSpec({
    steps: { a: { do: "send" }, b: { do: "stop" } },
    flows: { f: { steps: ["a", "b"] } },
  })
  assert(r.issues?.some((i) => /requires a prompt/.test(i)), "a send without a prompt must be rejected")
})

console.log("\n=== 3. Both READMEs agree ===")

await t("the Chinese README shows the same step kinds", () => {
  const zhBlock = yamlBlocks(README_ZH).find((b) => b.includes("workspaces:"))
  assert(zhBlock, "no config example in README.zh-CN.md")
  const enKinds = values(cfgBlock, "do").sort().join(",")
  const zhKinds = values(zhBlock, "do").sort().join(",")
  assert(enKinds === zhKinds, `step kinds differ: en=[${enKinds}] zh=[${zhKinds}]`)
})

await t("the Chinese README also uses steps and flows", () => {
  const zhBlock = yamlBlocks(README_ZH).find((b) => b.includes("workspaces:"))
  assert(/^\s*steps:/m.test(zhBlock), "the zh example must define steps")
  assert(/^\s*flows:/m.test(zhBlock), "the zh example must define flows")
})

await t("neither README still explains the retired stage or decision model", () => {
  for (const [name, md] of [["README.md", README], ["README.zh-CN.md", README_ZH]]) {
    assert(!/^## Customizing stages/m.test(md), `${name} still has a stages chapter`)
    assert(!/^\s*behavior:/m.test(md), `${name} still documents a behavior field`)
    assert(!/^\s*decisions:/m.test(md), `${name} still documents a decisions key`)
  }
})

console.log("\n=== 3. Both READMEs agree ===")

await t("the Chinese README documents the same actions", () => {
  const zhBlock = yamlBlocks(README_ZH).find((b) => b.includes("workspaces:"))
  assert(zhBlock, "no config example in README.zh-CN.md")
  const enDos = values(cfgBlock, "do").sort().join(",")
  const zhDos = values(zhBlock, "do").sort().join(",")
  assert(enDos === zhDos, `action sets differ: en=[${enDos}] zh=[${zhDos}]`)
})

await t("neither README still explains the retired stage model", () => {
  for (const [name, md] of [["README.md", README], ["README.zh-CN.md", README_ZH]]) {
    assert(!/^## Customizing stages/m.test(md), `${name} still has a stages chapter`)
    assert(!/^\s*behavior:/m.test(md), `${name} still documents a behavior field`)
  }
})

await t("mermaid blocks avoid the syntax GitHub refuses", () => {
  // A node label containing a double quote ends the label early:
  //   U[you: "review this"]  ->  Parse error on line 2
  // GitHub shows "Unable to render rich display" instead of the diagram, which
  // is worse than no diagram at all. Nothing here can run mermaid, so this
  // checks the one construct that breaks it.
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const src = readFileSync(join(ROOT, file), "utf8")
    const blocks = [...src.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1])
    for (const [i, code] of blocks.entries()) {
      const bad = code.split("\n").filter((line) => /[[{(][^\]})]*"/.test(line))
      assert(bad.length === 0, `${file} block ${i + 1}: a quoted node label breaks the parser — ${bad[0]?.trim()}`)
    }
  }
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
