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
              local model picks the decision point that fits
                          ↓
              plugin checks the log: has this one already fired?
                          ↓
        ┌─────────────────┼─────────────────┐
      send            stop and wait      do nothing
```

**Why the split.** Choosing what the situation is belongs to the model: it reads
the conversation, including the plugin's own messages, and matches it against
the `when` text you wrote. Remembering what has already happened belongs to the
plugin: it counts its own messages in the log, which is exact and costs nothing.

Neither half guesses at the other's job. The model is never asked to keep score,
and the plugin never tries to interpret prose.

## Configuring decision points

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
        decisions:
          - id: bug_root
            when: The user reported a bug and the agent has investigated, but the root cause is still a guess and the plugin has not yet asked for evidence.
            do: send
            prompt: Is that a guess or a proven root cause? If you need anything from the browser console, go get it yourself — the CDP and login scripts are already there.

          - id: review
            when: The agent just produced a technical plan or assessment and the plugin has not yet sent its review request.
            do: send
            prompt: Read the docs and code you actually need. Double-check whether the assessment is complete…

          - id: summarize
            when: The plugin already sent its review request and the agent has answered it, but the plugin has not yet asked for a consolidated list.
            do: send
            prompt: List every change you plan to make, with all the important points.

          - id: confirm
            when: The agent has listed its planned changes and is waiting for the user to decide whether to start.
            do: stop
            notifyText: Plan is ready — your call whether to start.

          - id: finished
            when: The work is pushed (the reply contains HEAD -> main) or the agent has explicitly declared the task complete.
            do: stop
            notifyText: Work is done.
```

`fixtures/brandu.yml` holds the full working set this plugin was built against
— twelve decision points covering a review loop, three self-check rounds and
conflict handling. The example above is trimmed to keep this section readable.

## Anatomy of a decision point

A decision point is one thing the plugin may do next. The model reads the
conversation and picks whichever one describes the situation; the plugin
carries it out.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable name. Also the tag on the message it sends. |
| `when` | yes | **The situation this applies to, in words.** This is the model's input. |
| `do` | yes | `send` a message, `stop` and wait for the user, or `silent` do nothing. |
| `prompt` | for `send` | The message text. |
| `notifyText` | no | Panel label explaining what a `stop` means. |

There is no stage list, no behaviour table and no condition expression. `when`
is prose because the model is better at recognising "the agent still says it
found problems" than any pattern would be.

### Ordering

**Decision points fire once each.** Order in the config does not sequence them
— the model picks by situation, not by position. What order affects is only how
the list reads in the panel.

The plugin guarantees a `send` never repeats: it counts the messages it has
already sent, by `id`, and refuses to send the same one twice. A `stop` halts
auto-advance once and then stays quiet until the user speaks again.

### Writing `when` that works

The model separates situations by the boundaries between them, and it can only
use what is in the conversation. Two rules, both measured:

**Quote what the plugin already sent.** The conversation contains the plugin's
own messages, so name them by their opening words:

```yaml
- id: summarize
  when: The review request「Read the docs and code you actually need」has already
        appeared, and the agent just replied to it — but the agent's reply is a
        review conclusion, not a numbered list.
- id: confirm
  when: The plugin's「List every change you plan to make」message has appeared,
        and the agent's reply is a numbered list of changes.
```

Without those quotes the two entries are nearly identical to the model. With
them, one scenario went from 14.8% to 51.1% confidence on the right answer.

**Describe what the reply looks like, not just what happened.** "The agent
produced a plan" fits both before and after the review. "A numbered list of
changes" is something only the summarised reply has.

Write them in whatever language you configured the rules in. Chinese and English
both work.

### The cost of more decision points

Every decision point is an option for the model, and more options make adjacent
descriptions harder to tell apart. Measured on a twelve-point set: removing a
single unrelated entry — one that describes a situation nowhere in the
conversation — flipped a correct answer to its neighbour, because it diluted the
field.

So when a set stops working, the fix is usually to sharpen the two entries that
sit next to each other, not to add more of them. A workspace with a dozen
decision points needs more distinct `when` texts than one with three.

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

Below `confidenceFloor` (default `0.15`) the plugin does nothing: it logs
`uncertain` and pauses automatic advancement. A turn where the conversation
does not clearly match any decision point therefore produces no action, which is
the intended outcome.

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

Right-click a workspace in the left sidebar → **Decision rules…** → every decision point in config order, each with its `when` text.

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
