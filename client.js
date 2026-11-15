/**
 * decision-orchestrator 客户端：工作区右键菜单 + 规则只读面板。
 *
 * 方向 2：GUI 只读展示，修改走 cordis.patch.yml 的 config。
 * 依据 practices.md：可调参数放进 Config，用户在 patch 层修改。
 *
 * 注册形态对齐内置 client 插件（以 dsh-client-ui-workspace 为例）：
 *   ctx.slots.inject(`shell.overlay`, function* () {
 *     yield ctx.slots.register({ name, id, locale, inject }, Component)
 *   })
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

    /** 阶段中文名，用于分组标题。 */
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
     * 读取本插件投影到该工作区的规则。
     *
     * Host 侧 projection 声明了 wire.view + summary:true，
     * client 从 session summary 的 projectionValues 直接读已算好的值。
     */
    function readProjection(ctx, workspaceId) {
      try {
        const sessions = ctx.sessions?.list?.getSnapshot?.()
        const byId = sessions?.byId ?? {}

        // 优先：该工作区的会话
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
        // 退化：任意带该投影的会话
        for (const id of Object.keys(byId)) {
          const v = byId[id]?.projectionValues?.[PROJECTION_KEY]
          if (v) return { sessionId: id, view: v }
        }
      } catch { /* ignore */ }
      return undefined
    }

    /** 样式（用 --dsw-alias-* 主题 token）。 */
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
     * 按阶段分组渲染规则。
     *
     * 未知阶段单独成组显示，不静默归到某个已知阶段 ——
     * 配置里写错 when 时应该看得出来，而不是被默默挪到别处。
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

    /** 规则只读面板。 */
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

    /** 由 ctx 提供的关闭/打开状态（模块级，单例足够）。 */
    let setInfo = null

    function PanelHost() {
      const [info, setState] = useState(null)
      setInfo = setState
      if (info === null) return null
      return h(RulesPanel, { info, onClose: () => setState(null) })
    }

    function applyClient(ctx) {
      // 注入样式
      try {
        if (typeof document !== "undefined" && !document.getElementById("do-style")) {
          const el = document.createElement("style")
          el.id = "do-style"
          el.textContent = STYLE
          document.head.appendChild(el)
        }
      } catch { /* ignore */ }

      // ── 工作区右键菜单 ──
      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: "workspace.decisionOrchestrator",
            target: "workspace",
            order: 250, // 介于 rename(100) 与 delete(300) 之间
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

      // ── 面板挂到 shell.overlay ──
      // 形态对齐内置插件：inject(slot, function* () { yield register(def, Component) })
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
      // 用到的服务必须全部声明：cordis 的 Proxy 对未注入的 ctx.xxx 直接抛错，
      // 被 try/catch 吞掉后会静默降级成「该工作区没有会话」。
      inject: ["slots", "contextMenus", "sessions", "workspaces"],
      apply(ctx) {
        applyClient(ctx)
      },
    }
  },
})
