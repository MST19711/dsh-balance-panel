/**
 * dsh-balance-panel — Client half (v0.3.0)
 *
 * 通用余额/用量面板渲染器:不知道任何具体供应商。host 按「当前会话的
 * provider」匹配后端并归一化成 panel 描述:
 *
 *   { ok, isSupported, backendId, current:{provider, model},
 *     panel: { title, rows:[{label, value, strong?, bar?:{fill, tone}}], chip:{text, tone}, foot },
 *     error }
 *
 * 行的 bar 字段可选:订阅配额语义(OpenCode Go)带进度条;按量计费现金语义
 * (智谱开放平台)是纯金额行,没有比例元素。
 * 当前会话 provider 不属于任何后端时,小窗自动隐藏。
 *
 * UI 骨架沿用 v0.1.0(Go Meter):右缘卡片、可折叠徽章、设置页、错误/过期兜底。
 *
 * License: MIT
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-balance-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    //#region styles
    const CSS_NAMESPACE = "dbp"; // dsh balance panel
    const css = `
      .${CSS_NAMESPACE}-card {
        position: absolute; right: 36px; top: 92px; width: 212px;
        box-sizing: border-box; padding: 10px 12px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        box-shadow: var(--dsw-shadow-lv3); font-size: 12px; line-height: 1.45;
        display: flex; flex-direction: column; gap: 6px;
        pointer-events: auto; z-index: 10;
      }
      .${CSS_NAMESPACE}-head { display: flex; align-items: center; gap: 6px; }
      .${CSS_NAMESPACE}-title { font-size: 13px; font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .${CSS_NAMESPACE}-model { font-size: 11px; color: var(--dsw-alias-label-tertiary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .${CSS_NAMESPACE}-btn {
        flex: none; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
        font-size: 11px; line-height: 16px; padding: 1px 6px; font-family: inherit;
      }
      .${CSS_NAMESPACE}-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .${CSS_NAMESPACE}-rows { display: flex; flex-direction: column; gap: 6px; }
      .${CSS_NAMESPACE}-row { display: flex; flex-direction: column; gap: 4px; }
      .${CSS_NAMESPACE}-rowTop { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .${CSS_NAMESPACE}-rowLabel { flex: 0 0 52px; color: var(--dsw-alias-label-secondary); }
      .${CSS_NAMESPACE}-rowVal { flex: 1; min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
      .${CSS_NAMESPACE}-rowVal--strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .${CSS_NAMESPACE}-bar { display: block; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-module-platform); overflow: hidden; }
      .${CSS_NAMESPACE}-barFill { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-state-success-primary); }
      .${CSS_NAMESPACE}-barFill.warn { background: var(--dsw-alias-state-warn-primary); }
      .${CSS_NAMESPACE}-barFill.danger { background: var(--dsw-alias-state-error-primary); }
      .${CSS_NAMESPACE}-err { color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.5; word-break: break-all; }
      .${CSS_NAMESPACE}-stale { color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
      .${CSS_NAMESPACE}-foot { color: var(--dsw-alias-label-tertiary); font-size: 10px; display: flex; justify-content: space-between; gap: 6px; }
      .${CSS_NAMESPACE}-chip {
        position: absolute; right: 36px; top: 92px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        box-shadow: var(--dsw-shadow-lv2); padding: 3px 10px; font-size: 12px; font-weight: 500;
        pointer-events: auto; z-index: 10; display: inline-flex; align-items: center; gap: 5px; font-family: inherit;
      }
      .${CSS_NAMESPACE}-chip:hover { border-color: var(--dsw-alias-brand-primary); }
      .${CSS_NAMESPACE}-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
      .${CSS_NAMESPACE}-dot.warn { background: var(--dsw-alias-state-warn-primary); }
      .${CSS_NAMESPACE}-dot.danger { background: var(--dsw-alias-state-error-primary); }
      .${CSS_NAMESPACE}-panel { max-width: 520px; display: flex; flex-direction: column; gap: 8px; }
      .${CSS_NAMESPACE}-group { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .${CSS_NAMESPACE}-check { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; }
      .${CSS_NAMESPACE}-check input { accent-color: var(--dsw-alias-brand-primary); }
      .${CSS_NAMESPACE}-field { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); }
      .${CSS_NAMESPACE}-field select {
        padding: 3px 6px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      }
      .${CSS_NAMESPACE}-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
    `;
    const tagId = "@deepseek-ai/dsh-balance-panel/widget.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-balance-panel";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region config
    const STORAGE_KEY = "dsh-balance-panel:config";
    const LEGACY_STORAGE_KEY = "dsh-opencode-go-usage:config"; // v0.1.0 迁移源
    const DEFAULTS = {
      enabled: true,
      refreshSeconds: 30,
      collapsed: false,        // 上次折叠态
      collapsedDefault: false, // 设置页:加载时默认折叠
    };

    function loadConfig() {
      let saved = null;
      try {
        let raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) raw = window.localStorage.getItem(LEGACY_STORAGE_KEY); // v0.1.0 迁移
        if (raw !== null) saved = JSON.parse(raw);
      } catch (error) { saved = null; }
      if (saved === null || typeof saved !== "object") return { ...DEFAULTS };
      const cfg = {
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.enabled,
        refreshSeconds: Number.isFinite(saved.refreshSeconds) ? Math.max(10, Math.min(3600, saved.refreshSeconds)) : DEFAULTS.refreshSeconds,
        collapsed: typeof saved.collapsed === "boolean" ? saved.collapsed : DEFAULTS.collapsed,
        collapsedDefault: typeof saved.collapsedDefault === "boolean" ? saved.collapsedDefault : DEFAULTS.collapsedDefault,
      };
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (error) { /* 迁移失败无害 */ }
      return cfg;
    }
    function saveConfig(cfg) {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); return true; } catch (error) { return false; }
    }
    //#endregion

    //#region store
    // 极简快照 store:update 生成新对象并通知订阅者(渲染侧 useReducer 订阅)。
    let snapshot = {
      status: "idle", // idle | ready | error | stale
      data: null,     // /usage 成功响应
      error: null,
      hasSession: false,
      addressed: false,
      sessionId: null,
      lastRefreshAt: 0, // 最近一次轮询结束时间(本地)
    };
    const listeners = new Set();
    function notify() {
      for (const fn of [...listeners]) { try { fn(); } catch (error) { console.log("dsh-balance-panel: listener failed", error); } }
    }
    function update(patch) {
      snapshot = { ...snapshot, ...patch };
      notify();
    }
    function subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }
    //#endregion

    //#region helpers
    function fmtTime(ts) {
      if (!Number.isFinite(ts) || ts <= 0) return "";
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    //#endregion

    //#region data flow
    let appCtx = null;
    let watchers = null; // { dispose: () => void }

    function computeVisible(snap, cfg) {
      if (!cfg.enabled) return false;
      if (!snap.hasSession || snap.addressed) return false;
      if (snap.data === null) return false;
      return snap.data.ok === true && snap.data.isSupported === true;
    }

    async function refreshUsage() {
      if (appCtx === null) return;
      const sid = snapshot.sessionId;
      try {
        const qs = sid ? "?sessionId=" + encodeURIComponent(String(sid)) : "";
        const res = await fetch("/dsh-balance-panel/usage" + qs);
        if (!res.ok) throw new Error("http " + res.status);
        const body = await res.json();
        if (body === null || typeof body !== "object") throw new Error("bad response");
        if (body.ok !== true) {
          update({
            error: { code: "UNKNOWN", message: typeof body.error === "string" ? body.error : String(body) },
            status: snapshot.data !== null ? "stale" : "error",
            lastRefreshAt: Date.now(),
          });
          return;
        }
        update({ data: body, error: null, status: "ready", lastRefreshAt: Date.now() });
      } catch (error) {
        update({
          error: { code: "FETCH_FAILED", message: error && error.message ? String(error.message) : String(error) },
          status: snapshot.data !== null ? "stale" : "error",
          lastRefreshAt: Date.now(),
        });
      }
    }

    async function refreshSessionInfo() {
      if (appCtx === null) return;
      const list = appCtx.sessions && appCtx.sessions.list ? appCtx.sessions.list : null;
      const snap = list ? list.getSnapshot() : undefined;
      const sid = snap !== undefined && snap !== null ? snap.current : undefined;
      if (sid === undefined || sid === null) {
        update({ hasSession: false, addressed: false, sessionId: null });
        return;
      }
      let addressed = false;
      try {
        addressed = typeof appCtx.sessions.subagentAddress === "function" && appCtx.sessions.subagentAddress(sid) !== undefined;
      } catch (error) {
        addressed = false;
      }
      update({ hasSession: true, addressed: addressed, sessionId: String(sid) });
      await refreshUsage();
    }

    function refreshTick() {
      void refreshSessionInfo();
    }

    function setupWatchers() {
      teardownWatchers();
      const cfg = loadConfig();
      const ms = cfg.refreshSeconds * 1000;
      const timers = [];

      try {
        timers.push(appCtx.timer.interval(refreshTick, ms));
      } catch (error) {
        console.log("dsh-balance-panel: timer 不可用", error);
      }

      // 会话变化(切换会话/无会话)
      let listDisposer = null;
      try {
        listDisposer = appCtx.sessions.list.subscribe(() => { refreshTick(); });
      } catch (error) {
        console.log("dsh-balance-panel: 会话列表订阅失败", error);
      }

      // 切回前台立即刷新
      const onVisibility = () => { if (document.visibilityState === "visible") { refreshTick(); } };
      document.addEventListener("visibilitychange", onVisibility);

      watchers = {
        dispose: () => {
          for (const t of timers) { try { t(); } catch (error) {} }
          if (listDisposer !== null) { try { listDisposer(); } catch (error) {} }
          document.removeEventListener("visibilitychange", onVisibility);
        },
      };
    }

    function teardownWatchers() {
      if (watchers !== null) {
        try { watchers.dispose(); } catch (error) {}
        watchers = null;
      }
    }
    //#endregion

    //#region widget
    /** 距右侧边框的间距;小窗顶部距 banner(标签栏)底部的距离与之保持一致。 */
    const EDGE_GAP = 36;

    /**
    * 运行时测量:小窗顶部 = banner 标签栏底部 + EDGE_GAP,使「距 banner 的距离」
    * 与「距右侧边框的距离」相同。找不到标签栏/浮层时返回 null,回退到静态 top。
    */
    function measureBannerTop() {
      try {
        const doc = window.document;
        const tablist = doc.querySelector('[data-slot="conversation"] [role="tablist"]')
          ?? doc.querySelector('[data-slot="conversation.session"] [role="tablist"]')
          ?? doc.querySelector('[role="tablist"]');
        const overlay = doc.querySelector("[data-shell-overlay]");
        if (tablist === null || overlay === null) return null;
        const tabBottom = tablist.getBoundingClientRect().bottom;
        const overlayTop = overlay.getBoundingClientRect().top;
        const top = tabBottom - overlayTop + EDGE_GAP;
        if (!Number.isFinite(top)) return null;
        return Math.max(0, Math.round(top));
      } catch (error) {
        return null;
      }
    }

    function Row({ row }) {
      const bar = row.bar && typeof row.bar === "object" ? row.bar : null;
      const fill = bar ? Math.max(0, Math.min(100, Number(bar.fill) || 0)) : null;
      return React.createElement(
        "div", { className: CSS_NAMESPACE + "-row" },
        React.createElement(
          "div", { className: CSS_NAMESPACE + "-rowTop" },
          React.createElement("span", { className: CSS_NAMESPACE + "-rowLabel" }, String(row.label ?? "")),
          React.createElement("span", {
            className: CSS_NAMESPACE + "-rowVal" + (row.strong === true ? " " + CSS_NAMESPACE + "-rowVal--strong" : ""),
          }, String(row.value ?? "—")),
        ),
        bar !== null
          ? React.createElement("span", { className: CSS_NAMESPACE + "-bar" },
              React.createElement("span", {
                className: CSS_NAMESPACE + "-barFill " + (bar.tone === "warn" || bar.tone === "danger" ? bar.tone : "ok"),
                style: { width: fill + "%" },
              }))
          : null,
      );
    }

    function Widget() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => subscribe(force), []);
      const snap = snapshot;
      const cfg = loadConfig();
      const [collapsed, setCollapsed] = React.useState(cfg.collapsed);
      React.useEffect(() => { setCollapsed(cfg.collapsed); }, [cfg.collapsed]);
      // banner 位置随标签切换/窗口缩放变化:resize 时重测
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        const onResize = () => setTick((t) => t + 1);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, []);
      const bannerTop = React.useMemo(() => measureBannerTop(), [snap.lastRefreshAt, snap.status, tick, collapsed]);
      const top = bannerTop === null ? 92 : bannerTop;

      const visible = computeVisible(snap, cfg);
      const data = snap.data;
      if (!visible || data === null) return null;

      const panel = data.panel && typeof data.panel === "object" ? data.panel : null;

      if (panel !== null && collapsed) {
        const chip = panel.chip && typeof panel.chip === "object" ? panel.chip : null;
        return React.createElement(
          "button",
          {
            type: "button",
            className: CSS_NAMESPACE + "-chip",
            style: { top: top + "px" },
            title: (panel.title || "余额") + "(" + (data.current && data.current.model ? data.current.model : "") + ") — 点击展开",
            onClick: () => {
              setCollapsed(false);
              saveConfig({ ...loadConfig(), collapsed: false });
            },
          },
          React.createElement("span", { className: CSS_NAMESPACE + "-dot " + (chip && (chip.tone === "warn" || chip.tone === "danger") ? chip.tone : "ok") }),
          String(chip && typeof chip.text === "string" ? chip.text : panel.title || "余额"),
        );
      }

      const rows = panel !== null && Array.isArray(panel.rows)
        ? panel.rows.filter((row) => row !== null && typeof row === "object").map((row, i) => React.createElement(Row, { key: i, row }))
        : [];

      const error = (panel === null ? (data.error ?? null) : null) ?? (snap.status === "stale" || snap.status === "error" ? snap.error : null);
      const errorNode = error !== null && error !== undefined
        ? React.createElement(
            "div", { className: CSS_NAMESPACE + "-err" },
            String(error.message || error.code || "未知错误"),
            React.createElement("br"),
            React.createElement(
              "button",
              { type: "button", className: CSS_NAMESPACE + "-btn", onClick: () => { refreshTick(); } },
              "重试",
            ),
          )
        : null;
      const staleNode = snap.status === "stale"
        ? React.createElement("div", { className: CSS_NAMESPACE + "-stale" }, "数据过期,等待下一次刷新")
        : null;

      return React.createElement(
        "div", { className: CSS_NAMESPACE + "-card", style: { top: top + "px" } },
        React.createElement(
          "div", { className: CSS_NAMESPACE + "-head" },
          React.createElement("span", { className: CSS_NAMESPACE + "-title" }, String(panel !== null && panel.title ? panel.title : "余额")),
          React.createElement(
            "button",
            { type: "button", className: CSS_NAMESPACE + "-btn", title: "立即刷新", onClick: () => { refreshTick(); } },
            "刷新",
          ),
          panel !== null
            ? React.createElement(
                "button",
                {
                  type: "button", className: CSS_NAMESPACE + "-btn", title: "折叠",
                  onClick: () => {
                    setCollapsed(true);
                    saveConfig({ ...loadConfig(), collapsed: true });
                  },
                },
                "—",
              )
            : null,
        ),
        data.current !== null && data.current !== undefined && typeof data.current.model === "string" && data.current.model.length > 0
          ? React.createElement("div", { className: CSS_NAMESPACE + "-model" }, String(data.current.model))
          : null,
        rows.length > 0 ? React.createElement("div", { className: CSS_NAMESPACE + "-rows" }, rows) : null,
        errorNode,
        staleNode,
        React.createElement(
          "div", { className: CSS_NAMESPACE + "-foot" },
          React.createElement("span", null, "更新于 " + fmtTime(snap.lastRefreshAt)),
          React.createElement("span", null, String(panel !== null && panel.foot ? panel.foot : "")),
        ),
      );
    }
    //#endregion

    //#region settings panel
    function Panel() {
      const [cfg, setCfg] = React.useState(loadConfig());
      const save = (patch) => {
        const next = { ...cfg, ...patch };
        setCfg(next);
        saveConfig(next);
        if (patch.refreshSeconds !== undefined || patch.enabled !== undefined) {
          setupWatchers(); // 间隔/开关变更立即生效
        }
      };
      return React.createElement(
        "div", { className: CSS_NAMESPACE + "-panel" },
        React.createElement("label", { className: CSS_NAMESPACE + "-check" },
          React.createElement("input", { type: "checkbox", checked: cfg.enabled, onChange: (e) => save({ enabled: e.target.checked }) }),
          "启用余额面板"),
        React.createElement(
          "div", { className: CSS_NAMESPACE + "-group" },
          React.createElement(
            "label", { className: CSS_NAMESPACE + "-field" },
            React.createElement("span", null, "刷新间隔"),
            React.createElement("select", { value: String(cfg.refreshSeconds), onChange: (e) => save({ refreshSeconds: Number(e.target.value) }) },
              React.createElement("option", { value: "15" }, "15 秒"),
              React.createElement("option", { value: "30" }, "30 秒"),
              React.createElement("option", { value: "60" }, "60 秒"),
              React.createElement("option", { value: "120" }, "120 秒"),
            ),
          ),
          React.createElement("label", { className: CSS_NAMESPACE + "-check" },
            React.createElement("input", { type: "checkbox", checked: cfg.collapsedDefault, onChange: (e) => save({ collapsedDefault: e.target.checked }) }),
            "加载时默认折叠为小徽章"),
        ),
        React.createElement(
          "div", { className: CSS_NAMESPACE + "-note" },
          "面板按「当前会话的 provider」自动选择数据源,只显示命中的那一张:",
          "OpenCode Go(订阅配额,带进度条)、智谱开放平台(按量计费现金余额,纯金额)。",
          "各数据源由插件服务端代理调用,key 不会进入浏览器;host 端分别缓存(15s / 5min)。",
          "当前会话模型不属于任何已接入供应商时小窗自动隐藏;连续失败时保留旧数据并标记「数据过期」。",
        ),
      );
    }
    //#endregion

    //#region plugin body
    const inject = ["slots", "sessions", "timer"];

    function apply(ctx) {
      appCtx = ctx;
      setupWatchers();           // 会话/余额轮询
      void refreshSessionInfo(); // 首帧立即拉取

      ctx.on("connection/reset", () => {
        teardownWatchers();
        setupWatchers();
        void refreshSessionInfo();
      });

      // 右上浮层小窗(官方槽位目录:shell.overlay 是「frame-wide surface of your own」的加性席位)
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "balance-panel",
        order: 100,
        label: "余额面板",
      }, Widget));

      // 设置页
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "balance-panel",
        order: 26,
        label: "余额面板",
      }, Panel));

      ctx.effect(() => () => {
        teardownWatchers();
        appCtx = null;
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
