/**
 * dsh-agent-pipeline client: the standing flow panel.
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
  id: "dsh-agent-pipeline",

  factory(require) {
    const react = require("react")

    const h = react.createElement

    const PROJECTION_KEY = "agent-pipeline"

    const NS = "agent-pipeline"

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
        "rules.menu": "Agent 流程…",
        "rules.title": "Agent 流程",
        "rules.on": "已启用",
        "rules.off": "未启用",
        "rules.close": "关闭",
        "rules.steps": "{n} 步",
        "rules.empty": "这个工作区没有开启 agent-pipeline。",
        "rules.noSession": "先在这个工作区打开一个会话，才能读到它的流程。",
        "rules.notLoaded": "这个工作区的会话还没载入流程信息，切到该工作区的会话后再试。",
        "rules.elsewhere": "改流程请编辑 profile 里的 cordis.patch.yml。",
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
        "rules.menu": "Agent flows\u2026",
        "rules.title": "Agent flows",
        "rules.on": "On",
        "rules.off": "Off",
        "rules.close": "Close",
        "rules.steps": "{n} steps",
        "rules.empty": "agent-pipeline is not enabled for this workspace.",
        "rules.noSession": "Open a session in this workspace to read its flows.",
        "rules.notLoaded": "This workspace's sessions have not loaded their flows yet; open one of them and try again.",
        "rules.elsewhere": "To change a flow, edit cordis.patch.yml in the profile.",
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
.ap-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);padding:24px}
.ap-panel{display:flex;flex-direction:column;width:min(780px,100%);max-height:min(80vh,760px);border:1px solid var(--dsw-alias-border-primary,#3a3a3a);border-radius:10px;background:var(--dsw-alias-background-primary,#1e1e1e);box-shadow:0 12px 40px rgba(0,0,0,.45);font-size:12.5px;line-height:1.6;color:var(--dsw-alias-text-primary,#ddd);box-sizing:border-box}
.ap-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-primary,#3a3a3a)}
.ap-title{font-weight:600;font-size:13px}
.ap-state{padding:1px 8px;border-radius:9px;font-size:11px;background:rgba(150,150,150,.16);color:var(--dsw-alias-text-secondary,#999)}
.ap-state-on{background:rgba(80,160,110,.2);color:var(--dsw-alias-text-primary,#ccc)}
.ap-where{color:var(--dsw-alias-text-secondary,#999);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:32ch}
.ap-spacer{flex:1}
.ap-close{background:transparent;border:1px solid var(--dsw-alias-border-primary,#3a3a3a);color:var(--dsw-alias-text-secondary,#aaa);border-radius:5px;padding:1px 9px;font-size:11px;cursor:pointer;line-height:1.7}
.ap-close:hover{background:var(--dsw-alias-background-tertiary,rgba(255,255,255,.08));color:var(--dsw-alias-text-primary,#ddd)}
.ap-body{overflow:auto;padding:8px 14px 12px}
.ap-note{padding:12px 2px;color:var(--dsw-alias-text-secondary,#999)}
.ap-flow{margin-top:8px;border:1px solid var(--dsw-alias-border-primary,#333);border-radius:8px;overflow:hidden}
.ap-flow-head{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;text-align:left}
.ap-flow-head:hover{background:var(--dsw-alias-background-tertiary,rgba(255,255,255,.05))}
.ap-caret{width:10px;color:var(--dsw-alias-text-secondary,#888);font-size:10px}
.ap-flow-name{font-weight:600}
.ap-flow-count{color:var(--dsw-alias-text-secondary,#999);font-variant-numeric:tabular-nums;font-size:11px}
.ap-rows{padding:2px 10px 8px;border-top:1px solid var(--dsw-alias-border-primary,#333)}
.ap-row{display:grid;grid-template-columns:24px 128px 60px 1fr;gap:8px;align-items:baseline;padding:3px 0}
.ap-idx{color:var(--dsw-alias-text-secondary,#888);font-variant-numeric:tabular-nums;text-align:right}
.ap-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all}
.ap-kind{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-text-secondary,#999)}
.ap-prose{white-space:pre-wrap;word-break:break-word}
.ap-exit{grid-column:2/5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-text-secondary,#999)}
.ap-foot{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-primary,#3a3a3a);color:var(--dsw-alias-text-secondary,#999);font-size:11px}
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

    /** One flow's collapsible block: its label, step count, then every step. */
    function FlowBlock(props) {
      const { t, locale, name, flow, spec, open, onToggle } = props
      const label = (flow?.label && (flow.label[locale] || flow.label.en)) || name
      const ids = Array.isArray(flow?.steps) ? flow.steps : []
      return h(
        "div",
        { className: "ap-flow" },
        h(
          "button",
          {
            className: "ap-flow-head",
            type: "button",
            "aria-expanded": open,
            onClick: onToggle,
          },
          h("span", { className: "ap-caret", "aria-hidden": "true" }, open ? "\u25BE" : "\u25B8"),
          h("span", { className: "ap-flow-name" }, label),
          h("span", { className: "ap-flow-count" }, `(${name}) \u2014 ${t("rules.steps", { n: ids.length })}`),
        ),
        open
          ? h(
            "div",
            { className: "ap-rows" },
            ...ids.map((id, i) => {
              const step = spec?.steps?.[id] ?? {}
              // The prose a step acts on: a prompt, a branch question, or the
              // line a stop shows before it waits.
              const prose = String(step.prompt ?? step.question ?? step.notifyText ?? "")
              const exits = step.do === "branch" ? Object.entries(step.options ?? {}) : []
              return h(
                "div",
                { className: "ap-row", key: id },
                h("span", { className: "ap-idx" }, String(i + 1)),
                h("span", { className: "ap-id" }, id),
                h("span", { className: "ap-kind" }, String(step.do ?? "")),
                h("span", { className: "ap-prose" }, prose),
                // A branch is only meaningful with its exits; without them the
                // reader cannot tell where either answer leads.
                ...exits.map(([answer, target]) => h(
                  "span",
                  { className: "ap-exit", key: `${id}-${answer}` },
                  `\u251C\u2500 ${answer} \u2192 ${target}`,
                )),
              )
            }),
          )
          : null,
      )
    }

    /**
     * The read-only definition panel.
     *
     * Rendered in `shell.overlay`: twelve steps with their full prompts are a
     * table, and the composer dock exists for one-line status. Read-only by
     * design — the config is the single source of truth, and the footer says
     * where it lives.
     */
    function RulesPanel(props) {
      const { t, locale, where, spec, enabled, note, onClose } = props
      const names = spec?.flows ? Object.keys(spec.flows) : []
      const [open, setOpen] = react.useState(() => new Set(names.slice(0, 1)))

      // Escape closes, like the host's own dialogs. A read-only panel that traps
      // a keyboard user is worse than no panel.
      react.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose() }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
      }, [onClose])

      const toggle = (name) => {
        setOpen((prev) => {
          const next = new Set(prev)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }

      const body = note
        ? h("div", { className: "ap-note" }, t(note))
        : names.length === 0
          ? h("div", { className: "ap-note" }, t("rules.empty"))
          : names.map((name) => h(FlowBlock, {
            key: name,
            t,
            locale,
            name,
            flow: spec.flows[name],
            spec,
            open: open.has(name),
            onToggle: () => toggle(name),
          }))

      return h(
        "div",
        {
          className: "ap-backdrop",
          onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
        },
        h(
          "div",
          {
            className: "ap-panel",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": t("rules.title"),
          },
          h(
            "div",
            { className: "ap-head" },
            h("span", { className: "ap-title" }, t("rules.title")),
            h("span", { className: `ap-state${enabled ? " ap-state-on" : ""}` },
              enabled ? t("rules.on") : t("rules.off")),
            where ? h("span", { className: "ap-where", title: where }, where) : null,
            h("span", { className: "ap-spacer" }),
            h("button", { className: "ap-close", type: "button", onClick: onClose }, t("rules.close")),
          ),
          h("div", { className: "ap-body" }, body),
          h("div", { className: "ap-foot" }, t("rules.elsewhere")),
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
          // `ctx.get` rather than `ctx.remote`: the restricted context refuses an
          // undeclared property read by throwing, which `?.` does not soften, so
          // `ctx.remote` would throw here every time. `get` needs no declaration,
          // and this call is optional — pause is a convenience, and a profile
          // without the remote service still renders the panel.
          const commands = ctx.get("remote")?.commands
          if (!commands || typeof commands.execute !== "function") return
          commands.execute(sessionId, `/flow ${action}`, [], new AbortController().signal)
        } catch { /* the panel still renders without host control */ }
      }

      // ── Open state for the definition panel ──
      // Kept here rather than inside the overlay component: the menu can be
      // clicked before the overlay has ever rendered, so a setter captured at
      // render time would be a no-op on exactly the click that matters.
      let rulesTarget = null
      const rulesListeners = new Set()
      const setRulesTarget = (target) => {
        rulesTarget = target
        for (const notify of rulesListeners) notify()
      }

      /**
       * What one workspace's pipeline looks like, read from the projection its
       * sessions carry.
       *
       * `projectionValues` on a session-list entry is the wire view the host
       * computed, so this reads the same shape the panel renders — the Client
       * never folds session events itself.
       */
      const definitionFor = (workspaceId) => {
        try {
          const byId = ctx.sessions.list.getSnapshot().byId ?? {}
          const items = ctx.workspaces.list.getSnapshot().items ?? []
          const ws = items.find((i) => i.workspaceId === workspaceId)
          const ids = ws?.sessionIds ?? []
          for (const id of ids) {
            const v = byId[id]?.projectionValues?.[PROJECTION_KEY]
            if (v) return { view: v }
          }
          // Two ways to have nothing: no session at all, or sessions that have
          // not been opened since the plugin loaded. They need different words.
          return { note: ids.length === 0 ? "rules.noSession" : "rules.notLoaded" }
        } catch {
          return { note: "rules.noSession" }
        }
      }

      // ── The workspace menu entry ──
      // Reading the rules is a view interaction, so it needs no tool and no
      // command — the host's `/flow` only starts and steers a pipeline.
      try {
        ctx.contextMenus.register({
          id: "agentPipeline.rules",
          target: "workspace",
          // Between rename (100) and delete (300): reading what a workspace runs
          // belongs near renaming it, far from deleting it.
          order: 250,
          resolve: (target) => [{
            id: "rules",
            label: () => makeT(activeLocale)("rules.menu"),
            run: () => setRulesTarget(target),
          }],
        })
      } catch (e) {
        // Declared in `inject`, so the service is present; a throw here is a
        // duplicate id or a host that changed its registration shape. Say so
        // rather than silently having no menu — that is what made the missing
        // entry invisible the first time.
        console.error("[agent-pipeline] workspace menu registration failed:", e)
      }

      // ── The definition panel ──
      // `shell.overlay` is the frame-wide layer, so the dialog is not confined
      // to a column or a scroll container.
      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register(
          { name: NS, id: "rules" },
          function RulesOverlay() {
            const [, force] = react.useState(0)
            react.useEffect(() => {
              const notify = () => force((n) => n + 1)
              rulesListeners.add(notify)
              return () => rulesListeners.delete(notify)
            }, [])

            const target = rulesTarget
            if (!target) return null

            const found = definitionFor(target.workspaceId)
            const view = found.view
            return h(RulesPanel, {
              t: makeT(activeLocale),
              locale: activeLocale(),
              where: target.displayTitle ?? target.title ?? "",
              spec: view?.definition ?? null,
              enabled: view?.enabled === true,
              note: found.note ?? null,
              onClose: () => setRulesTarget(null),
            })
          },
        )
      })

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

    // The services this client reads, by **service name**. A Client half loaded
    // through `__ModuleLoader__` gets a restricted context: `ctx.slots`,
    // `ctx.contextMenus` and the rest are readable only when named here, and
    // reading an undeclared one throws. `dsh.client.inject` in package.json is a
    // different list — package names, for activation order — and does not
    // satisfy this.
    return {
      inject: ["slots", "contextMenus", "locale", "sessions", "workspaces"],
      apply: applyClient,
    }
  },
})
