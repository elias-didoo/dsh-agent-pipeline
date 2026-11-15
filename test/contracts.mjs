/**
 * 回归测试：DSH 运行时契约。
 *
 * 背景：曾因 projection 缺 stateSchema/viewSchema 导致
 *   "Cannot read properties of undefined (reading 'parse')"
 * 使所有会话无法加载。这里把教训固化成测试。
 *
 * 运行：node test/contracts.mjs
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const hostSrc = readFileSync(join(ROOT, "host.js"), "utf8")
const clientSrc = readFileSync(join(ROOT, "client.js"), "utf8")

let pass = 0
let fail = 0
// 必须 await fn()：同步版抓不到 async 用例里的断言失败，
// 会让失败的用例静默显示成通过。
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

console.log("=== 1. projection 契约（dsh-session-projection）===")
// 热读：values[key] = wire.viewSchema.parse(wire.view(state))  ← 不在 try 内
// 冷读：stateSchema.parse(row.val)                              ← 不在 try 内
await t("stateSchema 已声明", () => has(hostSrc, /^\s*stateSchema,\s*$/m, "register 里缺 stateSchema"))
await t("wire.viewSchema 已声明", () => has(hostSrc, /^\s*viewSchema,\s*$/m, "wire 里缺 viewSchema"))
await t("wire.view 已声明", () => has(hostSrc, /^\s*view:\s*viewOf,\s*$/m, "缺 wire.view"))
await t("stateVersion 是安全整数", () => has(hostSrc, /stateVersion:\s*\d+/, "stateVersion 缺失或非常量"))
await t("init 与 apply 存在", () => {
  has(hostSrc, /^\s*init:\s*\(header\)/m, "缺 init")
  has(hostSrc, /^\s*apply:\s*applyEvent,\s*$/m, "缺 apply")
})

console.log("\n=== 2. contextMenus 契约 ===")
await t("target/id/order/resolve 齐全", () => {
  has(clientSrc, /target:\s*"workspace"/, "缺 target")
  has(clientSrc, /id:\s*"workspace\.decisionOrchestrator"/, "缺 id")
  has(clientSrc, /order:\s*\d+/, "缺 order")
  has(clientSrc, /resolve:\s*\(\{[^}]*\}\)\s*=>/, "缺 resolve")
})

console.log("\n=== 3. slots 契约 ===")
await t("用 generator 形式的 slots.inject", () =>
  has(clientSrc, /slots\.inject\("shell\.overlay",\s*function\s*\*/, "slots.inject 回调必须是 generator"))
await t("register 的组件是第二参数", () =>
  has(clientSrc, /slots\.register\([\s\S]*?\},\s*PanelHost\s*,?\s*\)/, "组件必须作为 register 的第二参数"))
await t("register 定义含 name/id/inject", () => {
  const m = /slots\.register\(([\s\S]*?)\},\s*PanelHost/.exec(clientSrc)
  assert(m, "找不到 register 调用")
  for (const k of ["name", "id", "inject"]) {
    assert(new RegExp(`\\b${k}\\s*:`).test(m[1]), `register 定义缺 ${k}`)
  }
})

console.log("\n=== 4. Client ModuleLoader 契约 ===")
await t("id 等于包名", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  assert(clientSrc.includes(`id: "${pkg.name}"`), `ModuleLoader id 必须等于 package.json name（${pkg.name}）`)
})
await t("factory 返回 { inject, apply }", () => {
  const m = /return\s*\{[\s\S]*?inject:\s*\[([^\]]*)\]/.exec(clientSrc)
  assert(m, "找不到 factory 的 inject 声明")
  assert(m[1].includes('"slots"'), "inject 缺 slots")
  has(clientSrc, /apply\(ctx\)/, "缺 apply")
})

console.log("\n=== 4b. client inject 覆盖所有用到的服务 ===")
await t("ctx.<service> 用到的服务都在 inject 里", () => {
  // cordis 的 Proxy 对未注入的 ctx.xxx 直接抛错；若被 try/catch 吞掉，
  // 就会静默降级（曾导致 GUI 永远显示「此工作区尚无会话」）。
  const decl = /inject:\s*\[([^\]]+)\]/.exec(clientSrc)
  assert(decl, "找不到 inject 声明")
  const declared = new Set(
    decl[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
  )
  // 去掉注释，避免把文档里的 ctx.xxx 当成真实调用
  const code = clientSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
  const used = new Set()
  for (const m of code.matchAll(/ctx\.([a-zA-Z]+)/g)) used.add(m[1])
  // 这些不是 cordis 服务
  for (const notService of ["effect", "on", "get", "logger"]) used.delete(notService)
  const missing = [...used].filter((k) => !declared.has(k))
  assert(missing.length === 0, `inject 缺少: ${missing.join(", ")}`)
})

console.log("\n=== 4c. client 与 config 的阶段定义同步 ===")

await t("client 的 STAGE_ORDER === config.STAGES", async () => {
  // 两份定义各自独立；一旦不同步，client 会把规则显示在错的阶段下。
  const { STAGES } = await import("../lib/config.js")
  const m = /const STAGE_ORDER = (\[[^\]]*\])/.exec(clientSrc)
  assert(m, "找不到 STAGE_ORDER")
  const order = JSON.parse(m[1])
  assert(
    JSON.stringify(order) === JSON.stringify(STAGES),
    `client ${JSON.stringify(order)} 与 config ${JSON.stringify(STAGES)} 不一致`,
  )
})

await t("client 的 STAGE_TEXT 覆盖全部阶段", async () => {
  const { STAGES } = await import("../lib/config.js")
  const m = /const STAGE_TEXT = \{([\s\S]*?)\}/.exec(clientSrc)
  assert(m, "找不到 STAGE_TEXT")
  const keys = [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1])
  for (const st of STAGES) {
    assert(keys.includes(st), `STAGE_TEXT 缺 ${st}`)
  }
  assert(keys.length === STAGES.length, `STAGE_TEXT 多出键: ${keys.filter((k) => !STAGES.includes(k))}`)
})

await t("renderStages 把未知阶段单独分组（不静默归到 planning）", async () => {
  const m = /function renderStages\(rules\) \{[\s\S]*?\n    \}/.exec(clientSrc)
  assert(m, "找不到 renderStages")
  // 源码层面确认不再有「未知即 planning」的兜底
  assert(
    !/STAGE_ORDER\.includes\(r\.when\)\s*\?\s*r\.when\s*:\s*"planning"/.test(m[0]),
    "renderStages 仍把未知阶段静默归到 planning",
  )
  assert(/unknown\.length > 0/.test(m[0]), "renderStages 未对未知阶段单独成组")
})

console.log("\n=== 4d. 测试框架自身 ===")

await t("每个测试文件的 t() 都 await fn()", async () => {
  // 同步版 t() 抓不到 async 用例的断言失败，会让失败静默显示成通过。
  // 这个坑在 phase.mjs 和 contracts.mjs 上都踩过。
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
  assert(bad.length === 0, `这些文件的 t() 不 await，异步断言失败会被静默吞掉: ${bad.join(", ")}`)
})

await t("client 的 ACTION_TEXT 覆盖 config 的全部 action", async () => {
  // 两份定义各自独立；不同步时面板会把 raw action 名直接显示给用户。
  const src = readFileSync(join(ROOT, "lib/config.js"), "utf8")
  const m = /const ACTIONS = new Set\((\[[^\]]*\])\)/.exec(src)
  assert(m, "找不到 ACTIONS")
  const actions = JSON.parse(m[1])
  const cm = /const ACTION_TEXT = \{([\s\S]*?)\n    \}/.exec(clientSrc)
  assert(cm, "找不到 ACTION_TEXT")
  const keys = [...cm[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1])
  for (const a of actions) assert(keys.includes(a), `ACTION_TEXT 缺 ${a}`)
  assert(keys.length === actions.length, `ACTION_TEXT 多出键: ${keys.filter((k) => !actions.includes(k))}`)
})

console.log("\n=== 5. v4 消息来源契约 ===")
const actionSrc = readFileSync(join(ROOT, "lib/action.js"), "utf8")
const arbiterSrc = readFileSync(join(ROOT, "lib/arbiter.js"), "utf8")
await t('source.kind 不是 "plugin"', () => {
  const combined = actionSrc + arbiterSrc
  assert(!/kind:\s*["']plugin["']/.test(combined), '仍然使用被 v4 拒绝的 kind: "plugin"')
})
await t('source.kind = "decision"', () => has(arbiterSrc, /PLUGIN_SOURCE_KIND\s*=\s*"decision"/, "kind 应为 decision"))
await t("使用本地 createUserMessage", () => has(actionSrc, /from\s+"\.\/message\.js"/, "应使用本地 message.js"))
await t("发送后等待持久化确认", () => has(actionSrc, /await ctx\.sessions\.flush\(/, "缺 sessions.flush"))

console.log("\n=== 6. 零外部依赖 ===")
await t("不 import @deepseek-ai/*", () => {
  for (const f of ["host.js", "client.js", "lib/action.js", "lib/arbiter.js", "lib/config.js", "lib/context.js", "lib/core.js", "lib/judge.js", "lib/log.js", "lib/message.js", "lib/phases.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8")
    const bad = /^\s*import\s+[^;]*from\s+["']@deepseek-ai\//m.exec(src)
    assert(!bad, `${f} 仍 import 外部包：${bad?.[0]?.trim()}`)
  }
})

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
