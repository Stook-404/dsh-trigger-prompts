/**
 * dsh-trigger-prompts — 客户端
 *
 * 在「对话 / 轨迹 / 画廊」页签行右侧加一个「触发词」按钮，点开是下拉面板：
 *   - 按插件分组列出每个工具的名字与描述（= 模型看到的触发提示词）
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
        fetchedAt: 0,
        query: '',
      };

      let btn = null;
      let panel = null;
      let listEl = null;
      let countEl = null;
      let searchEl = null;
      let pinBtn = null;
      let refreshBtn = null;
      let positionRaf = 0;
      let observer = null;
      let timer = 0;

      const css = `
        .dsh-tp-btn {
          margin-left: 10px; padding: 3px 10px; border-radius: 999px;
          border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
          background: transparent; color: inherit; font: inherit; font-size: 12px;
          line-height: 18px; cursor: pointer; display: inline-flex; align-items: center;
          gap: 4px; opacity: .78; transition: opacity .15s, background .15s;
          white-space: nowrap; flex: none;
        }
        .dsh-tp-btn:hover { opacity: 1; background: color-mix(in srgb, CanvasText 8%, transparent); }
        .dsh-tp-btn[aria-expanded="true"] { opacity: 1; border-color: color-mix(in srgb, CanvasText 40%, transparent); }
        .dsh-tp-caret { font-size: 9px; opacity: .7; }

        .dsh-tp-panel {
          position: fixed; z-index: 2147483000; width: min(420px, calc(100vw - 24px));
          max-height: min(72vh, 580px); display: flex; flex-direction: column;
          background: Canvas; color: CanvasText; border-radius: 12px;
          border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
          box-shadow: 0 18px 48px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.2);
          font-size: 13px; overflow: hidden;
        }
        .dsh-tp-head {
          display: flex; align-items: center; gap: 8px; padding: 10px 12px;
          border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
        }
        .dsh-tp-title { font-weight: 600; font-size: 13px; }
        .dsh-tp-count { font-size: 11px; opacity: .6; }
        .dsh-tp-spacer { flex: 1 1 auto; }
        .dsh-tp-iconbtn {
          border: 1px solid transparent; background: transparent; color: inherit;
          width: 24px; height: 24px; border-radius: 6px; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 13px; opacity: .65; padding: 0;
        }
        .dsh-tp-iconbtn:hover { opacity: 1; background: color-mix(in srgb, CanvasText 10%, transparent); }
        .dsh-tp-iconbtn[aria-pressed="true"] {
          opacity: 1; background: color-mix(in srgb, CanvasText 16%, transparent);
          border-color: color-mix(in srgb, CanvasText 30%, transparent);
        }
        .dsh-tp-search {
          margin: 8px 12px 0; padding: 5px 8px; font: inherit; font-size: 12px;
          border-radius: 6px; color: inherit; background: color-mix(in srgb, CanvasText 6%, transparent);
          border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
          outline: none;
        }
        .dsh-tp-search:focus { border-color: color-mix(in srgb, CanvasText 34%, transparent); }
        .dsh-tp-body { overflow: auto; padding: 8px 8px 12px; }
        .dsh-tp-group { margin-top: 8px; }
        .dsh-tp-group:first-child { margin-top: 2px; }
        .dsh-tp-grouphead {
          display: flex; align-items: baseline; gap: 6px; padding: 4px 4px 6px;
          font-size: 11px; text-transform: none; opacity: .72;
        }
        .dsh-tp-grouphead.clickable { cursor: pointer; user-select: none; }
        .dsh-tp-grouphead.clickable:hover { opacity: 1; }
        .dsh-tp-grouphead b { font-size: 12px; font-weight: 600; opacity: .95; }
        .dsh-tp-grouphead span { opacity: .8; }
        .dsh-tp-grouphead .dsh-tp-caret2 { font-size: 9px; opacity: .7; }
        .dsh-tp-group.collapsed .dsh-tp-item { display: none; }
        .dsh-tp-item {
          border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
          border-radius: 8px; padding: 8px 10px; margin: 0 0 6px;
          background: color-mix(in srgb, CanvasText 4%, transparent);
        }
        .dsh-tp-itemhead { display: flex; align-items: center; gap: 6px; }
        .dsh-tp-name {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px; font-weight: 600; word-break: break-all;
        }
        .dsh-tp-zh {
          margin-top: 6px; font-size: 12.5px; line-height: 1.6; opacity: .95;
          white-space: pre-wrap; word-break: break-word;
        }
        .dsh-tp-zhplugin { font-size: 11px; opacity: .9; font-weight: 500; }
        .dsh-tp-intro {
          margin: 2px 2px 8px; font-size: 12px; line-height: 1.6; opacity: .72;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
          overflow: hidden; white-space: pre-wrap; word-break: break-word;
        }
        .dsh-tp-grip {
          width: 16px; height: 22px; flex: none; margin-left: -4px;
          display: inline-flex; align-items: center; justify-content: center;
          cursor: grab; opacity: .4; font-size: 12px; letter-spacing: -2px;
          user-select: none; touch-action: none; border-radius: 4px;
        }
        .dsh-tp-grip:hover { opacity: .85; background: color-mix(in srgb, CanvasText 10%, transparent); }
        .dsh-tp-panel.dragging, .dsh-tp-panel.dragging .dsh-tp-grip { cursor: grabbing; }
        .dsh-tp-panel.dragging { user-select: none; }
        .dsh-tp-empty { padding: 18px 10px; text-align: center; opacity: .6; font-size: 12px; }
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
        btn.title = '各插件的触发提示词（工具描述）';
        const label = document.createElement('span');
        label.textContent = '触发词';
        const caret = document.createElement('span');
        caret.className = 'dsh-tp-caret';
        caret.textContent = '▾';
        btn.append(label, caret);
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          toggle();
        });
        return btn;
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
        const spacer = document.createElement('div');
        spacer.className = 'dsh-tp-spacer';

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

        pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'dsh-tp-iconbtn';
        pinBtn.title = '置顶：保持打开，与其它界面交互也不关闭';
        pinBtn.setAttribute('aria-label', '置顶');
        pinBtn.setAttribute('aria-pressed', 'false');
        pinBtn.textContent = '📌';
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

        head.append(grip, title, countEl, spacer, pinBtn, refreshBtn, closeBtn);

        searchEl = document.createElement('input');
        searchEl.className = 'dsh-tp-search';
        searchEl.type = 'search';
        searchEl.placeholder = '搜索插件 / 工具 / 关键字';
        searchEl.addEventListener('input', () => {
          state.query = searchEl.value.trim();
          renderList();
        });
        searchEl.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') close();
        });

        listEl = document.createElement('div');
        listEl.className = 'dsh-tp-body';

        panel.append(head, searchEl, listEl);
        panel.addEventListener('pointerdown', (event) => event.stopPropagation());
        document.body.appendChild(panel);
        applyPinnedUI();
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
        if (event.key === 'Escape' && state.open) {
          event.stopPropagation();
          close();
        }
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
        const haystack = `${tool.name}\n${tool.description}\n${tool.plugin ?? ''}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
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

      function renderList() {
        if (!listEl) return;
        const payload = state.payload;
        if (countEl) {
          countEl.textContent = payload
            ? `共 ${payload.tools.length} 个工具 · ${payload.plugins.filter((p) => p.count > 0).length} 个插件`
            : '';
        }
        listEl.replaceChildren();

        if (state.loading && !payload) {
          const empty = document.createElement('div');
          empty.className = 'dsh-tp-empty';
          empty.textContent = '正在读取工具注册表…';
          listEl.appendChild(empty);
          return;
        }
        if (state.error && !payload) {
          const empty = document.createElement('div');
          empty.className = 'dsh-tp-empty';
          empty.textContent = `读取失败：${state.error}（宿主插件可能还没加载，重启 DSH 后再试）`;
          listEl.appendChild(empty);
          return;
        }
        if (!payload) return;

        const pluginsById = new Map(payload.plugins.map((plugin) => [plugin.id, plugin]));
        const query = state.query;
        const visible = payload.tools.filter((tool) => matches(tool, query));
        if (visible.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dsh-tp-empty';
          empty.textContent = query ? '没有匹配的工具' : '运行时注册表暂时没有返回工具描述';
          listEl.appendChild(empty);
          return;
        }

        const groups = new Map();
        for (const tool of visible) {
          const key = tool.plugin ?? (tool.name.startsWith('mcp__') ? '__mcp__' : '');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(tool);
        }
        const rank = (key) => (key === '' ? 2 : key === '__mcp__' ? 1 : 0);
        const order = [...groups.keys()].sort((a, b) => {
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          return a.localeCompare(b);
        });

        for (const key of order) {
          const tools = groups.get(key);
          const group = document.createElement('div');
          group.className = 'dsh-tp-group';

          const head = document.createElement('div');
          head.className = 'dsh-tp-grouphead';
          const strong = document.createElement('b');
          strong.textContent = groupLabel(key, pluginsById);
          const span = document.createElement('span');
          span.textContent = `${tools.length} 个工具`;
          const zhPlugin = state.dict?.plugins?.[key];
          const pluginName = typeof zhPlugin === 'string' ? zhPlugin : zhPlugin?.name;
          if (pluginName) {
            const zhSpan = document.createElement('span');
            zhSpan.className = 'dsh-tp-zhplugin';
            zhSpan.textContent = `· ${pluginName}`;
            head.append(strong, zhSpan, span);
          } else {
            head.append(strong, span);
          }

          // 内置 / MCP 这类大组默认折叠，避免几十上百条淹没插件工具
          const foldable = rank(key) > 0 && tools.length > 12 && !state.query;
          if (foldable) {
            group.classList.add('collapsed');
            head.classList.add('clickable');
            const caret2 = document.createElement('span');
            caret2.className = 'dsh-tp-caret2';
            caret2.textContent = '▸';
            head.prepend(caret2);
            head.addEventListener('click', () => {
              const collapsed = group.classList.toggle('collapsed');
              caret2.textContent = collapsed ? '▸' : '▾';
            });
          }
          group.appendChild(head);

          const intro = typeof zhPlugin === 'object' && zhPlugin ? zhPlugin.intro : null;
          if (intro) {
            const introEl = document.createElement('div');
            introEl.className = 'dsh-tp-intro';
            introEl.textContent = intro;
            introEl.title = intro;
            group.appendChild(introEl);
          }

          for (const tool of tools) {
            group.appendChild(renderItem(tool));
          }
          listEl.appendChild(group);
        }
      }

      function renderItem(tool) {
        const item = document.createElement('div');
        item.className = 'dsh-tp-item';

        const head = document.createElement('div');
        head.className = 'dsh-tp-itemhead';
        const name = document.createElement('div');
        name.className = 'dsh-tp-name';
        name.textContent = tool.name;

        head.append(name);

        const entry = state.dict?.tools?.[tool.name];
        const zh = typeof entry === 'string' ? entry : entry?.zh ?? null;
        if (zh) {
          const zhEl = document.createElement('div');
          zhEl.className = 'dsh-tp-zh';
          zhEl.textContent = zh;
          item.append(head, zhEl);
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
        if (state.open) schedulePosition();
      }

      function startObservers() {
        injectStyles(document);
        ensureButton();
        ensurePanel();
        try {
          state.pinned = localStorage.getItem(LS_PIN) === '1';
          const rawPos = localStorage.getItem(LS_POS);
          if (rawPos) {
            const parsed = JSON.parse(rawPos);
            if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) state.pos = parsed;
          }
        } catch {
          state.pinned = false;
          state.pos = null;
        }
        applyPinnedUI();

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
