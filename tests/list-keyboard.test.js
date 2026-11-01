// 单测：键盘可达（v0.9 A-5b）。
//
// 这一项补的是「只用键盘也能开会话、切章」这一条通道，产品侧只有一个浏览器模块
// `renderer/list-keyboard.js`（纯逻辑 + 容器事件委托），渲染层只接线。所以这里测两半：
//   · 纯逻辑：按键 → 计划（激活 / 移动 / 不管）、下标夹紧、roving tabindex、补 Tab 停留点；
//   · 接线：容器上的 keydown 事件委托（真的调 onActivate、方向键真的移焦点并改 tabIndex、
//     焦点在卡片里的按钮上时不被抢）。
// 再加几条静态闸门，钉住「只补键盘通道、不碰鼠标」以及「index.html 里加载顺序 / 只引一次」。
//
// 真实浏览器里的行为（真实 Tab / Enter 按键）由 E2E 第 70 组断言。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listKeyboard = require(path.join(ROOT, 'renderer', 'list-keyboard.js'));
const INDEX = read('renderer/index.html');
const RENDERER = read('renderer/renderer.js');

const key = (name, extra) => ({ key: name, preventDefault() {}, ...(extra || {}) });

// ---------- 纯逻辑 ----------

test('键盘可达：Enter / 空格 / Spacebar 都算激活，别的键不算', () => {
  assert.equal(listKeyboard.isActivateKey('Enter'), true);
  assert.equal(listKeyboard.isActivateKey(' '), true);
  assert.equal(listKeyboard.isActivateKey('Spacebar'), true);
  assert.equal(listKeyboard.isActivateKey('a'), false);
  assert.equal(listKeyboard.isActivateKey(''), false);
  assert.equal(listKeyboard.isActivateKey(undefined), false);
});

test('键盘可达：方向键在同一列表内一格一格走，到头就夹住（不绕回）', () => {
  assert.equal(listKeyboard.nextIndex(1, 'ArrowDown', 3), 2);
  assert.equal(listKeyboard.nextIndex(1, 'ArrowUp', 3), 0);
  assert.equal(listKeyboard.nextIndex(0, 'ArrowUp', 3), 0);
  assert.equal(listKeyboard.nextIndex(2, 'ArrowDown', 3), 2);
  assert.equal(listKeyboard.nextIndex(1, 'ArrowRight', 3), 2, '右方向键也算下一项');
  assert.equal(listKeyboard.nextIndex(1, 'ArrowLeft', 3), 0, '左方向键也算上一项');
  assert.equal(listKeyboard.nextIndex(1, 'Home', 3), 0);
  assert.equal(listKeyboard.nextIndex(1, 'End', 3), 2);
});

test('键盘可达：坏下标 / 空列表 / 非数字都收敛，不乱跳', () => {
  assert.equal(listKeyboard.nextIndex(-5, 'ArrowDown', 3), 1, '坏下标当第一个再走一格');
  assert.equal(listKeyboard.nextIndex(99, 'ArrowUp', 3), 0, '越界下标也当第一个（不瞎猜「最后一个」）');
  assert.equal(listKeyboard.nextIndex(NaN, 'End', 3), 2);
  assert.equal(listKeyboard.nextIndex(0, 'ArrowDown', 0), null, '空列表没有可去的地方');
  assert.equal(listKeyboard.nextIndex(0, 'ArrowDown', -1), null);
  assert.equal(listKeyboard.nextIndex(0, 'PageDown', 3), null, '不认识的键不接管');
});

test('键盘可达：按键计划——带修饰键 / 其它键一律不管，避免抢 Ctrl+方向 / 选中', () => {
  assert.deepEqual(listKeyboard.keyAction(key('Enter'), 1, 3), { type: 'activate', index: 1 });
  assert.deepEqual(listKeyboard.keyAction(key(' '), 0, 3), { type: 'activate', index: 0 });
  assert.deepEqual(listKeyboard.keyAction(key('ArrowDown'), 1, 3), { type: 'move', index: 2 });
  assert.equal(listKeyboard.keyAction(key('ArrowDown', { ctrlKey: true }), 1, 3), null);
  assert.equal(listKeyboard.keyAction(key('ArrowDown', { shiftKey: true }), 1, 3), null);
  assert.equal(listKeyboard.keyAction(key('Enter', { altKey: true }), 1, 3), null);
  assert.equal(listKeyboard.keyAction(key('Escape'), 1, 3), null);
  assert.equal(listKeyboard.keyAction(null, 0, 3), null);
});

test('键盘可达：roving tabindex——只有当前项是 0，其余 -1；坏下标落到第一个', () => {
  const items = [{ tabIndex: 9 }, { tabIndex: 9 }, { tabIndex: 9 }];
  assert.equal(listKeyboard.applyTabStops(items, 1), 3);
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, 0, -1]);
  listKeyboard.applyTabStops(items, 99);
  assert.deepEqual(items.map((el) => el.tabIndex), [0, -1, -1], '越界时让第一个可 Tab 到');
  assert.equal(listKeyboard.applyTabStops([], 0), 0, '空列表不炸');
});

test('键盘可达：当前章在折叠的卷里时，补第一个条目当 Tab 停留点（且不重复补）', () => {
  const fake = (tabs) => {
    const items = tabs.map((tabIndex) => ({ tabIndex }));
    return { items, querySelectorAll: () => items };
  };
  const none = fake([-1, -1]);
  assert.equal(listKeyboard.ensureTabStop(none, '.chapter-item'), true);
  assert.equal(none.items[0].tabIndex, 0);
  const has = fake([-1, 0]);
  assert.equal(listKeyboard.ensureTabStop(has, '.chapter-item'), false, '已经有停留点就不动');
  assert.equal(listKeyboard.ensureTabStop({ querySelectorAll: () => [] }, '.chapter-item'), false);
  assert.equal(listKeyboard.ensureTabStop(null, '.chapter-item'), false);
});

// ---------- 容器事件委托（假 DOM） ----------

function makeItems(count, selector) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      tabIndex: -1,
      dataset: { index: String(i) },
      focused: false,
      scrolled: false,
      matches: (sel) => sel === selector,
      closest(sel) {
        return sel === selector ? this : null;
      },
      focus() {
        // 假 DOM 里只记住「谁拿到了焦点」，并把别人的焦点清掉
        for (const el of items) el.focused = false;
        this.focused = true;
      },
      scrollIntoView() {
        this.scrolled = true;
      }
    });
  }
  return items;
}

function makeContainer(items) {
  const handlers = [];
  return {
    contains: (el) => items.indexOf(el) >= 0,
    querySelectorAll: () => items,
    addEventListener: (type, fn) => handlers.push([type, fn]),
    removeEventListener: (type, fn) => {
      const at = handlers.findIndex(([t, f]) => t === type && f === fn);
      if (at >= 0) handlers.splice(at, 1);
    },
    fire(event) {
      for (const [type, fn] of handlers) if (type === event.type) fn(event);
    },
    handlerCount: () => handlers.length
  };
}

test('键盘可达：容器委托——Enter 激活条目、方向键移焦点并把 roving 跟着挪', () => {
  const items = makeItems(3, '.chapter-item');
  const container = makeContainer(items);
  const activated = [];
  const moved = [];
  const inst = listKeyboard.install({
    container,
    itemSelector: '.chapter-item',
    arrows: true,
    onActivate: (item) => activated.push(item.dataset.index),
    onMove: (item) => moved.push(item.dataset.index)
  });
  let prevented = 0;
  const send = (target, name) =>
    container.fire({ type: 'keydown', key: name, target, preventDefault: () => (prevented += 1) });

  send(items[1], 'Enter');
  assert.deepEqual(activated, ['1'], 'Enter 激活当前聚焦的条目');
  assert.equal(prevented, 1, '接管了就要 preventDefault（避免空格滚页面）');

  send(items[1], 'ArrowDown');
  assert.equal(items[2].focused, true, '焦点move 到下一项');
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, -1, 0], 'roving 跟着新焦点');
  assert.deepEqual(moved, ['2']);
  assert.equal(items[2].scrolled, true, '移动后滚进可视区');

  send(items[0], 'End');
  assert.equal(items[2].focused, true, 'End 跳到最后一个');
  send(items[2], 'Home');
  assert.equal(items[0].focused, true, 'Home 回到第一个');
  send(items[0], 'ArrowUp');
  assert.equal(items[0].focused, true, '到头夹住');

  send(items[0], 'a');
  assert.equal(activated.length, 1, '普通字母键不激活');
  inst.destroy();
  assert.equal(container.handlerCount(), 0, 'destroy 摘掉监听');
});

test('键盘可达：焦点在条目里的按钮上时不抢（卡片里的「⋯」自己响应 Enter）', () => {
  const items = makeItems(2, '.book-card');
  const container = makeContainer(items);
  const activated = [];
  listKeyboard.install({ container, itemSelector: '.book-card', onActivate: (el) => activated.push(el) });
  // 焦点在卡片里的按钮上：event.target 是那个按钮（不等于卡片本身）
  const nested = { closest: (sel) => (sel === '.book-card' ? items[0] : null), tagName: 'BUTTON' };
  let preventedNested = 0;
  container.fire({ type: 'keydown', key: 'Enter', target: nested, preventDefault: () => (preventedNested += 1) });
  assert.deepEqual(activated, [], '卡片不该替里面的按钮做激活');
  assert.equal(preventedNested, 0, '也不许 preventDefault——否则按钮的 Enter 激活会被拦掉（E2E 抓到的真 bug）');
  container.fire({ type: 'keydown', key: ' ', target: items[0], preventDefault() {} });
  assert.equal(activated.length, 1, '空格能在卡片本身上打开书');
});

test('键盘可达：没开方向键导航时，方向键既不 preventDefault 也不移焦点', () => {
  const items = makeItems(3, '.book-card');
  const container = makeContainer(items);
  const moved = [];
  listKeyboard.install({ container, itemSelector: '.book-card', onActivate() {}, onMove: (el) => moved.push(el) });
  let prevented = 0;
  container.fire({ type: 'keydown', key: 'ArrowDown', target: items[0], preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 0);
  assert.deepEqual(moved, []);
  assert.equal(items[1].focused, false);
});

test('键盘可达：事件委托只认容器里的条目，指向别处的 target 不理', () => {
  const items = makeItems(2, '.chapter-item');
  const container = makeContainer(items);
  let called = 0;
  listKeyboard.install({ container, itemSelector: '.chapter-item', arrows: true, onActivate: () => (called += 1) });
  container.fire({ type: 'keydown', key: 'Enter', target: { closest: () => null }, preventDefault() {} });
  assert.equal(called, 0);
  const outside = { closest: () => ({ dataset: { index: '0' } }) };
  container.fire({ type: 'keydown', key: 'Enter', target: outside, preventDefault() {} });
  assert.equal(called, 0, '不在容器里的条目（例如别处的同名元素）不算');
});

// ---------- 静态闸门 ----------

test('静态闸门：index.html 在 renderer.js 之前加载 list-keyboard.js，且只加载一次', () => {
  const at = INDEX.indexOf('renderer/list-keyboard.js'.replace('renderer/', ''));
  assert.ok(at > 0, 'index.html 必须加载 list-keyboard.js');
  const rendererAt = INDEX.indexOf('src="renderer.js"');
  assert.ok(at < rendererAt, 'list-keyboard.js 要在 renderer.js 之前加载');
  assert.equal(INDEX.split('list-keyboard.js').length - 1, 1, '只许引一次');
});

test('静态闸门：渲染层用模块接线，不许自己再抄一套键盘处理', () => {
  assert.ok(RENDERER.includes('window.CWListKeyboard'), '渲染层必须拿模块');
  assert.ok(
    /listKeyboard\.install\(\{[^}]*chapter-list/.test(RENDERER) ||
      RENDERER.includes("container: $('chapter-list')"),
    '章节列表要挂到容器上（事件委托）'
  );
  assert.ok(RENDERER.includes("container: $('book-grid')"), '书架书卡要挂到容器上');
  assert.ok(
    RENDERER.includes("itemSelector: '.book-card[data-path]'"),
    '只认真正的书卡——同一张网格里的「＋ 新建一本书」是原生按钮，不能被拦'
  );
  // 章节条目 / 书卡都要真的可聚焦，并且带无障碍名称与角色
  assert.ok(RENDERER.includes('item.tabIndex = index === state.index ? 0 : -1'), '章节条目要参与 roving');
  assert.ok(RENDERER.includes("item.setAttribute('role', 'button')"), '章节条目要有按钮角色');
  assert.ok(RENDERER.includes('item.setAttribute(\'aria-label\', `打开${chapterTitle(index, chapter.name)}`)'));
  assert.ok(RENDERER.includes('card.tabIndex = 0'), '书卡要可聚焦');
  assert.ok(RENDERER.includes("card.setAttribute('aria-label', `打开《${book.title}》`)"));
  assert.ok(RENDERER.includes('next.tabIndex = 0'), '切章快路径要把 Tab 停留点跟着挪');
  assert.ok(RENDERER.includes("listKeyboard.ensureTabStop(list, '.chapter-item')"));
});

test('静态闸门：模块只碰键盘 / 焦点，不许碰鼠标事件、定时器、文件与 Electron', () => {
  const source = read('renderer/list-keyboard.js');
  for (const forbidden of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'require(', 'electron', 'node:fs', 'innerHTML']) {
    assert.equal(source.includes(forbidden), false, `list-keyboard.js 不许出现 ${forbidden}`);
  }
  for (const mouse of ["'click'", "'mousedown'", "'dblclick'", "'contextmenu'", "'pointerdown'", "'pointerup'"]) {
    assert.equal(source.includes(mouse), false, `键盘模块不许接管鼠标事件（${mouse}）`);
  }
  assert.ok(source.includes("addEventListener('keydown'"), '唯一的入口是容器的 keydown');
});

test('静态闸门：13 个弹层都有无障碍名称（标题 id + aria-labelledby），且指向真标题', () => {
  const backdrops = [...INDEX.matchAll(/<div id="([a-z-]+-backdrop)" class="backdrop/g)].map((m) => m[1]);
  assert.equal(backdrops.length, 13, '弹层数量变了就要同步这条测试');
  for (const id of backdrops) {
    const start = INDEX.indexOf(`<div id="${id}"`);
    const seg = INDEX.slice(start, start + 5000);
    const dialog = /<div class="[^"]*modal[^"]*" role="dialog"([^>]*)>/.exec(seg);
    assert.ok(dialog, `${id} 里的 role="dialog" 不见了`);
    const labelledby = /aria-labelledby="([^"]+)"/.exec(dialog[1]);
    assert.ok(labelledby, `${id} 的弹层必须挂 aria-labelledby（读屏进弹层要报名字）`);
    const title = new RegExp(`<h2[^>]*id="${labelledby[1]}"[^>]*>[^<]*</h2>`).exec(seg);
    assert.ok(title, `${id} 的 aria-labelledby 指向了不存在的 ${labelledby[1]}`);
  }
});
