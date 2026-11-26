/**
 * 无浏览器渲染仿真：用最小 DOM 桩跑一遍客户端，验证
 *   1. 插件分组默认不列工具，只有「展开工具」按钮
 *   2. 点「展开工具」才把工具列出来
 *   3. 搜索栏下两个筛选按钮：插件 / 技能，至少保留一个，重新打开的排到最后
 *   4. 技能条目带「触发说法」
 *   node tests/render-sim.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------------- 最小 DOM ---------------- */
class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.placeholder = '';
    this.disabled = false;
    this.hidden = false;
    this._attrs = {};
    this._listeners = new Map();
    this.style = {
      cssText: '',
      setProperty() {},
      removeProperty() {},
      getPropertyValue: () => '',
    };
  }
  get id() { return this._attrs.id ?? ''; }
  set id(value) { this._attrs.id = String(value); }
  get classList() {
    const self = this;
    const read = () => (self.className || '').split(/\s+/).filter(Boolean);
    const write = (list) => { self.className = list.join(' '); };
    return {
      contains: (name) => read().includes(name),
      add: (...names) => write([...new Set([...read(), ...names])]),
      remove: (...names) => write(read().filter((n) => !names.includes(n))),
      toggle: (name, force) => {
        const has = read().includes(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next && !has) write([...read(), name]);
        if (!next && has) write(read().filter((n) => n !== name));
        return next;
      },
    };
  }
  get textContent() {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    const text = String(value ?? '');
    if (text.length) this.appendChild(new TextNode(text));
  }
  get dataset() {
    const attrs = this._attrs;
    return new Proxy({}, {
      get: (_t, key) => attrs['data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())],
      set: (_t, key, value) => {
        attrs['data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())] = String(value);
        return true;
      },
    });
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) {
    const child = typeof node === 'string' ? new TextNode(node) : node;
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  prepend(...nodes) {
    const list = nodes.map((node) => (typeof node === 'string' ? new TextNode(node) : node));
    for (const child of list) { child.parentNode = this; }
    this.children.unshift(...list);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child) child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this._attrs[String(name)] = String(value); }
  getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; }
  removeAttribute(name) { delete this._attrs[name]; }
  hasAttribute(name) { return name in this._attrs; }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) ?? [];
    this._listeners.set(type, list.filter((fn) => fn !== handler));
  }
  /** 模拟一次带冒泡的事件派发 */
  dispatch(type, extra) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      stopped: false,
      defaultPrevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; },
      ...extra,
    };
    let node = this;
    while (node) {
      const handlers = node._listeners?.get(type) ?? [];
      for (const handler of handlers) handler.call(node, event);
      if (event.stopped) break;
      node = node.parentNode;
    }
    return event;
  }
  setRect(rect) {
    this._rect = { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, width: rect.width, height: rect.height };
  }
  getBoundingClientRect() {
    if (this._rect) return this._rect;
    return { left: 0, top: 0, right: 420, bottom: 24, width: 420, height: 24 };
  }
  get offsetWidth() { return 420; }
  get offsetHeight() { return 24; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  matches() { return false; }
  focus() {}
  blur() {}
  click() { this.dispatch('click'); }
}

const styleFor = (el) => ({
  fontSize: '13px',
  fontWeight: '500',
  paddingLeft: '8px',
  paddingRight: '8px',
  lineHeight: '20px',
  columnGap: '6px',
  gap: '6px',
  ...(el && el._computed ? el._computed : {}),
});

const html = new El('html');
const head = new El('head');
const body = new El('body');
const tabs = new El('div');
tabs.setAttribute('data-conversation-tabs', '');
tabs.className = 'conversation-tabs';
const nativeTab = new El('button');
nativeTab.setAttribute('role', 'tab');
nativeTab.className = 'dsh-tp-native-tab';
nativeTab.textContent = '对话';
nativeTab.setRect({ left: 600, top: 100, width: 48, height: 30 });
tabs.appendChild(nativeTab);
tabs.setRect({ left: 600, top: 100, width: 600, height: 30 });
body.appendChild(tabs);

const documentStub = {
  body,
  head,
  documentElement: html,
  createElement: (tag) => new El(tag),
  createTextNode: (text) => new TextNode(text),
  querySelector: (selector) => (String(selector).includes('data-conversation-tabs') ? tabs : null),
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, handler) => documentStub._listeners.push([type, handler]),
  removeEventListener: () => {},
  _listeners: [],
};

const payload = {
  ok: true,
  generatedAt: '2026-11-22T00:00:00.000Z',
  profile: 'desktop',
  tools: [
    { name: 'agent_teams_create', description: 'Create a team', parameters: { type: 'object' }, plugin: '@nanmicoder/dsh-agent-teams' },
    { name: 'agent_teams_approve', description: 'Approve the plan', parameters: { type: 'object' }, plugin: '@nanmicoder/dsh-agent-teams' },
    { name: 'vision_describe', description: 'Describe an image', parameters: { type: 'object' }, plugin: 'dsh-vision-router' },
    { name: 'read_text_file', description: 'Read a file', parameters: { type: 'object' }, plugin: null },
  ],
  plugins: [
    { id: '@nanmicoder/dsh-agent-teams', version: '0.9.0', description: 'Agent teams', count: 2 },
    { id: 'dsh-vision-router', version: '3.1.1', description: 'Vision', count: 1 },
  ],
  skills: [
    {
      name: 'impeccable',
      description: 'Use when the user wants to design, redesign, critique or audit a frontend interface.',
      whenToUse: '需要改界面的时候',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project',
      provider: 'filesystem',
      path: 'D:\\skills\\impeccable\\SKILL.md',
    },
    {
      name: 'design-taste-frontend',
      description: 'Anti-slop frontend skill for company websites.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'project',
      provider: 'filesystem',
      path: 'D:\\skills\\design-taste-frontend\\SKILL.md',
    },
  ],
  skillsComplete: true,
  warnings: [],
};

const dict = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'zh-cn.json'), 'utf8'));

const store = new Map();
const windowStub = {
  __ModuleLoader__: {
    load: ({ factory }) => { windowStub.__factory = factory; },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: () => {},
  getComputedStyle: styleFor,
  devicePixelRatio: 1,
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  },
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node' },
  fetch: async (url) => {
    const body = String(url).includes('/zh-cn.json') ? dict : payload;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  },
  MutationObserver: class { observe() {} disconnect() {} },
  console,
};

for (const [key, value] of Object.entries({
  document: documentStub,
  window: windowStub,
  navigator: windowStub.navigator,
  localStorage: windowStub.localStorage,
  fetch: windowStub.fetch,
  MutationObserver: windowStub.MutationObserver,
  requestAnimationFrame: windowStub.requestAnimationFrame,
  cancelAnimationFrame: windowStub.cancelAnimationFrame,
  getComputedStyle: windowStub.getComputedStyle,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
documentStub.defaultView = windowStub;
windowStub.document = documentStub;

/* ---------------- 载入客户端 ---------------- */
const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
await import(pathToFileURL(clientPath).href);
const plugin = windowStub.__factory();
plugin.apply({ effect: (factory) => factory() });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(60);

/* ---------------- 断言 ---------------- */
function walk(node, out = []) {
  for (const child of node.children ?? []) {
    if (child.nodeType === 1) { out.push(child); walk(child, out); }
  }
  return out;
}
function byClass(name) {
  return walk(body).filter((el) => (el.className || '').split(/\s+/).includes(name));
}
function listText() {
  const list = byClass('dsh-tp-body')[0];
  assert.ok(list, '列表容器应存在');
  return list;
}
function order(list) {
  return list.children.map((child) => child.textContent.replace(/\s+/g, ' '));
}

const btn = byClass('dsh-tp-btn')[0];
assert.ok(btn, '顶部按钮应存在');
btn.dispatch('click');
await sleep(80);

const panel = byClass('dsh-tp-panel')[0];
assert.ok(panel, '面板应打开');

const list = listText();
assert.ok(list.textContent.includes('智能体团队'), '插件中文名应出现');
assert.ok(!list.textContent.includes('agent_teams_create'), '默认不应列出工具项');
assert.ok(!list.textContent.includes('vision_describe'), '默认不应列出工具项');
assert.ok(list.textContent.includes('展开工具'), '每个插件应带展开工具按钮');
assert.ok(list.textContent.includes('组个团队把这件事分成几块同时做'), '插件触发说法应出现');

const expandBtns = byClass('dsh-tp-expand');
assert.equal(expandBtns.length, 2, '两个插件各一个展开按钮');
expandBtns[0].dispatch('click');
await sleep(60);
assert.ok(listText().textContent.includes('agent_teams_create'), '展开后应列出工具');
assert.ok(!listText().textContent.includes('vision_describe'), '只展开第一个插件');
const collapse = byClass('dsh-tp-expand').find((el) => el.textContent.includes('收起工具'));
assert.ok(collapse, '已展开的按钮文案应变成收起工具');
collapse.dispatch('click');
await sleep(60);
assert.ok(!listText().textContent.includes('agent_teams_create'), '收起后工具应消失');

/* 技能节 */
assert.ok(listText().textContent.includes('impeccable'), '技能应列出');
assert.ok(listText().textContent.includes('帮我设计一版这个界面'), '技能触发说法应出现');
const order0 = order(list);
if (process.env.DEBUG_ORDER) console.log('order0:', JSON.stringify(order0));
const pluginsIdx = order0.findIndex((text) => text.includes('智能体团队'));
const skillsIdx = order0.findIndex((text) => text.includes('技能（Ski'));
assert.ok(pluginsIdx >= 0 && skillsIdx > pluginsIdx, '默认插件在上、技能在下');

/* 筛选按钮 */
const filters = byClass('dsh-tp-filter');
assert.equal(filters.length, 2, '搜索栏下应有两个筛选按钮');
const [pluginBtn, skillBtn] = filters;
assert.equal(pluginBtn.textContent, '插件');
assert.equal(skillBtn.textContent, '技能');
assert.equal(pluginBtn.getAttribute('aria-pressed'), 'true');
assert.equal(skillBtn.getAttribute('aria-pressed'), 'true');

skillBtn.dispatch('click');
await sleep(60);
assert.equal(skillBtn.getAttribute('aria-pressed'), 'false', '技能应被隐藏');
assert.ok(!listText().textContent.includes('impeccable'), '隐藏后技能应消失');
assert.equal(pluginBtn.getAttribute('aria-disabled'), 'true', '只剩一节时不能再隐藏');

pluginBtn.dispatch('click');
await sleep(60);
assert.equal(pluginBtn.getAttribute('aria-pressed'), 'true', '至少保留一节：点不动');

skillBtn.dispatch('click');
await sleep(60);
assert.equal(skillBtn.getAttribute('aria-pressed'), 'true', '技能重新显示');
assert.ok(listText().textContent.includes('impeccable'));
const order2 = order(list);
const pluginsIdx2 = order2.findIndex((text) => text.includes('智能体团队'));
const skillsIdx2 = order2.findIndex((text) => text.includes('技能（Ski'));
assert.ok(pluginsIdx2 >= 0 && skillsIdx2 > pluginsIdx2, '重新显示时排在插件下方');

/* 反向：先关插件，再打开 → 插件排到技能下方 */
pluginBtn.dispatch('click');
await sleep(60);
assert.ok(!listText().textContent.includes('智能体团队'), '插件应被隐藏');
assert.ok(listText().textContent.includes('impeccable'), '技能仍在');
assert.equal(order(list).filter((text) => text.includes('智能体团队')).length, 0);
pluginBtn.dispatch('click');
await sleep(60);
const order4 = order(list);
const skillsIdx4 = order4.findIndex((text) => text.includes('技能（Ski'));
const pluginsIdx4 = order4.findIndex((text) => text.includes('智能体团队'));
assert.ok(skillsIdx4 >= 0 && pluginsIdx4 > skillsIdx4, '插件重新显示时排在技能下方');

/* 搜索仍可用 */
const search = byClass('dsh-tp-search')[0];
assert.ok(search, '搜索框应存在');
search.value = 'vision';
search.dispatch('input', { target: search });
await sleep(120);
assert.ok(listText().textContent.includes('视觉理解'), '搜索后只剩匹配插件');
assert.ok(!listText().textContent.includes('智能体团队'), '不匹配的插件应被过滤');

search.value = '';
search.dispatch('input', { target: search });
await sleep(120);

/* ── 分类盒子 ── */
const inside = (root, name) => walk(root).filter((el) => (el.className || '').split(/\s+/).includes(name));
const catsBox = byClass('dsh-tp-cats')[0];
assert.ok(catsBox, '分类盒子应存在');
assert.equal(catsBox.hasAttribute('hidden'), false, '有数据时分类盒应显示');

const catCells = () => inside(catsBox, 'dsh-tp-cat').filter((el) => !el.classList.contains('dsh-tp-catadd'));
const cellName = (el) => inside(el, 'dsh-tp-catname')[0]?.textContent ?? '';
const cellCount = (el) => inside(el, 'dsh-tp-catcount')[0]?.textContent ?? '';

/* 两组同时亮着 → 两端各一个「默认」格，名字前带 (插件) / (skill) */
assert.equal(catCells().length, 2, '两节各一个默认格，实际：' + catCells().map(cellName).join('|'));
assert.equal(cellName(catCells()[0]), '(插件) 默认', '插件格名前缀');
assert.equal(cellName(catCells()[1]), '(skill) 默认', '技能格名前缀');
assert.equal(cellCount(catCells()[0]), '2', '两个插件都默认归到「默认」');
assert.equal(cellCount(catCells()[1]), '2', '两个技能都默认归到「默认」');
assert.equal(inside(catsBox, 'dsh-tp-catadd').length, 2, '每节一个「新建分类」按钮');

/* 新建插件分类 */
inside(catsBox, 'dsh-tp-catadd')[0].dispatch('click');
await sleep(40);
const draftInput = inside(catsBox, 'dsh-tp-catinput')[0];
assert.ok(draftInput, '点新建后应出现命名输入框');
draftInput.value = '工作';
draftInput.dispatch('input', { target: draftInput });
draftInput.dispatch('keydown', { key: 'Enter', target: draftInput });
await sleep(40);

let names = catCells().map(cellName);
assert.ok(names.includes('(插件) 工作'), '插件侧应多出「工作」格：' + names.join('|'));
assert.ok(!names.includes('(skill) 工作'), '插件分类不能出现在技能侧');
assert.deepEqual(JSON.parse(windowStub.localStorage.getItem('dsh-trigger-prompts:cats')).plugins.order, ['工作'], '分类应落盘');

/* 给插件选分类：卡片上的芯片 → 卡片内展开选择行 */
const pluginCardOf = () => byClass('dsh-tp-group').find((el) => el.textContent.includes('智能体团队'));
assert.ok(pluginCardOf(), '应能找到插件卡');
const chip = inside(pluginCardOf(), 'dsh-tp-catchip')[0];
assert.ok(chip, '插件卡上应有分类芯片');
assert.equal(chip.textContent, '默认', '没有分类时芯片显示「默认」');
chip.dispatch('click');
await sleep(40);
const picker = inside(pluginCardOf(), 'dsh-tp-catpicker')[0];
assert.ok(picker, '点芯片应在卡片里展开分类选择行');
const workOpt = inside(picker, 'dsh-tp-catopt').find((el) => el.textContent === '工作');
assert.ok(workOpt, '选择行里应有刚建的「工作」');
workOpt.dispatch('click');
await sleep(40);
assert.equal(inside(pluginCardOf(), 'dsh-tp-catchip')[0].textContent, '工作', '选完后芯片应显示新分类');
assert.equal(byClass('dsh-tp-catpicker').length, 0, '选完应收起选择行');
names = catCells().map((el) => cellName(el) + ':' + cellCount(el));
assert.ok(names.includes('(插件) 工作:1'), '工作格计数应为 1：' + names.join('|'));
assert.ok(names.includes('(插件) 默认:1'), '默认格应剩 1 个：' + names.join('|'));

/* 点分类格 = 只看这一类 */
catCells().find((el) => cellName(el) === '(插件) 工作').dispatch('click');
await sleep(40);
assert.ok(catCells().find((el) => cellName(el) === '(插件) 工作').classList.contains('is-active'), '选中的格子应高亮');
assert.ok(listText().textContent.includes('智能体团队'), '工作分类里的插件应留下');
assert.ok(!listText().textContent.includes('视觉理解'), '其它插件应被筛掉');
assert.ok(listText().textContent.includes('impeccable'), '技能不受插件分类筛选影响');

/* 再点一次取消筛选 */
catCells().find((el) => cellName(el) === '(插件) 工作').dispatch('click');
await sleep(40);
assert.ok(listText().textContent.includes('视觉理解'), '再点一次应取消筛选');

/* 技能分类独立 */
inside(catsBox, 'dsh-tp-catadd')[1].dispatch('click');
await sleep(40);
const skillDraft = inside(catsBox, 'dsh-tp-catinput')[0];
assert.ok(skillDraft, '技能侧也应能新建');
skillDraft.value = '研究';
skillDraft.dispatch('keydown', { key: 'Enter', target: skillDraft });
await sleep(40);
names = catCells().map(cellName);
assert.ok(names.includes('(skill) 研究'), '技能侧应多出「研究」格：' + names.join('|'));
assert.ok(!names.includes('(插件) 研究'), '技能分类不能跑到插件侧');

/* 只剩一节亮着 → 不加前缀 */
pluginBtn.dispatch('click');
await sleep(40);
const soloNames = catCells().map(cellName);
assert.ok(soloNames.every((name) => !name.startsWith('(')), '只剩一节时不加前缀：' + soloNames.join('|'));
assert.ok(soloNames.includes('默认') && soloNames.includes('研究'), '只剩技能格：' + soloNames.join('|'));
pluginBtn.dispatch('click');
await sleep(40);
assert.equal(catCells().length, 4, '插件回来后共 4 个格子（插件 默认/工作 + 技能 默认/研究）：' + catCells().map(cellName).join('|'));

/* ── 页签对齐 ── */
assert.equal(btn.style.height, '30px', '按钮高度应跟原生页签一致');
assert.equal(btn.style.marginLeft, '6px', '按钮间距应跟页签行 gap 一致');
assert.equal(btn.style.fontSize, '13px', '按钮字号应跟页签一致');

/* ── 长按拖动：只在页签行内 ── */
const ls = windowStub.localStorage;
ls.removeItem('dsh-trigger-prompts:btnpos');
btn.setRect({ left: 1000, top: 100, width: 90, height: 30 });
btn.dispatch('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 1050, clientY: 115 });
await sleep(320);
btn.dispatch('pointermove', { pointerId: 1, clientX: 850, clientY: 215 });
await sleep(20);
const dragged = btn.style.transform || '';
assert.match(dragged, /translate\(-200px, -?\d+px\)/, '横向位移应生效：' + dragged);
const dy = Number((/translate\(-?[\d.]+px, (-?[\d.]+)px\)/.exec(dragged) ?? [])[1]);
assert.ok(Number.isFinite(dy) && dy >= -1 && dy <= 100, '纵向位移必须被夹住：' + dy);
assert.ok(Math.abs(dy) <= 3, '往下拖 100px 也只能挪到页签行内（不允许进对话区）：' + dy);
assert.ok(btn.classList.contains('moved'), '移动后应带 moved 标记');
btn.dispatch('pointerup', { pointerId: 1 });
await sleep(20);
assert.ok(ls.getItem('dsh-trigger-prompts:btnpos'), '位移应记进 localStorage');
btn.dispatch('click');
await sleep(40);
assert.equal(byClass('dsh-tp-panel').length, 1, '拖动结束后那次 click 不应关掉面板');
assert.ok(panel, '面板仍在');

/* ── 右键复位 ── */
const ctx = btn.dispatch('contextmenu');
assert.equal(btn.style.transform, '', '右键后应回到原位');
assert.equal(ls.getItem('dsh-trigger-prompts:btnpos'), null, '复位应清掉 localStorage');
assert.ok(!btn.classList.contains('moved'), '复位后不该有 moved 标记');
assert.ok(ctx.defaultPrevented, '右键复位时应阻止系统菜单');

/* ── 再点一次仍能正常开合 ── */
btn.dispatch('click');
await sleep(40);
assert.equal(panel.style.display, 'none', '复位后普通点击应能关闭面板');
btn.dispatch('click');
await sleep(40);
assert.equal(panel.style.display, 'flex', '再点应重新打开');

console.log('render-sim ok');
console.log('--- 面板文本（前 900 字）---');
console.log(panel.textContent.replace(/\s+/g, ' ').slice(0, 900));
console.log('--- 顶层区块顺序 ---');
console.log(order(listText()).map((text, index) => index + ': ' + text.slice(0, 40)).join('\n'));
