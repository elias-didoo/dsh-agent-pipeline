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

    const ACTION_TEXT = {
      send: "自动发送提示词",
      stop: "停下来等你",
      silent: "不做任何动作",
    }

    /** Localized stage names used as group headings. */
    const STAGE_TEXT = {
      planning: "方案阶段",
      implementing: "改代码中",
      selfchecking: "自检阶段",
      waiting: "等你决定",
      finished: "已完成",
      conflict: "有冲突",
    }
    const STAGE_ORDER = ["planning", "implementing", "selfchecking", "waiting", "finished", "conflict"]

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
.do-stage{font-size:12px;font-weight:600;color:var(--dsw-alias-text-secondary,#999);margin-top:6px;padding-left:2px}
.do-stage-unknown{color:var(--dsw-alias-text-warning,#e0a030)}
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
     * Render rules grouped by stage.
     *
     * Unknown stages get their own group instead of being silently folded into
     * a known one: a typo in `when` should be visible, not quietly relocated.
     */
    function renderStages(rules) {
      const list = Array.isArray(rules) ? rules : []
      const byStage = new Map()
      const unknown = []
      for (const r of list) {
        const st = r?.when
        if (STAGE_ORDER.includes(st)) {
          if (!byStage.has(st)) byStage.set(st, [])
          byStage.get(st).push(r)
        } else {
          unknown.push(r)
        }
      }

      const out = []
      for (const st of STAGE_ORDER) {
        const group = byStage.get(st)
        if (!group || group.length === 0) continue
        out.push(h("div", { className: "do-stage", key: st }, STAGE_TEXT[st] ?? st))
        for (const r of group) out.push(renderRule(r))
      }
      if (unknown.length > 0) {
        out.push(h("div", { className: "do-stage do-stage-unknown", key: "__unknown" }, "阶段未识别"))
        for (const r of unknown) out.push(renderRule(r))
      }
      return out
    }

    function renderRule(r) {
      return h(
        "div",
        { className: "do-rule", key: r.id },
        h(
          "div",
          { className: "do-rule-head" },
          h("code", { className: "do-rule-id" }, r.id ?? "(无 id)"),
          h("span", { className: "do-rule-action" }, ACTION_TEXT[r.action] ?? r.action),
        ),
        h("div", { className: "do-rule-scene" }, r.scene ?? ""),
        r.action === "send" && r.prompt
          ? h("div", { className: "do-rule-prompt" }, `\u2192 ${r.prompt}`)
          : null,
        r.action === "stop" && r.notifyText
          ? h("div", { className: "do-rule-prompt" }, `\u2192 停下：${r.notifyText}`)
          : null,
      )
    }

    /** Read-only rules panel. */
    function RulesPanel({ info, onClose }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose() }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
      }, [onClose])

      const rules = info?.rules ?? []
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
          { className: "do-panel", role: "dialog", "aria-modal": "true", "aria-label": "决策规则" },
          h(
            "div",
            { className: "do-header" },
            h("div", { className: "do-title" }, `决策规则 · ${info?.displayTitle ?? "工作区"}`),
            h("button", { className: "do-close", onClick: onClose, "aria-label": "关闭" }, "\u2715"),
          ),

          h(
            "div",
            { className: "do-status" },
            h(
              "span",
              { className: enabled ? "do-badge do-badge-on" : "do-badge do-badge-off" },
              enabled ? "已启用" : "未启用",
            ),
            info?.hasSession === false
              ? h("span", { className: "do-meta do-warn" }, "此工作区尚无会话，规则状态需先建一个会话才可见")
              : null,
          ),

          rules.length === 0
            ? h("div", { className: "do-empty" }, enabled ? "尚未配置规则" : "此工作区未启用决策编排")
            : h("div", { className: "do-rules" }, ...renderStages(rules)),

          h(
            "div",
            { className: "do-hint" },
            h("div", { className: "do-hint-title" }, "如何修改"),
            h(
              "div",
              { className: "do-hint-body" },
              "编辑 ",
              h("code", null, "~/.dsh/profiles/desktop/cordis.patch.yml"),
              " 中 ",
              h("code", null, "decision-orchestrator"),
              " 行的 ",
              h("code", null, "config.workspaces"),
              "，改完重启 DSH 生效。",
            ),
          ),
        ),
      )
    }

    /** Open/close state provided by ctx (module-level; one instance suffices). */
    let setInfo = null

    function PanelHost() {
      const [info, setState] = useState(null)
      setInfo = setState
      if (info === null) return null
      return h(RulesPanel, { info, onClose: () => setState(null) })
    }

    function applyClient(ctx) {
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
                label: "决策规则\u2026",
                run: () => {
                  const found = readProjection(ctx, workspaceId)
                  const view = found?.view
                  if (typeof setInfo === "function") {
                    setInfo({
                      workspaceId,
                      displayTitle,
                      enabled: view?.enabled === true,
                      rules: Array.isArray(view?.rules) ? view.rules : [],
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
          PanelHost,
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
