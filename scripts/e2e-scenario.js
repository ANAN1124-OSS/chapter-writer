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

  return { ok: true, checks: checks.length, details: checks };
};
