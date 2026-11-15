/**
 * 统一测试入口：node test/all.mjs [--fast]
 *
 *   --fast  跳过真实 Kev 端到端（需要本地模型在跑）
 */

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const fast = process.argv.includes("--fast")

// 先跑类型检查（非 node 脚本）
{
  console.log("\n▶  类型检查（allowJs + checkJs）")
  const r = spawnSync("bash", [join(HERE, "typecheck.sh")], { stdio: "inherit" })
  if (r.status !== 0) {
    console.log("\n❌ 类型检查未通过，后续测试仍会运行")
  }
}

const suites = [
  ["contracts.mjs", "DSH 运行时契约（projection/slots/ModuleLoader/v4 来源）"],
  ["apply.mjs", "apply() 装配（projection 注册与 schema）"],
  ["context.mjs", "上下文预算与最后一条优先"],
  ["confidence.mjs", "置信度归一化"],
  ["phase.mjs", "阶段机（进度推导 + pickRule）"],
  ["flow.mjs", "主循环分支（假 ctx，不碰真机）"],
  ["e2e-kev.mjs", "真实 Kev 端到端", !fast],
]

let failed = 0
for (const [file, label, enabled = true] of suites) {
  if (!enabled) {
    console.log(`\n⏭  ${label} — 已跳过（--fast）`)
    continue
  }
  console.log(`\n▶  ${label}`)
  const r = spawnSync(process.execPath, [join(HERE, file)], {
    stdio: "inherit",
    env: { ...process.env, DECISION_ORCHESTRATOR_LOG_DIR: join(tmpdir(), "decision-orchestrator-test-logs") },
  })
  if (r.status !== 0) failed++
}

console.log(`\n${failed === 0 ? "✅ 全部通过" : `❌ ${failed} 个套件失败`}`)
process.exit(failed ? 1 : 0)
