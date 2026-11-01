// 弹层焦点管理（v0.9 A-5 无障碍与键盘）的自检。
//
// 分三层：
//   ① 纯决策：当前是哪个弹层（z-index）、Tab / Shift+Tab 落到哪、关闭后要不要还焦点；
//   ② 接线：用一套很小的假 DOM 跑 install()，证明「打开带焦点进来、Tab 在首尾绕回、
//      焦点被抢走会拉回、关闭后还给打开前的元素」这几件事真的接上了（不碰真浏览器）；
//   ③ 静态闸门：index.html 的加载顺序、renderer.js 只调一次 install、减少动效的
//      CSS 块还在（系统「减少动画」要有反馈）、模块本身不许引入定时器 / 文件 / Electron。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dialogFocus = require('../renderer/dialog-focus');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MODULE_SOURCE = read('renderer/dialog-focus.js');
const RENDERER_SOURCE = read('renderer/renderer.js');
const INDEX_SOURCE = read('renderer/index.html');
const STYLES_SOURCE = read('renderer/styles.css');

// ---------------------------------------------------------------- ① 纯决策

test('焦点管理：当前弹层按 z-index 挑最高的，同 z-index 取 DOM 里靠后的', () => {
  const { pickTopIndex } = dialogFocus;
  assert.equal(pickTopIndex([]), -1);
  assert.equal(pickTopIndex([{ open: false, z: 100 }, null, { open: false, z: 300 }]), -1);
  assert.equal(pickTopIndex([{ open: true, z: 100 }]), 0);
  assert.equal(pickTopIndex([{ open: true, z: 100 }, { open: false, z: 300 }]), 0);
  // #modal-backdrop 是 300（通用询问框永远压在设置 / 排版之上）
  assert.equal(pickTopIndex([{ open: true, z: 100 }, { open: true, z: 300 }]), 1);
  // 同 z-index：后打开的那个在 DOM 里靠后，也画在上面
  assert.equal(pickTopIndex([{ open: true, z: 100 }, { open: true, z: 100 }]), 1);
  // z-index 缺失 / 不是数当 0；坏项跳过
  assert.equal(pickTopIndex([{ open: true }, { open: true, z: 1 }]), 1);
  assert.equal(pickTopIndex([null, undefined, { open: true, z: 'abc' }]), 2);
  // 弹层关掉后回到下面那个还开着的
  assert.equal(pickTopIndex([{ open: true, z: 100 }, { open: false, z: 300 }]), 0);
});

test('焦点管理：Tab / Shift+Tab 在首尾绕回，中间原样前进 / 后退', () => {
  const { tabTarget } = dialogFocus;
  // 前进
  assert.equal(tabTarget(0, 3, false), 1);
  assert.equal(tabTarget(1, 3, false), 2);
  assert.equal(tabTarget(2, 3, false), 0, '最后一个 Tab 回第一个');
  // 后退
  assert.equal(tabTarget(2, 3, true), 1);
  assert.equal(tabTarget(1, 3, true), 0);
  assert.equal(tabTarget(0, 3, true), 2, '第一个 Shift+Tab 回最后一个');
  // 只有一个元素：原地不动
  assert.equal(tabTarget(0, 1, false), 0);
  assert.equal(tabTarget(0, 1, true), 0);
  // 焦点不在弹层里：从头 / 从尾进门
  assert.equal(tabTarget(-1, 4, false), 0);
  assert.equal(tabTarget(-1, 4, true), 3);
  // 越界 / 空 / 坏值：别算出野下标
  assert.equal(tabTarget(9, 4, false), 0);
  assert.equal(tabTarget(9, 4, true), 2, '越界下标夹到最后一项再往回退一步');
  assert.equal(tabTarget(0, 0, false), -1);
  assert.equal(tabTarget(0, -3, true), -1);
  assert.equal(tabTarget(0, NaN, false), -1);
  assert.equal(tabTarget(NaN, 3, false), 0);
  assert.equal(tabTarget(null, 3, true), 2);
});

test('焦点管理：焦点丢在 body / 还停在关掉的弹层里 / 已经不可见才归还；代码自己 focus 了别处就不抢', () => {
  const { shouldRestoreFocus } = dialogFocus;
  assert.equal(shouldRestoreFocus(undefined), true, '不知道焦点在哪时按「丢了」处理');
  assert.equal(shouldRestoreFocus(null), true);
  assert.equal(shouldRestoreFocus({ isBody: true }), true, 'body / html / 没有 activeElement');
  // 真窗口实测：祖先 display:none 之后 activeElement 仍是弹层里的元素，必须单独判
  assert.equal(shouldRestoreFocus({ insideBackdrop: true }), true, '还停在刚关掉的弹层里');
  assert.equal(shouldRestoreFocus({ hidden: true }), true, '元素已经看不见了');
  assert.equal(shouldRestoreFocus({ isBody: false, insideBackdrop: false, hidden: false }), false, '业务代码给了别的可见元素，不抢');
  // 组合状态：只要有一项成立就归还
  assert.equal(shouldRestoreFocus({ isBody: false, insideBackdrop: true, hidden: false }), true);
  assert.equal(shouldRestoreFocus({ isBody: false, insideBackdrop: false, hidden: true }), true);
});

test('焦点管理：可聚焦选择器覆盖常用控件，且负 tabindex 交给 isTabbable 过滤', () => {
  const { FOCUSABLE_SELECTOR } = dialogFocus;
  for (const needle of ['button', 'input', 'select', 'textarea', 'a[href]', '[tabindex]', '[contenteditable="true"]']) {
    assert.ok(FOCUSABLE_SELECTOR.includes(needle), `选择器缺 ${needle}`);
  }
});

// ---------------------------------------------------------------- ② 假 DOM 接线

function makeFakeDom() {
  const doc = {
    listeners: new Map(),
    activeElement: null,
    body: { tagName: 'BODY', isConnected: true, getClientRects: () => [{ width: 800, height: 600 }] },
    documentElement: { tagName: 'HTML', isConnected: true, getClientRects: () => [{ width: 800, height: 600 }] },
    // 默认没有弹层；要测弹层的用例自己在 install 之前换掉
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      doc.listeners.set(type, handler);
    },
    removeEventListener(type) {
      doc.listeners.delete(type);
    }
  };
  const win = {
    getComputedStyle(el) {
      return {
        zIndex: el.zIndex == null ? '100' : el.zIndex,
        display: el.display || 'block',
        visibility: el.visibility || 'visible'
      };
    }
    // 故意不给 MutationObserver：真实环境有，测试里靠 sync() 手动驱动
  };
  return { doc, win };
}

function makeEl(doc, props = {}) {
  const el = {
    id: '',
    tagName: 'BUTTON',
    tabIndex: 0,
    disabled: false,
    isConnected: true,
    attrs: {},
    hidden: false,
    zIndex: '100',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    getClientRects() {
      return el.hidden ? [] : [{ width: 20, height: 20 }];
    },
    closest(selector) {
      return selector === '[inert]' && el.inert ? el : null;
    },
    focus() {
      doc.activeElement = el;
      el.focusCount = (el.focusCount || 0) + 1;
    },
    ...props
  };
  return el;
}

// 一个带 n 个按钮的弹层；state.open 控制可见性，state.z 控制层级
function makeDialog(doc, state, items) {
  const modal = {
    items,
    contains(target) {
      return items.includes(target);
    },
    querySelectorAll() {
      return items;
    }
  };
  const backdrop = {
    id: state.id,
    zIndex: state.z,
    classList: { contains: (name) => name === 'hidden' && !state.open },
    querySelector: (selector) => (selector === '.modal' ? modal : null),
    contains: (target) => modal.contains(target)
  };
  return backdrop;
}

function fireKey(doc, event) {
  const handler = doc.listeners.get('keydown');
  assert.ok(handler, 'keydown 监听器没装上');
  const calls = { prevented: 0 };
  handler({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      calls.prevented += 1;
    },
    ...event
  });
  return calls;
}

test('假 DOM：install 只装一次，destroy 之后监听器清干净', () => {
  const { doc, win } = makeFakeDom();
  const first = dialogFocus.install({ document: doc, window: win });
  assert.ok(first, 'install 应该返回实例');
  assert.equal(typeof first.sync, 'function');
  assert.equal(dialogFocus.install({ document: doc, window: win }), first, '重复 install 复用同一份监听');
  assert.equal(doc.listeners.size, 2, 'keydown + focusin 两个监听');
  first.destroy();
  assert.equal(doc.listeners.size, 0);
  const again = dialogFocus.install({ document: doc, window: win });
  assert.notEqual(again, first, 'destroy 之后可以重新装');
  again.destroy();
});

test('假 DOM：没有 document / window 时 install 直接返回 null（Node 里 require 不炸）', () => {
  assert.equal(dialogFocus.install({}), null);
  assert.equal(dialogFocus.install(), null);
});

test('假 DOM：弹层打开把焦点带进第一个可聚焦元素，Tab 在末尾绕回开头', () => {
  const { doc, win } = makeFakeDom();
  const opener = makeEl(doc, { id: 'opener', tagName: 'BUTTON', isConnected: true });
  const b1 = makeEl(doc, { id: 'b1' });
  const b2 = makeEl(doc, { id: 'b2' });
  const state = { id: 'demo-backdrop', open: false, z: '100' };
  const backdrop = makeDialog(doc, state, [b1, b2]);
  doc.querySelectorAll = (selector) => (selector === '.backdrop' ? [backdrop] : []);
  const instance = dialogFocus.install({ document: doc, window: win });

  // 背景里先有焦点（打开前那个元素）
  doc.activeElement = opener;
  doc.listeners.get('focusin')({ target: opener });
  doc.activeElement = opener; // 模拟用户点按钮：焦点还在按钮上，弹层还没开
  assert.equal(opener.focusCount, undefined);

  // 打开：焦点还没进弹层 → sync() 把它带进第一个可聚焦元素
  state.open = true;
  instance.sync();
  assert.equal(doc.activeElement, b1, '打开后焦点应该在弹层里');

  // 在最后一个元素按 Tab：绕回第一个
  doc.activeElement = b2;
  const wrap = fireKey(doc, { key: 'Tab' });
  assert.equal(doc.activeElement, b1);
  assert.equal(wrap.prevented, 1, '边界要自己兜住，不能再让浏览器跑到背景');

  // 中间位置按 Tab：不动手，交给浏览器原生的顺序
  doc.activeElement = b1;
  const middle = fireKey(doc, { key: 'Tab' });
  assert.equal(doc.activeElement, b1);
  assert.equal(middle.prevented, 0);

  // Shift+Tab 在第一个：绕回最后一个
  const back = fireKey(doc, { key: 'Tab', shiftKey: true });
  assert.equal(doc.activeElement, b2);
  assert.equal(back.prevented, 1);

  // Ctrl+Tab 之类不是焦点遍历：不拦
  doc.activeElement = b2;
  const ctrlTab = fireKey(doc, { key: 'Tab', ctrlKey: true });
  assert.equal(doc.activeElement, b2);
  assert.equal(ctrlTab.prevented, 0);

  instance.destroy();
});

test('假 DOM：代码主动把焦点交给背景时不许抢；但从背景按 Tab 会被带回弹层', () => {
  const { doc, win } = makeFakeDom();
  const opener = makeEl(doc, { id: 'btn-settings' });
  const b1 = makeEl(doc, { id: 'ok' });
  const state = { id: 'demo-backdrop', open: false, z: '100' };
  const backdrop = makeDialog(doc, state, [b1]);
  doc.querySelectorAll = (selector) => (selector === '.backdrop' ? [backdrop] : []);
  const instance = dialogFocus.install({ document: doc, window: win });

  doc.activeElement = opener;
  doc.listeners.get('focusin')({ target: opener }); // 记住打开前的焦点
  state.open = true;
  instance.sync();
  // 弹层里再 Tab 一圈（焦点在 b1，它是唯一元素 → 原地）
  doc.activeElement = b1;
  fireKey(doc, { key: 'Tab' });
  assert.equal(doc.activeElement, b1);

  // 弹层开着时业务代码把焦点主动交给编辑区（「替换这一处」依赖编辑器真的拿到焦点）：
  // 焦点管理不许抢——只在用户按 Tab 这条路上兜住。
  const editor = makeEl(doc, { id: 'editor', tagName: 'TEXTAREA' });
  doc.activeElement = editor;
  doc.listeners.get('focusin')({ target: editor });
  assert.equal(doc.activeElement, editor, '代码给的焦点不该被弹层抢回');

  // 但从背景按 Tab：焦点要回到弹层里
  fireKey(doc, { key: 'Tab' });
  assert.equal(doc.activeElement, b1, '背景按 Tab 应该回到弹层');

  // 关闭：真窗口的行为是 activeElement 还停在弹层里那个 input 上（祖先 display:none 不会把它重置成 body）
  // → 这种「没归属」的焦点要还给打开前的元素
  state.open = false;
  b1.hidden = true;
  doc.activeElement = b1;
  instance.sync();
  assert.equal(doc.activeElement, opener, '关闭后焦点应该回到打开前的元素');
  instance.destroy();
});

test('假 DOM：关闭时业务代码已经 focus 了别处，就不抢焦点', () => {
  const { doc, win } = makeFakeDom();
  const opener = makeEl(doc, { id: 'btn-format' });
  const editor = makeEl(doc, { id: 'editor', tagName: 'TEXTAREA' });
  const b1 = makeEl(doc, { id: 'apply' });
  const state = { id: 'demo-backdrop', open: false, z: '100' };
  const backdrop = makeDialog(doc, state, [b1]);
  doc.querySelectorAll = (selector) => (selector === '.backdrop' ? [backdrop] : []);
  const instance = dialogFocus.install({ document: doc, window: win });

  doc.activeElement = opener;
  doc.listeners.get('focusin')({ target: opener });
  state.open = true;
  instance.sync();
  // 关闭时业务代码先把焦点给了编辑区（例如套用整理后回去接着写）
  state.open = false;
  doc.activeElement = editor;
  instance.sync();
  assert.equal(doc.activeElement, editor, '编辑区已经拿到焦点，不该被弹层的关闭逻辑抢走');
  instance.destroy();
});

test('假 DOM：嵌套弹层关掉上面那个，焦点回到下面还开着的弹层', () => {
  const { doc, win } = makeFakeDom();
  const belowBtn = makeEl(doc, { id: 'below' });
  const topBtn = makeEl(doc, { id: 'top' });
  const below = { id: 'below-backdrop', open: true, z: '100' };
  const top = { id: 'top-backdrop', open: false, z: '300' };
  const belowEl = makeDialog(doc, below, [belowBtn]);
  const topEl = makeDialog(doc, top, [topBtn]);
  doc.querySelectorAll = (selector) => (selector === '.backdrop' ? [belowEl, topEl] : []);
  const instance = dialogFocus.install({ document: doc, window: win });

  instance.sync(); // 下面那个先开着
  assert.equal(doc.activeElement, belowBtn, '先开着的弹层先拿到焦点');
  top.open = true; // 通用询问框压在上面
  instance.sync();
  assert.equal(doc.activeElement, topBtn, '新打开的（z 更高的）弹层拿到焦点');
  top.open = false;
  doc.activeElement = doc.body; // 上面那个关掉，焦点丢了
  instance.sync();
  assert.equal(doc.activeElement, belowBtn, '焦点回到下面还开着的弹层，而不是背景');
  instance.destroy();
});

// ---------------------------------------------------------------- ③ 静态闸门

test('静态闸门：index.html 在 renderer.js 之前加载 dialog-focus.js，且只加载一次', () => {
  assert.equal(INDEX_SOURCE.split('src="dialog-focus.js"').length - 1, 1, 'dialog-focus.js 只该引一次');
  const focusAt = INDEX_SOURCE.indexOf('src="dialog-focus.js"');
  const rendererAt = INDEX_SOURCE.indexOf('src="renderer.js"');
  assert.ok(focusAt > 0, 'index.html 必须加载 dialog-focus.js');
  assert.ok(focusAt < rendererAt, 'dialog-focus.js 必须排在 renderer.js 之前（否则 window.CWDialogFocus 还没挂上）');
});

test('静态闸门：renderer.js 只调一次 CWDialogFocus.install()', () => {
  const calls = RENDERER_SOURCE.split('window.CWDialogFocus.install(').length - 1;
  assert.equal(calls, 1, '焦点管理只该有一处接线（多处装会叠加监听）');
});

test('静态闸门：减少动效的 CSS 块还在，四件事都写了', () => {
  const at = STYLES_SOURCE.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at > 0, 'styles.css 缺 prefers-reduced-motion 块（系统关掉动画时界面要跟着安静）');
  const block = STYLES_SOURCE.slice(at, at + 500);
  for (const needle of ['animation-duration', 'animation-iteration-count', 'transition-duration', 'scroll-behavior']) {
    assert.ok(block.includes(needle), `减少动效块里缺 ${needle}`);
  }
  // 界面上确实还有过渡 / 动画（不是把动效全删了），减少动效只是覆盖时长
  assert.ok(/transition:\s/.test(STYLES_SOURCE), 'styles.css 原有的过渡不该被这次改动删掉');
  assert.ok(/@keyframes toast-in/.test(STYLES_SOURCE), 'toast 的入场动画还在，减少动效只压时长');
});

test('静态闸门：焦点模块不碰定时器 / 文件 / Electron，也不许给背景加 inert', () => {
  const code = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/setTimeout|setInterval/.test(code), false, '焦点不该靠定时器兜（窗口被遮挡时定时器会被节流）');
  assert.equal(/require\s*\(/.test(code), false, '焦点模块不 require 任何东西');
  assert.equal(/electron|node:fs|\bfs\./.test(code), false, '焦点模块不许碰 Electron / 文件系统');
  // 只用「拉回焦点」的思路：不给背景元素加 inert（会连带禁掉背景的读屏与程序化点击）
  assert.equal(/setAttribute\(\s*['"]inert/.test(code), false, '不许给背景加 inert');
  assert.equal(/\.inert\s*=/.test(code), false, '不许给背景加 inert');
  // 只处理 Tab；其它按键（Esc / Ctrl+S 等）归业务逻辑
  assert.equal(/event\.key\s*!==\s*'Tab'/.test(code), true, 'keydown 只该处理 Tab');
});
