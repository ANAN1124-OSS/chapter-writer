// 单测：菜单键盘可达（v0.9 A-5c）。
//
// 这一项补的是「右键菜单 / 顶栏下拉 / 分卷标题行」这三块以前只有鼠标才拿得到的通道。
// 产品侧只有一个浏览器模块 `renderer/menu-keyboard.js`（纯决策 + 菜单事件接线），渲染层只接线；
// 分卷标题行的键盘通道在 `renderer/list-keyboard.js`（见本文件最后几条 + list-keyboard.test.js）。
// 所以这里测三半：
//   · 纯决策：方向键怎么绕、Esc / Tab 什么算收起、关闭时该不该归还焦点、条目可不可用；
//   · 接线（假 DOM）：打开把焦点带进第一条可用条目、方向键真的移焦点、Esc 收起并还给打开者、
//     焦点已跑到别处时不抢、顶栏下拉的整理卡 Esc 不被 focusin 又弹开；
//   · 静态闸门：加载顺序 / 只引一次、渲染层走模块接线、模块不碰文件 / Electron / 定时器、
//     菜单 id 与 index.html 一一对上。
// 真实 Electron 里的行为（真实 Shift+F10 / Tab / 方向键 / Esc）由 E2E 第 71 组断言。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const menuKeyboard = require(path.join(ROOT, 'renderer', 'menu-keyboard.js'));
const listKeyboard = require(path.join(ROOT, 'renderer', 'list-keyboard.js'));
const INDEX = read('renderer/index.html');
const RENDERER = read('renderer/renderer.js');

const key = (name, extra) => ({ key: name, preventDefault() {}, stopPropagation() {}, ...(extra || {}) });

// ---------- 纯决策 ----------

test('菜单键盘：方向键在菜单里上下绕回，Home / End 到两头', () => {
  assert.equal(menuKeyboard.stepIndex(0, 'ArrowDown', 3), 1);
  assert.equal(menuKeyboard.stepIndex(2, 'ArrowDown', 3), 0, '到底绕回第一条');
  assert.equal(menuKeyboard.stepIndex(0, 'ArrowUp', 3), 2, '往上从第一条绕到最后一条');
  assert.equal(menuKeyboard.stepIndex(1, 'ArrowUp', 3), 0);
  assert.equal(menuKeyboard.stepIndex(1, 'Home', 3), 0);
  assert.equal(menuKeyboard.stepIndex(1, 'End', 3), 2);
  assert.equal(menuKeyboard.stepIndex(-1, 'ArrowDown', 3), 0, '没有当前条目时从头开始');
  assert.equal(menuKeyboard.stepIndex(99, 'ArrowDown', 3), 0, '越界下标当「没选中」，从第一条开始（不瞎跳到中间）');
  assert.equal(menuKeyboard.stepIndex(99, 'ArrowUp', 3), 2, '越界时往上就是最后一条');
  assert.equal(menuKeyboard.stepIndex(0, 'ArrowDown', 0), null, '空菜单没有可去的地方');
  assert.equal(menuKeyboard.stepIndex(0, 'PageDown', 3), null, '不认识的键不接管');
});

test('菜单键盘：Esc 一律收起；Tab 只在右键菜单里算收起（顶栏下拉保持原生 Tab）', () => {
  assert.deepEqual(menuKeyboard.menuKeyAction(key('Escape'), 'context', 0, 5), { type: 'close', reason: 'escape' });
  assert.deepEqual(menuKeyboard.menuKeyAction(key('Escape'), 'dropdown', 0, 5), { type: 'close', reason: 'escape' });
  assert.deepEqual(menuKeyboard.menuKeyAction(key('Tab'), 'context', 0, 5), { type: 'close', reason: 'tab' });
  assert.equal(menuKeyboard.menuKeyAction(key('Tab'), 'dropdown', 0, 5), null, '顶栏下拉的 Tab 交给浏览器');
  assert.deepEqual(menuKeyboard.menuKeyAction(key('ArrowDown'), 'context', 0, 3), { type: 'move', index: 1 });
  assert.deepEqual(menuKeyboard.menuKeyAction(key('ArrowUp'), 'dropdown', 0, 3), { type: 'move', index: 2 });
  assert.equal(menuKeyboard.menuKeyAction(key('ArrowDown', { ctrlKey: true }), 'context', 0, 3), null);
  assert.equal(menuKeyboard.menuKeyAction(key('ArrowDown', { shiftKey: true }), 'context', 0, 3), null, 'Shift 组合不抢');
  assert.equal(menuKeyboard.menuKeyAction(key('Enter'), 'context', 0, 3), null, 'Enter 交给按钮自己');
  assert.equal(menuKeyboard.menuKeyAction(null, 'context', 0, 3), null);
});

test('菜单键盘：关掉菜单时只有焦点「没归属」才归还（掉到 body / 还在菜单里 / 已不可见）', () => {
  assert.equal(menuKeyboard.shouldReturnFocus({ isBody: true }), true);
  assert.equal(menuKeyboard.shouldReturnFocus({ isBody: false, insideMenu: true }), true);
  assert.equal(menuKeyboard.shouldReturnFocus({ isBody: false, insideMenu: false, hidden: true }), true);
  assert.equal(menuKeyboard.shouldReturnFocus({ isBody: false, insideMenu: false, hidden: false }), false, '焦点在别处就不抢');
  assert.equal(menuKeyboard.shouldReturnFocus(null), true);
});

test('菜单键盘：菜单条目可用性——禁用 / aria-hidden / 负 tabindex / .hidden / 0 尺寸都不算', () => {
  const base = { disabled: false, ariaHidden: false, tabIndex: 0, hiddenClass: false, hasRects: true };
  assert.equal(menuKeyboard.isUsableItem(base), true);
  for (const broken of [
    { ...base, disabled: true },
    { ...base, ariaHidden: true },
    { ...base, tabIndex: -1 },
    { ...base, hiddenClass: true },
    { ...base, hasRects: false }
  ]) {
    assert.equal(menuKeyboard.isUsableItem(broken), false, JSON.stringify(broken));
  }
  assert.equal(menuKeyboard.isUsableItem(null), false);
});

// ---------- 假 DOM 接线 ----------

function makeClassList(hidden) {
  const set = new Set(hidden ? ['hidden'] : []);
  return {
    contains: (name) => set.has(name),
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    toggle: (name, on) => {
      if (on === undefined ? !set.has(name) : on) set.add(name);
      else set.delete(name);
    }
  };
}

function makeItem(text, opts = {}) {
  const item = {
    text,
    tagName: 'BUTTON',
    disabled: Boolean(opts.disabled),
    tabIndex: opts.tabIndex === undefined ? 0 : opts.tabIndex,
    classList: makeClassList(Boolean(opts.hiddenClass)),
    isConnected: true,
    getAttribute: (name) => (name === 'aria-hidden' && opts.ariaHidden ? 'true' : null),
    getClientRects: () => [1],
    matches: () => false,
    closest: () => null,
    focus() {
      if (item.onFocus) item.onFocus(item);
      return true;
    }
  };
  return item;
}

function makeMenu(id, items, hidden = true) {
  const handlers = [];
  const menu = {
    id,
    items,
    classList: makeClassList(hidden),
    querySelectorAll: () => items,
    contains: (el) => el === menu || items.indexOf(el) >= 0,
    setAttribute() {},
    addEventListener: (type, fn) => handlers.push([type, fn]),
    removeEventListener: (type, fn) => {
      const at = handlers.findIndex(([t, f]) => t === type && f === fn);
      if (at >= 0) handlers.splice(at, 1);
    },
    handlerCount: () => handlers.length,
    fireKey(event) {
      for (const [type, fn] of handlers) if (type === 'keydown') fn({ currentTarget: menu, ...event });
    }
  };
  return menu;
}

let MO_INSTANCES = [];
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    MO_INSTANCES.push(this);
  }
  observe() {}
  disconnect() { this.disconnected = true; }
  trigger() { this.callback(); }
}

function makeDoc(menus, openers = {}) {
  const byId = new Map();
  for (const menu of menus) byId.set(menu.id, menu);
  for (const [id, el] of Object.entries(openers)) byId.set(id, el);
  const listeners = [];
  const doc = {
    body: { tagName: 'BODY', isConnected: true, getClientRects: () => [1] },
    documentElement: { tagName: 'HTML', isConnected: true, getClientRects: () => [1] },
    activeElement: null,
    getElementById: (id) => byId.get(id) || null,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: Boolean(capture) }),
    removeEventListener: () => {},
    fire(type, target) {
      const event = { type, target };
      for (const entry of listeners) if (entry.type === type) entry.fn(event);
      return event;
    }
  };
  doc.defaultView = {
    MutationObserver: FakeMutationObserver,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  };
  return doc;
}

function makeOpener(selectorMatches) {
  // 打开者要能被 `.matches(选择器)` 与 `.closest(组合选择器)` 认出来（模块两处都用）
  const matchesAny = (selector) =>
    String(selector)
      .split(',')
      .map((part) => part.trim())
      .some((part) => selectorMatches.includes(part));
  const opener = {
    isConnected: true,
    tagName: 'DIV',
    classList: makeClassList(false),
    getClientRects: () => [1],
    matches: (selector) => matchesAny(selector),
    closest: (selector) => (matchesAny(selector) ? opener : null),
    focus() { return true; }
  };
  return opener;
}

function buildMenus() {
  const contextItems = [
    makeItem('标记为完稿'),
    makeItem('标记为待修'),
    makeItem('已隐藏的条目', { hiddenClass: true }),
    makeItem('禁用条目', { disabled: true }),
    makeItem('删除（移到 _trash）')
  ];
  const volumeItems = [makeItem('在此卷末尾新建章节'), makeItem('重命名卷…')];
  const bookItems = [makeItem('打开这本书'), makeItem('删除这本书…')];
  const formatItems = [makeItem('排版设置…'), makeItem('一键整理本书…')];
  const displayItems = [makeItem('显示：紧凑'), makeItem('显示：标准')];
  const exportItems = [makeItem('复制整本到剪贴板'), makeItem('导出 TXT…')];
  return {
    menus: [
      makeMenu('context-menu', contextItems),
      makeMenu('volume-menu', volumeItems),
      makeMenu('book-menu', bookItems),
      makeMenu('format-menu', formatItems),
      makeMenu('display-menu', displayItems),
      makeMenu('export-menu', exportItems)
    ],
    contextItems,
    formatItems
  };
}

function setup() {
  MO_INSTANCES = [];
  const { menus, contextItems, formatItems } = buildMenus();
  const chapterItem = makeOpener(['.chapter-item']);
  const btnFormat = makeOpener([]);
  const btnDisplay = makeOpener([]);
  const btnExport = makeOpener([]);
  const doc = makeDoc(menus, {
    'btn-format': btnFormat,
    'btn-display': btnDisplay,
    'btn-export': btnExport
  });
  // 假 DOM 的 focus 语义：焦点落到谁身上就记到 doc.activeElement（模块只靠它判断「焦点在哪」）
  const wire = (el) => {
    el.focus = () => {
      doc.activeElement = el;
      if (typeof el.afterFocus === 'function') el.afterFocus(el);
      return true;
    };
    return el;
  };
  [chapterItem, btnFormat, btnDisplay, btnExport].forEach(wire);
  for (const menu of menus) menu.items.forEach(wire);
  doc.chapterItem = chapterItem;
  const inst = menuKeyboard.install({ document: doc, window: doc.defaultView, MutationObserver: FakeMutationObserver });
  const observer = MO_INSTANCES[0];
  const openMenu = (id) => {
    const menu = menus.find((m) => m.id === id);
    menu.classList.remove('hidden');
    observer.trigger();
    return menu;
  };
  const fireContextMenu = (target) => doc.fire('contextmenu', target);
  return { doc, inst, observer, menus, contextItems, formatItems, chapterItem, btnFormat, btnDisplay, btnExport, openMenu, fireContextMenu };
}

test('菜单键盘：右键菜单变成可见时把焦点带进第一条可用条目（跳过 .hidden 与禁用）', () => {
  const env = setup();
  env.fireContextMenu(env.chapterItem);
  const menu = env.openMenu('context-menu');
  assert.equal(env.doc.activeElement, env.contextItems[0], '焦点落在第一条可用条目');
  assert.notEqual(env.doc.activeElement, env.contextItems[2], '不落在 .hidden 的条目上');
  assert.notEqual(env.doc.activeElement, env.contextItems[3], '不落在禁用条目上');
  env.inst.destroy();
});

test('菜单键盘：方向键在菜单里移焦点并拦住滚动；Esc 收起菜单并把焦点还给打开它的元素', () => {
  const env = setup();
  env.fireContextMenu(env.chapterItem);
  const menu = env.openMenu('context-menu');
  let prevented = 0;
  menu.fireKey({ key: 'ArrowDown', preventDefault: () => (prevented += 1) });
  assert.equal(env.doc.activeElement, env.contextItems[1], '下一条');
  assert.equal(prevented, 1, '接管了就要 preventDefault');
  menu.fireKey({ key: 'ArrowDown' });
  assert.equal(env.doc.activeElement, env.contextItems[4], '跳过隐藏 / 禁用的两条');
  menu.fireKey({ key: 'ArrowDown' });
  assert.equal(env.doc.activeElement, env.contextItems[0], '到底绕回第一条');
  menu.fireKey({ key: 'End' });
  assert.equal(env.doc.activeElement, env.contextItems[4]);
  menu.fireKey({ key: 'Home' });
  assert.equal(env.doc.activeElement, env.contextItems[0]);

  let stopped = 0;
  menu.fireKey({ key: 'Escape', stopPropagation: () => (stopped += 1) });
  assert.equal(menu.classList.contains('hidden'), true, 'Esc 收起菜单');
  assert.equal(stopped, 1, 'Esc 不再往下传（文档上的其它 Esc 处理不该跟着跑）');
  assert.equal(env.doc.activeElement, env.chapterItem, '焦点还给打开它的章节条目');
  env.inst.destroy();
});

test('菜单键盘：右键菜单里 Tab 也算收起（菜单条目在 DOM 末尾，Tab 出去会跑到页面开头）', () => {
  const env = setup();
  env.fireContextMenu(env.chapterItem);
  const menu = env.openMenu('context-menu');
  let prevented = 0;
  menu.fireKey({ key: 'Tab', preventDefault: () => (prevented += 1) });
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(env.doc.activeElement, env.chapterItem);
  assert.equal(prevented, 1);
  env.inst.destroy();
});

test('菜单键盘：顶栏下拉打开时不抢焦点（沿用浏览器原生 Tab 顺序）', () => {
  const env = setup();
  env.btnDisplay.focus();
  const menu = env.openMenu('display-menu');
  assert.equal(env.doc.activeElement, env.btnDisplay, '打开顶栏下拉时焦点留在按钮上');
  // 焦点在按钮上时事件根本到不了菜单（菜单的 keydown 只在焦点进菜单后才触发），
  // 所以「Tab 进菜单」这条交给 E2E 用真实按键断言；这里只钉「Tab 不收起顶栏下拉」。
  let prevented = 0;
  menu.fireKey({ key: 'Tab', preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 0, '顶栏下拉的 Tab 交给浏览器（menuKeyAction 对 dropdown 返回 null）');
  assert.equal(menu.classList.contains('hidden'), false, 'Tab 不收起顶栏下拉');
  env.inst.destroy();
});

test('菜单键盘：关闭时焦点已经跑到别处就不抢（业务代码自己接管）', () => {
  const env = setup();
  env.fireContextMenu(env.chapterItem);
  const menu = env.openMenu('context-menu');
  const editor = { tagName: 'TEXTAREA', isConnected: true, getClientRects: () => [1], focus() { env.doc.activeElement = editor; } };
  env.doc.activeElement = editor;
  menu.classList.add('hidden');
  env.observer.trigger();
  assert.equal(env.doc.activeElement, editor, '焦点在别处时关闭菜单不抢回来');
  env.inst.destroy();
});

test('菜单键盘：右键另一条时换打开者（不能拿「上一次拿焦点的那一条」顶替）', () => {
  const env = setup();
  const other = makeOpener(['.chapter-item']);
  other.focus = () => { env.doc.activeElement = other; };
  env.fireContextMenu(env.chapterItem);
  const menu = env.openMenu('context-menu');
  menu.fireKey({ key: 'Escape' });
  assert.equal(env.doc.activeElement, env.chapterItem);
  // 焦点仍在 chapterItem，但这次右键的是 other
  env.fireContextMenu(other);
  menu.classList.remove('hidden');
  env.observer.trigger();
  menu.fireKey({ key: 'Escape' });
  assert.equal(env.doc.activeElement, other, 'Esc 还给「被右键的那一条」');
  env.inst.destroy();
});

test('菜单键盘：「整理」卡 Esc 收起后不被按钮的 focusin 又弹开（一次性闸门）', () => {
  const env = setup();
  // 假的「整理」下拉容器：捕获阶段的 focusin 监听（模块注册）+ 渲染层冒泡阶段的重开处理
  const dropdownListeners = [];
  const dropdown = {
    addEventListener: (type, fn, capture) => dropdownListeners.push({ type, fn, capture: Boolean(capture) }),
    contains: () => true
  };
  const doc = env.doc;
  const byId = new Map([[ 'format-menu', env.menus.find((m) => m.id === 'format-menu') ]]);
  const realGet = doc.getElementById.bind(doc);
  doc.getElementById = (id) => (id === 'format-dropdown' ? dropdown : realGet(id));
  const { menus } = env;
  const formatMenu = menus.find((m) => m.id === 'format-menu');
  let reopened = 0;
  // 重装：这次 document 里有 #format-dropdown，模块会挂捕获期闸门
  env.inst.destroy();
  MO_INSTANCES = [];
  const inst = menuKeyboard.install({ document: doc, window: doc.defaultView, MutationObserver: FakeMutationObserver });
  const observer = MO_INSTANCES[0];
  const fireFocusIn = (target) => {
    let stopped = false;
    const event = { type: 'focusin', target, stopPropagation: () => { stopped = true; } };
    for (const entry of dropdownListeners) {
      if (entry.type !== 'focusin' || !entry.capture) continue;
      entry.fn(event);
    }
    if (!stopped) reopened += 1; // 渲染层冒泡阶段 handler
  };
  env.btnFormat.focus = () => {
    doc.activeElement = env.btnFormat;
    fireFocusIn(env.btnFormat);
  };
  env.btnFormat.onFocus = env.btnFormat.focus;
  formatMenu.classList.remove('hidden');
  observer.trigger();
  // 焦点进卡片（相当于 Tab 进去）
  doc.activeElement = env.formatItems[0];
  formatMenu.fireKey({ key: 'Escape' });
  assert.equal(formatMenu.classList.contains('hidden'), true, 'Esc 收起卡片');
  assert.equal(reopened, 0, '焦点还给按钮时那一次 focusin 被拦掉（卡片不会又弹开）');
  // 闸门只拦一次：之后再聚焦按钮（Tab 回来）照旧弹开
  env.btnFormat.focus();
  assert.equal(reopened, 1, '再聚焦一次照旧弹开卡片（键盘入口没弄坏）');
  inst.destroy();
});

// ---------- 静态闸门 ----------

test('静态闸门：index.html 在 renderer.js 之前加载 menu-keyboard.js，且只加载一次', () => {
  const at = INDEX.indexOf('src="menu-keyboard.js"');
  assert.ok(at > 0, 'index.html 必须加载 menu-keyboard.js');
  const rendererAt = INDEX.indexOf('src="renderer.js"');
  assert.ok(at < rendererAt, 'menu-keyboard.js 要在 renderer.js 之前加载');
  assert.equal(INDEX.split('menu-keyboard.js').length - 1, 1, '只许引一次');
  assert.ok(INDEX.indexOf('src="dialog-focus.js"') < at, '弹层焦点管理先加载（两者互不依赖，顺序固定便于排查）');
});

test('静态闸门：渲染层走模块接线，不自己再抄一套菜单键盘处理', () => {
  assert.ok(RENDERER.includes('window.CWMenuKeyboard'), '渲染层必须拿菜单键盘模块');
  assert.ok(RENDERER.includes('window.CWMenuKeyboard.install()'), '渲染层要装一次（模块自己找 6 个菜单）');
  assert.ok(RENDERER.includes('listKeyboard.installVolumeHeaders({ container: $(\'chapter-list\') })'), '分卷标题行的键盘通道要挂到章节列表容器上');
  assert.equal(RENDERER.includes('menuKeyAction'), false, '渲染层不该自己写菜单按键判定（模块里有）');
});

test('静态闸门：模块只管焦点，不碰文件 / Electron / 定时器 / innerHTML', () => {
  const source = read('renderer/menu-keyboard.js');
  for (const forbidden of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'require(', 'electron', 'node:fs', 'innerHTML']) {
    assert.equal(source.includes(forbidden), false, `menu-keyboard.js 不许出现 ${forbidden}`);
  }
  assert.ok(source.includes("addEventListener('keydown'"), '菜单里的键盘入口');
  assert.ok(source.includes("addEventListener('contextmenu'"), '右键只记「谁打开的」，不拦默认行为');
  assert.equal(source.includes('preventDefault'), true, '方向键 / Esc 要拦住滚动与默认行为（只对键盘事件）');
});

test('静态闸门：模块里的菜单 id 与 index.html 一一对上', () => {
  for (const spec of menuKeyboard.MENUS) {
    assert.ok(INDEX.includes(`id="${spec.id}"`), `index.html 里找不到 ${spec.id}`);
    if (spec.openerId) assert.ok(INDEX.includes(`id="${spec.openerId}"`), `index.html 里找不到 ${spec.openerId}`);
  }
  assert.equal(menuKeyboard.MENUS.filter((spec) => spec.kind === 'context').length, 3, '右键菜单三个');
  assert.equal(menuKeyboard.MENUS.filter((spec) => spec.kind === 'dropdown').length, 3, '顶栏下拉三个');
});

test('静态闸门：分卷标题行的键盘通道在 list-keyboard.js 里，且不另写折叠逻辑', () => {
  const source = read('renderer/list-keyboard.js');
  assert.ok(source.includes('installVolumeHeaders'), 'list-keyboard.js 要导出 installVolumeHeaders');
  assert.ok(source.includes("row.setAttribute('role', 'button')"), '分卷标题行要有按钮角色');
  assert.ok(source.includes("row.setAttribute('aria-expanded'"), '分卷标题行要报告折叠状态');
  assert.ok(source.includes('row.click()'), '折叠展开复用原来的 click 处理（不抄第二份折叠逻辑）');
  assert.equal(typeof listKeyboard.installVolumeHeaders, 'function');
  assert.equal(source.includes('collapsedVolumes'), false, '模块不碰产品状态，只调 click');
});
