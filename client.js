/**
 * decision-orchestrator client: the standing flow panel.
 *
 * One panel, docked above the composer beside the todo list and the goal: the
 * running flow's steps, marked done / in progress / pending, with pause, resume
 * and cancel. It renders from the session projection rather than from the
 * current turn, which is what makes it stay put when the user sends a message —
 * the failure mode of a per-turn panel.
 *
 * Registration mirrors the built-in client plugins:
 *   ctx.slots.inject(`conversation.input.dock`, function* () {
 *     yield ctx.slots.register({ name, id, locale, inject }, Component)
 *   })
 *
 * Source, comments and docs are English throughout this repo. UI strings stay
 * bilingual in DICT because they are what the user reads in the panel.
 */

window.__ModuleLoader__.load({
  id: "dsh-decision-orchestrator",

  factory(require) {
    const react = require("react")

    const h = react.createElement

    const PROJECTION_KEY = "decision-orchestrator"

    const NS = "decision-orchestrator"

    const DICT = {
      zh: {
        "flow.pause": "暂停",
        "flow.resume": "恢复",
        "flow.cancel": "取消",
        "flow.paused": "已暂停",
        "flow.done": "已完成",
        "flow.cancelled": "已取消",
        "flow.progress": "{done}/{total}",
        "flow.hint": "流程由 agent 启动。暂停只停止自动推进，agent 仍可以继续工作。",
        "step.done": "已完成",
        "step.ongoing": "进行中",
        "step.pending": "待完成",
      },
      en: {
        "flow.pause": "Pause",
        "flow.resume": "Resume",
        "flow.cancel": "Cancel",
        "flow.paused": "Paused",
        "flow.done": "Done",
        "flow.cancelled": "Cancelled",
        "flow.progress": "{done}/{total}",
        "flow.hint": "The agent starts a flow. Pausing stops the automatic advance — the agent may keep working.",
        "step.done": "Done",
        "step.ongoing": "In progress",
        "step.pending": "Pending",
      },
    }

    /**
     * Panel styles.
     *
     * Theme tokens only, so light and dark both work without a second set of
     * rules. Class names carry the plugin prefix against colliding with a host
     * component.
     */
    const STYLE = `
.do-flow{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-primary,#3a3a3a);border-radius:8px;background:var(--dsw-alias-background-secondary,rgba(255,255,255,.03));font-size:12px;line-height:1.5;box-sizing:border-box}
.do-flow-head{display:flex;align-items:center;gap:8px}
.do-flow-title{font-weight:600;color:var(--dsw-alias-text-primary,#ddd)}
.do-flow-count{color:var(--dsw-alias-text-secondary,#999);font-variant-numeric:tabular-nums}
.do-flow-badge{padding:1px 8px;border-radius:9px;background:rgba(150,150,150,.16);color:var(--dsw-alias-text-secondary,#999)}
.do-flow-note{color:var(--dsw-alias-text-secondary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38ch}
.do-flow-spacer{flex:1}
.do-flow-btn{background:transparent;border:1px solid var(--dsw-alias-border-primary,#3a3a3a);color:var(--dsw-alias-text-secondary,#aaa);border-radius:5px;padding:1px 8px;font-size:11px;cursor:pointer;line-height:1.6}
.do-flow-btn:hover{background:var(--dsw-alias-background-tertiary,rgba(255,255,255,.08));color:var(--dsw-alias-text-primary,#ddd)}
.do-flow-steps{display:flex;flex-wrap:wrap;gap:4px 10px}
.do-flow-step{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-text-secondary,#999)}
.do-flow-step-done{color:var(--dsw-alias-text-primary,#ccc)}
.do-flow-step-ongoing{color:var(--dsw-alias-text-link,#6aa8ff);font-weight:600}
.do-flow-mark{font-size:11px;line-height:1}
`

    /** Read one locale key, falling back to English then to the key itself. */
    function makeT(activeLocale) {
      return (key, vars) => {
        const dict = DICT[activeLocale()] ?? DICT.en
        let text = dict[key] ?? DICT.en[key] ?? key
        for (const [name, value] of Object.entries(vars ?? {})) {
          text = text.replaceAll(`{${name}}`, String(value))
        }
        return text
      }
    }

    /** The marker and class for one step's state. */
    function stepMark(status) {
      if (status === "done") return { mark: "\u25CF", cls: "do-flow-step-done" }
      if (status === "ongoing") return { mark: "\u25D0", cls: "do-flow-step-ongoing" }
      return { mark: "\u25CB", cls: "" }
    }

    /**
     * The standing panel.
     *
     * Renders through `useProjection`, which subscribes to the smallest slice it
     * needs: the view the host already computed. The Client never folds session
     * events itself.
     */
    function FlowPanel(props) {
      const { t, flow, sessionId, onControl } = props
      if (!flow) return null

      const finished = flow.status === "done" || flow.status === "cancelled"
      const badge = flow.status === "paused" ? t("flow.paused")
        : flow.status === "done" ? t("flow.done")
          : flow.status === "cancelled" ? t("flow.cancelled")
            : ""

      return h(
        "div",
        { className: "do-flow", "data-flow": flow.flow },
        h(
          "div",
          { className: "do-flow-head" },
          h("span", { className: "do-flow-title" }, flow.label ?? flow.flow),
          h("span", { className: "do-flow-count" }, t("flow.progress", { done: flow.done, total: flow.total })),
          badge ? h("span", { className: "do-flow-badge" }, badge) : null,
          flow.note ? h("span", { className: "do-flow-note", title: flow.note }, flow.note) : null,
          h("span", { className: "do-flow-spacer" }),
          // A finished flow offers nothing: pause and cancel would both be lies.
          finished ? null : h(
            "button",
            {
              className: "do-flow-btn",
              type: "button",
              onClick: () => onControl(sessionId, flow.status === "paused" ? "resume" : "pause"),
              title: t("flow.hint"),
            },
            flow.status === "paused" ? t("flow.resume") : t("flow.pause"),
          ),
          finished ? null : h(
            "button",
            { className: "do-flow-btn", type: "button", onClick: () => onControl(sessionId, "cancel") },
            t("flow.cancel"),
          ),
        ),
        h(
          "div",
          { className: "do-flow-steps", role: "list" },
          ...(flow.steps ?? []).map((step) => {
            const { mark, cls } = stepMark(step.status)
            return h(
              "span",
              {
                key: step.id,
                role: "listitem",
                className: `do-flow-step ${cls}`.trim(),
                // The mark is decorative; the status is announced in words.
                title: t(`step.${step.status}`),
                "aria-label": `${step.label}: ${t(`step.${step.status}`)}`,
              },
              h("span", { className: "do-flow-mark", "aria-hidden": "true" }, mark),
              h("span", null, step.label ?? step.id),
            )
          }),
        ),
      )
    }

    function applyClient(ctx) {
      // ── Panel strings follow the DSH language setting ──
      // Fetched rather than injected: a host without the locale service still
      // renders the panel, using the English dictionary.
      //
      // Read on every call, never captured once, so a language switch takes
      // effect on the next render instead of leaving stale text until a reload.
      let localeSvc
      try {
        localeSvc = ctx.get?.("locale")
        for (const [id, dict] of Object.entries(DICT)) localeSvc?.register?.(NS, id, dict)
      } catch { /* keep defaults */ }

      const activeLocale = () => {
        try {
          const active = localeSvc?.getLocale?.()?.active
          if (typeof active === "string" && active.length > 0) {
            return DICT[active] ? active : (active.startsWith("zh") ? "zh" : "en")
          }
        } catch { /* fall through */ }
        return "en"
      }

      try {
        if (typeof document !== "undefined" && !document.getElementById("do-style")) {
          const el = document.createElement("style")
          el.id = "do-style"
          el.textContent = STYLE
          document.head.appendChild(el)
        }
      } catch { /* ignore */ }

      /**
       * Ask the host to pause, resume or cancel.
       *
       * Runs the host's `flow` command through `ctx.remote.commands.execute()`,
       * which is the documented route for a UI action that mutates host state.
       * The panel does not write state itself: the host owns the flow, and a
       * client-side write would be overwritten by the next projection anyway.
       */
      const onControl = (sessionId, action) => {
        try {
          const commands = ctx.remote?.commands
          if (!commands || typeof commands.execute !== "function") return
          commands.execute(sessionId, `/flow ${action}`, [], new AbortController().signal)
        } catch { /* ignore */ }
      }

      ctx.slots.inject("conversation.input.dock", function* () {
        yield ctx.slots.register(
          {
            name: NS,
            id: "flow",
            // After todo (0) and goal (10): a flow sits beside the plan and the
            // goal, not above them. Below queue (20) for the same reason.
            order: 15,
            label: () => {
              const t = makeT(activeLocale)
              return t("flow.pause")
            },
          },
          function FlowDock(props) {
            const t = makeT(activeLocale)
            // The host already computed the view; read that instead of folding
            // session events here.
            let value
            try {
              value = props.useProjection?.(PROJECTION_KEY)
            } catch { /* no projection yet */ }
            const view = value?.value ?? value
            const flow = view?.flow ?? null
            if (!flow) return null
            return h(FlowPanel, { t, flow, sessionId: props.sessionId, onControl })
          },
        )
      })
    }

    return { apply: applyClient }
  },
})
