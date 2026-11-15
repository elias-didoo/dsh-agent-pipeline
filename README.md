# dsh-decision-orchestrator

[中文](README.zh-CN.md) | **English**

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that judges what an agent should do after each turn, using a local decision model, and then follows the rules you wrote.

> **It does not think for you.** It hands one judgement — "what should happen next?" — to a model, then executes the rules you configured.

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

Mount it in `~/.dsh/profiles/desktop/cordis.patch.yml` (full config example under [Configuring rules](#configuring-rules)):

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
you ask → agent works → agent stops
                          ↓
              plugin reads the agent's last reply + the previous few turns
                          ↓
              local model picks one of the stages
                          ↓
              plugin counts its own messages in the log to know
              how far into that stage we are
                          ↓
        ┌─────────────────┼─────────────────┐
      send            stop and wait      do nothing
```

**Why the split.** The model is good at "are we still discussing the plan, or already editing code?" It cannot tell "is this the second or the third self-check round" — that information is not in the conversation text. So stages go to the model, ordering goes to a counter.

## Stages

A stage answers one question: which part of the work is the agent in right now?
Its `behavior` decides what the plugin does once that is known.

The stages below are **defaults**. A workspace may replace the whole list — see
[Customizing stages](#customizing-stages).

| Stage | Behavior | Meaning |
|---|---|---|
| `planning` | `sequence` | Requirements or design under discussion; no code touched yet |
| `implementing` | `passive` | Code is being edited |
| `selfchecking` | `sequence` | Code changes done, self-check in progress |
| `waiting` | `terminal` | Agent stopped and is explicitly waiting on you |
| `finished` | `terminal` | Work is fully done (pushed, or explicitly declared complete) |
| `conflict` | `once` | Rebase/merge hit conflicts |

### The four behaviors

| Behavior | What happens |
|---|---|
| `sequence` | Fire the stage's `send` rules in config order, one per visit. Once all have fired, hand over to the stage's `stop` rule. |
| `once` | Fire the first unfired `send` rule, then stop selecting for this stage. |
| `terminal` | Never send — fire the `stop` rule so auto-advance halts and waits for you. |
| `passive` | Do nothing. For stages where the agent is working and must not be nudged. |

## Configuring rules

Edit this plugin's `config` inside `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: decision-orchestrator
  name: "dsh-decision-orchestrator"
  config:
    model:
      baseUrl: http://127.0.0.1:8080
      name: kev-latest
    workspaces:
      - path: /Users/you/project
        enabled: true
        rules:
          # ── planning: each fires once, in order ──
          - id: bug_root
            when: planning
            scene: user reported a bug, agent investigated but the root cause is still a guess, no evidence yet
            action: send
            prompt: Is that a guess or a proven root cause? If you need anything from the browser console, go get it yourself — the CDP and login scripts are already there.

          - id: review
            when: planning
            scene: user has not said "go" yet, agent just produced a technical plan or assessment
            action: send
            prompt: Read the docs and code you actually need. Double-check whether the assessment is complete and whether it affects anything else. Is this plan the best experience for users? Is the architecture sound, elegant and simple? Is the code idiomatic? Is anything over-engineered? Does it match the project's documented direction and philosophy? Get it right in one pass, leave no technical debt, do not worry about migrating old data. Assessment only — do not touch the repo. Do not stop halfway to ask whether to continue; answer once you are certain. Documentation is a reference, not gospel — think independently about what is actually right. Search for industry best practice when unsure…

          - id: summarize
            when: planning
            scene: second-pass review done, needs a consolidated change list
            action: send
            prompt: List every change you plan to make, with all the important points.

          - id: need_confirm
            when: planning
            scene: change list delivered, waiting for the user to decide whether to start
            action: stop
            notifyText: Plan is ready — your call whether to start.

          # ── selfchecking: fixed four steps ──
          - id: selfcheck_1
            when: selfchecking
            scene: code changes complete, no self-check yet
            action: send
            prompt: Carefully review every file you just changed. Did everything planned get done? Did you touch anything out of scope? Did you introduce new problems? Is anything over-engineered? Are comments and docs up to the project's conventions? Fix what you find. What errors and warnings does the type check, lint and build report?…

          - id: selfcheck_2
            when: selfchecking
            scene: first self-check round finished
            action: send
            prompt: Are the problems actually fixed? Fix whatever is still broken.

          - id: selfcheck_3
            when: selfchecking
            scene: second self-check round finished
            action: send
            prompt: Every self-check round finds something new. Do you think another round is worth it? What would you focus on, and how?

          - id: push
            when: selfchecking
            scene: all three self-check rounds done
            action: send
            prompt: Push

          # ── other stages ──
          - id: conflict
            when: conflict
            scene: rebase or merge onto latest head hit conflicts
            action: send
            prompt: Were there conflicts when you rebased/merged onto latest head? How did you resolve them?

          - id: waiting
            when: waiting
            scene: agent stopped and is waiting for a user decision
            action: stop
            notifyText: Needs your attention.

          - id: finished
            when: finished
            scene: work pushed, or agent explicitly declared everything complete
            action: stop
            notifyText: Request complete.
```

### Rule fields

| Field | Description |
|---|---|
| `id` | Rule identifier, unique within a workspace |
| `when` | **Which stage this rule belongs to** — a defined stage id (the six above, or your own) |
| `scene` | Human-readable description, helps you remember when it applies (not sent to the model) |
| `action` | `send` auto-send / `stop` wait for you / `silent` do nothing |
| `prompt` | Required when `action: send` |
| `notifyText` | Optional; shown in the panel to explain what this rule stops on |

### Ordering within a stage

**`send` rules sharing the same `when` fire once each, in config order.**

- `planning`: `bug_root` → `review` → `summarize`, then `need_confirm` stops.
- `selfchecking`: `selfcheck_1` → `selfcheck_2` → `selfcheck_3` → `push`, then stop.

Ordering comes from **counting messages already in the log**, not from the model, so it is exact.

## Customizing stages

Stages are data. Add one, drop one, or rename one — nothing in the pipeline
branches on a stage id.

Define `stages` and the built-in list is replaced **wholesale**:

```yaml
    stages:
      - id: intake
        behavior: sequence
        label: { en: "Intake", zh: "接需求" }
        criteria: 用户刚提出需求，agent 还在确认要做什么
      - id: coding
        behavior: passive
        label: { en: "Coding", zh: "写代码" }
        criteria: agent 正在修改代码文件
      - id: handover
        behavior: terminal
        label: { en: "Handover", zh: "交接" }
        criteria: agent 已经推送完成，或明确宣告需求结束

    workspaces:
      - path: /Users/you/project
        enabled: true
        rules:
          - id: clarify
            when: intake        # ← refers to your stage id
            scene: 需求还不清楚
            action: send
            prompt: 你想改哪个页面？
          - id: confirm
            when: intake
            scene: 需求已确认
            action: stop
          - id: done
            when: handover
            scene: 已完成
            action: stop
```

### What each field needs

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique. This is what a rule's `when` refers to. |
| `behavior` | yes | One of `sequence`, `once`, `terminal`, `passive`. |
| `label.en` / `label.zh` | yes | Shown in the panel; the client picks by UI language. |
| `criteria` | yes | The description sent to the model. **Chinese works best** — see below. |

### Two things validation enforces

**At least one `terminal` stage.** Without one, a `sequence` stage that has
fired all its rules has nowhere to hand over, so every later turn would log a
skip and the pipeline would never settle.

**Every stage needs `criteria`.** The model picks a stage by matching the
conversation against those descriptions. A stage with vague criteria is a stage
the model will never choose.

### Writing criteria that actually work

The model separates stages by the boundaries between them, not by the stage
names. Two things measurably help:

- **State what distinguishes a stage from its neighbours**, not just what it is.
- **Write them in Chinese.** On nine scenarios from real sessions, Chinese
  criteria scored 8/9 while English translations of the same descriptions
  scored 5/9 and fell below the confidence floor on short replies. Cross-checks
  showed the criteria language is what matters, not the transcript language.

After adding a stage, exercise it: run a session that reaches it and check the
log shows the new stage being picked. `judge` events carry the stage and its
confidence.

## Language

Two different languages are in play, and they follow different rules.

| What | Follows |
|---|---|
| Panel text, and the "please continue" prompt sent to the agent | **Your DSH language setting** |
| Stage criteria (the text sent to the decision model) | **Chinese, always** |

The panel reads the language from DSH settings, so it matches the rest of the
UI without extra configuration. If you have never explicitly picked a language
in DSH, the plugin falls back to English.

The criteria stay Chinese for the reason above: the model separates stages far
more reliably in Chinese. They are model input, not documentation.

## Confidence

The model returns a probability distribution. The plugin uses a **normalized confidence**:

```
normalized = (p_max - 1/n) / (1 - 1/n)
```

This maps "pure guess" to 0 and "certain" to 1.

**Why normalize.** Raw `p_max` means different things at different option counts — a guess is 0.5 with two options but 0.167 with six. Without normalization, a fixed threshold drifts with the number of stages.

**So the plugin always sends every defined stage to the model**, never trimming to the ones you configured. Otherwise the option count varies per workspace and the same 0.5 would mean different things. Stages you have no rules for simply never get selected.

Below `confidenceFloor` (default 0.3) the plugin does nothing: it logs `uncertain` and pauses automatic advancement.

## Global settings

```yaml
    defaults:
      maxIterations: 20        # max auto-advance rounds per session
      failureRetryLimit: 3     # stop after this many consecutive errors (network + judge share the counter)
      confidenceFloor: 0.3     # normalized confidence threshold
      humanCooldownMs: 30000   # stay quiet this long after you speak
      quietWindowMs: 30000     # stay quiet this long after another agent relays
      contextBudgetRatio: 0.7  # fraction of the model window to use
      maxTurns: 3              # how many turns back to look
```

**Context budget.** The agent's last reply is always kept whole; only earlier turns get truncated to fit. Measured: with the same input, 120 characters of context produced a wrong stage, the full text produced the right one.

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

## Viewing rules

Right-click a workspace in the left sidebar → **Decision rules…** → rules listed grouped by stage.

Edit `cordis.patch.yml` to change them; restart DSH to apply.

> The client panel requires **a DSH restart** after first install.

## Message source tag

Messages the plugin sends carry `source.kind = "decision"`, keeping them distinct from human messages:

- they do not trigger session-title generation
- they do not reset duplicate-tool-call protection
- they are not mistaken for human activity, so the plugin cannot suppress itself
- the plugin counts them in the log to derive stage progress

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
| `judge` | One judgement; includes `stage`, `confidence`, `rawConfidence` |
| `pick` | Which rule was selected; includes `stage`, `ruleId`, `progress` |
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
| `confidence.mjs` | Confidence normalization and threshold behaviour |
| `phase.mjs` | Stage progress derivation + `pickRule` lookup |
| `flow.mjs` | Every branch of the main loop |
| `e2e-kev.mjs` | End-to-end against a live model |

## Troubleshooting

```bash
tail -20 ~/.dsh/decision-orchestrator/logs/$(date +%F).jsonl
```

Key `ev` values: `judge` (stage and confidence), `pick` (which rule), `send`, `skip` (held back — see `why`), `halt` (paused by a stop rule), `stop` (terminated by an error or limit).
