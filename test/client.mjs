/**
 * Client rendering, executed rather than pattern-matched.
 *
 * contracts.mjs checks client.js by reading its source. That catches a missing
 * registration but not a wrong label, a lost stage or a dictionary miss — those
 * only show up when the components actually run. This file builds a small React
 * stand-in, loads client.js through its real module-loader entry point, and
 * inspects the resulting tree.
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
const CLIENT_SRC = readFileSync(join(ROOT, "client.js"), "utf8")

/**
 * Load client.js the way the page does and return its factory result.
 * @param {string} locale active DSH language
 */
function load(locale = "zh") {
  let def = null
  let slot = null
  const react = {
    // Keep children as a real array so the tree can be walked.
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    // One component at a time; set() replaces the current slot so a second
    // render sees the value the first one wrote.
    useState: () => [slot, (v) => { slot = v }],
  }
  globalThis.window = { __ModuleLoader__: { load: (d) => { def = d } } }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: "", textContent: "" }),
    head: { appendChild() {} },
  }
  // The module-loader entry point is a script for the page to eval.
  eval(CLIENT_SRC)
  const mod = def.factory((n) => (n === "react" ? react : {}))
  return { mod, def, getSlot: () => slot }
}

/** A projection view shaped exactly like models.host viewOf() produces. */
function projectionView(overrides = {}) {
  return {
    enabled: true,
    rules: [
      { id: "review", when: "planning", scene: "评审方案", action: "send", prompt: "请评审" },
      { id: "confirm", when: "planning", scene: "等确认", action: "stop", notifyText: "需要拍板" },
      { id: "orphan", when: "ghost", scene: "未定义阶段", action: "silent" },
    ],
    stages: [
      { id: "planning", behavior: "sequence", label: { en: "Planning", zh: "方案阶段" } },
      { id: "finished", behavior: "terminal", label: { en: "Finished", zh: "已完成" } },
    ],
    ...overrides,
  }
}

/** Mount the client against a fake ctx and return the registered pieces. */
function mount({ locale = "zh", view = projectionView(), workspaceId = "w1" } = {}) {
  const { mod, def } = load(locale)
  const registered = { menus: [], slot: null, dicts: [] }
  const session = { id: "s1", workspaceId, projectionValues: { "decision-orchestrator": view } }
  const ctx = {
    effect: (fn) => { fn() },
    contextMenus: { register: (m) => { registered.menus.push(m); return () => {} } },
    slots: {
      inject: (_k, gen) => { const it = gen(); it.next(); return () => {} },
      register: (_d, comp) => { registered.slot = comp; return () => {} },
    },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: session }, allIds: ["s1"] }) } },
    workspaces: {
      list: {
        getSnapshot: () => ({
          byId: { [workspaceId]: { id: workspaceId, sessionIds: ["s1"] } },
          allIds: [workspaceId],
        }),
      },
    },
    get: (k) => (k === "locale"
      ? {
        register: (ns, id, dict) => { registered.dicts.push({ ns, id, dict }); return () => {} },
        getLocale: () => ({ active: locale }),
      }
      : undefined),
  }
  mod.apply(ctx)
  return { registered, def, ctx }
}

/** Open the panel and render it, returning the element tree. */
function renderPanel(mounted) {
  const comp = mounted.registered.slot
  assert(typeof comp === "function", "no component registered")
  comp() // first pass binds setState
  const menu = mounted.registered.menus[0]
  assert(menu, "no menu registered")
  menu.resolve({ workspaceId: "w1", displayTitle: "目标工作区" })[0].run()
  return comp()
}

/**
 * Walk an element tree, executing function components and collecting text.
 * `props` string values are skipped: they are constants such as class names,
 * aria labels and React keys, not rendered content.
 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === "string" || typeof node === "number") {
    if (String(node).trim()) out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === "object") {
    if (typeof node.type === "function") {
      collectText(node.type(node.props), out)
      return out
    }
    for (const child of node.children ?? []) collectText(child, out)
  }
  return out
}

const textOf = (mounted) => collectText(renderPanel(mounted))

console.log("=== 1. The module loads and registers what the host expects ===")

await t("the module-loader entry point declares the package id", () => {
  const { def } = load()
  assert(def.id === "dsh-decision-orchestrator", `got ${def.id}`)
})

await t("the factory yields inject and apply", () => {
  const { mod } = load()
  assert(typeof mod.apply === "function", "missing apply")
  assert(Array.isArray(mod.inject), "missing inject")
})

await t("apply registers a context menu and a slot component", () => {
  const m = mount()
  assert(m.registered.menus.length === 1, `menus: ${m.registered.menus.length}`)
  assert(m.registered.menus[0].target === "workspace", "menu must target workspace")
  assert(typeof m.registered.slot === "function", "no component registered")
})

await t("apply registers a dictionary for zh and en", () => {
  const m = mount()
  const langs = m.registered.dicts.map((d) => d.id).sort()
  assert(langs.join(",") === "en,zh", `got ${langs.join(",")}`)
  for (const d of m.registered.dicts) {
    assert(d.ns === "decision-orchestrator", `namespace should be the package name, got ${d.ns}`)
    assert(Object.keys(d.dict).length > 0, `${d.id} dictionary is empty`)
  }
})

await t("both dictionaries define the same keys", () => {
  const m = mount()
  const zh = m.registered.dicts.find((d) => d.id === "zh").dict
  const en = m.registered.dicts.find((d) => d.id === "en").dict
  const zk = Object.keys(zh).sort().join(",")
  const ek = Object.keys(en).sort().join(",")
  assert(zk === ek, `zh and en disagree; missing in en: ${Object.keys(zh).filter((k) => !(k in en))}`)
})

console.log("\n=== 2. The menu label follows the DSH language ===")

for (const [locale, want] of [["zh", "决策规则…"], ["en", "Decision rules…"], ["zh-CN", "决策规则…"], ["fr", "Decision rules…"]]) {
  await t(`menu label with locale=${locale}`, () => {
    const m = mount({ locale })
    const label = m.registered.menus[0].resolve({ workspaceId: "w1", displayTitle: "W" })[0].label
    assert(label === want, `got "${label}"`)
  })
}

console.log("\n=== 3. The panel renders real content ===")

await t("panel title carries the workspace name", () => {
  const text = textOf(mount())
  assert(text.some((x) => x.includes("决策规则") && x.includes("目标工作区")), `title not found in ${JSON.stringify(text.slice(0, 5))}`)
})

await t("enabled state is shown", () => {
  const text = textOf(mount())
  assert(text.includes("已启用"), `"已启用" not found`)
})

await t("a rule's action is translated, not shown as its raw enum", () => {
  const text = textOf(mount())
  assert(text.includes("自动发送提示词"), `send label missing`)
  assert(text.includes("不做任何动作"), `silent label missing`)
  assert(!text.includes("send") || text.includes("→ 请评审"), "raw enum leaked into the label")
})

await t("a rule's prompt is rendered", () => {
  const text = textOf(mount())
  assert(text.some((x) => x.includes("请评审")), `prompt missing`)
})

await t("a stop rule's notifyText is rendered with its prefix", () => {
  const text = textOf(mount())
  assert(text.some((x) => x.includes("需要拍板")), `notifyText missing`)
})

console.log("\n=== 4. Stages come from the projection ===")

await t("a defined stage renders its label, not its id", () => {
  const text = textOf(mount())
  assert(text.includes("方案阶段"), `stage label missing; got ${JSON.stringify(text)}`)
})

await t("the label follows the panel language", () => {
  const zh = textOf(mount({ locale: "zh" }))
  const en = textOf(mount({ locale: "en" }))
  assert(zh.includes("方案阶段"), "zh should use the zh label")
  assert(en.includes("Planning"), "en should use the en label")
  assert(!en.includes("方案阶段"), "en must not fall back to the zh label")
})

await t("an undefined stage is grouped separately, with a label", () => {
  const text = textOf(mount())
  assert(text.includes("阶段未识别"), `unknown group label missing`)
})

await t("a rule pointing at an undefined stage is still rendered", () => {
  const text = textOf(mount())
  assert(text.some((x) => x.includes("未定义阶段")), "the orphan rule should still show its scene")
})

await t("an empty stage list does not crash and flags everything as unknown", () => {
  const text = textOf(mount({ view: projectionView({ stages: [] }) }))
  assert(text.includes("阶段未识别"), "should group everything as unknown")
})

await t("a disabled workspace renders its own message", () => {
  const text = textOf(mount({ view: projectionView({ enabled: false }) }))
  assert(text.some((x) => x.includes("未启用")), `got ${JSON.stringify(text.slice(0, 6))}`)
})

await t("a workspace with no rules renders its own message", () => {
  const text = textOf(mount({ view: projectionView({ rules: [] }) }))
  assert(text.some((x) => x.includes("尚未配置规则")), `got ${JSON.stringify(text.slice(0, 6))}`)
})

console.log("\n=== 5. Degradation without the locale service ===")

await t("the panel still renders when the locale service is absent", () => {
  const { mod } = load()
  const registered = { menus: [], slot: null }
  const ctx = {
    effect: (fn) => { fn() },
    contextMenus: { register: (m) => { registered.menus.push(m); return () => {} } },
    slots: {
      inject: (_k, gen) => { const it = gen(); it.next(); return () => {} },
      register: (_d, comp) => { registered.slot = comp; return () => {} },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {}, allIds: [] }) } },
    workspaces: { list: { getSnapshot: () => ({ byId: {}, allIds: [] }) } },
    get: () => undefined,
  }
  mod.apply(ctx)
  const label = registered.menus[0].resolve({ workspaceId: "w1", displayTitle: "W" })[0].label
  assert(label === "Decision rules…", `should fall back to English, got "${label}"`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
