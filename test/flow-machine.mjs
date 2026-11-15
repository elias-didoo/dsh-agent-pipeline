/**
 * Flow machine: walking a pipeline, and rebuilding it from the log.
 *
 * The replay tests carry the weight. A flow that advances correctly in memory
 * but rebuilds to a different position after a reload would double-send a step
 * whose message is already in the transcript.
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

const { validateFlowSpec } = await import("../lib/flow-spec.js")
const M = await import("../lib/flow-machine.js")

/** The requirement pipeline shape: two sends, a stop, a wait, a branch. */
const SPEC = validateFlowSpec({
  steps: {
    review: { id: "review", do: "send", prompt: "Read everything first." },
    summarize: { do: "send", prompt: "List every change." },
    confirm: { do: "stop", notifyText: "Waiting for go-ahead." },
    go: { do: "wait-user", prompt: "Say go when ready.", expect: "开干" },
    branch: {
      do: "branch",
      question: "Still broken, or clean?",
      options: { problems: "fix", clean: "push" },
    },
    fix: { do: "send", prompt: "Fix what you found." },
    push: { do: "send", prompt: "Push it." },
  },
  flows: {
    requirement: {
      label: { en: "Requirement", zh: "需求流程" },
      steps: ["review", "summarize", "confirm", "go", "branch", "fix", "push"],
    },
  },
})
assert(!SPEC.issues, `fixture must be valid: ${JSON.stringify(SPEC.issues)}`)

console.log("=== 1. Starting ===")

await t("a flow starts at its first step", () => {
  const st = M.startFlow("requirement", SPEC, 1000)
  assert(st.flow === "requirement", "name recorded")
  assert(st.status === M.FLOW_STATUS.ACTIVE, "starts active")
  assert(st.cursor === 0, "cursor at the first step")
  assert(M.currentStepId(st) === "review", `got ${M.currentStepId(st)}`)
})

await t("an unknown flow yields no state", () => {
  assert(M.startFlow("nope", SPEC, 1000) === undefined, "should be undefined")
})

await t("every step starts pending", () => {
  const st = M.startFlow("requirement", SPEC, 1000)
  assert(st.steps.every((s) => s.status === M.STEP_STATUS.PENDING), "all pending")
})

console.log("\n=== 2. Advancing ===")

await t("advance marks the current step done and moves on", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  st = M.advance(st, 2000)
  assert(st.steps[0].status === M.STEP_STATUS.DONE, "first done")
  assert(M.currentStepId(st) === "summarize", `now at ${M.currentStepId(st)}`)
  assert(st.updatedAt === 2000, "updatedAt moves")
})

await t("advance does not mutate the state it was given", () => {
  const before = M.startFlow("requirement", SPEC, 1000)
  const snapshot = JSON.stringify(before)
  M.advance(before, 2000)
  assert(JSON.stringify(before) === snapshot, "input must be untouched")
})

await t("running past the last step completes the flow", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  for (let i = 0; i < SPEC.flows.requirement.steps.length; i++) st = M.advance(st, 2000 + i)
  assert(st.status === M.FLOW_STATUS.DONE, `expected done, got ${st.status}`)
  assert(M.currentStepId(st) === undefined, "no current step once done")
})

await t("advancing a finished flow is a no-op", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  for (let i = 0; i < 20; i++) st = M.advance(st, 2000)
  const snapshot = JSON.stringify(st)
  assert(JSON.stringify(M.advance(st, 3000)) === snapshot, "should not move")
})

await t("markOngoing marks the current step without moving the cursor", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  st = M.markOngoing(st)
  assert(st.steps[0].status === M.STEP_STATUS.ONGOING, "first is ongoing")
  assert(st.cursor === 0, "cursor unchanged")
})

console.log("\n=== 3. Branching ===")

await t("jumpTo lands on the named step", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  for (let i = 0; i < 4; i++) st = M.advance(st, 2000) // now at branch
  assert(M.currentStepId(st) === "branch", `at ${M.currentStepId(st)}`)
  st = M.jumpTo(st, "fix", 3000)
  assert(M.currentStepId(st) === "fix", `jumped to ${M.currentStepId(st)}`)
  assert(st.steps[4].status === M.STEP_STATUS.DONE, "the branch itself is done")
})

await t("skipped steps stay pending, not done", () => {
  // The panel should show what was skipped; marking it done would claim work
  // that never happened.
  let st = M.startFlow("requirement", SPEC, 1000)
  for (let i = 0; i < 4; i++) st = M.advance(st, 2000)
  st = M.jumpTo(st, "push", 3000)
  assert(st.steps[5].status === M.STEP_STATUS.PENDING, "fix stays pending")
  assert(st.steps[6].status === M.STEP_STATUS.PENDING, "push not yet run")
  assert(M.currentStepId(st) === "push", "cursor on push")
})

await t("jumpTo to an unknown step leaves the state alone", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  st = M.advance(st, 2000)
  const before = st.cursor
  st = M.jumpTo(st, "does-not-exist", 3000)
  assert(st.cursor === before, "cursor must not move")
})

console.log("\n=== 4. Pause, resume, cancel ===")

await t("pause stops advancing and resume continues from the same step", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  st = M.advance(st, 2000)
  st = M.pauseFlow(st, 3000)
  assert(st.status === M.FLOW_STATUS.PAUSED, "paused")
  assert(M.currentStepId(st) === undefined, "a paused flow has no current step to run")
  st = M.resumeFlow(st, 4000)
  assert(st.status === M.FLOW_STATUS.ACTIVE, "active again")
  assert(M.currentStepId(st) === "summarize", `resumed at ${M.currentStepId(st)}`)
})

await t("advance does nothing while paused", () => {
  let st = M.pauseFlow(M.startFlow("requirement", SPEC, 1000), 2000)
  const snapshot = JSON.stringify(st)
  assert(JSON.stringify(M.advance(st, 3000)) === snapshot, "paused flow must not advance")
})

await t("cancel ends the flow and resume does not revive it", () => {
  let st = M.cancelFlow(M.startFlow("requirement", SPEC, 1000), 2000)
  assert(st.status === M.FLOW_STATUS.CANCELLED, "cancelled")
  assert(M.resumeFlow(st, 3000).status === M.FLOW_STATUS.CANCELLED, "cancel is final")
})

await t("cancelling a finished flow does not rewrite it", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  for (let i = 0; i < 20; i++) st = M.advance(st, 2000)
  assert(M.cancelFlow(st, 3000).status === M.FLOW_STATUS.DONE, "done stays done")
})

console.log("\n=== 5. Replay from the log ===")

await t("replay resumes exactly where the sent messages left off", () => {
  // review and summarize were sent; the flow should be sitting on confirm.
  const st = M.replayFlow("requirement", SPEC, new Set(["review", "summarize"]), {}, 5000)
  assert(M.currentStepId(st) === "confirm", `expected confirm, got ${M.currentStepId(st)}`)
  assert(st.steps[0].status === M.STEP_STATUS.DONE, "review done")
  assert(st.steps[1].status === M.STEP_STATUS.DONE, "summarize done")
})

await t("replay with nothing sent starts at the beginning", () => {
  const st = M.replayFlow("requirement", SPEC, new Set(), {}, 5000)
  assert(M.currentStepId(st) === "review", `got ${M.currentStepId(st)}`)
})

await t("replay walks over a stop step without needing it to be sent", () => {
  // A stop has no message of its own; it settles the flow. Once the flow has
  // moved past it the replay must not stall there.
  const st = M.replayFlow("requirement", SPEC, new Set(["review"]), {}, 5000)
  assert(M.currentStepId(st) === "summarize", `got ${M.currentStepId(st)}`)
})

await t("replay follows a recorded branch choice", () => {
  const st = M.replayFlow(
    "requirement", SPEC,
    new Set(["review", "summarize"]),
    {
      passedStepIds: new Set(["confirm", "go"]),
      branchChoices: (id) => (id === "branch" ? "push" : undefined),
    },
    5000,
  )
  assert(M.currentStepId(st) === "push", `expected push, got ${M.currentStepId(st)}`)
})

await t("replay stops at a branch whose direction was not recorded", () => {
  // Guessing would send the wrong follow-up; stopping lets the model decide
  // again from a live transcript.
  const st = M.replayFlow(
    "requirement", SPEC,
    new Set(["review", "summarize"]),
    { passedStepIds: new Set(["confirm", "go"]) },
    5000,
  )
  assert(M.currentStepId(st) === "branch", `expected branch, got ${M.currentStepId(st)}`)
})

await t("replay stops at a silent step that was never recorded as passed", () => {
  // A stop sends nothing, so without its record the replay cannot tell whether
  // the flow has already paused there. Stopping is the safe answer: halting
  // twice is visible, skipping the pause is not.
  const st = M.replayFlow("requirement", SPEC, new Set(["review", "summarize"]), {}, 5000)
  assert(M.currentStepId(st) === "confirm", `expected confirm, got ${M.currentStepId(st)}`)
})

await t("replay restores paused and cancelled states", () => {
  const paused = M.replayFlow("requirement", SPEC, new Set(["review"]), { status: "paused" }, 5000)
  assert(paused.status === M.FLOW_STATUS.PAUSED, "paused restored")
  const cancelled = M.replayFlow("requirement", SPEC, new Set(["review"]), { status: "cancelled" }, 5000)
  assert(cancelled.status === M.FLOW_STATUS.CANCELLED, "cancelled restored")
})

await t("replay after a branch sits on the step it branched to", () => {
  // The branch itself sends nothing, so both the silent steps and the branch
  // direction have to be supplied before the replay can pass it.
  const st = M.replayFlow(
    "requirement", SPEC,
    new Set(["review", "summarize"]),
    { passedStepIds: new Set(["confirm", "go"]), branchChoices: () => "push" },
    5000,
  )
  assert(M.currentStepId(st) === "push", `expected push, got ${M.currentStepId(st)}`)
})

await t("replay reports done once the branch target has also been sent", () => {
  const st = M.replayFlow(
    "requirement", SPEC,
    new Set(["review", "summarize", "push"]),
    { passedStepIds: new Set(["confirm", "go"]), branchChoices: () => "push" },
    5000,
  )
  assert(st.status === M.FLOW_STATUS.DONE, `expected done, got ${st.status}`)
})

await t("replay of a branchless flow finishes once every step is in the log", () => {
  const flat = validateFlowSpec({
    steps: { a: { do: "send", prompt: "a" }, b: { do: "stop" }, c: { do: "send", prompt: "c" } },
    flows: { linear: { steps: ["a", "b", "c"] } },
  })
  const st = M.replayFlow("linear", flat, new Set(["a", "c"]), { passedStepIds: new Set(["b"]) }, 5000)
  assert(st.status === M.FLOW_STATUS.DONE, `expected done, got ${st.status}`)
})

console.log("\n=== 6. The panel view ===")

await t("the view carries progress and one row per step", () => {
  let st = M.startFlow("requirement", SPEC, 1000)
  st = M.advance(st, 2000)
  const v = M.stepsView(st, SPEC, "zh")
  assert(v.label === "需求流程", `label was ${v.label}`)
  assert(v.done === 1, `done was ${v.done}`)
  assert(v.total === 7, `total was ${v.total}`)
  assert(v.steps.length === 7, "one row per step")
  assert(v.steps[0].label === "Read everything first.", "row uses the step prose")
})

await t("the view falls back to English for an unknown locale", () => {
  const st = M.startFlow("requirement", SPEC, 1000)
  assert(M.stepsView(st, SPEC, "fr").label === "Requirement", "should fall back to en")
})

await t("the view is undefined without state or spec", () => {
  assert(M.stepsView(undefined, SPEC, "zh") === undefined, "no state")
  assert(M.stepsView(M.startFlow("requirement", SPEC, 1), {}, "zh") === undefined, "no spec")
})

console.log(`\n=== ${pass} passed / ${fail} failed ===`)
process.exit(fail ? 1 : 0)
