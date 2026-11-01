// E2E 第 70 组：弹层无障碍名称 + 书卡 / 章节条目的键盘可达（v0.9 A-5b）。
//
// 钉住两件事：
//   1. **13 个弹层都有无障碍名称**：`role="dialog"` 挂 `aria-labelledby`、指向真标题——
//      以前 13 个弹层的标题只有 3 个有 id、没有一个挂 aria-labelledby，读屏进弹层只报
//      「对话框」，分不清是设置还是排版。
//   2. **只用键盘也能开会话、切章**：书卡与章节条目以前都是普通 <div>（tabIndex -1），
//      能 Tab 到书卡右上角的「⋯」却打不开书、能 Tab 到顶栏却切不了章。现在书卡 / 章节条目
//      都可 Tab 到、Enter / 空格激活；章节列表用 roving tabindex（只有当前章是 Tab 停留点），
//      方向键在列表里移焦点、Tab 直接跳出列表。
//
// 为什么必须 E2E：Tab 焦点遍历与「Enter 触发按钮」都是浏览器默认行为，渲染层 dispatch 的
// KeyboardEvent 走不到；这里用 win.webContents.sendInputEvent 发**真实按键**再读 activeElement。
// 另外钉一条「鼠标行为没变」：点章节条目照旧切章（本轮只补键盘通道）。
//
// 自足：自己造一本 2 章的演练书，收尾走书架 _trash 删掉；不写配置、不碰真实书架。
const BACKDROPS = [
  'find-backdrop',
  'proofread-backdrop',
  'sensitive-backdrop',
  'export-backdrop',
  'jump-backdrop',
  'conflict-backdrop',
  'bookinfo-backdrop',
  'history-backdrop',
  'fragment-backdrop',
  'fragments-backdrop',
  'modal-backdrop',
  'format-backdrop',
  'settings-backdrop'
];

// 每个弹层的标题应该是哪一句（export / history / modal 的标题是动态的，只比前缀 / 非空）
const EXPECTED_NAMES = {
  'find-backdrop': '查找替换',
  'proofread-backdrop': '校对',
  'sensitive-backdrop': '敏感词预检',
  'export-backdrop': '导出',
  'jump-backdrop': '跳到哪一章',
  'conflict-backdrop': '检测到同步冲突副本',
  'bookinfo-backdrop': '书籍信息',
  'history-backdrop': '本书历史',
  'fragment-backdrop': '记一条碎片',
  'fragments-backdrop': '插入碎片',
  'format-backdrop': '智能排版',
  'settings-backdrop': '设置'
};

const JS_NAMES = `(() => {
  const ids = ${JSON.stringify(BACKDROPS)};
  return JSON.stringify(ids.map((id) => {
    const bd = document.getElementById(id);
    const dialog = bd ? bd.querySelector('[role="dialog"]') : null;
    const labelledby = dialog ? dialog.getAttribute('aria-labelledby') : null;
    const el = labelledby ? document.getElementById(labelledby) : null;
    return {
      id,
      hasDialog: Boolean(dialog),
      ariaModal: dialog ? dialog.getAttribute('aria-modal') : null,
      labelledby,
      exists: Boolean(el),
      isTitle: Boolean(el && el.classList.contains('modal-title')),
      name: el ? (el.textContent || '').trim() : ''
    };
  }));
})()`;

const JS_CARD = `(() => {
  const card = document.querySelector('#book-grid .book-card:not(.new-book)');
  if (!card) return JSON.stringify({ found: false });
  return JSON.stringify({
    found: true,
    tag: card.tagName.toLowerCase(),
    role: card.getAttribute('role'),
    label: card.getAttribute('aria-label'),
    tabIndex: card.tabIndex,
    path: card.dataset.path || '',
    title: (card.querySelector('.book-card-title') || {}).textContent || ''
  });
})()`;

const JS_CHAPTER_TABS = `(() => {
  const items = Array.from(document.querySelectorAll('#chapter-list .chapter-item'));
  const active = document.querySelector('#chapter-list .chapter-item.active');
  return JSON.stringify({
    total: items.length,
    zeros: items.filter((el) => el.tabIndex === 0).map((el) => el.dataset.index),
    role: items.length ? items[0].getAttribute('role') : null,
    label: items.length ? items[0].getAttribute('aria-label') : null,
    activeIndex: active ? active.dataset.index : null
  });
})()`;

const JS_FOCUS_CHAPTER = (index) => `(() => {
  const item = document.querySelector('#chapter-list .chapter-item[data-index="${index}"]');
  if (!item) return JSON.stringify({ ok: false });
  item.focus();
  return JSON.stringify({
    ok: true,
    focused: document.activeElement === item,
    activeIndex: document.activeElement ? document.activeElement.dataset.index : null
  });
})()`;

const JS_FOCUSED = `(() => {
  const active = document.activeElement;
  if (!active) return JSON.stringify({ tag: null });
  return JSON.stringify({
    tag: active.tagName.toLowerCase(),
    id: active.id || '',
    cls: typeof active.className === 'string' ? active.className : '',
    chapterIndex: active.dataset ? active.dataset.index || null : null,
    cardPath: active.dataset ? active.dataset.path || null : null,
    cardTitle: active.classList && active.classList.contains('book-card')
      ? (active.querySelector('.book-card-title') || {}).textContent || ''
      : null
  });
})()`;

module.exports = async function group70A11yKeyboard(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry, win, sleep } = t;

  // 真实按键：Tab / Enter / 空格 / 方向键都要靠浏览器默认行为，只有 sendInputEvent 能触发
  const sendKey = async (keyCode, modifiers = [], wait = 90) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(wait);
  };
  const sendTab = (shift = false) => sendKey('Tab', shift ? ['shift'] : []);
  const focused = async () => JSON.parse(await exec(JS_FOCUSED));

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

  // ---------- 演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;
  const created = await storage.createBook(booksRoot, '键盘演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  await exec('window.__cwTest.refreshShelf()');
  await sleep(300);
  const hasFocus = await ensureWindowFocus();
  check('键盘可达：自动化窗口拿到了系统焦点（真实按键才有默认焦点遍历）', hasFocus === true);

  // ---------- A. 13 个弹层的无障碍名称 ----------
  const names = JSON.parse(await exec(JS_NAMES));
  check('无障碍名称：13 个弹层都在页面上', names.length === 13, names.length);
  let named = 0;
  for (const item of names) {
    const want = EXPECTED_NAMES[item.id];
    const ok =
      item.hasDialog === true &&
      item.ariaModal === 'true' &&
      Boolean(item.labelledby) &&
      item.exists === true &&
      item.isTitle === true &&
      item.name.length > 0 &&
      (!want || item.name.startsWith(want));
    if (ok && item.id !== 'modal-backdrop') named += 1;
    check(
      `无障碍名称：${item.id} 的弹层挂了 aria-labelledby 且指向真标题（${item.name || '空'}）`,
      ok,
      item
    );
  }
  check('无障碍名称：12 个固定标题的弹层都有名字（通用询问框的标题是动态的，进写作页后单独测）', named === 12, named);

  // ---------- B. 书架书卡：Tab 可达 + Enter / 空格打开 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  const card = JSON.parse(await exec(JS_CARD));
  check('键盘可达：书卡是可聚焦的按钮（role=button / tabindex=0 / 有书名）', card.found === true && card.tabIndex === 0 && card.role === 'button' && /^打开《.+》$/.test(card.label || ''), card);

  // 真实 Tab：从书架搜索框出发，几次 Tab 之内应该走到书卡（以前只能走到「⋯」按钮）
  await exec("document.getElementById('shelf-search').focus()");
  let tabToCard = null;
  let hit = null;
  for (let step = 1; step <= 16; step += 1) {
    await sendTab(false);
    const now = await focused();
    if (now.cardPath && now.cls && now.cls.split(/\s+/).includes('book-card')) {
      tabToCard = step;
      hit = now;
      break;
    }
  }
  check('键盘可达：Tab 能走到书卡上（不只是「⋯」按钮）', tabToCard !== null, { tabToCard, hit });
  check('键盘可达：Tab 停在书卡上时整个卡片是焦点（不是里面的按钮）', Boolean(hit && hit.cardTitle), hit);

  // 真实 Enter 打开这本书
  const wantedPath = hit && hit.cardPath;
  await sendKey('Enter', [], 200);
  await waitFor("window.__cwTest.view() === 'editor'", 8000);
  check('键盘可达：书卡上按 Enter 就打开这本书（不用鼠标）', (await exec('window.__cwTest.view()')) === 'editor');
  check(
    '键盘可达：Enter 打开的就是焦点所在的那本书',
    (await exec('window.__cwTest.bookPathValue()')) === wantedPath,
    { got: await exec('window.__cwTest.bookPathValue()'), want: wantedPath }
  );

  // 空格也能打开（回书架，直接聚焦演练书的书卡再按空格）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  const focusedCard = await exec(`(() => {
    const cards = Array.from(document.querySelectorAll('#book-grid .book-card'));
    const el = cards.find((c) => c.dataset.path === ${JSON.stringify(bookPath)});
    if (el) el.focus();
    return Boolean(el);
  })()`);
  check('键盘可达：书架上能找到演练书的书卡并聚焦', focusedCard === true);
  await sendKey(' ', [], 200);
  await waitFor("window.__cwTest.view() === 'editor'", 8000);
  check('键盘可达：书卡上按空格也打开这本书', (await exec('window.__cwTest.view()')) === 'editor');

  // 「⋯」按钮自己响应 Enter（卡片不抢）：书卡把 keydown 委托在容器上，如果它对「焦点在卡片里
  // 那个按钮上」的 Enter 也 preventDefault，按钮的原生激活（Enter 触发 click）就被吃掉了。
  // Electron 的 sendInputEvent 只发原始键盘消息、触发不了按钮的原生激活（要 char 事件），
  // 所以这里直接看**默认行为有没有被拦**，再点一下确认菜单照旧能开。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  await exec("(() => { const more = document.querySelector('#book-grid .book-card .book-card-more'); if (more) more.focus(); return Boolean(more); })()");
  const nestedPrevented = await exec(`(() => {
    const more = document.querySelector('#book-grid .book-card .book-card-more');
    if (!more) return JSON.stringify({ ok: false });
    let seen = null;
    const spy = (event) => { seen = event.defaultPrevented; };
    document.addEventListener('keydown', spy, { once: true });
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', spy);
    return JSON.stringify({ ok: true, defaultPrevented: seen, focused: document.activeElement === more });
  })()`);
  const nested = JSON.parse(nestedPrevented);
  check(
    '键盘可达：焦点在书卡里的「⋯」上时，卡片的键盘处理不拦它的 Enter（原生激活不被吃掉）',
    nested.ok === true && nested.focused === true && nested.defaultPrevented === false,
    nested
  );
  await exec("document.querySelector('#book-grid .book-card .book-card-more').click()");
  await sleep(120);
  const menuOpen = await exec("!document.getElementById('book-menu').classList.contains('hidden')");
  const stillShelf = (await exec('window.__cwTest.view()')) === 'shelf';
  check('键盘可达：「⋯」照旧打开书卡菜单、不打开书（鼠标路径没变）', menuOpen === true && stillShelf === true, { menuOpen, stillShelf });
  await exec("document.getElementById('book-menu').classList.add('hidden')");

  // ---------- C. 章节列表：roving tabindex + 方向键 / Enter / 空格 ----------
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await ensureWindowFocus();
  const tabs = JSON.parse(await exec(JS_CHAPTER_TABS));
  check('键盘可达：章节条目是按钮且带无障碍名称', tabs.role === 'button' && /^打开第\d+章/.test(tabs.label || ''), tabs);
  check(
    '键盘可达：整张列表只有一个 Tab 停留点，就是当前章（roving tabindex）',
    tabs.zeros.length === 1 && tabs.zeros[0] === tabs.activeIndex,
    tabs
  );

  const titleBefore = await exec('window.__cwTest.currentTitle()');
  await exec(JS_FOCUS_CHAPTER(0));
  await sendKey('Down');
  const afterArrow = await focused();
  check(
    '键盘可达：方向键把焦点移到下一章（不切章）',
    afterArrow.chapterIndex === '1' && (await exec('window.__cwTest.currentTitle()')) === titleBefore,
    afterArrow
  );
  const rovingAfterArrow = JSON.parse(await exec(JS_CHAPTER_TABS));
  check(
    '键盘可达：焦点移到哪一条，roving 停留点就跟到哪一条',
    rovingAfterArrow.zeros.length === 1 && rovingAfterArrow.zeros[0] === '1',
    rovingAfterArrow
  );

  await sendKey('Enter', [], 250);
  await waitFor(`window.__cwTest.currentTitle() !== ${JSON.stringify(titleBefore)}`, 8000);
  const titleAfterEnter = await exec('window.__cwTest.currentTitle()');
  check('键盘可达：章节条目上按 Enter 切章（不用鼠标）', titleAfterEnter !== titleBefore, { titleBefore, titleAfterEnter });

  // 空格也切回来（聚焦第一章再按空格）
  await exec(JS_FOCUS_CHAPTER(0));
  await sendKey(' ', [], 250);
  await waitFor(`window.__cwTest.currentTitle() === ${JSON.stringify(titleBefore)}`, 8000);
  check('键盘可达：章节条目上按空格也切章', (await exec('window.__cwTest.currentTitle()')) === titleBefore);

  // 鼠标行为没变：真实点击第二章照旧切章
  await exec("document.querySelector('#chapter-list .chapter-item[data-index=\"1\"]').click()");
  await waitFor(`window.__cwTest.currentTitle() === ${JSON.stringify(titleAfterEnter)}`, 8000);
  check('键盘可达：鼠标点章节条目照旧切章（只补键盘通道，没改鼠标）', (await exec('window.__cwTest.currentTitle()')) === titleAfterEnter);

  // ---------- D. 通用询问框的名字（标题是打开的瞬间填进去的，得真开一次）----------
  await exec("window.__cwTest.setText('键盘可达：这一段不保存')");
  const pending = exec('window.__cwTest.backToShelf()');
  await waitFor('window.__cwTest.modalOpen()');
  await sleep(160);
  const modalName = JSON.parse(await exec(JS_NAMES)).find((item) => item.id === 'modal-backdrop');
  check(
    '无障碍名称：通用询问框打开后有非空名字（读屏能读出在问什么）',
    Boolean(modalName && modalName.labelledby === 'modal-title' && modalName.name.length > 0),
    modalName
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  await pending.catch(() => {});
  await sleep(160);
  // 取消之后正文还是「未保存」：存掉再往下走（否则回书架又会弹询问、后面的 exec 会一直等）
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 8000);

  // ---------- E. 只用键盘存盘（Ctrl+S）----------
  await exec("window.__cwTest.setText('键盘存盘：这两个字要落盘')");
  await waitFor('window.__cwTest.dirty() === true', 4000);
  await sendKey('S', ['control'], 300);
  // 真实按键没生效也要先收尾（别把未保存状态留给后面的组），再让断言红
  const savedByKeys = await waitFor('window.__cwTest.dirty() === false', 5000).catch(() => false);
  check('键盘可达：Ctrl+S 真实按键把正文落盘（键盘走完「打开 → 切章 → 保存」）', savedByKeys === true);
  if (!savedByKeys) await exec('window.__cwTest.save()');

  // ---------- 收尾 ----------
  const meta = await storage.readBookMeta(bookPath);
  const savedText = await storage.loadChapterText(bookPath, meta.chapters[1].file);
  check('键盘可达：真的落盘了（磁盘正文就是键盘存进去的那一段）', savedText.text.includes('键盘存盘'), savedText.text.slice(0, 40));
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(150);
  const deleted = await deleteBookWithRetry(bookPath);
  check('键盘可达：演练书已收尾（删除走书架 _trash）', Boolean(deleted && deleted.ok === true), deleted);
  const shelfAfter = (await storage.listBooks(booksRoot)).length;
  check('键盘可达：书架数量回到演练前', shelfAfter === shelfBefore, { before: shelfBefore, after: shelfAfter });
  check(
    '键盘可达：演练期间没有留下打开的弹层 / 菜单',
    (await exec("document.querySelectorAll('.backdrop:not(.hidden)').length")) === 0
  );
};
