/**
 * dsh-trigger-prompts — 客户端
 *
 * 在「对话 / 轨迹 / 画廊」页签行右侧加一个「触发词」按钮，点开是下拉面板：
 *   - 按插件分组列出每个工具的名字与描述（= 模型看到的触发提示词）
 *   - 末尾单独一节列出技能（skill）：名字 + 完整 description + 何时用 + 来源路径
 *   - 顶部中文说明「这工具干什么 + 你可以说什么话触发它」，英文原文可展开
 *   - 面板右上角「置顶」按钮，置顶后与其它界面交互也不会自动关闭；左侧 ⠿ 长按可拖动
 *
 * 说明：宿主没有为「页签行尾部」暴露插槽（conversation.view 注册的是真正的视图页签，
 * 点了会切换主区域），所以这里用 DOM 观察把按钮挂进 [data-conversation-tabs]，
 * 再用 MutationObserver + 定时兜底保证 React 重渲染后仍在。
 */
(() => {
  const ID = 'dsh-trigger-prompts';
  const LIST_ROUTE = '/plugins/dsh-trigger-prompts/list';
  const DICT_ROUTE = '/plugins/dsh-trigger-prompts/zh-cn.json';
  const LS_PIN = 'dsh-trigger-prompts:pinned';
  const LS_POS = 'dsh-trigger-prompts:pos';
  const LS_ALL = 'dsh-trigger-prompts:showAll';
  const LS_THEME = 'dsh-trigger-prompts:theme';
  const LS_SECTIONS = 'dsh-trigger-prompts:sections';
  const LS_BTN = 'dsh-trigger-prompts:btnpos';
  const DEFAULT_THEME = { bg: '#dce9f7', alpha: 0.92 };
  const STALE_MS = 15 * 1000;

  window.__ModuleLoader__.load({
    id: ID,
    factory: () => {
      if (window.__dshTriggerPrompts && window.__dshTriggerPrompts.alive) {
        return window.__dshTriggerPrompts.plugin;
      }

      const state = {
        alive: true,
        mounted: false,
        open: false,
        pinned: false,
        loading: false,
        error: null,
        payload: null,
        dict: null,
        pos: null,
        showAll: false,
        theme: null,
        fetchedAt: 0,
        query: '',
        sections: ['plugins', 'skills'],
        expanded: new Set(),
        btnOffset: null,
        btnAlign: '',
      };

      let btn = null;
      let panel = null;
      let listEl = null;
      let countEl = null;
      let searchEl = null;
      let filtersEl = null;
      const filterBtns = {};
      let pinBtn = null;
      let scopeBtn = null;
      let settingsBtn = null;
      let settingsEl = null;
      let colorInput = null;
      let alphaInput = null;
      let alphaLabel = null;
      let refreshBtn = null;
      let positionRaf = 0;
      let observer = null;
      let timer = 0;

      const css = `
        /* ── 触发词按钮（页签行最右） ── */
        .dsh-tp-btn {
          box-sizing: border-box; margin-left: 8px; padding: 0 10px 0 8px;
          border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
          background: transparent; color: inherit; font: inherit; font-size: 12px;
          line-height: 1; cursor: pointer; display: inline-flex; align-items: center;
          justify-content: center; gap: 6px; opacity: .82; white-space: nowrap; flex: none;
          user-select: none; touch-action: none;
          transition: opacity .16s, background .16s, border-color .16s, transform .12s;
        }
        .dsh-tp-btn.moved {
          opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent);
          border-color: color-mix(in srgb, currentColor 32%, transparent);
          box-shadow: 0 6px 16px -10px rgba(10, 22, 45, .8);
        }
        .dsh-tp-btn.dragging {
          cursor: grabbing; opacity: 1; transition: none;
          border-color: color-mix(in srgb, #4d9fff 60%, transparent);
          background: color-mix(in srgb, #4d9fff 16%, transparent);
        }
        .dsh-tp-btn::before {
          content: ''; width: 6px; height: 6px; border-radius: 50%; flex: none;
          background: linear-gradient(135deg, #4d9fff, #a78bfa);
          box-shadow: 0 0 0 2px color-mix(in srgb, #4d9fff 24%, transparent);
        }
        .dsh-tp-btn:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); }
        .dsh-tp-btn[aria-expanded="true"] {
          opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent);
          border-color: color-mix(in srgb, currentColor 34%, transparent);
        }
        .dsh-tp-caret { font-size: 9px; opacity: .6; transition: transform .18s; }
        .dsh-tp-btn[aria-expanded="true"] .dsh-tp-caret { transform: rotate(180deg); }

        /* ── 面板 ── */
        .dsh-tp-panel {
          --tp-accent: #4d9fff;
          --tp-accent-2: #a78bfa;
          --tp-card: rgba(255, 255, 255, .66);
          --tp-card-2: rgba(255, 255, 255, .46);
          --tp-line: rgba(22, 35, 58, .11);
          --tp-line-strong: rgba(22, 35, 58, .18);
          --tp-muted: rgba(22, 35, 58, .62);
          position: fixed; z-index: 2147483000;
          width: min(460px, calc(100vw - 24px));
          max-height: min(78vh, 640px);
          display: flex; flex-direction: column;
          background: var(--tp-bg, rgba(220, 233, 247, .92));
          color: var(--tp-fg, #16233a);
          border-radius: 16px;
          border: 1px solid var(--tp-line-strong);
          box-shadow:
            0 1px 0 rgba(255, 255, 255, .45) inset,
            0 30px 70px -28px rgba(10, 22, 45, .55),
            0 10px 26px -20px rgba(10, 22, 45, .45);
          backdrop-filter: blur(22px) saturate(1.35);
          -webkit-backdrop-filter: blur(22px) saturate(1.35);
          font-size: 13px; overflow: hidden;
          animation: dsh-tp-in .16s ease-out;
        }
        .dsh-tp-panel * { box-sizing: border-box; }
        @keyframes dsh-tp-in {
          from { opacity: 0; transform: translateY(-4px) scale(.995); }
          to { opacity: 1; transform: none; }
        }

        /* ── 头部 ── */
        .dsh-tp-head {
          display: flex; align-items: center; gap: 9px; padding: 11px 12px 10px;
          border-bottom: 1px solid var(--tp-line);
          background: linear-gradient(180deg, color-mix(in srgb, currentColor 4%, transparent), transparent);
        }
        .dsh-tp-logo {
          position: relative; width: 22px; height: 22px; flex: none; border-radius: 7px;
          background: linear-gradient(140deg, var(--tp-accent), var(--tp-accent-2));
          box-shadow: 0 4px 10px -5px color-mix(in srgb, var(--tp-accent) 70%, transparent);
        }
        .dsh-tp-logo::before, .dsh-tp-logo::after {
          content: ''; position: absolute; width: 5px; height: 5px; border-radius: 2px;
          background: rgba(255, 255, 255, .94);
        }
        .dsh-tp-logo::before { left: 5px; top: 5px; }
        .dsh-tp-logo::after { right: 5px; bottom: 5px; }
        .dsh-tp-titles { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
        .dsh-tp-title { font-size: 13px; font-weight: 650; letter-spacing: .015em; white-space: nowrap; }
        .dsh-tp-count {
          font-size: 10.5px; color: var(--tp-muted); white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums;
        }
        .dsh-tp-actions { display: flex; align-items: center; gap: 2px; flex: none; }
        .dsh-tp-iconbtn {
          width: 26px; height: 26px; padding: 0; border-radius: 8px; flex: none;
          border: 1px solid transparent; background: transparent; color: inherit;
          cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
          font-size: 12.5px; opacity: .58;
          transition: opacity .15s, background .15s, border-color .15s, color .15s;
        }
        .dsh-tp-iconbtn:hover { opacity: 1; background: color-mix(in srgb, currentColor 9%, transparent); }
        .dsh-tp-pinbtn { font-size: 13px; }
        .dsh-tp-iconbtn[aria-pressed="true"] {
          opacity: 1; color: var(--tp-accent);
          background: color-mix(in srgb, var(--tp-accent) 14%, transparent);
          border-color: color-mix(in srgb, var(--tp-accent) 30%, transparent);
        }
        .dsh-tp-scopebtn {
          flex: none; height: 26px; padding: 0 9px 0 8px; border-radius: 9px;
          border: 1px solid var(--tp-line-strong); background: var(--tp-card-2);
          color: inherit; cursor: pointer; font: inherit; font-size: 11px;
          display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
          transition: background .15s, border-color .15s, color .15s, box-shadow .15s;
        }
        .dsh-tp-scopebtn::before {
          content: ''; width: 5px; height: 5px; border-radius: 50%; flex: none;
          background: color-mix(in srgb, currentColor 40%, transparent);
        }
        .dsh-tp-scopebtn:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
        .dsh-tp-scopebtn[aria-pressed="true"] {
          color: #fff; border-color: transparent;
          background: linear-gradient(135deg, #4d9fff, #6f7cf5);
          box-shadow: 0 3px 10px -5px rgba(77, 159, 255, .9);
        }
        .dsh-tp-scopebtn[aria-pressed="true"]::before { background: rgba(255, 255, 255, .9); }

        /* ── 搜索 ── */
        .dsh-tp-searchwrap { position: relative; margin: 9px 12px 0; }
        .dsh-tp-searchicon {
          position: absolute; left: 10px; top: 50%; width: 11px; height: 11px;
          transform: translateY(-50%); border: 1.6px solid var(--tp-muted);
          border-radius: 50%; pointer-events: none; opacity: .75;
        }
        .dsh-tp-searchicon::after {
          content: ''; position: absolute; right: -3.5px; bottom: -2.5px;
          width: 5px; height: 1.6px; border-radius: 2px;
          background: var(--tp-muted); transform: rotate(45deg);
        }
        .dsh-tp-search {
          width: 100%; height: 30px; padding: 0 10px 0 28px; font: inherit; font-size: 12px;
          color: inherit; background: var(--tp-card-2); border: 1px solid var(--tp-line);
          border-radius: 10px; outline: none;
          transition: border-color .15s, box-shadow .15s, background .15s;
        }
        .dsh-tp-search::placeholder { color: var(--tp-muted); }
        .dsh-tp-search:focus {
          background: var(--tp-card);
          border-color: color-mix(in srgb, var(--tp-accent) 55%, transparent);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-accent) 16%, transparent);
        }

        /* ── 分段筛选 ── */
        .dsh-tp-filters {
          display: flex; gap: 2px; margin: 8px 12px 0; padding: 3px;
          border-radius: 10px; border: 1px solid var(--tp-line); background: var(--tp-card-2);
        }
        .dsh-tp-filter {
          flex: 1 1 0; height: 24px; border-radius: 8px; cursor: pointer;
          border: 1px solid transparent; background: transparent; color: inherit;
          font: inherit; font-size: 11.5px; opacity: .7;
          transition: opacity .15s, background .15s, color .15s, box-shadow .15s;
        }
        .dsh-tp-filter:hover { opacity: 1; background: color-mix(in srgb, currentColor 8%, transparent); }
        .dsh-tp-filter[aria-pressed="true"] {
          opacity: 1; color: #fff; border-color: transparent;
          background: linear-gradient(135deg, #4d9fff, #6f7cf5);
          box-shadow: 0 3px 9px -4px rgba(77, 159, 255, .85);
        }
        .dsh-tp-filter[aria-pressed="true"]:hover { background: linear-gradient(135deg, #4d9fff, #6f7cf5); }
        .dsh-tp-filter[aria-disabled="true"] { cursor: default; }

        /* ── 列表容器 ── */
        .dsh-tp-body {
          overflow: auto; padding: 10px 12px 14px;
          display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin;
        }
        .dsh-tp-body::-webkit-scrollbar { width: 9px; }
        .dsh-tp-body::-webkit-scrollbar-thumb {
          border-radius: 9px; border: 3px solid transparent; background-clip: content-box;
          background-color: color-mix(in srgb, currentColor 22%, transparent);
        }
        .dsh-tp-body::-webkit-scrollbar-thumb:hover {
          background-color: color-mix(in srgb, currentColor 34%, transparent);
        }

        /* ── 插件卡 ── */
        .dsh-tp-group {
          padding: 10px 11px 9px; border-radius: 14px;
          border: 1px solid var(--tp-line); background: var(--tp-card);
          box-shadow: 0 1px 2px rgba(10, 22, 45, .05), 0 12px 26px -22px rgba(10, 22, 45, .5);
          transition: border-color .16s, box-shadow .16s;
        }
        .dsh-tp-group:hover {
          border-color: var(--tp-line-strong);
          box-shadow: 0 1px 2px rgba(10, 22, 45, .06), 0 18px 34px -24px rgba(10, 22, 45, .55);
        }
        .dsh-tp-grouphead { display: flex; align-items: center; gap: 9px; }
        .dsh-tp-avatar {
          flex: none; width: 30px; height: 30px; border-radius: 10px; user-select: none;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 11.5px; font-weight: 700; letter-spacing: .02em; color: #fff;
          text-shadow: 0 1px 1px rgba(0, 0, 0, .18);
          background: linear-gradient(140deg, hsl(var(--h, 215) 80% 64%), hsl(calc(var(--h, 215) + 34) 74% 52%));
          box-shadow: 0 5px 12px -7px hsl(var(--h, 215) 65% 35%);
        }
        .dsh-tp-gheadtext { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .dsh-tp-gnameline { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .dsh-tp-gname {
          min-width: 0; font-size: 12px; font-weight: 650;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .dsh-tp-ver {
          flex: none; font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 5px;
          color: var(--tp-muted); border: 1px solid var(--tp-line); background: var(--tp-card-2);
          font-variant-numeric: tabular-nums;
        }
        .dsh-tp-gsub {
          display: flex; align-items: center; gap: 5px; min-width: 0;
          font-size: 11px; color: var(--tp-muted); white-space: nowrap;
        }
        .dsh-tp-zhname {
          font-weight: 600; overflow: hidden; text-overflow: ellipsis;
          color: color-mix(in srgb, currentColor 82%, transparent);
        }
        .dsh-tp-dot { opacity: .5; }
        .dsh-tp-expand {
          flex: none; display: inline-flex; align-items: center; gap: 5px;
          height: 25px; padding: 0 9px; border-radius: 8px; cursor: pointer;
          font: inherit; font-size: 11px; color: var(--tp-muted);
          border: 1px solid var(--tp-line-strong); background: var(--tp-card-2);
          transition: color .15s, background .15s, border-color .15s;
        }
        .dsh-tp-expand:hover {
          color: inherit;
          border-color: color-mix(in srgb, var(--tp-accent) 45%, var(--tp-line-strong));
          background: color-mix(in srgb, var(--tp-accent) 10%, var(--tp-card-2));
        }
        .dsh-tp-expand[aria-expanded="true"] {
          color: var(--tp-accent);
          border-color: color-mix(in srgb, var(--tp-accent) 45%, transparent);
          background: color-mix(in srgb, var(--tp-accent) 14%, transparent);
        }
        .dsh-tp-chev {
          width: 5px; height: 5px; flex: none; margin-top: -2px;
          border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
          transform: rotate(45deg); transition: transform .18s, margin-top .18s;
        }
        .dsh-tp-expand[aria-expanded="true"] .dsh-tp-chev { transform: rotate(-135deg); margin-top: 2px; }

        .dsh-tp-intro {
          margin: 9px 0 0; font-size: 12px; line-height: 1.62; color: var(--tp-muted);
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
          overflow: hidden; white-space: pre-wrap; word-break: break-word;
        }

        /* ── 触发说法胶囊 ── */
        .dsh-tp-saywrap {
          margin: 9px 0 0; padding: 6px 8px 7px; border-radius: 10px;
          display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
          border: 1px solid var(--tp-line); background: var(--tp-card-2);
        }
        .dsh-tp-saylabel {
          flex: none; display: inline-flex; align-items: center; gap: 5px;
          font-size: 10px; letter-spacing: .04em; color: var(--tp-muted);
        }
        .dsh-tp-saylabel::before {
          content: ''; width: 4px; height: 4px; border-radius: 50%;
          background: var(--tp-accent); flex: none;
        }
        .dsh-tp-saychip {
          max-width: 100%; padding: 2.5px 8px; border-radius: 999px; cursor: pointer;
          font: inherit; font-size: 11px; line-height: 1.45; color: inherit;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          border: 1px solid var(--tp-line-strong); background: var(--tp-card);
          box-shadow: 0 1px 1px rgba(10, 22, 45, .04);
          transition: transform .12s, border-color .15s, background .15s, color .15s;
        }
        .dsh-tp-saychip:hover {
          transform: translateY(-1px); color: var(--tp-accent);
          border-color: color-mix(in srgb, var(--tp-accent) 50%, transparent);
          background: color-mix(in srgb, var(--tp-accent) 10%, var(--tp-card));
        }
        .dsh-tp-saychip:active { transform: translateY(0); }
        .dsh-tp-saychip.done {
          color: #2f8f4e;
          border-color: color-mix(in srgb, #4caf50 55%, transparent);
          background: color-mix(in srgb, #4caf50 16%, var(--tp-card));
        }

        /* ── 工具列表 ── */
        .dsh-tp-toollist {
          margin: 11px 0 0; padding: 2px 0 2px 11px;
          border-left: 2px solid var(--tp-line);
          display: flex; flex-direction: column; gap: 6px;
        }
        .dsh-tp-item {
          padding: 7px 9px; border-radius: 10px;
          border: 1px solid var(--tp-line); background: var(--tp-card-2);
        }
        .dsh-tp-itemhead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .dsh-tp-name {
          font-size: 11.5px; font-weight: 600; word-break: break-all;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .dsh-tp-zh {
          margin-top: 4px; font-size: 11.5px; line-height: 1.58; color: var(--tp-muted);
          white-space: pre-wrap; word-break: break-word;
        }
        .dsh-tp-toolhint {
          margin: 10px 0 0; padding: 8px 10px; border-radius: 9px;
          font-size: 11.5px; color: var(--tp-muted); border: 1px dashed var(--tp-line-strong);
        }

        /* ── 技能卡 ── */
        .dsh-tp-skillgroup > .dsh-tp-intro { -webkit-line-clamp: 2; }
        .dsh-tp-skillgroup {
          border-color: color-mix(in srgb, var(--tp-accent-2) 34%, var(--tp-line));
          background: color-mix(in srgb, var(--tp-accent-2) 7%, var(--tp-card));
        }
        .dsh-tp-skillgroup .dsh-tp-avatar {
          background: linear-gradient(140deg, hsl(262 82% 70%), hsl(292 70% 58%));
          box-shadow: 0 5px 12px -7px hsl(275 60% 40%);
        }
        .dsh-tp-skill {
          margin-top: 7px; padding: 9px 10px 8px; border-radius: 12px;
          border: 1px solid var(--tp-line); background: var(--tp-card);
        }
        .dsh-tp-skill .dsh-tp-itemhead { gap: 7px; }
        .dsh-tp-skill .dsh-tp-avatar { width: 24px; height: 24px; border-radius: 8px; font-size: 10px; }
        .dsh-tp-skill .dsh-tp-name { font-size: 11.5px; }
        .dsh-tp-badge {
          flex: none; font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 5px;
          color: var(--tp-muted); border: 1px solid var(--tp-line-strong);
          background: var(--tp-card-2); white-space: nowrap;
        }
        .dsh-tp-when {
          margin-top: 7px; padding-left: 9px; font-size: 11.5px; line-height: 1.55;
          border-left: 2px solid color-mix(in srgb, var(--tp-accent-2) 55%, transparent);
          color: var(--tp-muted); white-space: pre-wrap; word-break: break-word;
        }
        .dsh-tp-when b { font-weight: 600; opacity: .95; }
        .dsh-tp-meta {
          margin-top: 7px; font-size: 10px; color: var(--tp-muted); opacity: .82;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        /* ── 外观设置 ── */
        .dsh-tp-settings {
          margin: 9px 12px 0; padding: 10px 11px; border-radius: 12px;
          border: 1px solid var(--tp-line); background: var(--tp-card);
          box-shadow: 0 8px 20px -18px rgba(10, 22, 45, .6);
        }
        .dsh-tp-settings[hidden] { display: none; }
        .dsh-tp-setrow { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; flex-wrap: wrap; }
        .dsh-tp-setrow:last-child { margin-bottom: 0; }
        .dsh-tp-setlabel { font-size: 11px; color: var(--tp-muted); min-width: 44px; }
        .dsh-tp-color {
          width: 34px; height: 24px; padding: 0; cursor: pointer; border-radius: 7px;
          border: 1px solid var(--tp-line-strong); background: transparent;
        }
        .dsh-tp-swatch {
          width: 18px; height: 18px; padding: 0; border-radius: 50%; cursor: pointer;
          border: 1px solid rgba(0, 0, 0, .12); box-shadow: 0 1px 2px rgba(0, 0, 0, .12);
          transition: transform .12s;
        }
        .dsh-tp-swatch:hover { transform: scale(1.15); }
        .dsh-tp-range {
          flex: 1 1 90px; min-width: 80px; height: 18px; cursor: pointer;
          accent-color: var(--tp-accent);
        }
        .dsh-tp-setval {
          min-width: 32px; text-align: right; font-size: 10.5px;
          color: var(--tp-muted); font-variant-numeric: tabular-nums;
        }
        .dsh-tp-reset {
          padding: 4px 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 11px;
          color: inherit; background: var(--tp-card-2); border: 1px solid var(--tp-line-strong);
        }
        .dsh-tp-reset:hover { background: color-mix(in srgb, currentColor 10%, transparent); }

        /* ── 空状态 / 抓手 ── */
        .dsh-tp-empty {
          padding: 26px 16px; display: flex; flex-direction: column; align-items: center; gap: 10px;
          text-align: center; font-size: 12px; line-height: 1.6; color: var(--tp-muted);
        }
        .dsh-tp-emptymark {
          position: relative; width: 36px; height: 36px; border-radius: 12px;
          border: 1px dashed var(--tp-line-strong);
        }
        .dsh-tp-emptymark::after {
          content: ''; position: absolute; inset: 12px; border-radius: 5px;
          background: color-mix(in srgb, var(--tp-accent) 45%, transparent);
        }
        .dsh-tp-grip {
          width: 14px; height: 24px; flex: none; margin-left: -4px; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: grab; opacity: .35; font-size: 12px; letter-spacing: -2px;
          user-select: none; touch-action: none; border-radius: 6px;
          border: none; background: transparent; color: inherit;
          transition: opacity .15s, background .15s;
        }
        .dsh-tp-grip:hover { opacity: .9; background: color-mix(in srgb, currentColor 9%, transparent); }
        .dsh-tp-panel.dragging, .dsh-tp-panel.dragging .dsh-tp-grip { cursor: grabbing; }
        .dsh-tp-panel.dragging { user-select: none; }

        @media (prefers-reduced-motion: reduce) {
          .dsh-tp-panel { animation: none; }
          .dsh-tp-saychip:hover { transform: none; }
        }

      `;

      function injectStyles(doc) {
        if (doc.getElementById('dsh-tp-styles')) return;
        const style = doc.createElement('style');
        style.id = 'dsh-tp-styles';
        style.textContent = css;
        (doc.head || doc.documentElement).appendChild(style);
      }

      function tabsContainer() {
        return document.querySelector('[data-conversation-tabs]');
      }

      function ensureButton() {
        if (btn) return btn;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dsh-tp-btn';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
        btn.title = '点击打开触发提示词；长按可拖动按钮（只在页签行内移动，拖不进对话区）；右键单击复位';
        const label = document.createElement('span');
        label.textContent = '触发词';
        const caret = document.createElement('span');
        caret.className = 'dsh-tp-caret';
        caret.textContent = '▾';
        btn.append(label, caret);
        let suppressClick = false;
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          toggle();
        });

        // 右键单击：回到原位（没有位移时不做任何事，右键菜单照常）
        btn.addEventListener('contextmenu', (event) => {
          if (!state.btnOffset) return;
          event.preventDefault();
          event.stopPropagation();
          state.btnOffset = null;
          persistBtnOffset();
          applyBtnOffset();
          schedulePosition();
        });

        // 长按 260ms 拿起 → 只在页签行（对话区之外）里移动
        btn.addEventListener('pointerdown', (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          const rect = btn.getBoundingClientRect();
          const origin = state.btnOffset ?? { dx: 0, dy: 0 };
          const natural = {
            left: rect.left - origin.dx,
            top: rect.top - origin.dy,
            right: rect.right - origin.dx,
            bottom: rect.bottom - origin.dy,
          };
          const limits = buttonDragLimits(natural, tabsContainer()?.getBoundingClientRect() ?? null);
          const startX = event.clientX;
          const startY = event.clientY;
          let armed = false;
          let stopped = false;
          let moved = false;
          const armTimer = setTimeout(() => {
            armed = true;
            btn.classList.add('dragging');
            try {
              btn.setPointerCapture(event.pointerId);
            } catch {
              /* 忽略 */
            }
          }, 260);
          const cleanup = () => {
            clearTimeout(armTimer);
            btn.classList.remove('dragging');
            btn.removeEventListener('pointermove', onMove);
            btn.removeEventListener('pointerup', onUp);
            btn.removeEventListener('pointercancel', onUp);
          };
          const onMove = (moveEvent) => {
            if (stopped) return;
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (!armed) {
              // 长按期间明显移动 = 不是长按，交回点击
              if (Math.hypot(dx, dy) > 8) {
                stopped = true;
                cleanup();
              }
              return;
            }
            moved = true;
            state.btnOffset = {
              dx: Math.min(Math.max(origin.dx + dx, limits.minX), limits.maxX),
              dy: Math.min(Math.max(origin.dy + dy, limits.minY), limits.maxY),
            };
            applyBtnOffset();
            schedulePosition();
          };
          const onUp = () => {
            if (stopped) return;
            stopped = true;
            cleanup();
            if (!armed) return;
            suppressClick = true;
            setTimeout(() => {
              suppressClick = false;
            }, 400);
            if (moved) persistBtnOffset();
            schedulePosition();
          };
          btn.addEventListener('pointermove', onMove);
          btn.addEventListener('pointerup', onUp);
          btn.addEventListener('pointercancel', onUp);
        });
        return btn;
      }

      function persistBtnOffset() {
        try {
          if (state.btnOffset && (state.btnOffset.dx || state.btnOffset.dy)) {
            localStorage.setItem(LS_BTN, JSON.stringify(state.btnOffset));
          } else {
            localStorage.removeItem(LS_BTN);
          }
        } catch {
          /* 忽略隐私模式 */
        }
      }

      function applyBtnOffset() {
        if (!btn) return;
        const offset = state.btnOffset;
        if (!offset || (!offset.dx && !offset.dy)) {
          btn.style.transform = '';
          btn.classList.remove('moved');
          return;
        }
        btn.style.transform = 'translate(' + Math.round(offset.dx) + 'px, ' + Math.round(offset.dy) + 'px)';
        btn.classList.add('moved');
      }

      /** 位移上限：把按钮夹在页签行矩形内 —— 页签行在对话区之外，所以拖不进去。 */
      function buttonDragLimits(natural, box) {
        if (!box) return { minX: -200, maxX: 200, minY: -10, maxY: 10 };
        return {
          minX: Math.round(box.left - natural.left),
          maxX: Math.round(box.right - natural.right),
          minY: Math.round(box.top - natural.top),
          maxY: Math.round(box.bottom - natural.bottom),
        };
      }

      /** 量一个原生页签，把按钮的高度 / 字号 / 字重 / 内边距 / 行内间距抄过来。 */
      function alignButtonToTabs(container) {
        if (!btn || !container || typeof getComputedStyle !== 'function') return;
        const pickReference = () => {
          const direct = container.querySelector?.('[role="tab"]');
          if (direct) return direct;
          const candidates = [];
          for (const child of container.children ?? []) {
            if (!child || child === btn || child.nodeType !== 1) continue;
            candidates.push(...(child.querySelectorAll?.('button, a, [role="tab"]') ?? []), child);
          }
          return candidates.find((el) => el && el !== btn && (el.textContent ?? '').trim()) ?? null;
        };
        const reference = pickReference();
        if (!reference) return;
        const rect = reference.getBoundingClientRect();
        const style = getComputedStyle(reference);
        const rowStyle = getComputedStyle(container);
        const gap = rowStyle.columnGap && rowStyle.columnGap !== 'normal' ? rowStyle.columnGap : rowStyle.gap;
        const signature = [Math.round(rect.height), style.fontSize, style.fontWeight, style.paddingLeft, gap].join('|');
        if (signature === state.btnAlign) return;
        state.btnAlign = signature;
        if (rect.height) btn.style.height = Math.round(rect.height) + 'px';
        if (style.fontSize) btn.style.fontSize = style.fontSize;
        if (style.fontWeight) btn.style.fontWeight = style.fontWeight;
        if (style.paddingLeft) btn.style.paddingLeft = style.paddingLeft;
        if (style.paddingRight) btn.style.paddingRight = style.paddingRight;
        if (gap && gap !== 'normal') btn.style.marginLeft = gap;
        if (state.open) schedulePosition();
      }

      function ensurePanel() {
        if (panel) return panel;
        panel = document.createElement('div');
        panel.className = 'dsh-tp-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '触发提示词');
        panel.style.display = 'none';

        const head = document.createElement('div');
        head.className = 'dsh-tp-head';
        const title = document.createElement('div');
        title.className = 'dsh-tp-title';
        title.textContent = '触发提示词';
        countEl = document.createElement('div');
        countEl.className = 'dsh-tp-count';
        const titles = document.createElement('div');
        titles.className = 'dsh-tp-titles';
        titles.append(title, countEl);
        const logo = document.createElement('div');
        logo.className = 'dsh-tp-logo';
        logo.setAttribute('aria-hidden', 'true');
        const actions = document.createElement('div');
        actions.className = 'dsh-tp-actions';

        const grip = document.createElement('button');
        grip.type = 'button';
        grip.className = 'dsh-tp-grip';
        grip.textContent = '⠿';
        grip.title = '长按并拖动可移动面板；双击复位到按钮下方';
        grip.setAttribute('aria-label', '拖动面板');
        grip.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          state.pos = null;
          persistPos();
          positionPanel();
        });
        grip.addEventListener('pointerdown', (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const startX = event.clientX;
          const startY = event.clientY;
          const rect = panel.getBoundingClientRect();
          const offsetX = startX - rect.left;
          const offsetY = startY - rect.top;
          let armed = false;
          let stopped = false;
          const armTimer = setTimeout(() => {
            armed = true;
            panel.classList.add('dragging');
            try {
              grip.setPointerCapture(event.pointerId);
            } catch {
              /* 忽略 */
            }
          }, 240);
          const cleanup = () => {
            clearTimeout(armTimer);
            panel.classList.remove('dragging');
            grip.removeEventListener('pointermove', onMove);
            grip.removeEventListener('pointerup', onUp);
            grip.removeEventListener('pointercancel', onUp);
          };
          const onMove = (moveEvent) => {
            if (stopped) return;
            if (!armed) {
              // 长按期间手指/鼠标大幅移动 = 不是长按，取消
              if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 8) {
                stopped = true;
                cleanup();
              }
              return;
            }
            state.pos = { left: moveEvent.clientX - offsetX, top: moveEvent.clientY - offsetY };
            positionPanel();
          };
          const onUp = () => {
            if (stopped) return;
            stopped = true;
            cleanup();
            if (armed) persistPos();
          };
          grip.addEventListener('pointermove', onMove);
          grip.addEventListener('pointerup', onUp);
          grip.addEventListener('pointercancel', onUp);
        });

        scopeBtn = document.createElement('button');
        scopeBtn.type = 'button';
        scopeBtn.className = 'dsh-tp-scopebtn';
        scopeBtn.setAttribute('aria-pressed', 'false');
        scopeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          setShowAll(!state.showAll);
        });

        pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'dsh-tp-iconbtn dsh-tp-pinbtn';
        pinBtn.title = '置顶：保持打开，与其它界面交互也不关闭';
        pinBtn.setAttribute('aria-label', '置顶');
        pinBtn.setAttribute('aria-pressed', 'false');
        pinBtn.textContent = '★';
        pinBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          setPinned(!state.pinned);
        });

        refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'dsh-tp-iconbtn';
        refreshBtn.title = '刷新';
        refreshBtn.setAttribute('aria-label', '刷新');
        refreshBtn.textContent = '↻';
        refreshBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          state.fetchedAt = 0;
          void load(true);
        });

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'dsh-tp-iconbtn';
        closeBtn.title = '关闭';
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          close();
        });

        settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.className = 'dsh-tp-iconbtn';
        settingsBtn.title = '设置面板外观（背景色 / 透明度）';
        settingsBtn.setAttribute('aria-label', '设置');
        settingsBtn.setAttribute('aria-pressed', 'false');
        settingsBtn.textContent = '⚙';
        settingsBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleSettings();
        });

        actions.append(settingsBtn, scopeBtn, pinBtn, refreshBtn, closeBtn);
        head.append(grip, logo, titles, actions);

        searchEl = document.createElement('input');
        searchEl.className = 'dsh-tp-search';
        searchEl.type = 'search';
        searchEl.placeholder = '搜索插件 / 工具 / 技能 / 关键字';
        searchEl.addEventListener('input', () => {
          state.query = searchEl.value.trim();
          renderList();
        });
        searchEl.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') close();
        });

        filtersEl = document.createElement('div');
        filtersEl.className = 'dsh-tp-filters';
        filtersEl.addEventListener('pointerdown', (event) => event.stopPropagation());
        for (const entry of [['plugins', '插件'], ['skills', '技能']]) {
          const filterBtn = document.createElement('button');
          filterBtn.type = 'button';
          filterBtn.className = 'dsh-tp-filter';
          filterBtn.textContent = entry[1];
          filterBtn.setAttribute('aria-pressed', 'false');
          filterBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleSection(entry[0]);
          });
          filterBtns[entry[0]] = filterBtn;
          filtersEl.appendChild(filterBtn);
        }

        listEl = document.createElement('div');
        listEl.className = 'dsh-tp-body';

        settingsEl = document.createElement('div');
        settingsEl.className = 'dsh-tp-settings';
        settingsEl.setAttribute('hidden', '');

        const bgRow = document.createElement('div');
        bgRow.className = 'dsh-tp-setrow';
        const bgLabel = document.createElement('span');
        bgLabel.className = 'dsh-tp-setlabel';
        bgLabel.textContent = '背景色';
        colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'dsh-tp-color';
        colorInput.title = '选一个背景色';
        colorInput.addEventListener('input', () => saveTheme({ bg: colorInput.value }));
        bgRow.append(bgLabel, colorInput);
        for (const swatch of ['#dce9f7', '#e6f2e2', '#f1e7f7', '#fbf1d6', '#1f2430']) {
          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'dsh-tp-swatch';
          dot.style.background = swatch;
          dot.title = swatch;
          dot.setAttribute('aria-label', `背景色 ${swatch}`);
          dot.addEventListener('click', (event) => {
            event.stopPropagation();
            saveTheme({ bg: swatch });
          });
          bgRow.appendChild(dot);
        }

        const alphaRow = document.createElement('div');
        alphaRow.className = 'dsh-tp-setrow';
        const alphaTitle = document.createElement('span');
        alphaTitle.className = 'dsh-tp-setlabel';
        alphaTitle.textContent = '透明度';
        alphaInput = document.createElement('input');
        alphaInput.type = 'range';
        alphaInput.min = '35';
        alphaInput.max = '100';
        alphaInput.step = '1';
        alphaInput.className = 'dsh-tp-range';
        alphaInput.title = '面板背景的不透明度';
        alphaLabel = document.createElement('span');
        alphaLabel.className = 'dsh-tp-setval';
        alphaInput.addEventListener('input', () => {
          saveTheme({ alpha: Number(alphaInput.value) / 100 });
        });
        alphaRow.append(alphaTitle, alphaInput, alphaLabel);

        const resetRow = document.createElement('div');
        resetRow.className = 'dsh-tp-setrow';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'dsh-tp-reset';
        resetBtn.textContent = '恢复默认（浅蓝）';
        resetBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          resetTheme();
        });
        resetRow.append(resetBtn);

        settingsEl.append(bgRow, alphaRow, resetRow);

        const searchWrap = document.createElement('div');
        searchWrap.className = 'dsh-tp-searchwrap';
        const searchIcon = document.createElement('span');
        searchIcon.className = 'dsh-tp-searchicon';
        searchIcon.setAttribute('aria-hidden', 'true');
        searchWrap.append(searchIcon, searchEl);
        panel.append(head, searchWrap, filtersEl, settingsEl, listEl);
        panel.addEventListener('pointerdown', (event) => event.stopPropagation());
        document.body.appendChild(panel);
        applyPinnedUI();
        applyTheme();
        return panel;
      }

      function setPinned(next) {
        state.pinned = Boolean(next);
        try {
          localStorage.setItem(LS_PIN, state.pinned ? '1' : '0');
        } catch {
          /* 忽略隐私模式 */
        }
        applyPinnedUI();
      }

      function applyPinnedUI() {
        if (!pinBtn) return;
        pinBtn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
        pinBtn.title = state.pinned ? '已置顶：点击取消置顶' : '置顶：保持打开，与其它界面交互也不关闭';
      }

      function applyScopeUI() {
        if (!scopeBtn) return;
        scopeBtn.textContent = state.showAll ? '全部' : '仅插件';
        scopeBtn.setAttribute('aria-pressed', state.showAll ? 'true' : 'false');
        scopeBtn.title = state.showAll
          ? '当前显示全部工具（含内置 / MCP）：点击只看自己装的插件'
          : '当前只显示自己装的插件：点击也会列出内置 / MCP 外部工具';
      }

      function setShowAll(next) {
        state.showAll = Boolean(next);
        try {
          localStorage.setItem(LS_ALL, state.showAll ? '1' : '0');
        } catch {
          /* 忽略隐私模式 */
        }
        applyScopeUI();
        renderList();
        schedulePosition();
      }

      const SECTION_IDS = ['plugins', 'skills'];

      function normalizeSections(raw) {
        let parsed = null;
        try {
          parsed = JSON.parse(raw ?? 'null');
        } catch {
          parsed = null;
        }
        const kept = Array.isArray(parsed) ? parsed.filter((id) => SECTION_IDS.includes(id)) : [];
        const unique = [...new Set(kept)];
        return unique.length ? unique : ['plugins', 'skills'];
      }

      function persistSections() {
        try {
          localStorage.setItem(LS_SECTIONS, JSON.stringify(state.sections));
        } catch {
          /* 忽略隐私模式 */
        }
      }

      function applySectionsUI() {
        const onlyOne = state.sections.length === 1;
        for (const id of SECTION_IDS) {
          const button = filterBtns[id];
          if (!button) continue;
          const on = state.sections.includes(id);
          const alone = onlyOne && on;
          const label = id === 'plugins' ? '插件' : '技能';
          button.setAttribute('aria-pressed', on ? 'true' : 'false');
          button.setAttribute('aria-disabled', alone ? 'true' : 'false');
          if (alone) button.title = label + '：至少保留一个，另一个打开后才能隐藏它';
          else if (on) button.title = '隐藏' + label + '（再点会排到下方重新显示）';
          else button.title = '显示' + label + '（排在当前内容的下面）';
        }
      }

      /** 显示 / 隐藏一节。至少保留一节；重新打开的那节排到最后（= 显示在下方）。 */
      function toggleSection(id) {
        if (!SECTION_IDS.includes(id)) return;
        if (state.sections.includes(id)) {
          if (state.sections.length === 1) return;
          state.sections = state.sections.filter((section) => section !== id);
        } else {
          state.sections = [...state.sections, id];
        }
        persistSections();
        applySectionsUI();
        renderList();
        schedulePosition();
      }

      function toggleGroupTools(key) {
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        renderList();
        schedulePosition();
      }

      function hexToRgba(hex, alpha) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
        if (!match) return `rgba(220, 233, 247, ${alpha})`;
        const int = parseInt(match[1], 16);
        return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
      }

      // 相对亮度：亮背景配深字，暗背景配浅字
      function relLuminance(hex) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
        if (!match) return 0.9;
        const int = parseInt(match[1], 16);
        const channel = (value) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return (
          0.2126 * channel((int >> 16) & 255) +
          0.7152 * channel((int >> 8) & 255) +
          0.0722 * channel(int & 255)
        );
      }

      function applyTheme() {
        const theme = state.theme ?? DEFAULT_THEME;
        if (panel) {
          const dark = relLuminance(theme.bg) <= 0.45;
          panel.style.setProperty('--tp-bg', hexToRgba(theme.bg, theme.alpha));
          panel.style.setProperty('--tp-fg', dark ? '#eef4ff' : '#16233a');
          panel.style.setProperty('--tp-card', dark ? 'rgba(255, 255, 255, .065)' : 'rgba(255, 255, 255, .66)');
          panel.style.setProperty('--tp-card-2', dark ? 'rgba(255, 255, 255, .04)' : 'rgba(255, 255, 255, .46)');
          panel.style.setProperty('--tp-line', dark ? 'rgba(255, 255, 255, .12)' : 'rgba(22, 35, 58, .11)');
          panel.style.setProperty('--tp-line-strong', dark ? 'rgba(255, 255, 255, .2)' : 'rgba(22, 35, 58, .18)');
          panel.style.setProperty('--tp-muted', dark ? 'rgba(238, 244, 255, .68)' : 'rgba(22, 35, 58, .62)');
        }
        if (colorInput) colorInput.value = theme.bg;
        if (alphaInput) alphaInput.value = String(Math.round(theme.alpha * 100));
        if (alphaLabel) alphaLabel.textContent = Math.round(theme.alpha * 100) + '%';
      }

      function saveTheme(patch) {
        const next = { ...(state.theme ?? DEFAULT_THEME), ...patch };
        state.theme = next;
        try {
          localStorage.setItem(LS_THEME, JSON.stringify(next));
        } catch {
          /* 忽略隐私模式 */
        }
        applyTheme();
      }

      function resetTheme() {
        saveTheme({ ...DEFAULT_THEME });
      }

      function toggleSettings(force) {
        if (!settingsEl) return;
        const show = typeof force === 'boolean' ? force : settingsEl.hasAttribute('hidden');
        if (show) settingsEl.removeAttribute('hidden');
        else settingsEl.setAttribute('hidden', '');
        settingsBtn?.setAttribute('aria-pressed', show ? 'true' : 'false');
      }

      function persistPos() {
        try {
          if (state.pos) localStorage.setItem(LS_POS, JSON.stringify(state.pos));
          else localStorage.removeItem(LS_POS);
        } catch {
          /* 忽略隐私模式 */
        }
      }

      function positionPanel() {
        if (!panel || !state.open) return;
        const width = panel.offsetWidth || 420;
        const height = panel.offsetHeight || 400;
        let left;
        let top;
        if (state.pos && Number.isFinite(state.pos.left) && Number.isFinite(state.pos.top)) {
          left = state.pos.left;
          top = state.pos.top;
        } else if (btn) {
          const rect = btn.getBoundingClientRect();
          left = rect.left;
          top = rect.bottom + 8;
        } else {
          left = 24;
          top = 80;
        }
        // 夹在视口内：窗口变小或分辨率变化时不会把面板丢到屏幕外
        left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
        top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
      }

      function schedulePosition() {
        if (positionRaf) return;
        positionRaf = requestAnimationFrame(() => {
          positionRaf = 0;
          positionPanel();
        });
      }

      function open() {
        ensurePanel();
        state.open = true;
        panel.style.display = 'flex';
        btn.setAttribute('aria-expanded', 'true');
        renderList();
        schedulePosition();
        void load(false);
      }

      function close() {
        state.open = false;
        if (panel) panel.style.display = 'none';
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }

      function toggle() {
        if (state.open) close();
        else open();
      }

      function onOutsidePointer(event) {
        if (!state.open || state.pinned) return;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (panel?.contains(target) || btn?.contains(target)) return;
        close();
      }

      function onKeyDown(event) {
        if (event.key !== 'Escape' || !state.open) return;
        event.stopPropagation();
        if (settingsEl && !settingsEl.hasAttribute('hidden')) {
          toggleSettings(false);
          return;
        }
        close();
      }

      async function load(force) {
        const fresh = state.payload && Date.now() - state.fetchedAt < STALE_MS;
        if (!force && fresh) return;
        state.loading = true;
        renderList();
        try {
          const [listResponse, dictResponse] = await Promise.all([
            fetch(LIST_ROUTE, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
              cache: 'no-store',
            }),
            fetch(DICT_ROUTE, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
              cache: 'no-store',
            }).catch(() => null),
          ]);
          if (!listResponse.ok) throw new Error(`HTTP ${listResponse.status}`);
          const payload = await listResponse.json();
          if (!payload || payload.ok !== true) throw new Error(payload?.error || 'bad payload');
          state.payload = payload;
          if (dictResponse && dictResponse.ok) {
            try {
              state.dict = await dictResponse.json();
            } catch {
              /* 词典坏了不影响主功能 */
            }
          }
          state.error = null;
          state.fetchedAt = Date.now();
        } catch (error) {
          state.error = String(error?.message ?? error);
        } finally {
          state.loading = false;
          renderList();
          schedulePosition();
        }
      }

      function matches(tool, query) {
        if (!query) return true;
        const entry = state.dict?.tools?.[tool.name];
        const zh = typeof entry === 'string' ? entry : entry?.zh ?? '';
        const haystack = `${tool.name}\n${tool.description}\n${tool.plugin ?? ''}\n${zh}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
      }

      async function copyText(text) {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
          }
        } catch {
          /* 无权限时回退 */
        }
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
          return true;
        } catch {
          return false;
        }
      }

      function matchesSkill(skill, query) {
        if (!query) return true;
        const zh = state.dict?.skills?.[skill.name];
        const zhText = [
          typeof zh === 'string' ? zh : zh?.name ?? '',
          Array.isArray(zh?.say) ? zh.say.join('\n') : '',
        ].join('\n');
        const haystack = [
          skill.name,
          skill.description ?? '',
          skill.whenToUse ?? '',
          skill.source ?? '',
          skill.path ?? '',
          zhText,
        ]
          .join('\n')
          .toLowerCase();
        return haystack.includes(query.toLowerCase());
      }

      /** 插件自身（名字 / 中文名 / 简介 / 触发说法）是否命中搜索词。 */
      function matchesPlugin(id, query) {
        if (!query) return null;
        const zh = state.dict?.plugins?.[id];
        const text = [
          id,
          typeof zh === 'string' ? zh : zh?.name ?? '',
          zh?.intro ?? '',
          Array.isArray(zh?.say) ? zh.say.join('\n') : '',
        ]
          .join('\n')
          .toLowerCase();
        return text.includes(query.toLowerCase());
      }

      function pluginLabel(id, pluginsById) {
        if (!id) return '内置 / 其它';
        const meta = pluginsById.get(id);
        if (!meta) return id;
        return meta.version ? `${id} · v${meta.version}` : id;
      }

      function groupLabel(key, pluginsById) {
        if (key === '') return '内置 / 其它';
        if (key === '__mcp__') return 'MCP 外部工具';
        return pluginLabel(key, pluginsById);
      }

      function mkSpan(className, text) {
        const span = document.createElement('span');
        if (className) span.className = className;
        span.textContent = text ?? '';
        return span;
      }

      /** 稳定的小哈希：给头像挑一个固定的色相。 */
      function hashHue(value) {
        let hash = 0;
        const text = String(value ?? '');
        for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
        return hash;
      }

      /** 头像上的字母：跳过 @scope/ 与 dsh 前缀，最多取两个词首。 */
      function initialsOf(label) {
        const parts = String(label ?? '').split('/');
        const base = parts[parts.length - 1] ?? '';
        const words = base.replace(/^dsh[-_]?/i, '').split(/[-_.]+/).filter(Boolean);
        const picked = words.slice(0, 2).map((word) => word.charAt(0)).join('');
        const fallback = (words[0] ?? base).slice(0, 2);
        return (picked.length >= 2 ? picked : fallback || '?').toUpperCase();
      }

      function buildAvatar(label, hue) {
        const avatar = document.createElement('span');
        avatar.className = 'dsh-tp-avatar';
        avatar.textContent = initialsOf(label);
        avatar.setAttribute('aria-hidden', 'true');
        avatar.style.setProperty('--h', String(Number.isFinite(hue) ? hue : hashHue(label)));
        return avatar;
      }

      function buildEmpty(text) {
        const empty = document.createElement('div');
        empty.className = 'dsh-tp-empty';
        const mark = document.createElement('div');
        mark.className = 'dsh-tp-emptymark';
        mark.setAttribute('aria-hidden', 'true');
        empty.append(mark, mkSpan('dsh-tp-emptytxt', text));
        return empty;
      }

      /** 一排可点击复制的「触发说法」胶囊；没有就返回 null。 */
      function buildSayChips(sayList) {
        if (!Array.isArray(sayList) || sayList.length === 0) return null;
        const wrap = document.createElement('div');
        wrap.className = 'dsh-tp-saywrap';
        wrap.appendChild(mkSpan('dsh-tp-saylabel', '触发说法'));
        for (const phrase of sayList) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'dsh-tp-saychip';
          chip.textContent = '「' + phrase + '」';
          chip.title = '点击复制这句触发说法';
          chip.addEventListener('click', async (event) => {
            event.stopPropagation();
            await copyText(phrase);
            chip.classList.add('done');
            chip.textContent = '已复制';
            setTimeout(() => {
              chip.textContent = '「' + phrase + '」';
              chip.classList.remove('done');
            }, 1000);
          });
          wrap.appendChild(chip);
        }
        return wrap;
      }

      function renderList() {
        if (!listEl) return;
        const payload = state.payload;
        const skills = Array.isArray(payload?.skills) ? payload.skills : [];
        listEl.replaceChildren();

        if (state.loading && !payload) {
          listEl.appendChild(buildEmpty('正在读取插件与技能注册表…'));
          return;
        }
        if (state.error && !payload) {
          listEl.appendChild(buildEmpty('读取失败：' + state.error + '（宿主插件可能还没加载，重启 DSH 后再试）'));
          return;
        }
        if (!payload) {
          if (countEl) countEl.textContent = '';
          return;
        }

        const pluginsById = new Map(payload.plugins.map((plugin) => [plugin.id, plugin]));
        const query = state.query;
        const keyOf = (tool) => tool.plugin ?? (tool.name.startsWith('mcp__') ? '__mcp__' : '');
        const ownOnly = !state.showAll;
        const matched = payload.tools.filter((tool) => matches(tool, query));
        const visibleTools = ownOnly
          ? matched.filter((tool) => {
              const key = keyOf(tool);
              return key !== '' && key !== '__mcp__';
            })
          : matched;

        const groups = new Map();
        for (const tool of visibleTools) {
          const key = keyOf(tool);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(tool);
        }
        // 面板主内容是插件本身：没有匹配工具时，只有「没在搜索」或「插件自身命中」才保留卡片
        if (ownOnly) {
          for (const plugin of payload.plugins) {
            if (plugin.count <= 0) continue;
            if (groups.has(plugin.id)) continue;
            if (matchesPlugin(plugin.id, query) === false) continue;
            groups.set(plugin.id, []);
          }
        }
        const rank = (key) => (key === '' ? 2 : key === '__mcp__' ? 1 : 0);
        const order = [...groups.keys()].sort((a, b) => {
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return a.localeCompare(b);
        });
        const visibleSkills = skills.filter((skill) => matchesSkill(skill, query));
        let totalTools = 0;
        for (const list of groups.values()) totalTools += list.length;

        if (countEl) {
          const parts = [];
          if (state.sections.includes('plugins')) {
            parts.push(order.length + ' 个插件');
            parts.push(totalTools + ' 个工具');
          }
          if (state.sections.includes('skills')) parts.push(visibleSkills.length + ' 个技能');
          countEl.textContent = '共 ' + parts.join(' · ') + (ownOnly ? '' : ' · 含内置/MCP');
        }

        const wantPlugins = state.sections.includes('plugins') && order.length > 0;
        const wantSkills = state.sections.includes('skills') && visibleSkills.length > 0;
        if (!wantPlugins && !wantSkills) {
          let text;
          if (query) {
            text = '没有匹配的插件或技能' + (ownOnly ? '（内置 / MCP 的工具请点右上角「全部」）' : '');
          } else if (ownOnly) {
            text = '还没有自己装的插件注册工具，也没有发现技能（点右上角「全部」可看内置 / MCP）';
          } else {
            text = '运行时注册表暂时没有返回插件或技能';
          }
          listEl.appendChild(buildEmpty(text));
          return;
        }

        for (const section of state.sections) {
          if (section === 'plugins') {
            for (const key of order) listEl.appendChild(buildPluginGroup(key, groups.get(key) ?? [], pluginsById));
          } else if (section === 'skills' && visibleSkills.length) {
            listEl.appendChild(buildSkillsGroup(visibleSkills));
          }
        }
      }

      function buildPluginGroup(key, tools, pluginsById) {
        const group = document.createElement('div');
        group.className = 'dsh-tp-group';

        const meta = pluginsById.get(key);
        const label = key === '' ? '内置 / 其它' : key === '__mcp__' ? 'MCP 外部工具' : key;
        const zhPlugin = state.dict?.plugins?.[key];
        const pluginName = typeof zhPlugin === 'string' ? zhPlugin : zhPlugin?.name;

        const head = document.createElement('div');
        head.className = 'dsh-tp-grouphead';
        head.appendChild(buildAvatar(label));

        const headText = document.createElement('div');
        headText.className = 'dsh-tp-gheadtext';
        const nameLine = document.createElement('div');
        nameLine.className = 'dsh-tp-gnameline';
        const name = document.createElement('div');
        name.className = 'dsh-tp-gname';
        name.textContent = label;
        name.title = label;
        nameLine.appendChild(name);
        if (meta && meta.version) nameLine.appendChild(mkSpan('dsh-tp-ver', 'v' + meta.version));
        headText.appendChild(nameLine);

        const sub = document.createElement('div');
        sub.className = 'dsh-tp-gsub';
        if (pluginName) {
          sub.appendChild(mkSpan('dsh-tp-zhname', pluginName));
          sub.appendChild(mkSpan('dsh-tp-dot', '·'));
        }
        sub.appendChild(mkSpan('', tools.length + ' 个工具'));
        headText.appendChild(sub);
        head.appendChild(headText);

        const expanded = state.expanded.has(key);
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'dsh-tp-expand';
        expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        expandBtn.title = expanded ? '收起这个插件的工具列表' : '展开这个插件的 ' + tools.length + ' 个工具';
        expandBtn.append(document.createTextNode(expanded ? '收起工具' : '展开工具'), mkSpan('dsh-tp-chev', ''));
        expandBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleGroupTools(key);
        });
        head.appendChild(expandBtn);
        group.appendChild(head);

        const intro = typeof zhPlugin === 'object' && zhPlugin ? zhPlugin.intro : null;
        if (intro) {
          const introEl = document.createElement('div');
          introEl.className = 'dsh-tp-intro';
          introEl.textContent = intro;
          introEl.title = intro;
          group.appendChild(introEl);
        }

        const chips = buildSayChips(typeof zhPlugin === 'object' && zhPlugin ? zhPlugin.say : null);
        if (chips) group.appendChild(chips);

        if (!expanded) return group;
        if (tools.length === 0) {
          const hint = document.createElement('div');
          hint.className = 'dsh-tp-toolhint';
          hint.textContent = state.query ? '这个插件没有匹配的工具' : '这个插件当前没有暴露工具';
          group.appendChild(hint);
          return group;
        }
        const toollist = document.createElement('div');
        toollist.className = 'dsh-tp-toollist';
        for (const tool of tools) toollist.appendChild(renderItem(tool));
        group.appendChild(toollist);
        return group;
      }

      function buildSkillsGroup(skills) {
        const group = document.createElement('div');
        group.className = 'dsh-tp-group dsh-tp-skillgroup';

        const head = document.createElement('div');
        head.className = 'dsh-tp-grouphead';
        head.appendChild(buildAvatar('skills', 268));

        const headText = document.createElement('div');
        headText.className = 'dsh-tp-gheadtext';
        const nameLine = document.createElement('div');
        nameLine.className = 'dsh-tp-gnameline';
        const name = document.createElement('div');
        name.className = 'dsh-tp-gname';
        name.textContent = '技能（Skills）';
        nameLine.appendChild(name);
        headText.appendChild(nameLine);

        const sub = document.createElement('div');
        sub.className = 'dsh-tp-gsub';
        sub.appendChild(mkSpan('dsh-tp-zhname', '来自技能注册表'));
        sub.appendChild(mkSpan('dsh-tp-dot', '·'));
        sub.appendChild(mkSpan('', skills.length + ' 个技能'));
        headText.appendChild(sub);
        head.appendChild(headText);
        group.appendChild(head);

        const intro = document.createElement('div');
        intro.className = 'dsh-tp-intro';
        intro.textContent = 'skill 不注册成工具：技能注册表把 name + description 渲染进上下文里的 <available_skills> 目录，模型要正文时才调用 skill 工具加载。下面是模型看到的那段触发词。';
        group.appendChild(intro);

        for (const skill of skills) group.appendChild(buildSkillItem(skill));
        return group;
      }

      function buildSkillItem(skill) {
        const item = document.createElement('div');
        item.className = 'dsh-tp-skill';

        const head = document.createElement('div');
        head.className = 'dsh-tp-itemhead';
        head.appendChild(buildAvatar(skill.name, 268));

        const name = document.createElement('div');
        name.className = 'dsh-tp-name';
        name.textContent = skill.name;
        name.title = skill.name;
        head.appendChild(name);

        const zhSkill = state.dict?.skills?.[skill.name];
        const zhName = typeof zhSkill === 'string' ? zhSkill : zhSkill?.name;
        if (zhName) head.appendChild(mkSpan('dsh-tp-zhplugin dsh-tp-zhname', zhName));

        const invocation = skill.invocation ?? {};
        if (invocation.modelInvocable === false) {
          const badge = mkSpan('dsh-tp-badge', '仅手动');
          badge.title = '模型不会自动挑它，只能用 /名字 手动调用';
          head.appendChild(badge);
        }
        if (invocation.userInvocable === false) {
          const badge = mkSpan('dsh-tp-badge', '仅模型');
          badge.title = '不能手动调用，只能由模型按描述自动挑';
          head.appendChild(badge);
        }
        item.appendChild(head);

        const desc = document.createElement('div');
        desc.className = 'dsh-tp-zh';
        desc.textContent = typeof skill.description === 'string' ? skill.description : '';
        item.appendChild(desc);

        const chips = buildSayChips(typeof zhSkill === 'object' && zhSkill ? zhSkill.say : null);
        if (chips) item.appendChild(chips);

        if (typeof skill.whenToUse === 'string' && skill.whenToUse.trim()) {
          const when = document.createElement('div');
          when.className = 'dsh-tp-when';
          const label = document.createElement('b');
          label.textContent = '何时用：';
          when.append(label, document.createTextNode(skill.whenToUse.trim()));
          item.appendChild(when);
        }

        const metaParts = [];
        if (skill.source) metaParts.push(String(skill.source));
        if (skill.path) metaParts.push(String(skill.path));
        if (metaParts.length) {
          const meta = document.createElement('div');
          meta.className = 'dsh-tp-meta';
          meta.textContent = metaParts.join(' · ');
          meta.title = metaParts.join(String.fromCharCode(10));
          item.appendChild(meta);
        }
        return item;
      }

      function renderItem(tool) {
        const item = document.createElement('div');
        item.className = 'dsh-tp-item';

        const head = document.createElement('div');
        head.className = 'dsh-tp-itemhead';
        const name = document.createElement('div');
        name.className = 'dsh-tp-name';
        name.textContent = tool.name;
        head.appendChild(name);
        item.appendChild(head);

        const entry = state.dict?.tools?.[tool.name];
        const zh = typeof entry === 'string' ? entry : entry?.zh ?? null;
        if (zh) {
          const zhEl = document.createElement('div');
          zhEl.className = 'dsh-tp-zh';
          zhEl.textContent = zh;
          item.appendChild(zhEl);
        }
        return item;
      }


      function sync() {
        const doc = document.body;
        if (!doc) return;
        ensureButton();
        const container = tabsContainer();
        if (!container) {
          btn.style.display = 'none';
          return;
        }
        btn.style.display = '';
        if (btn.parentElement !== container) {
          container.appendChild(btn);
          if (state.open) schedulePosition();
        }
        alignButtonToTabs(container);
        applyBtnOffset();
        if (state.open) schedulePosition();
      }

      function startObservers() {
        injectStyles(document);
        ensureButton();
        ensurePanel();
        try {
          state.pinned = localStorage.getItem(LS_PIN) === '1';
          state.showAll = localStorage.getItem(LS_ALL) === '1';
          state.sections = normalizeSections(localStorage.getItem(LS_SECTIONS));
          const rawTheme = localStorage.getItem(LS_THEME);
          if (rawTheme) {
            const parsedTheme = JSON.parse(rawTheme);
            if (parsedTheme && typeof parsedTheme.bg === 'string' && Number.isFinite(parsedTheme.alpha)) {
              state.theme = parsedTheme;
            }
          }
          const rawBtnPos = localStorage.getItem(LS_BTN);
          if (rawBtnPos) {
            const parsedBtn = JSON.parse(rawBtnPos);
            if (parsedBtn && Number.isFinite(parsedBtn.dx) && Number.isFinite(parsedBtn.dy)) {
              state.btnOffset = { dx: parsedBtn.dx, dy: parsedBtn.dy };
            }
          }
          const rawPos = localStorage.getItem(LS_POS);
          if (rawPos) {
            const parsed = JSON.parse(rawPos);
            if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) state.pos = parsed;
          }
        } catch {
          state.pinned = false;
          state.showAll = false;
          state.sections = ['plugins', 'skills'];
          state.pos = null;
          state.theme = null;
          state.btnOffset = null;
        }
        applyPinnedUI();
        applyScopeUI();
        applySectionsUI();
        applyTheme();

        document.addEventListener('pointerdown', onOutsidePointer, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', schedulePosition);
        window.addEventListener('scroll', schedulePosition, true);

        try {
          observer = new MutationObserver(() => sync());
          observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch {
          observer = null;
        }
        timer = window.setInterval(sync, 2000);
        sync();
      }

      function dispose() {
        state.alive = false;
        observer?.disconnect();
        if (timer) window.clearInterval(timer);
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', schedulePosition);
        window.removeEventListener('scroll', schedulePosition, true);
        panel?.remove();
        btn?.remove();
        panel = null;
        btn = null;
      }

      const plugin = {
        name: ID,
        inject: [],
        apply(ctx) {
          if (state.mounted) {
            state.alive = true;
            return;
          }
          state.mounted = true;
          const run = () => {
            try {
              startObservers();
            } catch (error) {
              console.warn('[dsh-trigger-prompts] mount failed:', error);
            }
          };
          if (document.body) run();
          else document.addEventListener('DOMContentLoaded', run, { once: true });
          ctx?.effect?.(() => () => {
            try {
              dispose();
            } catch {
              /* 忽略 */
            }
          }, 'dsh-trigger-prompts: client mount');
        },
        dispose,
      };

      window.__dshTriggerPrompts = { alive: true, plugin };
      return plugin;
    },
  });
})();
