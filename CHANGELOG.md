# Changelog

## 0.1.0 — first release

A workspace's review process, written down once and walked by the plugin.

- **Flows as config.** A workspace declares `steps` and `flows`; three flows
  ship as an example: `requirement`, `bug`, `conflict`.
- **Four step kinds.** `send` (a prompt), `stop` and `wait-user` (pause for
  someone), `branch` (the local model picks between two answers).
- **Cursor from the transcript.** The flow's position is derived by replaying the
  session log each turn, so a resumed session lands where it left off and a
  paused flow does not lose its place.
- **A standing panel** above the composer: the running flow's steps, marked done,
  in progress or pending, with pause, resume and cancel.
- **Read the rules** from the workspace's right-click menu — every flow, every
  step, the whole prompt, and where each branch leads.
- **Two ways to start.** The agent calls `start_flow` when you ask for a
  requirement or report a bug; `/flow <name>` starts one yourself. Pause, resume
  and cancel are yours alone, so an agent cannot park its own pipeline and skip a
  self-check.

### Installing

Installs as a DSH bundle. Download the tarball from this release and point
**Plugins → Add plugin** at it. See the README for the config that follows.

### Known limits

- The decision model is a local `/v1/systemone` endpoint. Without one the plugin
  loads and a flow without branch steps still runs, but a `branch` step cannot
  decide.
- The panel and the workspace menu need a DSH restart to appear the first time: a
  reload replaces the host half, not the browser's module generation.
