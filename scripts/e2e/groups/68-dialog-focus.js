// E2E 第 68 组：弹层焦点管理与减少动效（v0.9 A-5 无障碍与键盘）。
//
// 钉住的是键盘 / 读屏用户真正会撞上的四件事（以前都没兜住，本轮先量后改）：
//   1. 弹层打开后焦点要进弹层——以前设置 / 排版 / 历史 / 插入碎片 / 校对 / 敏感词
//      打开后焦点还在背景按钮上，得 Tab 一圈背景才进得来；
//   2. 弹层开着时 Tab / Shift+Tab 走一整圈都不许跑出去（首尾要绕回，中间按原生顺序）；
//      以前每个弹层都能按几步 Tab 跑到「← 书架」等背景元素上；
//   3. 焦点被代码 / 读屏抢到背景时要拉回弹层；
//   4. Esc 关掉弹层后焦点不许丢在 <body> 上（要回到打开前那个元素）。
// 另外钉住「减少动效」：系统关掉动画时 prefers-reduced-motion: reduce 生效，
// 过渡 / 动画时长被压到 0.01ms；恢复后回到原值（只改时长，不改颜色 / 布局 / 功能）。
//
// 为什么必须 E2E：Tab 焦点遍历是浏览器默认行为，渲染层 dispatch 的 KeyboardEvent 根本
// 走不到；这里用 win.webContents.sendInputEvent 发**真实按键**，读 document.activeElement。
// 自足：自己造一本 2 章的演练书，收尾走书架 _trash 删掉；不写配置、不碰真实书架。
const fs = require('node:fs/promises');
const path = require('node:path');

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]'
].join(',');

const SEL = JSON.stringify(FOCUSABLE);

// 当前可见弹层（z-index 最高的那个）的现场：焦点在不在里面、有几个可聚焦元素
const JS_DIALOG = `(() => {
  const backs = Array.from(document.querySelectorAll('.backdrop')).filter((b) => !b.classList.contains('hidden'));
  const bd = backs[backs.length - 1] || null;
  if (!bd) return JSON.stringify({ open: false });
  const box = bd.querySelector('.modal') || bd;
  const active = document.activeElement;
  const list = Array.from(box.querySelectorAll(${SEL}))
    .filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0);
  return JSON.stringify({
    open: true,
    id: bd.id,
    count: list.length,
    inside: Boolean(active && box.contains(active)),
    activeId: active ? active.id || '' : null,
    activeTag: active ? active.tagName.toLowerCase() : null
  });
})()`;

const JS_ACTIVE = `(() => {
  const active = document.activeElement;
  const backs = Array.from(document.querySelectorAll('.backdrop')).filter((b) => !b.classList.contains('hidden'));
  const bd = backs[backs.length - 1] || null;
  const box = bd ? bd.querySelector('.modal') || bd : null;
  return JSON.stringify({
    id: active ? active.id || '' : null,
    tag: active ? active.tagName.toLowerCase() : null,
    inside: Boolean(active && box && box.contains(active)),
    isBody: !active || active === document.body,
    isFirst: Boolean(active && active.getAttribute && active.getAttribute('data-a5-first') === '1'),
    isLast: Boolean(active && active.getAttribute && active.getAttribute('data-a5-last') === '1'),
    isOpener: Boolean(active && active.getAttribute && active.getAttribute('data-a5-opener') === '1')
  });
})()`;

// 把焦点放到弹层里第一个 / 最后一个可聚焦元素上，并给首尾两个元素各打一个标记
// （测完由测试自己清掉）。首尾标记要一起打：测「末尾 Tab 绕回开头」时，
// 不能因为刚定位过末尾就把开头的标记清掉——那会让「绕回的是不是第一个」误判。
const jsFocusEdge = (which) => `(() => {
  const backs = Array.from(document.querySelectorAll('.backdrop')).filter((b) => !b.classList.contains('hidden'));
  const bd = backs[backs.length - 1] || null;
  if (!bd) return JSON.stringify({ ok: false, reason: 'no-dialog' });
  const box = bd.querySelector('.modal') || bd;
  const list = Array.from(box.querySelectorAll(${SEL}))
    .filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0);
  for (const el of list) {
    el.removeAttribute('data-a5-first');
    el.removeAttribute('data-a5-last');
  }
  if (!list.length) return JSON.stringify({ ok: false, reason: 'no-focusable', count: 0 });
  list[0].setAttribute('data-a5-first', '1');
  list[list.length - 1].setAttribute('data-a5-last', '1');
  const target = ${which === 'last' ? 'list[list.length - 1]' : 'list[0]'};
  target.focus();
  return JSON.stringify({ ok: true, count: list.length, id: target.id || '', tag: target.tagName.toLowerCase() });
})()`;

// 弹层开着时把焦点主动交给编辑区（模拟「替换这一处」这类业务代码），看焦点管理会不会抢
const JS_HANDOFF_TO_EDITOR = `(() => {
  const editor = document.getElementById('editor');
  const backs = Array.from(document.querySelectorAll('.backdrop')).filter((b) => !b.classList.contains('hidden'));
  const bd = backs[backs.length - 1] || null;
  const box = bd ? bd.querySelector('.modal') || bd : null;
  if (!editor) return JSON.stringify({ ok: false });
  editor.focus();
  return JSON.stringify({
    ok: true,
    respected: document.activeElement === editor,
    inside: Boolean(box && document.activeElement && box.contains(document.activeElement))
  });
})()`;

// 从背景按一次 Tab，看焦点会不会被带回弹层
const JS_BACKGROUND_TAB_TARGET = `(() => {
  const backs = Array.from(document.querySelectorAll('.backdrop')).filter((b) => !b.classList.contains('hidden'));
  const bd = backs[backs.length - 1] || null;
  const box = bd ? bd.querySelector('.modal') || bd : null;
  const active = document.activeElement;
  return JSON.stringify({ inside: Boolean(box && active && box.contains(active)), activeId: active ? active.id || '' : null });
})()`;

const jsFocusId = (id) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (el && el.focus) el.focus();
  const active = document.activeElement;
  if (active && active.getAttribute) active.setAttribute('data-a5-opener', '1');
  return active ? active.id || active.tagName.toLowerCase() : null;
})()`;

const ESC = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))";

module.exports = async function group68DialogFocus(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry, win, sleep } = t;

  // 真实 Tab 按键：Chromium 的焦点遍历走的是键盘事件的默认行为，只有 sendInputEvent 能触发
  const sendTab = async (shift) => {
    const modifiers = shift ? ['shift'] : [];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers });
    await sleep(60);
  };
  const activeNow = async () => JSON.parse(await exec(JS_ACTIVE));
  const dialogInfo = async () => JSON.parse(await exec(JS_DIALOG));

  const ensureWindowFocus = async () => {
    try {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        win.webContents.focus();
      }
    } catch { /* 窗口可能正在销毁 */ }
    for (let i = 0; i < 12; i += 1) {
      try {
        if (await exec('document.hasFocus() === true')) return true;
      } catch { /* 页面可能还没就绪 */ }
      try { win.focus(); } catch { /* 忽略 */ }
      await sleep(120);
    }
    return false;
  };

  // 逐个弹层：打开 → 焦点进来 → Tab 整圈不出去 → 首尾绕回 → 关闭后焦点不丢
  const checkDialog = async (spec) => {
    const name = spec.name;
    // 打开前先让「打开它的那个控件」拿到焦点（会让焦点归还这条断言有明确目标）
    await exec(jsFocusId(spec.opener));
    await exec(spec.open);
    await waitFor(`!document.getElementById(${JSON.stringify(spec.backdrop)}).classList.contains('hidden')`);
    await sleep(160);

    const info = await dialogInfo();
    check(`${name}：打开后焦点在弹层里（不留在背景）`, info.open === true && info.inside === true, info);
    check(`${name}：弹层里有可聚焦元素（键盘能操作）`, info.count > 0, info.count);
    check(
      `${name}：当前弹层就是刚打开的这个`,
      info.id === spec.backdrop,
      { got: info.id, want: spec.backdrop }
    );

    // ① 从第一个元素开始，Tab 走一整圈（count 次）都不许跑出弹层，最后回到第一个
    const first = JSON.parse(await exec(jsFocusEdge('first')));
    check(`${name}：能定位到第一个可聚焦元素`, first.ok === true, first);
    let escapedAt = null;
    let lastInside = null;
    for (let step = 1; step <= Math.max(1, first.count); step += 1) {
      await sendTab(false);
      const now = await activeNow();
      lastInside = now;
      if (!now.inside) {
        escapedAt = step;
        break;
      }
    }
    check(`${name}：Tab 走一整圈都不跑出弹层`, escapedAt === null, { escapedAt, count: first.count, landed: lastInside });
    check(`${name}：Tab 走完一圈回到第一个元素（首尾绕回）`, escapedAt === null && lastInside && lastInside.isFirst === true, lastInside);

    // ② 最后一个元素再 Tab 一次 → 绕回第一个，仍在弹层里
    const last = JSON.parse(await exec(jsFocusEdge('last')));
    check(`${name}：能定位到最后一个可聚焦元素`, last.ok === true, last);
    if (first.count > 1) {
      await sendTab(false);
      const wrapped = await activeNow();
      check(
        `${name}：最后一个再 Tab 回到第一个（不滑到背景）`,
        wrapped.inside === true && wrapped.isFirst === true,
        wrapped
      );
      // ③ 第一个元素 Shift+Tab → 绕到最后一个，仍在弹层里
      await exec(jsFocusEdge('first'));
      await sendTab(true);
      const backWrapped = await activeNow();
      check(
        `${name}：第一个 Shift+Tab 回到最后一个（不滑到背景）`,
        backWrapped.inside === true && backWrapped.isLast === true,
        backWrapped
      );
    }

    // ④ 弹层里再按 Tab（中间位置）仍然在弹层里——不靠一个固定 sleep 断渲染，直接读 activeElement
    await exec(jsFocusEdge('first'));
    await sendTab(false);
    check(`${name}：中间的 Tab 仍留在弹层里`, (await activeNow()).inside === true);

    // ⑤ 代码主动把焦点交给编辑区（「替换这一处」要把焦点给编辑器才能 insertText）：
    //    焦点管理不许抢——这条交互以前一抢就坏，E2E 的替换断言当场红，所以专门钉一条。
    if (spec.editorHandoff) {
      const hand = JSON.parse(await exec(JS_HANDOFF_TO_EDITOR));
      check(
        `${name}：代码主动把焦点交给编辑区时不被抢（「替换这一处」依赖它）`,
        hand.ok === true && hand.respected === true && hand.inside === false,
        hand
      );
    }

    // ⑥ 焦点在背景时按一次 Tab：要回到弹层里（背景元素不该被 Tab 遍历到）
    await exec(`(() => {
      const el = document.getElementById('btn-back') || document.getElementById('shelf-search');
      if (el && el.focus) el.focus();
    })()`);
    await sendTab(false);
    const pulled = JSON.parse(await exec(JS_BACKGROUND_TAB_TARGET));
    check(`${name}：焦点在背景时按 Tab 会回到弹层`, pulled.inside === true, pulled);

    // ⑦ Esc 关闭：焦点不许丢到 <body>，要还给打开前那个元素
    await exec(ESC);
    await waitFor(`document.getElementById(${JSON.stringify(spec.backdrop)}).classList.contains('hidden')`);
    await sleep(120);
    const after = await activeNow();
    check(`${name}：关闭后焦点没有丢在 body 上`, after.inside === false && after.isBody === false, after);
    check(`${name}：关闭后焦点还给打开前的元素`, after.isOpener === true, after);
    await exec("Array.from(document.querySelectorAll('[data-a5-opener]')).forEach((el) => el.removeAttribute('data-a5-opener'))");

    // 兜底：万一有弹层没关干净，后面的弹层测量会串场；这里直接断言全关掉了
    check(
      `${name}：测完没有留下别的弹层`,
      (await exec("document.querySelectorAll('.backdrop:not(.hidden)').length")) === 0
    );
  };

  // ---------- 演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;
  const created = await storage.createBook(booksRoot, '焦点演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  check('焦点与键盘：演练书造好（2 章）', (await storage.readBookMeta(bookPath)).chapters.length === 2);
  // 书架状态是刷新出来的：新造的书要先刷新才进 state.books（书籍信息弹层按路径查它）
  await exec('window.__cwTest.refreshShelf()');
  await sleep(300);

  const hasFocus = await ensureWindowFocus();
  check('焦点与键盘：自动化窗口拿到了系统焦点（真实按键才有默认焦点遍历）', hasFocus === true);

  // ---------- 书架弹层 ----------
  await checkDialog({
    name: '设置',
    opener: 'btn-settings',
    backdrop: 'settings-backdrop',
    open: 'window.__cwTest.openSettings()'
  });
  await checkDialog({
    name: '书籍信息',
    opener: 'shelf-search',
    backdrop: 'bookinfo-backdrop',
    open: `window.__cwTest.openBookInfoForPath(${JSON.stringify(bookPath)})`
  });

  // ---------- 写作页弹层 ----------
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await ensureWindowFocus();
  const editorDialogs = [
    { name: '排版（整理本章）', opener: 'btn-format', backdrop: 'format-backdrop', open: 'window.__cwTest.openFormatDialog()' },
    { name: '查找替换', opener: 'editor', backdrop: 'find-backdrop', open: 'window.__cwTest.openFindPanel()', editorHandoff: true },
    { name: '跳到哪一章', opener: 'editor', backdrop: 'jump-backdrop', open: 'window.__cwTest.openJumpDialog()' },
    { name: '本书历史', opener: 'editor', backdrop: 'history-backdrop', open: 'window.__cwTest.openHistoryForCurrentBook()' },
    { name: '灵感箱（记一条碎片）', opener: 'editor', backdrop: 'fragment-backdrop', open: 'window.__cwTest.openFragmentDialog()' },
    { name: '灵感箱（插入碎片）', opener: 'editor', backdrop: 'fragments-backdrop', open: 'window.__cwTest.openInsertFragmentDialog()' },
    { name: '校对', opener: 'editor', backdrop: 'proofread-backdrop', open: 'window.__cwTest.openProofreadPanel()' },
    { name: '敏感词预检', opener: 'editor', backdrop: 'sensitive-backdrop', open: 'window.__cwTest.openSensitivePanel()' }
  ];
  for (const spec of editorDialogs) await checkDialog(spec);

  // ---------- 通用询问框（未保存修改返回书架）----------
  // 它压在其它弹层之上（z-index 300），是唯一会跟别的弹层叠在一起的那个，单独测。
  await exec("window.__cwTest.setText('焦点演练：这一段不保存')");
  await exec(jsFocusId('editor'));
  const pending = exec('window.__cwTest.backToShelf()');
  await waitFor('window.__cwTest.modalOpen()');
  await sleep(160);
  const modalInfo = await dialogInfo();
  check('通用询问框：打开后焦点在弹层里', modalInfo.inside === true, modalInfo);
  check('通用询问框：z-index 300 的那个就是当前弹层', modalInfo.id === 'modal-backdrop', modalInfo.id);
  const modalFirst = JSON.parse(await exec(jsFocusEdge('last')));
  if (modalFirst.ok && modalFirst.count > 1) {
    await sendTab(false);
    const wrapped = await activeNow();
    check('通用询问框：最后一个再 Tab 回到第一个（不滑到背景）', wrapped.inside === true && wrapped.isFirst === true, wrapped);
  }
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  await pending.catch(() => {});
  await sleep(120);
  const afterModal = await activeNow();
  check('通用询问框：取消后焦点没有丢在 body 上', afterModal.isBody === false, afterModal);
  check('通用询问框：取消后焦点还给打开前的元素', afterModal.isOpener === true, afterModal);
  await exec("Array.from(document.querySelectorAll('[data-a5-opener]')).forEach((el) => el.removeAttribute('data-a5-opener'))");

  // ---------- 减少动效（prefers-reduced-motion）----------
  // Chromium 的媒体特性仿真只能走 CDP：先显式设成 no-preference 拿基线，再设成 reduce 看效果。
  const wc = win.webContents;
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    attached = true;
    const emulate = (value) =>
      wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        media: '',
        features: [{ name: 'prefers-reduced-motion', value }]
      });
    const readMotion = `(() => {
      const btn = document.getElementById('btn-settings');
      const style = getComputedStyle(btn);
      return JSON.stringify({
        reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        transition: style.transitionDuration,
        animation: style.animationDuration
      });
    })()`;

    // 计算值是 CSS 序列化后的字符串，而且可能是**列表**（`.btn` 过渡四个属性 → `0.12s, 0.12s, …`；
    // 减少动效下实测是 `1e-05s` 而不是 `0.00001s`）。所以先拆成单个值、统一换算成秒，再比阈值。
    const oneSecond = (part) => {
      const hit = /^([\d.e+-]+)(ms|s)$/.exec(String(part == null ? '' : part).trim());
      if (!hit) return NaN;
      const n = Number(hit[1]);
      return hit[2] === 'ms' ? n / 1000 : n;
    };
    const secondsOf = (value) => {
      const list = String(value == null ? '' : value)
        .split(',')
        .map((part) => oneSecond(part))
        .filter((n) => Number.isFinite(n));
      if (!list.length) return NaN;
      return Math.max(...list);
    };

    await emulate('no-preference');
    await sleep(80);
    const normal = JSON.parse(await exec(readMotion));
    check('减少动效：正常模式不命中 reduce（基线）', normal.reduce === false, normal);
    check(
      '减少动效：正常模式下过渡时长还在（没把动效删掉）',
      secondsOf(normal.transition) >= 0.05,
      normal.transition
    );

    await emulate('reduce');
    await sleep(80);
    const reduced = JSON.parse(await exec(readMotion));
    check('减少动效：系统「减少动画」时媒体查询命中', reduced.reduce === true, reduced);
    check(
      '减少动效：过渡时长被压到 0.01ms（约等于瞬时）',
      secondsOf(reduced.transition) > 0 && secondsOf(reduced.transition) <= 0.0001,
      reduced.transition
    );
    check(
      '减少动效：动画时长也被压到 0.01ms',
      secondsOf(reduced.animation) > 0 && secondsOf(reduced.animation) <= 0.0001,
      reduced.animation
    );
  } finally {
    if (attached) {
      try {
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { media: '', features: [] });
      } catch { /* 窗口可能已经关了 */ }
      try { wc.debugger.detach(); } catch { /* 已经断开 */ }
    }
  }

  // ---------- 收尾 ----------
  // 手上有未保存的字：先存掉（否则回书架又会弹「保存吗」），再删演练书、核对书架数量
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  const deleted = await deleteBookWithRetry(bookPath);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfAfter = (await storage.listBooks(booksRoot)).length;
  check(
    '焦点与键盘：演练书已收尾（书架数量复原、删除走书架 _trash）',
    shelfAfter === shelfBefore && Boolean(deleted && deleted.ok === true),
    { shelfBefore, shelfAfter, deleted }
  );
  check(
    '焦点与键盘：演练期间没有留下任何打开的弹层',
    (await exec("document.querySelectorAll('.backdrop:not(.hidden)').length")) === 0
  );
};
