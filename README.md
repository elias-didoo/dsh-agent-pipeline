# dsh-decision-orchestrator

[中文](README.zh-CN.md) | **English**

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that runs a workspace's fixed review pipeline, sending the next prompt whenever the agent finishes the last one, and asking a local decision model only where the pipeline genuinely forks.

> **It does not think for you.** You decide the process once; it walks it. The model is consulted only at the forks you left open.

## Requirements

- **DSH Desktop** — the plugin needs the client runtime shipped inside `app.asar`.
- **A decision model server speaking `/v1/systemone`.** Built against the [llama.cpp server](https://github.com/ggerganov/llama.cpp) `systemone` interface; verified with a 4B decision model (Kev-4B).
  - Only `choice`, `score` and `noul` question types are used.
  - **No text generation capability is required.**
- The server must be reachable locally; default is `http://127.0.0.1:8080`.

## Install

```bash
git clone https://github.com/elias-didoo/dsh-decision-orchestrator.git \
  ~/.dsh/plugins/decision-orchestrator
cd ~/.dsh/plugins/decision-orchestrator
npm test          # optional, verifies your environment
```

Add the dependency to `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-decision-orchestrator": "file:../../plugins/decision-orchestrator"
  }
}
```

Mount it in `~/.dsh/profiles/desktop/cordis.patch.yml` (full config example under [Configuring a flow](#configuring-a-flow)):

```yaml
- insert:
    - id: decision-orchestrator
      name: "dsh-decision-orchestrator"
      config:
        # ...
```

**Restart DSH.** The sidebar panel only appears after a restart.

## How it works

```
you say what you want → agent calls start_flow("requirement")
                          ↓
        the plugin walks a fixed step list, one step per turn
                          ↓
     ┌────────────────┬────────────────┬────────────────┬─────────────┐
   send            stop             wait-user          branch
 a prompt      pause for you     wait for a phrase   ask the model
```

**Why the split.** A workspace's process is fixed — the steps, their order and
their wording are things you decided once. Walking that process belongs in
code: it is deterministic, it costs nothing, and it cannot drift. What belongs
to the model is the one place the process genuinely forks, such as "does this
self-check still have problems to fix, or is it clean?".

Measured on the shipped configuration, that took the model from being asked on
every turn with twelve options to being asked once per pipeline with two.

**Flows are built from shared steps.** Three pipelines share most of their
steps; only the opening differs. Steps are defined once in a table and referenced
by id, so changing a prompt is one edit rather than three that can drift apart.

## Configuring a flow

Edit this plugin's `config` inside `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
workspaces:
  - path: /Users/you/project
    enabled: true
    steps:
      - id: review
        label: { en: Plan review, zh: 方案评审 }
        do: send
        prompt: Read the docs and code you actually need. Double-check whether…

      - id: confirm
        label: { en: Wait for go-ahead, zh: 等你决定开干 }
        do: stop
        notifyText: Plan is ready — your call whether to start.

      - id: start_work
        label: { en: User says go, zh: 用户说开干 }
        do: wait-user
        prompt: Say "go" when you want me to start checking.
        expect: go

      - id: selfcheck_branch
        label: { en: Any problems left?, zh: 还有问题吗 }
        do: branch
        question: Does the agent say problems remain, or that the check passed?
        options:
          problems: selfcheck_3
          clean: push

      - id: selfcheck_3
        do: send
        prompt: Every self-check finds something new. Do you need another round?

      - id: push
        do: send
        prompt: Push it.

    flows:
      - name: requirement
        label: { en: Requirement, zh: 需求流程 }
        steps: [review, confirm, start_work, selfcheck_branch, selfcheck_3, push]
```

`fixtures/brandu.yml` holds the full working set this plugin was built against
— twelve steps and three flows covering requirement, bug and conflict handling.

## Anatomy of a step

A step is one thing the plugin does when the flow reaches it.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable name. Also the tag on the message it sends. |
| `do` | yes | `send`, `stop`, `wait-user` or `branch`. |
| `label` | no | `{ en, zh }` shown in the panel. Falls back to the first line of prose. |
| `prompt` | `send`, `wait-user` | The message text. For `wait-user`, what tells the user what to say. |
| `notifyText` | no | Panel text explaining what a `stop` means. |
| `expect` | no | `wait-user` only: the phrase the user must say. Empty accepts any message. |
| `question` + `options` | `branch` | A two-way question and the step id each answer leads to. |

### What each kind does

**`send`** posts its prompt and advances. No model involved, which is the
common case.

**`stop`** advances and then holds: the plugin goes quiet until the user speaks.
Use it where you want to look at the plan before work starts.

**`wait-user`** advances only when the newest human message contains `expect`
and was written after the flow arrived here. That second condition is what stops
an old "go" from satisfying every later wait. It is not the same as `stop`: a
`stop` resumes on any reply, a `wait-user` resumes only on the phrase.

**`branch`** asks the model a two-way question and jumps to the chosen step.
Every step the branch skipped stays pending, so the panel shows what was not
done rather than claiming it was.

### Flow rules the validator enforces

- Every step a flow lists must exist in the shared table.
- A flow may not list the same step twice — the log records that a prompt was
  sent, not which visit sent it, so a repeat makes progress unrecoverable.
- A branch has exactly two options, and both must point inside the same flow.
- A flow needs at least one `stop` or `wait-user`, or it would run to the end
  without ever pausing for you.

Configuration is validated at load. A broken reference fails loudly instead of
running until it reaches the bad step and stopping in a state nobody planned.

## Starting a flow

The agent starts a flow by calling the `start_flow` tool — the same mechanism as
`create_goal` or `todo_write`. You ask in words; the agent turns that into the
call.

```
you: 评估如下需求，仅评估，不要动仓库：xxx
agent → start_flow({ flow: "requirement" })
```

The panel also has a start control, for when you would rather not go through the
agent.

Pause, resume and cancel are panel controls, not tools. An agent that could park
its own pipeline could also quietly skip its self-check.

## Language

Two different languages are in play, and they follow different rules.

| What | Follows |
|---|---|
| Panel text, and the "please continue" prompt sent to the agent | **Your DSH language setting** |
| Stage criteria (the text sent to the decision model) | **Chinese, always** |

The panel reads the language from DSH settings, so it matches the rest of the
UI without extra configuration. If you have never explicitly picked a language
in DSH, the plugin falls back to English.

The criteria stay Chinese for the reason above: the model separates situations far
more reliably in Chinese. They are model input, not documentation.

## Confidence

The model returns a probability for each option. Confidence is the probability it
put on the one it chose — raw `p_max`, nothing rescaling it.

Below `confidenceFloor` (default `0.15`) the plugin does not guess: it logs
`uncertain` and holds the flow at the branch. Guessing a direction would send
the wrong follow-up, and the wrong follow-up is harder to notice than a pause.

A branch is now the only place the floor applies, and a two-way question scores
far higher than the twelve-way one it replaced — 43% to 60% on the shipped
configuration against 24% typical before.

**Why not normalize.** An earlier version mapped the random baseline `1/n` to 0
so a fixed threshold would mean the same thing at any option count. That held up
with six options and failed with eleven: correct answers normalised to 0.06–0.41
while outright guesses landed at 0.04–0.06, overlapping, so no threshold
separated them. Raw `p_max` did separate them — correct answers at 0.21 and
above, guesses at 0.14 and below.

**The cost of that choice:** the meaningful range depends on how many decision
points a workspace defines. The default suits roughly ten; a workspace with far
more options may need a lower floor. Every `judge` log entry carries the full
distribution, so the floor can be re-calibrated from real sessions.

## Global settings

```yaml
    defaults:
      maxIterations: 20        # max auto-advance rounds per session
      failureRetryLimit: 3     # stop after this many consecutive errors (network + judge share the counter)
      confidenceFloor: 0.15    # raw p_max threshold
      humanCooldownMs: 30000   # stay quiet this long after you speak
      quietWindowMs: 30000     # stay quiet this long after another agent relays
      contextBudgetRatio: 0.7  # fraction of the model window to use
      maxTurns: 3              # how many turns back to look
```

**Context budget.** The agent's last reply is always kept whole; only earlier turns get truncated to fit. Measured: with the same input, 120 characters of context produced a wrong answer, the full text produced the right one.

The budget is measured by this plugin, not by the host's `tokenMeter`. That
service prices text at four characters per token and its own README says "CJK
text and JSON schemas underprice badly" at that rate, that its figures are "a
reference figure, not a billing record", and that "nothing in the harness makes
decisions from it". Measured here: 4825 Chinese characters cost 5289 tokens
while the meter priced them at 1215 — enough of a shortfall that a request the
plugin believed was 4.8k tokens reached 11.2k and the model rejected it. The
plugin's own estimate charges each character class at its measured cost and
deliberately errs high, because over-estimating trims context while
under-estimating loses the turn.

## Arbitration: when the plugin stays out of the way

Any one of these silences it:

1. One of your messages is still queued for processing
2. You spoke recently (within 30s)
3. Another agent relayed recently (within 30s)
4. **A goal is active and armed** (it advances itself; yield to it)
5. A scheduled task is pending delivery to this session
6. Auto-advance is paused, waiting for your reply

## Stop and recovery

The plugin **stops auto-advancing a session** in several cases and records `stoppedReason`:

| `stoppedReason` | Trigger |
|---|---|
| `non-retryable:<code>` | An unrecoverable error |
| `failure-limit:<n>` | Network errors hit `failureRetryLimit` |
| `iteration-limit:<n>` | Auto-advance rounds hit `maxIterations` |
| `judge-failure:<n>` | The decision service failed repeatedly |

**Once stopped, the session gets no further actions**, until you:

- restart DSH — `stoppedReason` lives in an in-process `WeakMap` and resets on restart; or
- raise the relevant limit (`failureRetryLimit` / `maxIterations`) and restart.

⚠️ **`iterations` accumulates across the whole session** and does not reset when you speak. A long-lived session reused across many tasks will burn through the budget and stop at `maxIterations`. Restart DSH or raise the value to keep reusing it.

## Network errors

When the agent stops because of a network drop or provider timeout, the plugin re-sends "please continue" until `failureRetryLimit` is reached.

**Note: this counter is shared across all error kinds** — network errors, send failures, and decision-service failures. They all use `failures`, which only resets after a prompt is sent successfully. Different error kinds therefore accelerate each other toward the limit.

This does not conflict with `dsh-llm-retry`: that is a system-level reconnect, while this plugin only sends after the session has **already stopped**.

## The panel

A flow in progress shows a standing panel above the composer: one row per step, marked done, in progress or pending, with the flow's name and an `n/m` count. Pause, resume and cancel live there.

The panel is driven by the session projection, not by the current turn, so it stays put when you send a message. That is the one behaviour worth checking after a change: the state it renders comes from the log, so a session reloaded from disk shows the same thing.

Edit `cordis.patch.yml` to change them; restart DSH to apply.

> The client panel requires **a DSH restart** after first install.

## Message source tag

Messages the plugin sends carry `source.kind = "decision"`, keeping them distinct from human messages:

- they do not trigger session-title generation
- they do not reset duplicate-tool-call protection
- they are not mistaken for human activity, so the plugin cannot suppress itself
- the plugin counts them in the log to know which points have fired

## Reading the log

The plugin sends no notifications. To find out when and why it stopped, read
the log:

```bash
tail -f ~/.dsh/decision-orchestrator/logs/$(date +%F).jsonl
```

| `ev` | Meaning |
|---|---|
| `apply` / `projection-ready` | Plugin mounted, projection ready |
| `locale` | UI language resolved for this process |
| `judge` | One judgement; includes `decision`, `confidence`, full `probabilities` |
| `pick` | Which decision point was selected; includes `decision`, `progress` |
| `halt` | A stop rule fired; auto-advance paused. `ruleId` says which |
| `stop` | Terminated by an error or the iteration limit. `why` says why |
| `uncertain` | Confidence below the floor, no judgement made |
| `send` | A prompt was sent; includes `ruleId`, `iterations` |
| `send-fail` | Send failed; includes `err` |
| `skip` | Held back, no action. `why` explains (arbitration, paused, empty input, …) |
| `error` | One execution failed but below the termination threshold |
| `retry` | Re-sent "please continue" after a network interruption |

## Tests

```bash
node test/all.mjs          # everything (includes a live model server)
node test/all.mjs --fast   # skip the live-model suite
./test/typecheck.sh        # type check only
```

| Suite | Covers |
|---|---|
| `contracts.mjs` | DSH runtime contracts, inject coverage, zero external deps |
| `apply.mjs` | Projection wiring and schemas |
| `context.mjs` | Context budget, last-message priority, source labels |
| `confidence.mjs` | Confidence (raw p_max) and the uncertain path |
| `phase.mjs` | Stage progress derivation + `pickRule` lookup |
| `flow.mjs` | Every branch of the main loop |
| `e2e-kev.mjs` | End-to-end against a live model |

## Troubleshooting

```bash
tail -20 ~/.dsh/decision-orchestrator/logs/$(date +%F).jsonl
```

Key `ev` values: `judge` (decision and confidence), `pick` (which decision point), `send`, `skip` (held back — see `why`), `halt` (paused by a stop point), `stop` (terminated by an error or limit).
