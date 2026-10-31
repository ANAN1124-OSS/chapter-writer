// 端到端自检：真实启动 Electron，通过渲染层的 __cwTest 钩子走主流程，
// 再回到主进程侧直接检查磁盘文件，验证「保存整本、编号重排、未保存拦截」确实生效。
const fs = require('node:fs/promises');
const path = require('node:path');
const chaptersLib = require('../core/chapters');

module.exports = async function runScenario(ctx) {
  const { win, clipboard, config, storage, sleep, exec, getCloseReady, resetCloseReady } = ctx;
  const booksRoot = config.booksRoot;
  const bookDir = path.join(booksRoot, '测试书');
  const checks = [];

  const check = (name, cond, detail) => {
    checks.push({ name, ok: Boolean(cond) });
    if (!cond) {
      throw new Error(`检查失败：${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
    }
  };

  const waitFor = async (expr, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      let value;
      try {
        value = await exec(expr);
      } catch { /* 页面切换间隙可能短暂失败 */ }
      if (value) return value;
      if (Date.now() - startedAt > timeout) throw new Error(`等待超时：${expr}`);
      await sleep(120);
    }
  };

  const diskText = async (file) => {
    const loaded = await storage.loadChapterText(bookDir, file);
    return loaded.text;
  };

  // 等主进程侧真正收到「可以关闭 / 不许关闭」的回执
  const waitCloseReady = async (timeout = 15000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = getCloseReady();
      if (value !== undefined) return value;
      if (Date.now() - startedAt > timeout) throw new Error('等待 close-ready 超时');
      await sleep(100);
    }
  };

  await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)');

  // 1. 新建书 → 自动打开、自动带一个空章
  await exec("window.__cwTest.newBook('测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  check('新建书后进入编辑视图', (await exec('window.__cwTest.view()')) === 'editor');
  check(
    '初始一个空章且标题为「第1章」',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) === JSON.stringify(['第1章'])
  );

  // 2. 改名 + 追加两章 → 章号按顺序自动生成
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.newChapter('夜雨')");
  await exec("window.__cwTest.newChapter('')");
  check(
    '三章标题按顺序自动编号（含空名回退）',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：夜雨', '第3章'])
  );
  check(
    '重命名不改文件名',
    JSON.stringify(await exec('window.__cwTest.chapterFiles()')) ===
      JSON.stringify(['001-未命名.txt', '002-夜雨.txt', '003-未命名.txt'])
  );

  // 3. 手动保存整本：写当前章 + 校验全书
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。')");
  check('输入后变为未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  const saveResult = await exec('window.__cwTest.save()');
  check('保存成功', saveResult && saveResult.ok === true, saveResult);
  check('保存后不再是未保存状态', (await exec('window.__cwTest.dirty()')) === false);
  check(
    '磁盘上的章节内容正确（CRLF 落盘、读回 LF）',
    (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。'
  );
  const meta1 = await storage.readBookMeta(bookDir);
  check('书目.json 三章顺序正确', JSON.stringify(meta1.chapters.map((c) => c.name)) === JSON.stringify(['起风', '夜雨', '']));

  // 4. 中间插入 → 章号自动顺延，旧文件一个都不改名
  await exec("window.__cwTest.insertAfter(0, '灯塔')");
  await waitFor("window.__cwTest.chapterTitles().length === 4");
  check(
    '插入后章号自动顺延',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：灯塔', '第3章：夜雨', '第4章'])
  );
  const meta2 = await storage.readBookMeta(bookDir);
  check(
    '插入后旧文件未改名、新文件用递增序号',
    JSON.stringify(meta2.chapters.map((c) => c.file)) ===
      JSON.stringify(['001-未命名.txt', '004-灯塔.txt', '002-夜雨.txt', '003-未命名.txt'])
  );
  for (const f of ['001-未命名.txt', '002-夜雨.txt', '003-未命名.txt']) {
    await fs.access(path.join(bookDir, f));
  }
  check('插入后自动切到新章节', (await exec('window.__cwTest.currentTitle()')) === '第2章：灯塔');

  // 5. 未保存时切章 → 选择「不保存」→ 磁盘不变
  await exec('window.__cwTest.switchTo(2)');
  await exec("window.__cwTest.setText('夜雨的草稿，不保存')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check('丢弃修改后磁盘内容未变', (await diskText('002-夜雨.txt')) === '');
  check('丢弃后回到未修改状态', (await exec('window.__cwTest.dirty()')) === false);
  check('切换到了目标章节', (await exec('window.__cwTest.currentTitle()')) === '第1章：起风');

  // 6. 未保存时切章 → 选择「保存并切换」→ 磁盘更新
  await exec('window.__cwTest.switchTo(1)');
  await exec("window.__cwTest.setText('灯塔正文')");
  await exec("window.__cwTest.switchTo(0, 'save')");
  check('保存并切换后磁盘内容已更新', (await diskText('004-灯塔.txt')) === '灯塔正文');

  // 7. 重命名章节（新建的「灯塔」改名为「灯塔改名」）
  await exec("window.__cwTest.renameChapterAt(1, '灯塔改名')");
  check(
    '重命名后标题变化、文件名不变',
    (await exec('window.__cwTest.currentTitle()')).length >= 0 &&
      JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
        JSON.stringify(['第1章：起风', '第2章：灯塔改名', '第3章：夜雨', '第4章'])
  );
  const meta3 = await storage.readBookMeta(bookDir);
  check('重命名只改 name 不动 file', meta3.chapters[1].file === '004-灯塔.txt' && meta3.chapters[1].name === '灯塔改名');

  // 8. 删除章节 → 文件进 _trash，json 移除
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.deleteChapterAt(3, { skipConfirm: true })");
  await waitFor("window.__cwTest.chapterTitles().length === 3");
  const meta4 = await storage.readBookMeta(bookDir);
  check(
    '删除后章节顺序正确',
    JSON.stringify(meta4.chapters.map((c) => c.name)) === JSON.stringify(['起风', '灯塔改名', '夜雨'])
  );
  const trash = await fs.readdir(path.join(bookDir, '_trash'));
  check('删除的文件进了 _trash 而不是被删掉', trash.some((f) => f.endsWith('003-未命名.txt')), trash);

  // 9. 复制整本：内容 = 导出拼接格式（标题行 + 空行 + 正文）
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const copyRes = await exec(`window.api.copyBook(${JSON.stringify(bookDir)})`);
  check('复制整本接口成功', copyRes && copyRes.ok === true, copyRes);
  const metaNow = await storage.readBookMeta(bookDir);
  const texts = [];
  for (const chapter of metaNow.chapters) {
    texts.push((await storage.loadChapterText(bookDir, chapter.file)).text);
  }
  const expected = require('../core/exporter').composeBook(metaNow, texts);
  // 注意：新版 Electron 的 clipboard 是异步 API，两个版本都兼容地 await 一下
  const clipText = await clipboard.readText();
  check('剪贴板内容与导出格式完全一致', clipText === expected, {
    actual: typeof clipText === 'string' ? clipText.slice(0, 120) : String(clipText)
  });

  // 10. 关窗拦截：未保存 → 取消 → 不退出
  await exec("window.__cwTest.setText('关窗测试：这段不该丢')");
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  check('关窗时未保存会先弹窗询问', (await exec('window.__cwTest.dialog()')) === '退出前保存');
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  check('选择取消后不会关闭', (await waitCloseReady()) === false);
  check('选择取消后内容仍在内存中', (await exec('window.__cwTest.text()')) === '关窗测试：这段不该丢');

  // 11. 关窗拦截：未保存 → 保存并退出 → 磁盘更新
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  await exec("window.__cwTest.answerModal('save')");
  await waitFor('window.__cwTest.modalOpen() === false', 12000);
  check('选择保存并退出后允许关闭', (await waitCloseReady()) === true);
  check('关窗前保存成功（磁盘内容更新）', (await diskText('001-未命名.txt')) === '关窗测试：这段不该丢');

  // 12. 干净状态关窗：不弹窗直接允许
  resetCloseReady();
  win.webContents.send('app:close-requested');
  check('无未保存修改时关窗直接允许', (await waitCloseReady()) === true);
  check('干净关窗不弹窗', (await exec('window.__cwTest.modalOpen()')) === false);

  // 13. 重载窗口（模拟重启）后重新打开书：内容、顺序、上次章节都还在
  win.webContents.reload();
  await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)', 15000);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookDir)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '重启后章节顺序不变',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：灯塔改名', '第3章：夜雨'])
  );
  check(
    '重启后能读回已保存内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '关窗测试：这段不该丢'
  );

  // 14. 外部修改检测：模拟用记事本改了当前章，重新获得焦点时提示重新加载
  const currentFile = await exec(
    'window.__cwTest.state.chapters[window.__cwTest.state.index].file'
  );
  await fs.appendFile(path.join(bookDir, currentFile), '\r\n外部改的内容', 'utf8');
  await exec("window.dispatchEvent(new Event('blur'))");
  await sleep(700);
  await exec("window.dispatchEvent(new Event('focus'))");
  await waitFor('window.__cwTest.modalOpen()', 8000);
  check('检测到外部修改并弹窗', (await exec('window.__cwTest.dialog()')) === '检测到外部修改');
  await exec("window.__cwTest.answerModal('reload')");
  await waitFor("window.__cwTest.text().includes('外部改的内容')", 8000);
  check('选择重新加载后读到外部内容', true);

  // 15. 损坏书目恢复：从目录 txt 重建
  const brokenDir = path.join(booksRoot, '坏书');
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, '002-乙.txt'), '乙内容', 'utf8');
  await fs.writeFile(path.join(brokenDir, '001-甲.txt'), '甲内容', 'utf8');
  await fs.writeFile(path.join(brokenDir, '书目.json'), '{ 坏掉的 json', 'utf8');
  const shelfBefore = await storage.listBooks(booksRoot);
  check('损坏的书在书架上被标记', shelfBefore.find((b) => b.folder === '坏书')?.status === 'corrupt');
  const repairRes = await exec(`window.api.repairBook(${JSON.stringify(brokenDir)}, 'rebuild')`);
  check('从目录重建成功', repairRes && repairRes.ok === true, repairRes);
  const repairedMeta = await storage.readBookMeta(brokenDir);
  check(
    '重建后章节顺序正确（按序号排序）',
    JSON.stringify(repairedMeta.chapters.map((c) => c.file)) === JSON.stringify(['001-甲.txt', '002-乙.txt'])
  );
  const brokenFiles = await fs.readdir(brokenDir);
  check('损坏的 json 被改名保留', brokenFiles.some((f) => f.startsWith('书目.json.corrupt-')));
  const shelfAfter = await storage.listBooks(booksRoot);
  check('修复后书架恢复 normal', shelfAfter.find((b) => b.folder === '坏书')?.status === 'ok');

  // 16. 导入小说：外部文件夹（纯 txt）→ 书架里的一本书
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const importSrc = path.join(path.dirname(booksRoot), '外部导入源');
  await fs.mkdir(importSrc, { recursive: true });
  await fs.writeFile(path.join(importSrc, '001-风起.txt'), '外部的第一章内容', 'utf8');
  await fs.writeFile(path.join(importSrc, '002-雨落.txt'), '外部的第二章内容', 'utf8');
  await exec(`window.__cwTest.importPaths([${JSON.stringify(importSrc)}])`);
  const shelfAfterImport = await storage.listBooks(booksRoot);
  const importedBook = shelfAfterImport.find((b) => b.folder === '外部导入源');
  check(
    '导入纯 txt 小说成功（按文件名重建书目）',
    importedBook && importedBook.status === 'ok' && importedBook.chapterCount === 2,
    importedBook
  );
  const importedPath = path.join(booksRoot, '外部导入源');
  check('导入后原文件夹仍保留（只复制不移动）', await fs.access(importSrc).then(() => true, () => false));
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(importedPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '导入的小说章节顺序正确',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：风起', '第2章：雨落'])
  );
  check('导入的小说正文完整', (await exec('window.__cwTest.chapterTextAt(0)')) === '外部的第一章内容');

  // 17. 删除小说：整本书进 _trash（e2e 走兜底路径，不往你的回收站丢测试数据）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.deleteBookByFolder('外部导入源', { skipConfirm: true })");
  await sleep(500);
  const shelfAfterDelete = await storage.listBooks(booksRoot);
  check('删除后书架上不再有这本书', !shelfAfterDelete.some((b) => b.folder === '外部导入源'));
  const rootTrashDir = path.join(booksRoot, '_trash');
  const rootTrash = await fs.readdir(rootTrashDir);
  check(
    '删除的书进入书架 _trash（可人工找回，没有真删）',
    rootTrash.some((f) => f.endsWith('外部导入源')),
    rootTrash
  );
  check('删除后原书文件夹已从书架目录移走', await fs.access(importedPath).then(() => false, () => true));

  // 18. 导入小说收藏夹：每个 txt 是一本书，自动分章
  const collectionSrc = path.join(path.dirname(booksRoot), '小说收藏夹');
  await fs.mkdir(collectionSrc, { recursive: true });
  await fs.writeFile(
    path.join(collectionSrc, '小说甲 - 作者.txt'),
    '第1章 开端\n\n甲的正文\n\n第2章 转折\n\n甲的二段',
    'utf8'
  );
  await fs.writeFile(
    path.join(collectionSrc, '小说乙 - 作者.txt'),
    '楔子\n\n乙的引子\n\n第一章 雪夜\n\n乙的正文',
    'utf8'
  );
  await exec(`window.__cwTest.importPaths([${JSON.stringify(collectionSrc)}], 'split')`);
  await sleep(500);
  const shelfCollection = await storage.listBooks(booksRoot);
  const bookA = shelfCollection.find((b) => b.title === '小说甲 - 作者');
  const bookB = shelfCollection.find((b) => b.title === '小说乙 - 作者');
  check('收藏夹里的每个 txt 都导入成一本书', Boolean(bookA && bookB), shelfCollection.map((b) => b.title));
  check(
    '导入时自动按标题行分章',
    Boolean(bookA && bookA.chapterCount === 2 && bookB && bookB.chapterCount === 2),
    { a: bookA && bookA.chapterCount, b: bookB && bookB.chapterCount }
  );
  const importedMetaA = await storage.readBookMeta(bookA.path);
  check(
    '分章后的章节名正确',
    JSON.stringify(importedMetaA.chapters.map((c) => c.name)) === JSON.stringify(['开端', '转折'])
  );
  const importedMetaB = await storage.readBookMeta(bookB.path);
  check(
    '楔子 / 第一章 也能识别',
    JSON.stringify(importedMetaB.chapters.map((c) => c.name)) === JSON.stringify(['楔子', '雪夜'])
  );

  // 19. 默认「原文件导入」：整篇一章、内容与源文件完全一致（不拆章、不改字）
  const rawSrc = path.join(path.dirname(booksRoot), '原样导入源');
  await fs.mkdir(rawSrc, { recursive: true });
  const rawContent = '第1章 开端\n\n原文第一段\n\n第2章 转折\n\n原文第二段';
  await fs.writeFile(path.join(rawSrc, '原样小说 - 作者.txt'), rawContent, 'utf8');
  await exec(`window.__cwTest.importPaths([${JSON.stringify(rawSrc)}], 'raw')`);
  const shelfRaw = await storage.listBooks(booksRoot);
  const rawBook = shelfRaw.find((b) => b.title === '原样小说 - 作者');
  check(
    '默认导入：每个 txt 一本书、不拆章',
    Boolean(rawBook && rawBook.chapterCount === 1),
    rawBook && rawBook.chapterCount
  );
  await exec(
    `window.__cwTest.openBookPath(${JSON.stringify(path.join(booksRoot, '原样小说 - 作者'))})`
  );
  await waitFor("window.__cwTest.view() === 'editor'");
  check('默认导入后只有一章「全文」', (await exec('window.__cwTest.currentTitle()')) === '第1章：全文');
  check('默认导入正文与源文件完全一致', (await exec('window.__cwTest.text()')) === rawContent);

  // 20. 默认「按原文章节导入」：按原文标题拆章，章名和正文照抄
  const chaptersSrc = path.join(path.dirname(booksRoot), '按原文章节源');
  await fs.mkdir(chaptersSrc, { recursive: true });
  const chapteredText = '第1章 开端\n\n原文第一段\n\n第2章 转折\n\n原文第二段\n';
  await fs.writeFile(path.join(chaptersSrc, '章节小说 - 作者.txt'), chapteredText, 'utf8');
  await exec(`window.__cwTest.importPaths([${JSON.stringify(chaptersSrc)}])`);
  const shelfChaptered = await storage.listBooks(booksRoot);
  const chapteredBook = shelfChaptered.find((b) => b.title === '章节小说 - 作者');
  check(
    '默认按原文章节导入：自动拆成多章',
    Boolean(chapteredBook && chapteredBook.chapterCount === 2),
    chapteredBook && chapteredBook.chapterCount
  );
  await exec(
    `window.__cwTest.openBookPath(${JSON.stringify(path.join(booksRoot, '章节小说 - 作者'))})`
  );
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '章名照抄原文标题',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章 开端', '第2章 转折'])
  );
  check(
    '本章正文保留原文空行（没有 trim）',
    (await exec('window.__cwTest.text()')) === '\n原文第一段\n'
  );

  // 21. 章节栏 / 写作区 之间的分隔条可拖动，宽度写入配置
  const initialSidebarWidth = await exec('window.__cwTest.sidebarWidth()');
  const splitterScriptResult = await exec(`(() => {
    try {
      const resizer = document.getElementById('sidebar-resizer');
      const rect = resizer.getBoundingClientRect();
      const x = rect.left + 3;
      const y = rect.top + 20;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 120, clientY: y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 120, clientY: y, button: 0, pointerId: 1 }));
      return 'ok';
    } catch (err) {
      return 'ERR:' + String((err && err.stack) || err);
    }
  })()`);
  if (splitterScriptResult !== 'ok') throw new Error('分隔条模拟失败：' + splitterScriptResult);
  await sleep(500);
  const draggedWidth = await exec('window.__cwTest.sidebarWidth()');
  check(
    '拖动分隔条可以调整章节栏宽度',
    Math.abs(draggedWidth - initialSidebarWidth - 120) <= 3,
    { initialSidebarWidth, draggedWidth }
  );
  const domSidebarWidth = await exec(
    `parseFloat(getComputedStyle(document.getElementById('sidebar')).width)`
  );
  check('章节栏宽度实际应用到页面', Math.abs(domSidebarWidth - draggedWidth) <= 1, {
    domSidebarWidth,
    draggedWidth
  });
  const savedSidebarWidth = await exec(
    `window.api.getConfig().then((r) => (r.ok ? r.data.editorSidebarWidth : null))`
  );
  check('章节栏宽度写入配置（下次启动保持）', savedSidebarWidth === draggedWidth, {
    savedSidebarWidth,
    draggedWidth
  });
  await exec(
    `document.getElementById('sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await sleep(400);
  const resetWidth = await exec('window.__cwTest.sidebarWidth()');
  check('双击分隔条恢复默认宽度', resetWidth === 250, { resetWidth });

  // 22. 排版：一键整理本章 —— 改正文但不自动写盘，可撤销，落盘为 CRLF
  const currentBookDir = path.join(booksRoot, '章节小说 - 作者');
  const currentChapterFile = (await exec('window.__cwTest.chapterFiles()'))[0];
  const messyText = '他说,"你好."   \n\n\n第二段  ';
  await exec(`window.__cwTest.setText(${JSON.stringify(messyText)})`);
  await sleep(150);
  check('整理前编辑区是脏样本', (await exec('window.__cwTest.text()')) === messyText);

  await exec("document.getElementById('btn-format').click()");
  check('写作页「排版 ▾」菜单能打开', (await exec('window.__cwTest.formatMenuOpen()')) === true);

  await exec("document.querySelector('#format-menu button[data-action=\"apply\"]').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === true');
  check('「一键整理本章」对话框打开', (await exec('window.__cwTest.formatDialogOpen()')) === true);

  await waitFor("window.__cwTest.formatSummary().includes('共 2 段')");
  const formatSummary = await exec('window.__cwTest.formatSummary()');
  check('预览给出改动统计', formatSummary.includes('标点转全角 2 处'), formatSummary);
  check(
    '预览显示整理后的正文（缩进 + 标点已转）',
    (await exec('window.__cwTest.formatPreview()')).startsWith('　　他说，"你好。"'),
    await exec('window.__cwTest.formatPreview()')
  );

  await exec("document.getElementById('btn-format-apply').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === false');
  await sleep(200);
  const formattedText = await exec('window.__cwTest.text()');
  check(
    '套用后编辑区是整理后的正文',
    formattedText === '　　他说，"你好。"\n\n　　第二段',
    formattedText
  );
  check('套用后仍是未保存状态（没有偷偷写盘）', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '套用后磁盘上还是整理前的内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '\n原文第一段\n',
    await exec('window.__cwTest.chapterTextAt(0)')
  );

  // 撤销：Ctrl+Z / 菜单「撤销上次整理」
  check('整理后可以撤销', (await exec('window.__cwTest.canUndoFormat()')) === true);
  await exec('window.__cwTest.undoFormat()');
  check('撤销整理恢复整理前的正文', (await exec('window.__cwTest.text()')) === messyText);
  check('撤销后快照栈清空', (await exec('window.__cwTest.formatUndoDepth()')) === 0);

  // 再整理一次并保存：磁盘落盘为 CRLF，正文整理结果一致
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify({
    indent: true,
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false
  })})`);
  await exec('window.__cwTest.applyFormat()');
  check('再次套用后正文正确', (await exec('window.__cwTest.text()')) === formattedText);

  // 真实键盘路径：Ctrl+Z 撤销整理（document 上的 keydown 拦截）
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))"
  );
  await sleep(200);
  check('Ctrl+Z 也能撤销整理', (await exec('window.__cwTest.text()')) === messyText);
  check('Ctrl+Z 撤销后快照栈清空', (await exec('window.__cwTest.formatUndoDepth()')) === 0);

  await exec('window.__cwTest.applyFormat()');
  check('撤销后再整理回来', (await exec('window.__cwTest.text()')) === formattedText);

  const formatSaveResult = await exec('window.__cwTest.save()');
  check('整理后保存成功', Boolean(formatSaveResult && formatSaveResult.ok === true), formatSaveResult);
  const rawOnDisk = await fs.readFile(path.join(currentBookDir, currentChapterFile), 'utf8');
  check(
    '落盘正文是 CRLF + 全角缩进（记事本友好）',
    rawOnDisk === '　　他说，"你好。"\r\n\r\n　　第二段',
    rawOnDisk
  );
  check(
    '保存后回读与整理结果一致',
    (await exec('window.__cwTest.chapterTextAt(0)')) === formattedText
  );

  // 幂等：已经是整理后的正文，再整理一次不应重复加缩进
  await exec('window.__cwTest.applyFormat()');
  check('重复整理不会重复叠加缩进', (await exec('window.__cwTest.text()')) === formattedText);
  check('无改动的整理不往撤销栈里塞东西', (await exec('window.__cwTest.formatUndoDepth()')) === 1);

  // 23. 显示排版：预设 / 护眼底色 / 设置实时预览与取消恢复（正文不动）
  const styleBefore = await exec('window.__cwTest.displayStyle()');
  await exec("window.__cwTest.applyDisplayPreset('loose')");
  await sleep(250);
  const styleLoose = await exec('window.__cwTest.displayStyle()');
  check(
    '预设「宽松」改行距生效',
    Math.abs(parseFloat(styleLoose.lineHeight) - parseFloat(styleLoose.fontSize) * 2.4) <= 1.5,
    { lineHeight: styleLoose.lineHeight, fontSize: styleLoose.fontSize }
  );
  check('预设「宽松」限制正文宽度 800px', styleLoose.maxWidth === '800px', styleLoose.maxWidth);
  check('显示预设不碰正文', (await exec('window.__cwTest.text()')) === formattedText);
  const looseConfig = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '显示预设写入配置（下次启动保持）',
    looseConfig.editorLineHeight === 2.4 &&
      looseConfig.editorLetterSpacing === 0.05 &&
      looseConfig.editorPageWidth === 800,
    looseConfig
  );

  await exec('window.__cwTest.openSettings()');
  check('从写作页能打开设置', (await exec('window.__cwTest.settingsOpen()')) === true);
  await exec("window.__cwTest.setSelect('settings-paper', 'green')");
  const styleGreen = await exec('window.__cwTest.displayStyle()');
  check('设置里改底色会实时预览', styleGreen.paperClass.includes('theme-green'), styleGreen.paperClass);
  await exec('window.__cwTest.closeSettings()');
  const styleRestored = await exec('window.__cwTest.displayStyle()');
  check('设置取消后恢复原底色', !styleRestored.paperClass.includes('theme-green'), styleRestored.paperClass);

  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setSelect('settings-paper', 'green')");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor(
    "window.api.getConfig().then((r) => (r.ok && r.data.editorPaper === 'green'))",
    10000
  );
  const savedPaper = await exec('window.api.getConfig().then((r) => (r.ok ? r.data.editorPaper : null))');
  check('设置保存后护眼底色写入配置', savedPaper === 'green', savedPaper);
  check('设置保存后正文仍未变', (await exec('window.__cwTest.text()')) === formattedText);

  // 24. 审阅修复复核：① 整理/撤销不把光标打回章首；② 关窗询问能压住排版弹层
  const caretText = '第一段文字，测试光标位置。\n\n第二段文字，继续测试。\n\n第三段文字。';
  await exec(`window.__cwTest.setText(${JSON.stringify(caretText)})`);
  await exec(`window.__cwTest.setCaret(${caretText.indexOf('第二段') + 3})`);
  await exec('window.__cwTest.applyFormat()');
  const caretAfterFormat = await exec('window.__cwTest.caret()');
  const caretSegment = (await exec('window.__cwTest.text()')).slice(0, caretAfterFormat);
  check(
    '整理后光标留在原段落，不被打回章首',
    caretSegment.endsWith('第二段'),
    { caretAfterFormat, segment: caretSegment.slice(-12) }
  );
  await exec('window.__cwTest.undoFormat()');
  const caretAfterUndo = await exec('window.__cwTest.caret()');
  const undoSegment = (await exec('window.__cwTest.text()')).slice(0, caretAfterUndo);
  check(
    '撤销整理后光标也留在原位置',
    undoSegment.endsWith('第二段'),
    { caretAfterUndo, segment: undoSegment.slice(-12) }
  );

  const zIndexes = await exec(`(() => ({
    modal: Number(getComputedStyle(document.getElementById('modal-backdrop')).zIndex),
    format: Number(getComputedStyle(document.getElementById('format-backdrop')).zIndex),
    settings: Number(getComputedStyle(document.getElementById('settings-backdrop')).zIndex)
  }))()`);
  check(
    '关窗询问的层级高于排版/设置弹层',
    zIndexes.modal > zIndexes.format && zIndexes.modal > zIndexes.settings,
    zIndexes
  );

  await exec('window.__cwTest.openFormatDialog()');
  check('排版弹层已打开（关窗复核前置条件）', (await exec('window.__cwTest.formatDialogOpen()')) === true);
  check('当前仍有未保存修改', (await exec('window.__cwTest.dirty()')) === true);
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  check('关窗询问会先收起排版弹层', (await exec('window.__cwTest.formatDialogOpen()')) === false);
  check('关窗询问正常弹出（没有被弹层压住）', (await exec('window.__cwTest.dialog()')) === '退出前保存');
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  check('取消关窗后窗口不关闭', (await waitCloseReady()) === false);

  // 25. 智能排版（对齐口袋写作）：缩进 0 字符 / 空一行（含缩进）
  const smartOpts = {
    indent: '0',
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false
  };
  await exec(`window.__cwTest.setText(${JSON.stringify('　　第一段。\n\n　　第二段。')})`);
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(smartOpts)})`);
  await exec('window.__cwTest.applyFormat()');
  check(
    '智能排版：缩进可设为 0 字符（去掉缩进）',
    (await exec('window.__cwTest.text()')) === '第一段。\n\n第二段。',
    await exec('window.__cwTest.text()')
  );

  const indentBlankOpts = { ...smartOpts, indent: '2', blankLines: 'singleIndent' };
  await exec(`window.__cwTest.setText(${JSON.stringify('第一段。\n\n第二段。')})`);
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(indentBlankOpts)})`);
  await exec('window.__cwTest.applyFormat()');
  const indentBlankText = await exec('window.__cwTest.text()');
  check(
    '智能排版：空行可带缩进（空行里是全角空格）',
    indentBlankText === '　　第一段。\n　　\n　　第二段。',
    indentBlankText
  );
  const indentSave = await exec('window.__cwTest.save()');
  check('智能排版：含缩进的空行保存成功', Boolean(indentSave && indentSave.ok === true), indentSave);
  const indentBlankRaw = await fs.readFile(path.join(currentBookDir, currentChapterFile), 'utf8');
  check(
    '智能排版：落盘为 CRLF 且空行保留全角缩进',
    indentBlankRaw === '　　第一段。\r\n　　\r\n　　第二段。',
    indentBlankRaw
  );
  const undoDepthBeforeRepeat = await exec('window.__cwTest.formatUndoDepth()');
  await exec('window.__cwTest.applyFormat()');
  check('智能排版：重复整理幂等（不会再改一次）', (await exec('window.__cwTest.text()')) === indentBlankText);
  check(
    '智能排版：无改动时不往撤销栈里塞东西',
    (await exec('window.__cwTest.formatUndoDepth()')) === undoDepthBeforeRepeat
  );

  // 26. 口袋写作同款显示项：字体文件（.ttf）、夜间、纸张纹理、左右边距
  const testFontPath = 'C:\\Windows\\Fonts\\consola.ttf';
  const fontRead = await exec(`window.api.readFont(${JSON.stringify(testFontPath)})`);
  check(
    '字体文件读取成功（主进程读成 base64 给渲染层）',
    Boolean(fontRead && fontRead.ok && fontRead.data.size > 1000 && fontRead.data.base64.length > 1000),
    fontRead && { ok: fontRead.ok, size: fontRead.data && fontRead.data.size }
  );
  const badFontRead = await exec('window.api.readFont("C:\\\\Windows\\\\win.ini")');
  check(
    '非字体文件被拒绝',
    Boolean(badFontRead && badFontRead.ok === false && badFontRead.code === 'BAD_FONT'),
    badFontRead && { ok: badFontRead.ok, code: badFontRead.code }
  );
  const customLoaded = await exec(`window.__cwTest.loadCustomFont(${JSON.stringify(testFontPath)})`);
  await sleep(300);
  const customState = await exec('window.__cwTest.customFontLoaded()');
  check('自定义字体能加载进页面（FontFace）', customLoaded === true && customState.ok === true, customState);
  const customApplied = await exec(
    `window.__cwTest.setCustomFont(${JSON.stringify(testFontPath)}, 'consola.ttf')`
  );
  check('自定义字体写入配置后生效', customApplied === true);
  check(
    '页面字体已切到自定义字体',
    (await exec('window.__cwTest.displayStyle()')).fontFamily.includes('cw-custom-font'),
    (await exec('window.__cwTest.displayStyle()')).fontFamily
  );

  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  const nightStyle = await exec('window.__cwTest.displayStyle()');
  check('夜间主题生效（页面换成深色）', nightStyle.paperClass.includes('theme-night'), nightStyle.paperClass);
  const nightRgb = (nightStyle.backgroundColor.match(/\d+/g) || []).map(Number);
  check(
    '夜间主题：正文底色变深、字色不变',
    nightRgb.length >= 3 && nightRgb[0] < 80 && nightRgb[1] < 80 && nightRgb[2] < 80,
    nightStyle.backgroundColor
  );
  await exec("window.__cwTest.setSelect('settings-padding-x', '24')");
  const paddingStyle = await exec('window.__cwTest.displayStyle()');
  check('左右边距可调（24px）', paddingStyle.paddingLeft === '24px' && paddingStyle.paddingRight === '24px', {
    left: paddingStyle.paddingLeft,
    right: paddingStyle.paddingRight
  });
  await exec("window.__cwTest.setSelect('settings-paper', 'kraft')");
  const kraftStyle = await exec('window.__cwTest.displayStyle()');
  check(
    '牛皮纸主题带纹理（CSS 渐变，不加图片文件）',
    kraftStyle.backgroundImage.includes('repeating-linear-gradient'),
    kraftStyle.backgroundImage.slice(0, 80)
  );
  await exec("window.__cwTest.setSelect('settings-paper', 'grid')");
  const gridStyle = await exec('window.__cwTest.displayStyle()');
  check('网格纸主题带纹理', gridStyle.backgroundImage.includes('linear-gradient'), gridStyle.backgroundImage.slice(0, 80));

  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor("window.api.getConfig().then((r) => (r.ok && r.data.editorPaper === 'night'))", 10000);
  const displayCfg = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '夜间主题与左右边距写入配置',
    displayCfg.editorPaper === 'night' && displayCfg.editorPaddingX === 24,
    { paper: displayCfg.editorPaper, paddingX: displayCfg.editorPaddingX }
  );
  check('改主题/边距不动正文一个字', (await exec('window.__cwTest.text()')) === indentBlankText);

  // 27. 章节拖拽排序：只改书目顺序，章节文件永不重命名，内容跟着章节走
  await exec("window.__cwTest.newBook('拖拽排序书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.newChapter('第二')");
  await exec("window.__cwTest.newChapter('第三')");
  const sortBookPath = await exec('window.__cwTest.state.bookPath');
  const filesBeforeMove = await exec('window.__cwTest.chapterFiles()');
  await exec('window.__cwTest.switchTo(2, "discard")');
  await exec("window.__cwTest.setText('这是第三章的正文，看它能不能跟着章节走。')");
  await exec('window.__cwTest.save()');
  const titlesBeforeMove = await exec('window.__cwTest.chapterTitles()');
  const namesBeforeMove = await exec('window.__cwTest.chapterNames()');

  await exec('window.__cwTest.moveChapterByDrag(2, 0)');
  await sleep(300);
  const namesAfterMove = await exec('window.__cwTest.chapterNames()');
  check(
    '拖拽排序：第 3 章移到最前',
    JSON.stringify(namesAfterMove) ===
      JSON.stringify([namesBeforeMove[2], namesBeforeMove[0], namesBeforeMove[1]]),
    { namesBeforeMove, namesAfterMove }
  );
  const titlesAfterMove = await exec('window.__cwTest.chapterTitles()');
  check(
    '拖拽排序：章号按新顺序自动重排',
    titlesAfterMove[0] === '第1章：第三' && titlesAfterMove[2] === '第3章：第二',
    { titlesBeforeMove, titlesAfterMove }
  );
  const filesAfterMove = await exec('window.__cwTest.chapterFiles()');
  check(
    '拖拽排序：章节文件一个都没改名',
    JSON.stringify(filesAfterMove.slice().sort()) === JSON.stringify(filesBeforeMove.slice().sort()),
    { filesBeforeMove, filesAfterMove }
  );
  const sortedMeta = await storage.readBookMeta(sortBookPath);
  check('拖拽排序：书目.json 顺序已落盘', sortedMeta.chapters[0].name === '第三', sortedMeta.chapters.map((c) => c.name));
  await exec('window.__cwTest.switchTo(0, "discard")');
  await waitFor("window.__cwTest.currentIndex() === 0");
  check(
    '拖拽排序：内容跟着章节一起搬家',
    (await exec('window.__cwTest.text()')) === '这是第三章的正文，看它能不能跟着章节走。'
  );

  // 28. 全书查找 / 替换（替换前自动备份原章节）
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('阿明走进屋里。\\n阿明坐下。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.switchTo(1, "discard")');
  await exec("window.__cwTest.setText('这里没有那个人。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.switchTo(2, "discard")');
  await exec("window.__cwTest.setText('阿明抬头看了看天。')");
  await exec('window.__cwTest.save()');

  await exec('window.__cwTest.openFindPanel()');
  check('Ctrl+F /「查找」按钮能打开查找面板', (await exec('window.__cwTest.findPanelOpen()')) === true);
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小明', scope: 'book' })");
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSummary().includes('整本命中')");
  check(
    '全书查找：命中数与章节数正确',
    (await exec('window.__cwTest.findSummary()')).includes('整本命中 3 处，分布在 2 章'),
    await exec('window.__cwTest.findSummary()')
  );
  check('全书查找：结果列表按章列出', (await exec('window.__cwTest.findResultCount()')) === 2);

  await exec('window.__cwTest.clickFindResult(1)');
  await waitFor('window.__cwTest.currentIndex() === 2');
  check('点击结果能跳到那一章', (await exec('window.__cwTest.currentIndex()')) === 2);
  await sleep(200);
  const selectionAfterJump = await exec('window.__cwTest.state.index');
  check('跳转后仍停在该章（没有被点击误切走）', selectionAfterJump === 2);

  // 当前章替换：只改编辑区，不写盘
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小明', scope: 'current' })");
  await exec('window.__cwTest.findReplaceAll()');
  await sleep(300);
  check(
    '当前章替换：编辑区已改',
    (await exec('window.__cwTest.text()')) === '小明走进屋里。\n小明坐下。'
  );
  check('当前章替换：仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '当前章替换：磁盘上还是旧内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '阿明走进屋里。\n阿明坐下。'
  );
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.closeFindPanel()');

  // 恢复成含「阿明」的原文，再测整本替换
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('阿明走进屋里。\\n阿明坐下。')");
  await exec('window.__cwTest.save()');

  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小明', scope: 'book' })");
  const replacePromise = exec('window.__cwTest.findReplaceAll()');
  await waitFor('window.__cwTest.modalOpen()');
  check('整本替换会先弹确认框', (await exec('window.__cwTest.dialog()')) === '整本替换确认');
  await exec("window.__cwTest.answerModal('ok')");
  await replacePromise;
  await waitFor("window.__cwTest.findPanelOpen() === false", 15000);
  await sleep(400);

  const replacedMeta = await storage.readBookMeta(sortBookPath);
  const replacedText0 = await storage.loadChapterText(sortBookPath, replacedMeta.chapters[0].file);
  const replacedText1 = await storage.loadChapterText(sortBookPath, replacedMeta.chapters[1].file);
  const replacedText2 = await storage.loadChapterText(sortBookPath, replacedMeta.chapters[2].file);
  check(
    '整本替换：命中章节已改写',
    replacedText0.text === '小明走进屋里。\n小明坐下。' && replacedText2.text === '小明抬头看了看天。',
    { replacedText0: replacedText0.text, replacedText2: replacedText2.text }
  );
  check('整本替换：没有命中的章节原样不动', replacedText1.text === '这里没有那个人。');
  check(
    '整本替换：字数缓存已更新',
    replacedMeta.chapters[0].chars === 12 && replacedMeta.chapters[2].chars === 9,
    replacedMeta.chapters.map((c) => c.chars)
  );
  const trashEntries = await fs.readdir(path.join(sortBookPath, '_trash')).catch(() => []);
  const backupName = trashEntries.find((name) => name.startsWith('替换备份-'));
  check('整本替换：原文已备份到书内 _trash', Boolean(backupName), trashEntries);
  const backupText = await fs.readFile(path.join(sortBookPath, '_trash', backupName, replacedMeta.chapters[0].file), 'utf8');
  check('整本替换：备份里是替换前的原文', backupText === '阿明走进屋里。\r\n阿明坐下。', backupText);
  check(
    '整本替换：当前章已从磁盘重新载入',
    (await exec('window.__cwTest.text()')) === '小明走进屋里。\n小明坐下。'
  );

  // 29. 只替换这一处：只改编辑区、替换后选中下一处、只作用于当前章
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('阿明一。阿明二。阿明三。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小红', scope: 'book' })");
  const oneOnBook = await exec('window.__cwTest.findReplaceOne()');
  check('替换这一处：整本范围下不会执行', oneOnBook && oneOnBook.ok === false, oneOnBook);
  check(
    '替换这一处：整本范围下正文不动',
    (await exec('window.__cwTest.text()')) === '阿明一。阿明二。阿明三。'
  );

  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小红', scope: 'current' })");
  await exec('window.__cwTest.findRun()');
  await sleep(200);
  check('替换这一处：查找后选中第 1 处', (await exec('window.__cwTest.selection()')).start === 0);
  const firstOne = await exec('window.__cwTest.findReplaceOne()');
  check(
    '替换这一处：只改第 1 处，其余命中保留',
    (await exec('window.__cwTest.text()')) === '小红一。阿明二。阿明三。',
    await exec('window.__cwTest.text()')
  );
  check('替换这一处：替换后自动选中第 2 处', (await exec('window.__cwTest.selection()')).start === 4);
  check(
    '替换这一处：返回替换序号与总数',
    firstOne && firstOne.ok === true && firstOne.index === 0 && firstOne.total === 3,
    firstOne
  );
  check('替换这一处：仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '替换这一处：磁盘上还是旧内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '阿明一。阿明二。阿明三。'
  );
  await exec('window.__cwTest.findReplaceOne()');
  check(
    '替换这一处：连按第二次替换第 2 处',
    (await exec('window.__cwTest.text()')) === '小红一。小红二。阿明三。'
  );
  check('替换这一处：第 3 处也被选中', (await exec('window.__cwTest.selection()')).start === 8);
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.closeFindPanel()');
  check(
    '替换这一处：保存后才写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '小红一。小红二。阿明三。'
  );

  // 30. 整本替换的备份还原：列出备份 → 二次确认 → 正文回到替换前（当前内容再备份一份）
  await exec('window.__cwTest.openFindPanel()');
  const backups = await exec('window.__cwTest.refreshReplaceBackups()');
  check(
    '替换备份：查找面板能列出最近一次整本替换的备份',
    Array.isArray(backups) && backups.length >= 1 && backups[0].fileCount === 2,
    backups && backups.map((item) => ({ name: item.name, fileCount: item.fileCount }))
  );
  const restorePromise = exec('window.__cwTest.restoreReplaceBackupFlow()');
  await waitFor('window.__cwTest.modalOpen()');
  check('替换备份：还原前会二次确认', (await exec('window.__cwTest.dialog()')) === '还原到替换前');
  await exec("window.__cwTest.answerModal('ok')");
  const restoreResult = await restorePromise;
  check('替换备份：还原成功', restoreResult && restoreResult.ok === true, restoreResult);
  await sleep(300);
  const restoredMeta = await storage.readBookMeta(sortBookPath);
  const restoredText0 = (await storage.loadChapterText(sortBookPath, restoredMeta.chapters[0].file)).text;
  const restoredText2 = (await storage.loadChapterText(sortBookPath, restoredMeta.chapters[2].file)).text;
  check('替换备份：正文回到替换前', restoredText0 === '阿明走进屋里。\n阿明坐下。', restoredText0);
  check('替换备份：其他命中章节也回到替换前', restoredText2 === '阿明抬头看了看天。', restoredText2);
  const trashAfterRestore = await fs.readdir(path.join(sortBookPath, '_trash'));
  check(
    '替换备份：还原前把当前内容又备份了一份',
    trashAfterRestore.some((name) => name.startsWith('还原前备份-')),
    trashAfterRestore
  );
  check(
    '替换备份：字数缓存已按还原后的正文更新',
    restoredMeta.chapters[0].chars === 12 && restoredMeta.chapters[2].chars === 9,
    restoredMeta.chapters.map((chapter) => chapter.chars)
  );
  check(
    '替换备份：编辑器已从磁盘重新载入',
    (await exec('window.__cwTest.text()')) === '阿明走进屋里。\n阿明坐下。'
  );
  check(
    '替换备份：原备份还在，可以重复还原',
    (await exec('window.__cwTest.replaceBackups()')).length === 1
  );
  await exec('window.__cwTest.closeFindPanel()');

  // 31. 撤销整理：快照上限 10 → 50，菜单显示还能撤销几步
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('段落一。\\n\\n段落二。')");
  await exec('window.__cwTest.save()');
  const undoDepthBefore = await exec('window.__cwTest.formatUndoDepth()');
  for (let i = 0; i < 11; i += 1) {
    const options = { indent: i % 2 === 0 ? '2' : '0', blankLines: 'keep', trimTrailing: true, normalizePunct: true };
    await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(options)})`);
    await exec('window.__cwTest.applyFormat()');
  }
  const undoDepthNow = await exec('window.__cwTest.formatUndoDepth()');
  check(
    '撤销整理：连续整理 11 次都留得下（不再被 10 步截断）',
    undoDepthNow === undoDepthBefore + 11 && undoDepthNow > 10,
    { undoDepthBefore, undoDepthNow }
  );
  check('撤销整理：11 步都能连续撤回', (await exec('window.__cwTest.formatUndoSteps()')) === 11);
  await exec('window.__cwTest.openFormatMenu()');
  const undoItemLabel = await exec('window.__cwTest.formatUndoItemText()');
  check('撤销整理：菜单显示还能撤销几步', undoItemLabel.includes('可撤销 11 步'), undoItemLabel);
  await exec('window.__cwTest.openFormatMenu()');
  await exec('window.__cwTest.undoFormat()');
  await exec('window.__cwTest.undoFormat()');
  check('撤销整理：连续撤销两步后还剩 9 步', (await exec('window.__cwTest.formatUndoSteps()')) === 9);

  // 32. 标点扩展：直引号 / 省略号（默认关，勾上才转，预览里给统计）
  await exec("window.__cwTest.setText('他说,\"你好...\"')");
  const punctOptions = {
    indent: '2',
    blankLines: 'keep',
    trimTrailing: true,
    normalizePunct: true,
    curlyQuotes: true,
    ellipsis: true
  };
  await exec('window.__cwTest.openFormatDialog()');
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(punctOptions)})`);
  await exec(
    "document.getElementById('fmt-quotes').dispatchEvent(new Event('change', { bubbles: true }))"
  );
  await waitFor("window.__cwTest.formatSummary().includes('直引号转弯引号')");
  const punctSummary = await exec('window.__cwTest.formatSummary()');
  check(
    '标点扩展：预览统计引号与省略号的转换数',
    punctSummary.includes('直引号转弯引号 2 处') && punctSummary.includes('省略号转中文 1 处'),
    punctSummary
  );
  const punctPreview = await exec('window.__cwTest.formatPreview()');
  check('标点扩展：预览里能看到转换后的引号/省略号', punctPreview.includes('“你好……”'), punctPreview);
  await exec("document.getElementById('btn-format-apply').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === false');
  await sleep(150);
  check(
    '标点扩展：套用后直引号转弯引号、三个点转省略号',
    (await exec('window.__cwTest.text()')) === '　　他说，“你好……”',
    await exec('window.__cwTest.text()')
  );
  check('标点扩展：套用后仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  const cfgWithPunct = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '标点扩展：两个开关会记住（写进配置）',
    cfgWithPunct.formatOptions.curlyQuotes === true && cfgWithPunct.formatOptions.ellipsis === true,
    cfgWithPunct.formatOptions
  );

  // 默认关：换一段没转过标点的正文，只套默认规则 → 引号/省略号原样
  await exec("window.__cwTest.setText('他说,\"你好...\"')");
  await exec(
    "window.__cwTest.writeFormatOptions({ indent: '0', blankLines: 'keep', trimTrailing: true, normalizePunct: true })"
  );
  await exec('window.__cwTest.applyFormat()');
  check(
    '标点扩展：两项默认关时引号/省略号保持原样',
    (await exec('window.__cwTest.text()')) === '他说，"你好..."',
    await exec('window.__cwTest.text()')
  );

  return { ok: true, checks: checks.length, details: checks };
};
