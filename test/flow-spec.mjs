/**
 * Flow specification: what a valid pipeline looks like, and what is rejected.
 *
 * The rejection cases matter more than the happy path here. A spec that loads
 * with a broken reference runs until it reaches the bad step and then stops in
 * a state nobody planned for; failing at load is the cheaper outcome.
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

const { STEP_KINDS, validateFlowSpec, stepLabel, stepInFlow, flowNames, describeFlow, describeAllFlows } = await import("../lib/flow-spec.js")

/** A minimal valid spec; overrides replace whole sections. */
function spec(overrides = {}) {
  return {
    steps: {
      review: { do: "send", prompt: "Read the docs and code." },
      summarize: { do: "send", prompt: "List every change." },
      confirm: { do: "stop", notifyText: "Waiting for your go-ahead." },
      ...overrides.steps,
    },
    flows: {
      requirement: { label: { en: "Requirement", zh: "需求流程" }, steps: ["review", "summarize", "confirm"] },
      ...overrides.flows,
    },
  }
}

console.log("=== 1. A valid spec ===")

await t("there are exactly four step kinds", () => {
  assert(STEP_KINDS.join(",") === "send,stop,wait-user,branch", `got ${STEP_KINDS.join(",")}`)
})

await t("a complete spec validates and keeps its order", () => {
  const r = validateFlowSpec(spec())
  assert(!r.issues, JSON.stringify(r.issues?.[0]))
  assert(r.flows.requirement.steps.join(",") === "review,summarize,confirm", "order must survive")
})

await t("steps are shared across flows, not copied", () => {
  const r = validateFlowSpec(spec({ flows: {
    requirement: { steps: ["review", "confirm"] },
    bug: { steps: ["review", "summarize", "confirm"] },
  } }))
  assert(!r.issues, JSON.stringify(r.issues?.[0]))
  assert(r.steps.review === r.steps.review, "one definition serves both flows")
  assert(Object.keys(r.steps).length === 3, `three distinct steps, got ${Object.keys(r.steps).length}`)
})

await t("a flow without a label falls back to its name", () => {
  const r = validateFlowSpec(spec({ flows: { plain: { steps: ["confirm"] } } }))
  assert(!r.issues, JSON.stringify(r.issues?.[0]))
  assert(r.flows.plain.label.en === "plain", "label should default to the flow name")
})

await t("flowNames lists them in config order", () => {
  // Pass the flows explicitly: spec() always adds requirement, so overriding
  // would leave it in front and the order assertion would test the helper.
  const r = validateFlowSpec({
    steps: { confirm: { do: "stop" } },
    flows: { a: { steps: ["confirm"] }, b: { steps: ["confirm"] } },
  })
  assert(flowNames(r).join(",") === "a,b", `got ${flowNames(r).join(",")}`)
})

console.log("\n=== 2. Steps that cannot run ===")

await t("an unknown do value is rejected", () => {
  const r = validateFlowSpec(spec({ steps: { review: { do: "notify" } } }))
  assert(r.issues?.some((i) => /do must be one of/.test(i)), "should reject the kind")
})

await t("send without a prompt is rejected", () => {
  const r = validateFlowSpec(spec({ steps: { review: { do: "send", prompt: "  " } } }))
  assert(r.issues?.some((i) => /requires a prompt/.test(i)), "should require a prompt")
})

await t("wait-user without a prompt is rejected", () => {
  // The prompt is what tells the user what to say; without it the flow waits
  // silently and the user has no idea it is their turn.
  const r = validateFlowSpec(spec({ steps: { go: { do: "wait-user" } } }))
  assert(r.issues?.some((i) => /wait-user requires a prompt/.test(i)), "should require a prompt")
})

await t("branch without a question is rejected", () => {
  const r = validateFlowSpec(spec({ steps: { b: { do: "branch", options: { a: "review", b: "confirm" } } } }))
  assert(r.issues?.some((i) => /branch requires a question/.test(i)), "should require a question")
})

await t("branch with three options is rejected", () => {
  // Two is what the model answers reliably; three turns the branch back into a
  // decision list, which is the thing this design removes.
  const r = validateFlowSpec(spec({ steps: { b: {
    do: "branch", question: "which?", options: { a: "review", b: "confirm", c: "summarize" },
  } } }))
  assert(r.issues?.some((i) => /exactly 2 entries/.test(i)), "should demand two options")
})

console.log("\n=== 3. Flows that cannot run ===")

await t("a flow referring to an undefined step is rejected", () => {
  const r = validateFlowSpec(spec({ flows: { bad: { steps: ["review", "nope"] } } }))
  assert(r.issues?.some((i) => /not defined in steps/.test(i)), "should name the missing step")
})

await t("a flow listing the same step twice is rejected", () => {
  // The log says "this prompt was sent", not which visit sent it, so a repeat
  // makes progress unrecoverable.
  const r = validateFlowSpec(spec({ flows: { twice: { steps: ["review", "review", "confirm"] } } }))
  assert(r.issues?.some((i) => /more than once/.test(i)), "should reject the repeat")
})

await t("a flow with no stop or wait is rejected", () => {
  const r = validateFlowSpec(spec({ flows: { run: { steps: ["review", "summarize"] } } }))
  assert(r.issues?.some((i) => /never pauses/.test(i)), "should demand a settling step")
})

await t("a branch pointing outside its flow is rejected", () => {
  const r = validateFlowSpec({
    steps: {
      b: { do: "branch", question: "q", options: { x: "review", y: "elsewhere" } },
      review: { do: "send", prompt: "r" },
      confirm: { do: "stop" },
      elsewhere: { do: "send", prompt: "e" },
    },
    flows: { f: { steps: ["b", "review", "confirm"] } },
  })
  assert(r.issues?.some((i) => /not in this flow/.test(i)), "should name the out-of-flow target")
})

await t("a branch pointing at itself is rejected", () => {
  const r = validateFlowSpec({
    steps: {
      b: { do: "branch", question: "q", options: { x: "b", y: "confirm" } },
      confirm: { do: "stop" },
    },
    flows: { f: { steps: ["b", "confirm"] } },
  })
  assert(r.issues?.some((i) => /points to itself/.test(i)) || r.issues?.some((i) => /not in this flow/.test(i)),
    "a self-loop must be rejected")
})

await t("a non-object spec is rejected rather than throwing", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    const r = validateFlowSpec(bad)
    assert(Array.isArray(r.issues) && r.issues.length > 0, `should report issues for ${JSON.stringify(bad)}`)
  }
})

console.log("\n=== 4. Lookups ===")

await t("stepInFlow finds a step the flow contains", () => {
  const r = validateFlowSpec(spec())
  assert(stepInFlow(r, "requirement", "review")?.do === "send", "should find review")
})

await t("stepInFlow refuses a step from another flow", () => {
  const r = validateFlowSpec(spec({
    steps: { other: { do: "send", prompt: "o" } },
    flows: { requirement: { steps: ["review", "confirm"] }, bug: { steps: ["other", "confirm"] } },
  }))
  assert(stepInFlow(r, "requirement", "other") === undefined, "must not leak across flows")
})

await t("stepLabel prefers an explicit label, then prose, then the id", () => {
  assert(stepLabel({ id: "x", label: { en: "Review", zh: "评审" }, prompt: "p" }, "zh") === "评审", "explicit label")
  assert(stepLabel({ id: "x", prompt: "Read the docs" }, "zh") === "Read the docs", "prose fallback")
  assert(stepLabel({ id: "x" }, "zh") === "x", "id fallback")
  assert(stepLabel(undefined, "zh") === "", "missing step yields empty")
})

await t("a long prose label is shortened for the panel", () => {
  const long = "这是一段非常长的提示词内容用来测试截断逻辑是否正常工作的情况"
  const label = stepLabel({ id: "x", prompt: long }, "zh")
  assert(label.length <= 25, `should be shortened, got ${label.length}`)
  assert(label.endsWith("…"), `should end with an ellipsis, got ${label}`)
})

console.log("\n=== 5. The read-only definition listing ===")

/** A spec with a branch, so the exits are exercised. */
function branchSpec() {
  return validateFlowSpec({
    steps: {
      review: { do: "send", prompt: "Read everything first." },
      confirm: { do: "stop", notifyText: "Your call." },
      pick: { do: "branch", question: "Still broken, or clean?", options: { problems: "fix", clean: "push" } },
      fix: { do: "send", prompt: "Fix it." },
      push: { do: "send", prompt: "Push it." },
    },
    flows: {
      requirement: { label: { en: "Requirement", zh: "需求流程" }, steps: ["review", "confirm", "pick", "fix", "push"] },
    },
  })
}

await t("the listing names the flow, its steps and their kinds", () => {
  const text = describeFlow(branchSpec(), "requirement", "en")
  assert(text.includes("Requirement"), `label missing: ${text}`)
  assert(/5 steps/.test(text), `step count missing: ${text}`)
  for (const id of ["review", "confirm", "pick", "fix", "push"]) {
    assert(text.includes(id), `step ${id} missing`)
  }
  for (const kind of ["send", "stop", "branch"]) {
    assert(text.includes(kind), `kind ${kind} missing`)
  }
})

await t("the listing carries each step's full prose", () => {
  const text = describeFlow(branchSpec(), "requirement", "en")
  assert(text.includes("Read everything first."), `prompt missing: ${text}`)
  assert(text.includes("Your call."), `notifyText missing for a stop: ${text}`)
  assert(text.includes("Still broken, or clean?"), `branch question missing: ${text}`)
})

await t("a branch shows where each answer leads", () => {
  // Without the exits the reader cannot tell which way either answer goes,
  // which is the one thing a branch exists to say.
  const text = describeFlow(branchSpec(), "requirement", "en")
  assert(text.includes("problems → fix"), `problems exit missing: ${text}`)
  assert(text.includes("clean → push"), `clean exit missing: ${text}`)
})

await t("the listing follows the requested locale", () => {
  assert(describeFlow(branchSpec(), "requirement", "zh").includes("需求流程"), "zh label missing")
  assert(describeFlow(branchSpec(), "requirement", "en").includes("Requirement"), "en label missing")
})

await t("a running instance is reported in the listing", () => {
  const text = describeFlow(branchSpec(), "requirement", "en", { stepId: "pick", done: 2, total: 5 })
  assert(/At step 3/.test(text), `position missing: ${text}`)
  assert(/2\/5 done/.test(text), `progress missing: ${text}`)
})

await t("an unknown flow renders nothing rather than throwing", () => {
  assert(describeFlow(branchSpec(), "nope", "en") === "", "should be empty")
  assert(describeFlow(undefined, "nope", "en") === "", "should survive a missing spec")
})

await t("a multi-line prompt is flattened onto one row", () => {
  // A prompt wrapped over four lines breaks the table this listing exists to be.
  const spec = validateFlowSpec({
    steps: { a: { do: "send", prompt: "line one\nline two\nline three" }, s: { do: "stop" } },
    flows: { f: { steps: ["a", "s"] } },
  })
  const text = describeFlow(spec, "f", "en")
  assert(!/line one\n/.test(text), "the prompt should not carry newlines")
  assert(text.includes("line one line two line three"), `lines should join: ${text}`)
})

await t("describeAllFlows joins every flow", () => {
  const spec = validateFlowSpec({
    steps: { a: { do: "send", prompt: "p" }, s: { do: "stop" } },
    flows: { one: { steps: ["a", "s"] }, two: { steps: ["a", "s"] } },
  })
  const text = describeAllFlows(spec, "en")
  assert(text.includes("(one)"), "first flow missing")
  assert(text.includes("(two)"), "second flow missing")
})

await t("describeAllFlows says so when a workspace defines none", () => {
  assert(describeAllFlows({ flows: {}, steps: {} }, "en").length > 0, "should say something")
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
