/**
 * Stage definitions and their behaviour.
 *
 * A stage answers one question — "which of these is the agent in right now?" —
 * and its `behavior` decides what happens once the stage is known. The stage
 * ids below are only defaults; a workspace may replace the whole list through
 * `config.stages`.
 *
 * Stage ids are opaque strings. Nothing outside this file may branch on one.
 */

/** How a stage acts once the model has selected it. */
export const BEHAVIORS = ["sequence", "once", "terminal", "passive"]

/**
 * What each behaviour means:
 *
 *   sequence  Fire the stage's `send` rules in config order, one per visit,
 *             until every one has fired; then hand over to the stage's `stop`
 *             rule. This is the "pipeline" behaviour.
 *   once      Fire the first unfired `send` rule, then stop selecting for this
 *             stage.
 *   terminal  Never send; fire the `stop` rule so auto-advance halts.
 *   passive   Do nothing at all — the agent is working and must not be nudged.
 */
export const BUILTIN_STAGES = [
  {
    id: "planning",
    behavior: "sequence",
    label: { en: "Planning", zh: "方案阶段" },
    criteria:
      "用户尚未说开干，agent 在讨论需求、评估方案或汇总改动点，从未修改过任何代码文件",
  },
  {
    id: "implementing",
    behavior: "passive",
    label: { en: "Implementing", zh: "改代码中" },
    criteria: "用户已说开干，agent 正在修改代码，尚未开始自检",
  },
  {
    id: "selfchecking",
    behavior: "sequence",
    label: { en: "Self-checking", zh: "自检阶段" },
    criteria:
      "agent 正在或刚完成自检：回复里在讲检查了什么、发现了几个问题、修了哪些，且没有推送记录",
  },
  {
    id: "waiting",
    behavior: "terminal",
    label: { en: "Waiting", zh: "等你决定" },
    criteria:
      "agent 正文里直接向用户提出了问题、请求批准、或索要更多信息，没有继续工作的下一步",
  },
  {
    id: "finished",
    behavior: "terminal",
    label: { en: "Finished", zh: "已完成" },
    criteria:
      "agent 已经推送完毕（回复里出现已推送 / push / HEAD -> main），或宣告整个需求结束",
  },
  {
    id: "conflict",
    behavior: "once",
    label: { en: "Conflict", zh: "有冲突" },
    criteria: "rebase 或 merge 最新 head 时发生冲突，或 agent 在说明如何解决冲突",
  },
]

/**
 * The criteria above are Chinese on purpose. They are sent verbatim to the
 * decision model, and that model separates the stages far more reliably in
 * Chinese than in English.
 *
 * Measured on nine scenarios drawn from real sessions: Chinese criteria scored
 * 8/9 against Chinese transcripts, while English criteria scored 5/9 against
 * English translations of the same scenarios. A cross-language check on one
 * ambiguous self-check transcript showed the deciding factor is the criteria
 * language, not the transcript language — Chinese criteria cleared the 0.3
 * floor against both transcripts, English criteria cleared neither.
 *
 * This is model input, not documentation.
 */

/**
 * Instruction line sent alongside the criteria.
 *
 * Same reasoning as the criteria: the model is asked in Chinese.
 */
export const QUESTION_INSTRUCTION = "根据对话判断 agent 当前处于哪个阶段。"

/** A stage definition is only usable if it is complete. */
export function isValidStage(stage) {
  return (
    stage !== null &&
    typeof stage === "object" &&
    typeof stage.id === "string" &&
    stage.id.trim().length > 0 &&
    BEHAVIORS.includes(stage.behavior) &&
    typeof stage.label?.en === "string" &&
    stage.label.en.trim().length > 0 &&
    typeof stage.label?.zh === "string" &&
    stage.label.zh.trim().length > 0 &&
    typeof stage.criteria === "string" &&
    stage.criteria.trim().length > 0
  )
}

/**
 * Whether a stage list can drive the pipeline.
 *
 * At least one `terminal` stage is required: without it a `sequence` stage that
 * has fired all its rules has nowhere to hand over to, so every later turn
 * would log a skip and the pipeline would never settle.
 */
export function hasTerminalStage(stages) {
  return Array.isArray(stages) && stages.some((s) => s?.behavior === "terminal")
}

/** Find one stage by id. */
export function stageById(stages, id) {
  return (stages ?? []).find((s) => s?.id === id)
}

/** Pick the label for a UI locale, falling back to English. */
export function stageLabel(stage, locale) {
  return stage?.label?.[locale] ?? stage?.label?.en ?? stage?.id ?? ""
}
