// E2E 第 71 组：右键菜单 / 顶栏下拉 / 分卷标题行的键盘可达（v0.9 A-5c）。
//
// A-5b 把弹层、章节条目、书卡补成键盘可达之后，还剩下「只有鼠标才拿得到」的三块，本组钉住：
//   1. **右键菜单**（章节 / 卷 / 书卡）：以前打开后焦点不进菜单、菜单条目又在 DOM 末尾，
//      Tab 走一整圈也到不了 → 键盘用户拿不到「重命名 / 编辑备注 / 移到卷… / 删除」；
//   2. **顶栏下拉**（整理 ▾ / 显示 ▾ / 导出 ▾）：整理卡按 Esc 收起后，把焦点还给按钮
//      又会立刻把卡片重新打开（等于 Esc 关不掉）；导出菜单按 Esc 收起后焦点直接丢到 <body>；
//   3. **分卷标题行**（折叠 / 展开）：以前是普通 <div>（tabIndex -1），Tab 到不了、键盘收不起卷。
//
// 为什么必须 E2E：真实焦点遍历、真实按键（Shift+F10 / Tab / 方向键 / Esc）与浏览器原生的
// contextmenu 合成都只有真实 Electron 才有；这里用 win.webContents.sendInputEvent 发**真实按键**，
// 再读 document.activeElement 与菜单的可见状态。鼠标路径（右键出现的位置、点条目照旧生效）也钉住。
//
// 自足：自己造一本 2 章 + 1 卷的演练书，收尾走书架 _trash 删掉；不写配置、不碰真实书架。
const JS_FOCUSED = `(() => {
  const a = document.activeElement;
  if (!a) return JSON.stringify({ tag: null, inMenu: [] });
  const menus = { context: 'context-menu', volume: 'volume-menu', book: 'book-menu', format: 'format-menu', display: 'display-menu', export: 'export-menu' };
  const inMenu = Object.keys(menus).filter((k) => {
    const m = document.getElementById(menus[k]);
    return m && m.contains(a);
  });
  return JSON.stringify({
    tag: a.tagName.toLowerCase(),
    id: a.id || '',
    cls: typeof a.className === 'string' ? a.className : '',
    text: (a.textContent || '').trim(),
    inMenu,
    chapterIndex: a.dataset ? (a.dataset.index == null ? null : a.dataset.index) : null,
    volumeId: a.dataset ? (a.dataset.volumeId == null ? null : a.dataset.volumeId) : null,
    more: Boolean(a.classList && a.classList.contains('book-card-more'))
  });
})()`;

const JS_VOLUME_ROWS = `(() => {
  const rows = Array.from(document.querySelectorAll('#chapter-list .volume-item'));
  return JSON.stringify(rows.map((r) => ({
    id: r.dataset.volumeId == null ? '' : r.dataset.volumeId,
    tabIndex: r.tabIndex,
    role: r.getAttribute('role'),
    expanded: r.getAttribute('aria-expanded'),
    collapsed: r.classList.contains('collapsed'),
    name: (r.querySelector('.volume-name') || {}).textContent || ''
  })));
})()`;

module.exports = async function group71MenuKeyboard(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry, win, sleep } = t;

  // 真实按键：Shift+F10 / Tab / 方向键 / Esc 都要靠浏览器默认行为，只有 sendInputEvent 能触发。
  // 方向键必须用 Chromium 的加速键名 Down / Up（写 ArrowDown 发出去是 Unidentified，见 A-5b）。
  const sendKey = async (keyCode, modifiers = [], wait = 110) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(wait);
  };
  const focused = async () => JSON.parse(await exec(JS_FOCUSED));
  const isOpen = (id) => exec(`!document.getElementById('${id}').classList.contains('hidden')`);
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
  const rightClick = (selector, offsetX = 20, offsetY = 10) =>
    exec(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + ${offsetX}, clientY: r.top + ${offsetY} }));
      return true;
    })()`);

  // ---------- 演练书（2 章 + 1 卷，第 1 章在卷里、第 2 章是「未分卷」）----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;
  const created = await storage.createBook(booksRoot, '菜单键盘演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  await exec('window.__cwTest.refreshShelf()');
  await sleep(250);
  const hasFocus = await ensureWindowFocus();
  check('菜单键盘：自动化窗口拿到了系统焦点（真实按键才有默认焦点遍历）', hasFocus === true);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await ensureWindowFocus();
  await exec("window.__cwTest.newVolume('卷一')");
  await sleep(200);
  await exec('window.__cwTest.moveChapterToVolumeAt(0, 0)');
  await sleep(250);
  const volumeIds = await exec('window.__cwTest.volumeIds()');
  const volumeId = volumeIds[0];
  const chapterVolumes = await exec('window.__cwTest.chapterVolumeIds()');
  // 移到卷里之后书目会按「未分卷在前、各卷在后」重排，所以这里只数个数、不假设下标
  check(
    '菜单键盘：演练书有一个卷（它里面正好一章、另一章是未分卷）',
    volumeIds.length === 1 &&
      chapterVolumes.filter((id) => id === volumeId).length === 1 &&
      chapterVolumes.filter((id) => id === null).length === 1,
    { volumeIds, chapterVolumes }
  );

  // ---------- A. 章节右键菜单：Shift+F10 打开 + 焦点进菜单 + 方向键 + Esc 归还 ----------
  await exec("document.querySelector('#chapter-list .chapter-item[data-index=\"1\"]').focus()");
  await sendKey('F10', ['shift'], 200);
  let open = await isOpen('context-menu');
  let now = await focused();
  check(
    '菜单键盘：章节条目上按 Shift+F10 打开右键菜单（浏览器原生合成 contextmenu）',
    open === true,
    { open, focus: now.text }
  );
  check(
    '菜单键盘：右键菜单打开时焦点被带进第一条可用条目（以前留在章节条目上）',
    now.inMenu.includes('context') && now.text === '标记为完稿',
    now
  );

  await sendKey('Down');
  const second = await focused();
  await sendKey('Down');
  const third = await focused();
  check(
    '菜单键盘：方向键在菜单里上下移动（跳过当前状态打勾后的文案也对）',
    second.text === '标记为待修' && third.text === '✓ 标记为草稿',
    { second: second.text, third: third.text }
  );
  await sendKey('Up');
  check('菜单键盘：方向键往回走一格', (await focused()).text === '标记为待修');
  await sendKey('End');
  const last = await focused();
  await sendKey('Home');
  const first = await focused();
  check(
    '菜单键盘：Home / End 到菜单两头（最后一条是删除）',
    last.text.startsWith('删除') && first.text === '标记为完稿',
    { last: last.text, first: first.text }
  );
  await sendKey('Escape', [], 160);
  open = await isOpen('context-menu');
  now = await focused();
  check(
    '菜单键盘：Esc 收起右键菜单并把焦点还给打开它的章节条目',
    open === false && now.chapterIndex === '1' && now.inMenu.length === 0,
    { open, focus: now }
  );

  // ---------- B. 鼠标右键路径：焦点同样进菜单，位置仍在鼠标处，Esc 还给被右键的那一条 ----------
  await rightClick("#chapter-list .chapter-item[data-index=\"0\"]", 20, 10);
  await sleep(180);
  open = await isOpen('context-menu');
  now = await focused();
  const menuRect = JSON.parse(await exec(`(() => {
    const r = document.getElementById('context-menu').getBoundingClientRect();
    const item = document.querySelector('#chapter-list .chapter-item[data-index="0"]');
    const ir = item.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), itemLeft: Math.round(ir.left + 20), itemTop: Math.round(ir.top + 10) });
  })()`));
  check(
    '菜单键盘：鼠标右键打开的菜单焦点也进第一条（右键不移动焦点，打开者另记）',
    open === true && now.inMenu.includes('context') && now.text.startsWith('标记为'),
    now
  );
  check(
    '菜单键盘：右键菜单仍出现在鼠标处（只补键盘通道，没改定位）',
    Math.abs(menuRect.left - menuRect.itemLeft) < 1.5 && Math.abs(menuRect.top - menuRect.itemTop) < 1.5,
    menuRect
  );
  await sendKey('Escape', [], 160);
  now = await focused();
  check(
    '菜单键盘：Esc 把焦点还给「被右键的那一条」（不是上一次拿焦点的那一条）',
    now.chapterIndex === '0' && now.inMenu.length === 0,
    now
  );

  // ---------- C. Tab 在右键菜单里也算收起（菜单条目在 DOM 末尾，Tab 出去会跑到页面开头）----------
  await rightClick("#chapter-list .chapter-item[data-index=\"1\"]");
  await sleep(160);
  await sendKey('Tab', [], 160);
  open = await isOpen('context-menu');
  now = await focused();
  check(
    '菜单键盘：右键菜单里按 Tab 收起菜单、焦点回到打开它的章节条目（不迷路）',
    open === false && now.chapterIndex === '1',
    { open, focus: now }
  );

  // ---------- D. 菜单条目照旧点得到（焦点进菜单不影响鼠标点击）----------
  await rightClick("#chapter-list .chapter-item[data-index=\"1\"]");
  await sleep(160);
  const statusBefore = await exec("document.querySelector('#chapter-list .chapter-item[data-index=\"1\"]').dataset.status");
  await exec("document.querySelector('#context-menu button[data-action=\"status-done\"]').click()");
  await sleep(250);
  const statusAfter = await exec("document.querySelector('#chapter-list .chapter-item[data-index=\"1\"]').dataset.status");
  check(
    '菜单键盘：鼠标点菜单条目照旧生效（状态改完稿），菜单随即收起',
    statusBefore !== 'done' && statusAfter === 'done' && (await isOpen('context-menu')) === false,
    { statusBefore, statusAfter }
  );

  // ---------- E. 分卷标题行：可聚焦 + role / aria-expanded + Enter 折叠展开 + 焦点不丢 ----------
  const rowsBefore = JSON.parse(await exec(JS_VOLUME_ROWS));
  const volumeRow = rowsBefore.find((row) => row.id === volumeId);
  check(
    '分卷键盘：分卷标题行是 role=button / tabIndex=0 / aria-expanded=true（以前 tabIndex -1、role=null）',
    rowsBefore.length === 2 &&
      Boolean(volumeRow) &&
      rowsBefore.every((row) => row.tabIndex === 0 && row.role === 'button') &&
      volumeRow.expanded === 'true',
    rowsBefore
  );
  const focusedVolume = await exec(`(() => {
    const row = Array.from(document.querySelectorAll('#chapter-list .volume-item')).find((r) => r.dataset.volumeId === ${JSON.stringify(volumeId)});
    if (!row) return false;
    row.focus();
    return document.activeElement === row;
  })()`);
  check('分卷键盘：分卷标题行真的能拿到焦点（Tab 站得住了）', focusedVolume === true);
  await sendKey('Enter', [], 350);
  const collapsedAfter = await exec('window.__cwTest.collapsedVolumes()');
  const rowsCollapsed = JSON.parse(await exec(JS_VOLUME_ROWS));
  now = await focused();
  check(
    '分卷键盘：Enter 折叠这一卷（以前按了什么都不发生）',
    collapsedAfter.includes(volumeId) && rowsCollapsed.find((row) => row.id === volumeId).expanded === 'false',
    { collapsedAfter, rows: rowsCollapsed.map((row) => `${row.id}:${row.expanded}`) }
  );
  check(
    '分卷键盘：折叠会重建列表，焦点仍回到同一卷的标题行（不丢到 body）',
    now.volumeId === volumeId && now.cls.includes('volume-item'),
    now
  );
  await sendKey('Enter', [], 350);
  const expandedAgain = await exec('window.__cwTest.collapsedVolumes()');
  now = await focused();
  check(
    '分卷键盘：再按 Enter 展开，焦点仍在同一卷',
    expandedAgain.includes(volumeId) === false && now.volumeId === volumeId,
    { expandedAgain, focus: now }
  );

  // ---------- F. 卷右键菜单：焦点进菜单、Esc 还给卷标题行 ----------
  await rightClick(`#chapter-list .volume-item[data-volume-id="${volumeId}"]`, 20, 8);
  await sleep(180);
  open = await isOpen('volume-menu');
  now = await focused();
  check(
    '菜单键盘：卷菜单打开时焦点进第一条（「在此卷末尾新建章节」）',
    open === true && now.inMenu.includes('volume') && now.text === '在此卷末尾新建章节',
    now
  );
  await sendKey('Escape', [], 160);
  now = await focused();
  check(
    '菜单键盘：Esc 收起卷菜单并把焦点还给卷标题行',
    (await isOpen('volume-menu')) === false && now.volumeId === volumeId,
    now
  );

  // ---------- G. 书卡菜单（「⋯」→ 焦点进菜单 → Esc 还给「⋯」）----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(250);
  await ensureWindowFocus();
  const openedBookMenu = await exec(`(() => {
    const card = Array.from(document.querySelectorAll('#book-grid .book-card')).find((c) => c.dataset.path === ${JSON.stringify(bookPath)});
    if (!card) return false;
    const more = card.querySelector('.book-card-more');
    if (!more) return false;
    more.focus();
    more.click();
    return true;
  })()`);
  await sleep(180);
  open = await isOpen('book-menu');
  now = await focused();
  check(
    '菜单键盘：书卡「⋯」打开的菜单焦点进第一条（「打开这本书」）',
    openedBookMenu === true && open === true && now.inMenu.includes('book') && now.text === '打开这本书',
    now
  );
  await sendKey('Escape', [], 160);
  now = await focused();
  check(
    '菜单键盘：Esc 收起书卡菜单并把焦点还给「⋯」按钮',
    (await isOpen('book-menu')) === false && now.more === true,
    now
  );

  // ---------- H. 顶栏「显示 ▾」：点开 → Tab 进菜单 → Esc 收起并还给按钮 ----------
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await ensureWindowFocus();
  await exec("document.getElementById('btn-display').focus(); document.getElementById('btn-display').click()");
  await sleep(160);
  const displayOpen = await isOpen('display-menu');
  await sendKey('Tab', [], 140);
  now = await focused();
  const displayTabbedIn = now.inMenu.includes('display');
  await sendKey('Escape', [], 160);
  now = await focused();
  check(
    '菜单键盘：「显示 ▾」点开后 Tab 能进菜单，Esc 收起并还给按钮（A-5b 量到本来就通，这里补断言）',
    displayOpen === true && displayTabbedIn === true && (await isOpen('display-menu')) === false && now.id === 'btn-display',
    { displayOpen, displayTabbedIn, focus: now }
  );

  // ---------- I. 顶栏「导出 ▾」：同样的口径（改前 Esc 会把焦点丢到 <body>）----------
  await exec("document.getElementById('btn-export').focus(); document.getElementById('btn-export').click()");
  await sleep(160);
  const exportOpen = await isOpen('export-menu');
  await sendKey('Tab', [], 140);
  now = await focused();
  const exportTabbedIn = now.inMenu.includes('export');
  await sendKey('Escape', [], 160);
  now = await focused();
  check(
    '菜单键盘：「导出 ▾」Tab 能进菜单，Esc 收起并把焦点还给按钮（以前丢到 <body>）',
    exportOpen === true && exportTabbedIn === true && (await isOpen('export-menu')) === false && now.id === 'btn-export',
    { exportOpen, exportTabbedIn, focus: now }
  );

  // ---------- J. 顶栏「整理 ▾」卡：Esc 收起后不许被按钮的 focusin 又弹开 ----------
  await exec("document.getElementById('btn-format').focus()");
  await sleep(250);
  const formatOpen = await isOpen('format-menu');
  await sendKey('Tab', [], 140);
  now = await focused();
  const formatTabbedIn = now.inMenu.includes('format');
  await sendKey('Escape', [], 200);
  const formatClosedNow = (await isOpen('format-menu')) === false;
  await sleep(420);
  const formatStaysClosed = (await isOpen('format-menu')) === false;
  now = await focused();
  check(
    '菜单键盘：「整理 ▾」卡里按 Esc 真的收起（改前焦点还给按钮 → focusin 又立刻把卡片打开）',
    formatOpen === true && formatTabbedIn === true && formatClosedNow === true && formatStaysClosed === true,
    { formatOpen, formatTabbedIn, formatClosedNow, formatStaysClosed }
  );
  check('菜单键盘：「整理 ▾」Esc 之后焦点回到按钮上', now.id === 'btn-format', now);
  const reopen = await exec(`(() => {
    const btn = document.getElementById('btn-format');
    // Esc 之后焦点本来就停在按钮上；先 blur 再 focus 才算一次新的「Tab 回来」
    btn.blur();
    btn.focus();
    return !document.getElementById('format-menu').classList.contains('hidden');
  })()`);
  check('菜单键盘：再次聚焦「整理 ▾」照旧弹开卡片（Esc 只拦那一次，键盘入口没被弄坏）', reopen === true);
  await exec("document.getElementById('btn-format').blur()");
  await sleep(200);

  // ---------- K. 鼠标主路径没变：点章节条目照旧切章 ----------
  const activeIndex = await exec("document.querySelector('#chapter-list .chapter-item.active').dataset.index");
  const otherIndex = activeIndex === '0' ? '1' : '0';
  const titleBefore = await exec('window.__cwTest.currentTitle()');
  await exec(`document.querySelector('#chapter-list .chapter-item[data-index="${otherIndex}"]').click()`);
  await waitFor(`window.__cwTest.currentTitle() !== ${JSON.stringify(titleBefore)}`, 8000);
  check(
    '菜单键盘：鼠标点章节条目照旧切章（这一轮只补键盘通道）',
    (await exec("document.querySelector('#chapter-list .chapter-item.active').dataset.index")) === otherIndex
  );

  // ---------- 收尾 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  const deleted = await deleteBookWithRetry(bookPath);
  check('菜单键盘：演练书已收尾（删除走书架 _trash）', Boolean(deleted && deleted.ok === true), deleted);
  const shelfAfter = (await storage.listBooks(booksRoot)).length;
  check('菜单键盘：书架数量回到演练前', shelfAfter === shelfBefore, { before: shelfBefore, after: shelfAfter });
  check(
    '菜单键盘：演练期间没有留下打开的菜单',
    (await exec("Array.from(document.querySelectorAll('.context-menu, .dropdown-menu')).every((m) => m.classList.contains('hidden'))")) === true
  );
};
