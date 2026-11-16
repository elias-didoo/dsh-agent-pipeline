/**
 * Client rendering, executed rather than pattern-matched.
 *
 * contracts.mjs checks client.js by reading its source. That catches a missing
 * registration but not a wrong label, a lost decision point or a dictionary miss — those
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

/** Minimal createElement, matching what the loader hands the module. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children })

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
  const slots = []
  const react = {
    // Keep children as a real array so the tree can be walked.
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    // One value per hook call, in call order, so a component with several
    // useState calls gets them back in the same order on the next render. An
    // initializer function is called the way React calls it.
    useState: (initial) => {
      const index = slots.length
      if (!(index in slots)) slots.push(typeof initial === "function" ? initial() : initial)
      return [slots[index], (v) => { slots[index] = typeof v === "function" ? v(slots[index]) : v }]
    },
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
  return { mod, def, getSlot: () => slots }
}

/**
 * A projection view shaped exactly like host.js viewOf() produces.
 *
 * The host computes this from the transcript; the client only renders it. A
 * shape here that differs from the host's would pass every assertion below
 * while the real panel showed nothing.
 */
function projectionView(overrides = {}) {
  return {
    enabled: true,
    flow: {
      flow: "requirement",
      label: "需求流程",
      status: "active",
      note: "加导出功能",
      done: 2,
      total: 5,
      steps: [
        { id: "review", status: "done", label: "方案评审", current: false },
        { id: "summarize", status: "done", label: "汇总方案", current: false },
        { id: "confirm", status: "done", label: "等你决定开干", current: false },
        { id: "start_work", status: "ongoing", label: "用户说开干", current: true },
        { id: "selfcheck_1", status: "pending", label: "第一轮自检", current: false },
      ],
      ...overrides.flow,
    },
    ...(overrides.flow === null ? { flow: null } : {}),
  }
}

/** Mount the client against a fake ctx and return the registered pieces. */
function mount({ locale = "zh", view = projectionView(), workspaceId = "w1" } = {}) {
  const { mod, def } = load(locale)
  const registered = { menus: [], slot: null, overlay: null, dicts: [] }
  const session = { id: "s1", workspaceId, projectionValues: { "agent-pipeline": view } }
  const ctx = {
    effect: (fn) => { fn() },
    contextMenus: { register: (m) => { registered.menus.push(m); return () => {} } },
    slots: {
      inject: (key, gen) => {
        const it = gen()
        it.next()
        // `shell.overlay` carries the read-only definition panel; the composer
        // dock carries the running-flow status. Keep them apart so a test can
        // drive the one it means.
        if (key === "shell.overlay") registered.overlayKey = true
        return () => {}
      },
      register: (d, comp) => {
        if (d?.id === "rules") registered.overlay = comp
        else registered.slot = comp
        return () => {}
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: session }, allIds: ["s1"] }) } },
    workspaces: {
      list: {
        // The real snapshot exposes `items`, and the host's own workspace code
        // looks a row up with `items.find(i => i.workspaceId === id)`. A harness
        // shaped like `byId` would let a panel that reads the wrong field pass.
        getSnapshot: () => ({
          items: [{ workspaceId, id: workspaceId, sessionIds: ["s1"] }],
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


/** Walk an element tree, executing function components and collecting text. */
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

/** Collect every element that carries an onClick, in tree order. */
function collectButtons(node, out = []) {
  if (!node || typeof node !== "object") return out
  if (Array.isArray(node)) { for (const n of node) collectButtons(n, out); return out }
  if (typeof node.type === "function") { collectButtons(node.type(node.props), out); return out }
  if (node.props?.onClick) out.push(node)
  for (const n of node.children ?? []) collectButtons(n, out)
  return out
}

console.log("=== 1. The module loads and registers what the host expects ===")

await t("the module-loader entry point declares the package id", () => {
  const { def } = load()
  assert(def.id === "dsh-agent-pipeline", `id was ${def.id}`)
})

await t("the factory yields apply", () => {
  const { mod } = load()
  assert(typeof mod.apply === "function", "apply must be a function")
})

await t("apply registers a dock component", () => {
  const { registered } = mount()
  assert(typeof registered.slot === "function", "no component registered")
})

await t("apply registers a dictionary for zh and en", () => {
  const { registered } = mount()
  const ids = registered.dicts.map((d) => d.id).sort()
  assert(ids.join(",") === "en,zh", `got ${ids.join(",")}`)
})

await t("both dictionaries define the same keys", () => {
  const { registered } = mount()
  const zh = registered.dicts.find((d) => d.id === "zh").dict
  const en = registered.dicts.find((d) => d.id === "en").dict
  const a = Object.keys(zh).sort().join(",")
  const b = Object.keys(en).sort().join(",")
  assert(a === b, `dictionaries differ:\n zh: ${a}\n en: ${b}`)
})

console.log("\n=== 2. The panel renders the flow ===")

/** Render the dock component against a view. */
function renderFlow({ locale = "zh", view = projectionView() } = {}) {
  const mounted = mount({ locale, view })
  const comp = mounted.registered.slot
  return collectText(h(comp, { sessionId: "s1", useProjection: () => view })).join(" ")
}

await t("the flow label and progress are shown", () => {
  const text = renderFlow()
  assert(text.includes("需求流程"), `label missing: ${text}`)
  assert(text.includes("2/5"), `progress missing: ${text}`)
})

await t("every step is listed by its label", () => {
  const text = renderFlow()
  for (const label of ["方案评审", "汇总方案", "等你决定开干", "用户说开干", "第一轮自检"]) {
    assert(text.includes(label), `step "${label}" missing from: ${text}`)
  }
})

await t("the three states use three distinct marks", () => {
  const text = renderFlow()
  assert(text.includes("\u25CF"), "no done mark")
  assert(text.includes("\u25D0"), "no ongoing mark")
  assert(text.includes("\u25CB"), "no pending mark")
})

await t("a paused flow offers resume, not pause", () => {
  const text = renderFlow({ view: projectionView({ flow: { status: "paused" } }) })
  assert(text.includes("恢复"), `should offer resume: ${text}`)
  assert(text.includes("已暂停"), `should say it is paused: ${text}`)
  // Look at the buttons, not at the text: the badge says "已暂停", which
  // contains "暂停" and would make a substring check pass for the wrong reason.
  const paused = projectionView({ flow: { status: "paused" } })
  const buttons = collectButtons(mount({ view: paused }).registered.slot({ sessionId: "s1", useProjection: () => paused }))
  const labels = buttons.map((b) => (b.children ?? []).flat(3).join(""))
  assert(labels.includes("恢复"), `buttons should offer resume: ${labels.join(",")}`)
  assert(!labels.includes("暂停"), `buttons should not offer pause: ${labels.join(",")}`)
})

await t("a finished flow offers no controls", () => {
  const view = projectionView({ flow: { status: "done" } })
  const text = renderFlow({ view })
  assert(text.includes("已完成"), `should say it is done: ${text}`)
  // Render first: collectButtons walks an element tree, not the component.
  const tree = mount({ view }).registered.slot({ sessionId: "s1", useProjection: () => view })
  const buttons = collectButtons(tree)
  assert(buttons.length === 0, `a finished flow should have no buttons, got ${buttons.length}`)
})

await t("no flow renders nothing at all", () => {
  const mounted = mount({ view: projectionView({ flow: null }) })
  const out = mounted.registered.slot({ sessionId: "s1", useProjection: () => projectionView({ flow: null }) })
  assert(out === null, `should render null, got ${JSON.stringify(out)}`)
})

await t("the panel stays put while the turn changes", () => {
  // The view comes from the projection, which the host derives from the log, so
  // the same view renders the same panel regardless of what the turn is doing.
  // This is the property the per-turn panel lacked.
  const a = renderFlow()
  const b = renderFlow()
  assert(a === b, "the same view must render the same panel")
  assert(a.includes("需求流程"), "and it must still show the flow")
})

console.log("\n=== 3. Locale ===")

for (const locale of ["zh", "en", "zh-CN", "fr"]) {
  await t(`a locale=${locale} panel still renders every step`, () => {
    const text = renderFlow({ locale })
    assert(text.includes("2/5"), `progress missing: ${text}`)
    // Step labels come from the config, not the dictionary, so they are the
    // same in any language.
    assert(text.includes("方案评审"), `step missing: ${text}`)
  })
}

await t("English control labels appear for locale=en", () => {
  const text = renderFlow({ locale: "en" })
  assert(text.includes("Pause"), `should say Pause: ${text}`)
  assert(text.includes("Cancel"), `should say Cancel: ${text}`)
})

await t("an unknown locale falls back to English rather than blanks", () => {
  const text = renderFlow({ locale: "fr" })
  assert(text.includes("Pause"), `should fall back to English: ${text}`)
})

await t("the panel still renders without the locale service", () => {
  const { mod } = load("zh")
  const registered = { slot: null }
  const ctx = {
    effect: (fn) => { fn() },
    slots: {
      inject: (_k, gen) => { const it = gen(); it.next(); return () => {} },
      register: (_d, comp) => { registered.slot = comp; return () => {} },
    },
    get: () => undefined,
  }
  mod.apply(ctx)
  const view = projectionView()
  const text = collectText(h(registered.slot, { sessionId: "s1", useProjection: () => view })).join(" ")
  assert(text.includes("需求流程"), `should render without locale: ${text}`)
})

console.log("\n=== 4. Control reaches the host ===")

await t("pressing pause runs the host command", () => {
  // pause/resume/cancel are user-only: they go through the host's command, not
  // through a client-side write the projection would overwrite.
  const calls = []
  const { mod } = load("zh")
  let registered
  const ctx = {
    effect: (fn) => { fn() },
    slots: { inject: (_k, gen) => { const it = gen(); it.next(); return () => {} }, register: (_d, c) => { registered = c; return () => {} } },
    get: (k) => (k === "locale" ? { register: () => {}, getLocale: () => ({ active: "zh" }) } : undefined),
    remote: { commands: { execute: (...args) => calls.push(args) } },
  }
  mod.apply(ctx)
  const view = projectionView()
  const tree = registered({ sessionId: "s1", useProjection: () => view })
  // Walk to the buttons and press the pause one.
  let pressed = false
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.type === "function") { walk(node.type(node.props)); return }
    if (node.props?.onClick && !pressed) {
      const label = (node.children ?? []).flat(3).join("")
      if (label.includes("暂停")) { pressed = true; node.props.onClick() }
    }
    ;(node.children ?? []).forEach(walk)
  }
  walk(tree)
  assert(pressed, "no pause button found")
  assert(calls.length === 1, `should call execute once, got ${calls.length}`)
  assert(String(calls[0][1]).includes("pause"), `command should ask for pause, got ${calls[0][1]}`)
  assert(calls[0][0] === "s1", `command should target the session, got ${calls[0][0]}`)
})

console.log("\n=== the workspace menu and the definition panel ===")

/** A view with a definition, shaped like host.js viewOf() produces. */
function rulesView(overrides = {}) {
  return {
    enabled: true,
    flow: null,
    definition: {
      steps: {
        review: { do: "send", prompt: "read everything first" },
        confirm: { do: "stop", notifyText: "waiting for your call" },
        pick: { do: "branch", question: "clean or not?", options: { clean: "push", problems: "fix" } },
        push: { do: "send", prompt: "push it" },
        fix: { do: "send", prompt: "fix it" },
      },
      flows: {
        requirement: { label: { zh: "需求流程", en: "Requirement" }, steps: ["review", "confirm", "pick"] },
      },
    },
    ...overrides,
  }
}

/** Flatten nested children the way React does, so the tree can be walked. */
function kids(node) {
  // This file's `h` keeps children on the node itself; React keeps them in
  // props. Read both so a helper works against either shape.
  const c = node?.children ?? node?.props?.children
  if (c === undefined) return []
  return (Array.isArray(c) ? c : [c]).flat(Infinity).filter((x) => x != null)
}

/** Expand function components until a host element comes out. */
function render(node) {
  let n = node
  let guard = 0
  while (n && typeof n.type === "function" && guard++ < 20) n = n.type(n.props)
  return n
}

/** All text under a node. */
function textOf(node) {
  if (node == null) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  return textOf(kids(node))
}

/** Open the panel through the menu and return the rendered dialog. */
function openPanel(m) {
  m.registered.menus[0].resolve({ workspaceId: "w1", displayTitle: "brandu" })[0].run()
  const backdrop = render(m.registered.overlay())
  return render(kids(backdrop)[0])
}

await t("the workspace menu offers one action, labelled in the active language", () => {
  const m = mount({ view: rulesView() })
  assert(m.registered.menus.length === 1, `registered ${m.registered.menus.length} menus`)
  const menu = m.registered.menus[0]
  assert(menu.target === "workspace", `target=${menu.target}`)
  const item = menu.resolve({ workspaceId: "w1", displayTitle: "brandu" })[0]
  assert(item.label() === "Agent 流程…", `label=${item.label()}`)
})

await t("the panel is closed until the menu is used", () => {
  const m = mount({ view: rulesView() })
  assert(m.registered.overlay() === null, "should render nothing before a click")
})

await t("the very first click opens it", () => {
  // The setter lives at module scope: a version that assigned it during render
  // would be a no-op on exactly this click, because the overlay has not
  // rendered yet.
  const m = mount({ view: rulesView() })
  const panel = openPanel(m)
  assert(panel, "empty after the first click")
})

await t("the panel shows whether the workspace is on", () => {
  const m = mount({ view: rulesView() })
  const head = render(kids(openPanel(m))[0])
  assert(textOf(kids(head)[0]) === "Agent 流程", `title=${textOf(kids(head)[0])}`)
  assert(textOf(kids(head)[1]) === "已启用", `state=${textOf(kids(head)[1])}`)
})

await t("the panel shows each flow with its label and step count", () => {
  const m = mount({ view: rulesView() })
  const body = render(kids(openPanel(m))[1])
  const blocks = kids(body)
  assert(blocks.length === 1, `flows=${blocks.length}`)
  const head = render(kids(render(blocks[0]))[0])
  assert(textOf(kids(head)[1]) === "需求流程", `label=${textOf(kids(head)[1])}`)
  assert(textOf(kids(head)[2]).includes("3 步"), `count=${textOf(kids(head)[2])}`)
})

await t("the panel shows every step with its id, kind and whole prompt", () => {
  const m = mount({ view: rulesView() })
  const body = render(kids(openPanel(m))[1])
  const rows = render(kids(render(kids(body)[0]))[1])
  const items = kids(rows).filter((r) => render(r).props?.className === "ap-row")
  assert(items.length === 3, `rows=${items.length}`)
  const first = kids(render(items[0])).map((c) => textOf(render(c)))
  assert(first[0] === "1", `index=${first[0]}`)
  assert(first[1] === "review", `id=${first[1]}`)
  assert(first[2] === "send", `kind=${first[2]}`)
  assert(first[3] === "read everything first", `prompt=${first[3]}`)
})

await t("a stop step shows the line it waits on", () => {
  const m = mount({ view: rulesView() })
  const body = render(kids(openPanel(m))[1])
  const rows = render(kids(render(kids(body)[0]))[1])
  const items = kids(rows).filter((r) => render(r).props?.className === "ap-row")
  assert(textOf(render(items[1])).includes("waiting for your call"), "stop line missing")
})

await t("a branch shows where each answer leads", () => {
  // Without the exits the reader cannot tell which way either answer goes.
  const m = mount({ view: rulesView() })
  const body = render(kids(openPanel(m))[1])
  const rows = render(kids(render(kids(body)[0]))[1])
  const branch = kids(rows).find((r) => textOf(render(r)).includes("clean or not?"))
  assert(branch, "branch row missing")
  const exits = kids(render(branch))
    .filter((c) => render(c).props?.className === "ap-exit")
    .map((c) => textOf(c))
  assert(exits.length === 2, `exits=${exits.length}`)
  assert(exits.some((e) => e.includes("clean") && e.includes("push")), `clean exit: ${exits.join(" | ")}`)
  assert(exits.some((e) => e.includes("problems") && e.includes("fix")), `problems exit: ${exits.join(" | ")}`)
})

await t("the footer says where the flow is edited", () => {
  const m = mount({ view: rulesView() })
  const foot = render(kids(openPanel(m))[2])
  assert(textOf(foot).includes("cordis.patch.yml"), `footer=${textOf(foot)}`)
})

await t("the close button closes it", () => {
  const m = mount({ view: rulesView() })
  const head = render(kids(openPanel(m))[0])
  const btn = kids(head).find((c) => render(c).props?.onClick)
  render(btn).props.onClick()
  assert(m.registered.overlay() === null, "still visible")
})

await t("a workspace with no sessions asks for one", () => {
  const m = mount({ view: rulesView() })
  m.ctx.workspaces.list.getSnapshot = () => ({ items: [{ workspaceId: "w1", sessionIds: [] }] })
  const body = render(kids(openPanel(m))[1])
  assert(textOf(body).includes("打开一个会话"), `note=${textOf(body)}`)
})

await t("a workspace whose sessions carry no projection says they have not loaded", () => {
  // "No session" and "a session that has not been opened since load" are
  // different states and need different wording; one blanket message would send
  // the user looking for a missing session that is right there.
  const m = mount({ view: rulesView() })
  m.ctx.sessions.list.getSnapshot = () => ({ byId: {}, allIds: [] })
  const body = render(kids(openPanel(m))[1])
  assert(textOf(body).includes("还没载入"), `note=${textOf(body)}`)
})

await t("a workspace the plugin is off for shows the off state", () => {
  const m = mount({ view: { enabled: false, flow: null, definition: null } })
  const head = render(kids(openPanel(m))[0])
  assert(textOf(kids(head)[1]) === "未启用", `state=${textOf(kids(head)[1])}`)
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
