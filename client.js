/**
 * decision-orchestrator client: workspace context menu + read-only rules panel.
 *
 * GUI is read-only display; edits go through the config in cordis.patch.yml.
 * Per practices.md: tunables belong in Config, and the user edits them at the
 * patch layer.
 *
 * Registration mirrors the built-in client plugins (dsh-client-ui-workspace):
 *   ctx.slots.inject(`shell.overlay`, function* () {
 *     yield ctx.slots.register({ name, id, locale, inject }, Component)
 *   })
 *
 * Source, comments and docs are English throughout this repo. UI strings below
 * stay Chinese because they are what the user reads in the panel, and the stage
 * criteria this plugin feeds the model are Chinese for the same reason.
 */

window.__ModuleLoader__.load({
  id: "dsh-decision-orchestrator",

  factory(require) {
    const react = require("react")

    const h = react.createElement
    const { useEffect, useState } = react

    const PROJECTION_KEY = "decision-orchestrator"

    /**
     * Panel strings.
     *
     * Registered as one namespace so the panel follows the DSH language setting
     * like any host component; nothing here is hardcoded per locale.
     */
    const NS = "decision-orchestrator"

    const DICT = {
      zh: {
        "menu.label": "决策规则…",
        "panel.title": "决策规则",
        "panel.close": "关闭",
        "action.send": "自动发送提示词",
        "action.stop": "停下来等你",
        "action.silent": "不做任何动作",
        "rule.noId": "(无 id)",
        "rule.stopPrefix": "停下：",
        "status.enabled": "已启用",
        "status.disabled": "未启用",
        "meta.noSession": "此工作区尚无会话，规则状态需先建一个会话才可见",
        "empty.noDecisions": "尚未配置决策点",
        "empty.notEnabled": "此工作区未启用决策编排",
        "hint.title": "如何修改",
        "hint.body": "编辑 cordis.patch.yml 中本插件的 config，改完重启 DSH 生效。",
      },
      en: {
        "menu.label": "Decision rules…",
        "panel.title": "Decision rules",
        "panel.close": "Close",
        "action.send": "Send prompt automatically",
        "action.stop": "Stop and wait for you",
        "action.silent": "Do nothing",
        "rule.noId": "(no id)",
        "rule.stopPrefix": "Stops: ",
        "status.enabled": "Enabled",
        "status.disabled": "Not enabled",
        "meta.noSession": "No session in this workspace yet — rule state appears once one exists",
        "empty.noDecisions": "No decision points configured yet",
        "empty.notEnabled": "Decision orchestration is not enabled for this workspace",
        "hint.title": "How to change these",
        "hint.body": "Edit this plugin's config in cordis.patch.yml, then restart DSH.",
      },
    }

    /**
     * Read the rules this plugin projected for that workspace.
     *
     * The host projection declares wire.view + summary:true, so the client
     * reads the precomputed value straight from the session summary's
     * projectionValues.
     */
    function readProjection(ctx, workspaceId) {
      try {
        const sessions = ctx.sessions?.list?.getSnapshot?.()
        const byId = sessions?.byId ?? {}

        // Preferred: a session in that workspace
        let wsSessionIds = []
        try {
          const ws = ctx.workspaces?.list?.getSnapshot?.()
          const item = ws?.items?.find?.((i) => i.workspaceId === workspaceId)
          if (Array.isArray(item?.sessionIds)) wsSessionIds = item.sessionIds
        } catch { /* ignore */ }

        for (const id of wsSessionIds) {
          const v = byId[id]?.projectionValues?.[PROJECTION_KEY]
          if (v) return { sessionId: id, view: v }
        }
        // Fallback: any session carrying this projection
        for (const id of Object.keys(byId)) {
          const v = byId[id]?.projectionValues?.[PROJECTION_KEY]
          if (v) return { sessionId: id, view: v }
        }
      } catch { /* ignore */ }
      return undefined
    }

    /** Styles, built on --dsw-alias-* theme tokens. */
    const STYLE = `
.do-overlay{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;z-index:10000}
.do-panel{width:min(680px,92vw);max-height:82vh;overflow:auto;background:var(--dsw-alias-background-primary,#1e1e1e);color:var(--dsw-alias-text-primary,#ddd);border:1px solid var(--dsw-alias-border-primary,#444);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.45);padding:20px;font-size:13px;line-height:1.55;box-sizing:border-box}
.do-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.do-title{font-size:15px;font-weight:600}
.do-close{background:transparent;border:none;color:var(--dsw-alias-text-secondary,#999);font-size:16px;cursor:pointer;padding:2px 8px;border-radius:4px;line-height:1}
.do-close:hover{background:var(--dsw-alias-background-secondary,#2a2a2a)}
.do-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.do-badge{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px}
.do-badge-on{background:rgba(80,180,120,.18);color:#4caf7d}
.do-badge-off{background:rgba(150,150,150,.16);color:#999}
.do-meta{font-size:12px;color:var(--dsw-alias-text-secondary,#999)}
.do-warn{color:#d9a441}
.do-empty{padding:20px 0;color:var(--dsw-alias-text-secondary,#999)}
.do-rules{display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.do-rule{border:1px solid var(--dsw-alias-border-primary,#3a3a3a);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-background-secondary,rgba(255,255,255,.03))}
.do-rule-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.do-rule-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-text-link,#6aa8ff)}
.do-rule-action{font-size:11px;color:var(--dsw-alias-text-secondary,#999);margin-left:auto}
.do-rule-scene{color:var(--dsw-alias-text-primary,#ddd)}
.do-rule-prompt{margin-top:6px;color:var(--dsw-alias-text-secondary,#aaa);font-size:12px}
.do-hint{border-top:1px solid var(--dsw-alias-border-primary,#333);padding-top:12px}
.do-hint-title{font-weight:600;margin-bottom:4px;font-size:12px;color:var(--dsw-alias-text-secondary,#aaa)}
.do-hint-body{color:var(--dsw-alias-text-secondary,#999);font-size:12px}
.do-hint code{background:var(--dsw-alias-background-tertiary,rgba(255,255,255,.08));padding:1px 5px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`

    /**
     * Render one decision point.
     *
     * The `when` text is shown as written: it is both the label the user gave it
     * and the description the model matches against, so showing it is the most
     * useful thing the panel can do.
     */
    function renderDecision(d, t) {
      const action = d?.do ?? "silent"
      return h(
        "div",
        { className: "do-rule", key: d.id },
        h(
          "div",
          { className: "do-rule-head" },
          h("code", { className: "do-rule-id" }, d.id ?? t("rule.noId")),
          h("span", { className: "do-rule-action" }, t(`action.${action}`)),
        ),
        h("div", { className: "do-rule-scene" }, d.when ?? ""),
        action === "send" && d.prompt
          ? h("div", { className: "do-rule-prompt" }, `\u2192 ${d.prompt}`)
          : null,
        action === "stop" && d.notifyText
          ? h("div", { className: "do-rule-prompt" }, `\u2192 ${t("rule.stopPrefix")}${d.notifyText}`)
          : null,
      )
    }

    /** Read-only rules panel. */
    function RulesPanel({ info, onClose, t, locale }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose() }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
      }, [onClose])

      const decisions = info?.decisions ?? []
      const enabled = info?.enabled === true

      return h(
        "div",
        {
          className: "do-overlay",
          role: "presentation",
          onClick: (e) => { if (e.target === e.currentTarget) onClose() },
        },
        h(
          "div",
          { className: "do-panel", role: "dialog", "aria-modal": "true", "aria-label": t("panel.title") },
          h(
            "div",
            { className: "do-header" },
            h("div", { className: "do-title" }, `${t("panel.title")} · ${info?.displayTitle ?? ""}`),
            h("button", { className: "do-close", onClick: onClose, "aria-label": t("panel.close") }, "\u2715"),
          ),

          h(
            "div",
            { className: "do-status" },
            h(
              "span",
              { className: enabled ? "do-badge do-badge-on" : "do-badge do-badge-off" },
              enabled ? t("status.enabled") : t("status.disabled"),
            ),
            info?.hasSession === false
              ? h("span", { className: "do-meta do-warn" }, t("meta.noSession"))
              : null,
          ),

          decisions.length === 0
            ? h("div", { className: "do-empty" }, enabled ? t("empty.noDecisions") : t("empty.notEnabled"))
            : h("div", { className: "do-rules" }, ...decisions.map((d) => renderDecision(d, t))),

          h(
            "div",
            { className: "do-hint" },
            h("div", { className: "do-hint-title" }, t("hint.title")),
            h(
              "div",
              { className: "do-hint-body" },
              t("hint.body"),
            ),
          ),
        ),
      )
    }

    /** Open/close state provided by ctx (module-level; one instance suffices). */
    let setInfo = null

    /** Component handed to the slot, closed over the resolved language. */
    function makePanelHost(t, activeLocale) {
      return function PanelHost() {
        const [info, setState] = useState(null)
        setInfo = setState
        if (info === null) return null
        return h(RulesPanel, { info, onClose: () => setState(null), t, locale: activeLocale() })
      }
    }

    function applyClient(ctx) {
      // ── Panel strings follow the DSH language setting ──
      // The service is fetched rather than injected: a host without it still
      // renders the panel, using the English dictionary below.
      //
      // The active language is read on every call, never captured once, so a
      // language switch takes effect the next time the panel renders instead of
      // leaving stale text until a reload.
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

      const t = (key) => {
        const dict = DICT[activeLocale()] ?? DICT.en
        return dict[key] ?? DICT.en[key] ?? key
      }

      // Inject styles
      try {
        if (typeof document !== "undefined" && !document.getElementById("do-style")) {
          const el = document.createElement("style")
          el.id = "do-style"
          el.textContent = STYLE
          document.head.appendChild(el)
        }
      } catch { /* ignore */ }

      // ── Workspace context menu ──
      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: "workspace.decisionOrchestrator",
            target: "workspace",
            order: 250, // between rename(100) and delete(300)
            resolve: ({ workspaceId, displayTitle }) => [
              {
                id: "rules",
                label: t("menu.label"),
                run: () => {
                  const found = readProjection(ctx, workspaceId)
                  const view = found?.view
                  if (typeof setInfo === "function") {
                    setInfo({
                      workspaceId,
                      displayTitle,
                      enabled: view?.enabled === true,
                      decisions: Array.isArray(view?.decisions) ? view.decisions : [],
                      hasSession: found !== undefined,
                    })
                  }
                },
              },
            ],
          }),
        "decision-orchestrator: workspace menu",
      )

      // ── Mount the panel into shell.overlay ──
      // Mirrors built-in plugins: inject(slot, function* () { yield register(def, Component) })
      ctx.slots.inject("shell.overlay", function* () {
        yield ctx.slots.register(
          {
            name: "shell.overlay",
            id: "decision-orchestrator.rules",
            inject: () => ({}),
          },
          makePanelHost(t, activeLocale),
        )
      })
    }

    return {
      // Every service used must be declared: Cordis' Proxy throws for any
      // ctx.xxx that was not injected, and a swallowed error silently degrades
      // into "this workspace has no session".
      inject: ["slots", "contextMenus", "sessions", "workspaces"],
      apply(ctx) {
        applyClient(ctx)
      },
    }
  },
})
