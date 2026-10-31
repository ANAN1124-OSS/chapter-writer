// 端到端自检：真实启动 Electron，通过渲染层的 __cwTest 钩子走主流程，
// 再回到主进程侧直接检查磁盘文件，验证「保存整本、编号重排、未保存拦截」确实生效。
const fs = require('node:fs/promises');
const path = require('node:path');
const chaptersLib = require('../core/chapters');
const exporter = require('../core/exporter');
const statsLib = require('../core/stats');
const statsSeedLib = require('./e2e-stats-seed');
const fragmentsLib = require('../core/fragments');
const { readZip, assertWellFormedXml } = require('./export-check');

module.exports = async function runScenario(ctx) {
  const { win, clipboard, config, userData, storage, sleep, exec, getCloseReady, resetCloseReady } = ctx;
  const {
    openWindow,
    closeWindow,
    destroyWindow,
    execIn,
    focusWindow,
    windowsInfo,
    openBookRegistry,
    registryCounts,
    mostRecentWindowId,
    windowBounds,
    setRealClose,
    windowAllClosed
  } = ctx;
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

  // 等主进程真的把文件写出来（范围导出确认后是异步写盘）
  const waitForFile = async (file, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0) return;
      } catch {
        /* 还没写出来 */
      }
      if (Date.now() - startedAt > timeout) throw new Error(`等待文件超时：${file}`);
      await sleep(100);
    }
  };
  const fileExists = async (file) => {
    try {
      await fs.stat(file);
      return true;
    } catch {
      return false;
    }
  };
  // 导出范围对话框的摘要要等主进程算完（book:export-plan 是异步的）
  const waitForSummary = async (needle, timeout = 8000) => {
    const startedAt = Date.now();
    let text = '';
    for (;;) {
      try {
        text = await exec('window.__cwTest.exportSummary()');
      } catch {
        /* 对话框可能刚开 */
      }
      if (typeof text === 'string' && text.includes(needle)) return text;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待导出摘要超时：${needle} :: ${text}`);
      }
      await sleep(120);
    }
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

  // 剪贴板是主进程能力：E2E 在这里直接读写，验证「复制本章」真的进了系统剪贴板
  const readClipboard = async () => {
    const value = await clipboard.readText();
    return typeof value === 'string' ? value : String(value == null ? '' : value);
  };
  const waitForClipboard = async (predicate, timeout = 8000) => {
    const startedAt = Date.now();
    let value = '';
    for (;;) {
      value = await readClipboard();
      if (predicate(value)) return value;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待剪贴板超时：${JSON.stringify(value.slice(0, 80))}`);
      }
      await sleep(100);
    }
  };

  await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)');

  // 0. 界面版本号跟着 package.json 走（发版只改一处，避免界面还显示旧版本）
  check(
    '界面版本号取自 package.json',
    (await exec('window.__cwTest.versionText()')) === `v${require('../package.json').version}`
  );

  // 0b. IPC 只接受书架目录下的书：越界路径必须被拒（不给渲染层任意读盘的能力）
  const badOpen = await exec("window.api.openBook('C:\\\\Windows')");
  check(
    '打开书架以外的路径被拒绝',
    Boolean(badOpen && badOpen.ok === false && badOpen.code === 'BAD_PATH'),
    badOpen
  );
  const badLoad = await exec("window.api.loadChapter('C:\\\\Windows', 'win.ini')");
  check(
    '读取书架以外的章节被拒绝',
    Boolean(badLoad && badLoad.ok === false && badLoad.code === 'BAD_PATH'),
    badLoad
  );

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

  // 9b. 导出/复制把编辑区里当前章的未保存内容也带上（只影响输出，绝不偷偷写盘）
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('这段还没保存，但导出和复制都必须有')");
  const unsavedText = await exec('window.__cwTest.text()');
  const unsavedId = await exec('window.__cwTest.currentChapterId()');
  const copyUnsaved = await exec(
    `window.api.copyBook(${JSON.stringify(bookDir)}, { chapterId: ${JSON.stringify(unsavedId)}, text: ${JSON.stringify(unsavedText)} })`
  );
  check('复制整本可以用编辑区内容覆盖当前章', Boolean(copyUnsaved && copyUnsaved.ok === true), copyUnsaved);
  check('复制结果标明含未保存内容', copyUnsaved.data && copyUnsaved.data.includedUnsaved === true, copyUnsaved.data);
  check('复制结果回报章数与字数', copyUnsaved.data.chapterCount === 3 && copyUnsaved.data.chars > 0, copyUnsaved.data);
  const clipUnsaved = await clipboard.readText();
  check(
    '未保存的内容出现在复制结果里',
    typeof clipUnsaved === 'string' && clipUnsaved.includes('这段还没保存，但导出和复制都必须有'),
    typeof clipUnsaved === 'string' ? clipUnsaved.slice(0, 120) : String(clipUnsaved)
  );
  check('用编辑区覆盖后磁盘仍是旧内容（没有偷偷保存）', (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。');
  check('复制后当前章仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);

  // 9c. 章节 id 对不上时退回磁盘内容（避免误把别的章覆盖成当前章）
  const copyBadOverride = await exec(
    `window.api.copyBook(${JSON.stringify(bookDir)}, { chapterId: 'ch_not_exist', text: '不该出现在结果里' })`
  );
  check('覆盖匹配不到时仍能复制', Boolean(copyBadOverride && copyBadOverride.ok === true), copyBadOverride);
  check('匹配不到时不标记含未保存内容', copyBadOverride.data && copyBadOverride.data.includedUnsaved === false, copyBadOverride.data);
  const clipBad = await clipboard.readText();
  check(
    '匹配不到时不会把内容硬塞进结果',
    typeof clipBad === 'string' && !clipBad.includes('不该出现在结果里'),
    typeof clipBad === 'string' ? clipBad.slice(0, 120) : String(clipBad)
  );

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

  // 21. 章节栏 / 写作区 之间的分隔条可拖动，宽度按「这本书」记忆（不写全局）
  const sidebarBookId = await exec('window.__cwTest.bookId()');
  const globalSidebarBefore = await exec(
    'window.api.getConfig().then((r) => (r.ok ? r.data.editorSidebarWidth : null))'
  );
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
  const savedSidebarDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(sidebarBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '章节栏宽度记到这本书（全局默认不变）',
    Boolean(savedSidebarDisplay) &&
      savedSidebarDisplay.editorSidebarWidth === draggedWidth &&
      globalSidebarBefore === 250,
    { savedSidebarDisplay, globalSidebarBefore }
  );
  await exec(
    `document.getElementById('sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await sleep(400);
  const resetWidth = await exec('window.__cwTest.sidebarWidth()');
  check('双击分隔条恢复默认宽度', resetWidth === 250, { resetWidth });
  const resetSidebarDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(sidebarBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '双击恢复也按这本书记（记成 250）',
    Boolean(resetSidebarDisplay) && resetSidebarDisplay.editorSidebarWidth === 250,
    resetSidebarDisplay
  );

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

  // 23. 显示排版：预设 / 设置实时预览与取消恢复（按书记忆：只影响这本书，全局默认不动）
  const displayBookId = await exec('window.__cwTest.bookId()');
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
  const looseDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '显示预设按这本书记住',
    Boolean(looseDisplay) && looseDisplay.editorLineHeight === 2.4 && looseDisplay.editorPageWidth === 800,
    looseDisplay
  );
  const globalAfterPreset = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '显示预设不改全局默认',
    globalAfterPreset.editorLineHeight === 1.95 && globalAfterPreset.editorPageWidth === 0,
    { lineHeight: globalAfterPreset.editorLineHeight, pageWidth: globalAfterPreset.editorPageWidth }
  );

  await exec('window.__cwTest.openSettings()');
  check('从写作页能打开设置', (await exec('window.__cwTest.settingsOpen()')) === true);
  check('写作页里打开设置只作用于这本书', (await exec('window.__cwTest.settingsScope()')) === 'book');
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
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok && r.data.editorPaper === 'green'))`,
    10000
  );
  const savedBookPaper = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  const globalAfterBookSettings = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check('设置保存后护眼底色写入「这本书」', savedBookPaper.editorPaper === 'green', savedBookPaper);
  check(
    '设置保存不改全局默认纸色',
    globalAfterBookSettings.editorPaper === 'paper',
    globalAfterBookSettings.editorPaper
  );
  check('设置保存后正文仍未变', (await exec('window.__cwTest.text()')) === formattedText);

  // 「恢复本书默认」：清掉这本书的覆盖，回到全局设置
  await exec('window.__cwTest.openSettings()');
  await exec("document.getElementById('btn-reset-book-display').click()");
  await sleep(300);
  const displayAfterReset = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '「恢复本书默认」清空这本书的显示覆盖',
    Boolean(displayAfterReset) && Object.keys(displayAfterReset).length === 0,
    displayAfterReset
  );
  const styleAfterReset = await exec('window.__cwTest.displayStyle()');
  check(
    '恢复默认后行距回到全局值',
    Math.abs(parseFloat(styleAfterReset.lineHeight) - 18 * 1.95) <= 1.5,
    styleAfterReset.lineHeight
  );
  await exec('window.__cwTest.closeSettings()');

  // 从书架改「全局默认」：没单独设置过的书都用它
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  check('从书架打开设置改的是全局默认', (await exec('window.__cwTest.settingsScope()')) === 'global');
  await exec("window.__cwTest.setSelect('settings-paper', 'cream')");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor("window.api.getConfig().then((r) => (r.ok && r.data.editorPaper === 'cream'))", 10000);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(currentBookDir)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await sleep(300);
  const globalPaperStyle = await exec('window.__cwTest.displayStyle()');
  check('没有单独设置的书沿用全局纸色', globalPaperStyle.paperClass.includes('theme-cream'), globalPaperStyle.paperClass);

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

  const themeBookId = await exec('window.__cwTest.bookId()');
  await exec('window.__cwTest.openSettings()');
  check('写作页里的设置只改这本书', (await exec('window.__cwTest.settingsScope()')) === 'book');
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
  await waitFor(
    `window.api.getBookDisplay(${JSON.stringify(themeBookId)}).then((r) => (r.ok && r.data.editorPaper === 'night' && r.data.editorPaddingX === 24))`,
    10000
  );
  const themeBookDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(themeBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  const themeGlobalCfg = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '夜间主题与左右边距按这本书记住',
    themeBookDisplay.editorPaper === 'night' && themeBookDisplay.editorPaddingX === 24,
    { paper: themeBookDisplay.editorPaper, paddingX: themeBookDisplay.editorPaddingX }
  );
  check(
    '这本书的显示设置不改全局默认（仍是书架里设的米黄）',
    themeGlobalCfg.editorPaper === 'cream',
    themeGlobalCfg.editorPaper
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

  // 33. 书架搜索：书名 + 章节名（不读正文）
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const allShelfTitles = await exec('window.__cwTest.shelfTitles()');

  await exec("window.__cwTest.setShelfQuery('拖拽排序书')");
  await sleep(120);
  const titleFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check('书架搜索：按书名过滤', JSON.stringify(titleFiltered) === JSON.stringify(['拖拽排序书']), titleFiltered);
  check(
    '书架搜索：书名匹配时不显示章节命中行',
    (await exec('window.__cwTest.shelfCardMatches()')).length === 0
  );

  await exec("window.__cwTest.setShelfQuery('第三')");
  await sleep(120);
  const chapterFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  const chapterMatchLines = await exec('window.__cwTest.shelfCardMatches()');
  check('书架搜索：按章节名过滤到对应的书', chapterFiltered.includes('拖拽排序书'), chapterFiltered);
  check(
    '书架搜索：卡片上显示命中的章节名',
    chapterMatchLines.some((line) => line.includes('第三')),
    chapterMatchLines
  );
  check(
    '书架搜索：过滤后条数少于全部',
    chapterFiltered.length < allShelfTitles.length,
    { filtered: chapterFiltered.length, all: allShelfTitles.length }
  );

  await exec("window.__cwTest.setShelfQuery('绝对不存在的书名xyz')");
  await sleep(120);
  check('书架搜索：没有匹配时列表为空', (await exec('window.__cwTest.shelfFilteredTitles()')).length === 0);
  check(
    '书架搜索：没有匹配时给出提示',
    (await exec('window.__cwTest.shelfSearchSummary()')).includes('没有匹配'),
    await exec('window.__cwTest.shelfSearchSummary()')
  );
  check(
    '书架搜索：没有匹配时不显示「新建一本书」',
    (await exec("document.querySelectorAll('.book-card.new-book').length")) === 0
  );

  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(120);
  check(
    '书架搜索：清空后恢复全部书',
    (await exec('window.__cwTest.shelfFilteredTitles()')).length === allShelfTitles.length
  );
  check(
    '书架搜索：清空后「新建一本书」回来',
    (await exec("document.querySelectorAll('.book-card.new-book').length")) === 1
  );

  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))"
  );
  await sleep(80);
  check(
    '书架页 Ctrl+F 聚焦搜索框',
    (await exec('document.activeElement && document.activeElement.id')) === 'shelf-search',
    await exec('document.activeElement && document.activeElement.id')
  );

  await exec("window.__cwTest.setShelfQuery('拖拽排序书')");
  await exec(
    "document.getElementById('shelf-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  await sleep(100);
  check('书架搜索：Esc 清空搜索', (await exec('window.__cwTest.shelfQuery()')) === '');
  await exec("window.__cwTest.setShelfQuery('拖拽排序书')");
  await exec(
    "document.getElementById('shelf-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
  );
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '书架搜索：回车打开第一本匹配的书',
    (await exec('window.__cwTest.state.meta.title')) === '拖拽排序书'
  );

  // 34. 按书记忆显示设置：两本书互不影响，恢复默认回全局
  await exec("window.__cwTest.newBook('显示测试A')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bookAPath = await exec('window.__cwTest.state.bookPath');
  const bookAId = await exec('window.__cwTest.bookId()');
  await exec("window.__cwTest.applyDisplayPreset('loose')");
  await exec('window.__cwTest.persistSidebarWidth(410)');
  await sleep(300);
  const aDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(bookAId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '按书记忆：A 书预设与章节栏宽度都记到 A',
    Boolean(aDisplay) && aDisplay.editorLineHeight === 2.4 && aDisplay.editorSidebarWidth === 410,
    aDisplay
  );
  check('按书记忆：A 书宽度应用到页面', (await exec('window.__cwTest.sidebarWidth()')) === 410);

  await exec("window.__cwTest.newBook('显示测试B')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bookBId = await exec('window.__cwTest.bookId()');
  await sleep(300);
  const bDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(bookBId)}).then((r) => (r.ok ? r.data : null))`
  );
  const bStyle = await exec('window.__cwTest.displayStyle()');
  check('按书记忆：B 书没有单独设置', Boolean(bDisplay) && Object.keys(bDisplay).length === 0, bDisplay);
  check(
    '按书记忆：B 书用全局行距',
    Math.abs(parseFloat(bStyle.lineHeight) - 18 * 1.95) <= 1.5,
    bStyle.lineHeight
  );
  check('按书记忆：B 书章节栏回到全局宽度', (await exec('window.__cwTest.sidebarWidth()')) === 250);

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookAPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await sleep(300);
  const aStyleAgain = await exec('window.__cwTest.displayStyle()');
  check(
    '按书记忆：重新打开 A 还是 A 自己的行距',
    Math.abs(parseFloat(aStyleAgain.lineHeight) - 18 * 2.4) <= 1.5,
    aStyleAgain.lineHeight
  );
  check(
    '按书记忆：重新打开 A 还是 A 自己的章节栏宽度',
    (await exec('window.__cwTest.sidebarWidth()')) === 410
  );

  await exec('window.__cwTest.openSettings()');
  check('按书记忆：A 书设置作用域是 book', (await exec('window.__cwTest.settingsScope()')) === 'book');
  check(
    '按书记忆：有单独设置时显示「恢复本书默认」',
    (await exec("document.getElementById('btn-reset-book-display').classList.contains('hidden')")) === false
  );
  await exec("document.getElementById('btn-reset-book-display').click()");
  await sleep(300);
  const aAfterReset = await exec(
    `window.api.getBookDisplay(${JSON.stringify(bookAId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '按书记忆：恢复默认清空 A 的覆盖',
    Boolean(aAfterReset) && Object.keys(aAfterReset).length === 0,
    aAfterReset
  );
  check(
    '按书记忆：恢复后 A 回到全局行距',
    Math.abs(parseFloat((await exec('window.__cwTest.displayStyle()')).lineHeight) - 18 * 1.95) <= 1.5
  );
  await exec('window.__cwTest.closeSettings()');
  const cfgOnDisk = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '按书记忆：设置落进 config.json（重启也能保持）',
    Boolean(cfgOnDisk.bookDisplay) &&
      Object.keys(cfgOnDisk.bookDisplay).length > 0 &&
      !cfgOnDisk.bookDisplay[bookAId],
    cfgOnDisk.bookDisplay && Object.keys(cfgOnDisk.bookDisplay)
  );

  // 35. 新建 / 插入章节前自动保存当前章（不再弹「保存 / 不保存 / 取消」）
  await exec("window.__cwTest.newBook('自动保存测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.setText('第一段没保存的内容')");
  check('自动保存：输入后是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  await exec("window.__cwTest.newChapter('新章一')");
  check('自动保存：新建章节不再弹询问框', (await exec('window.__cwTest.modalOpen()')) === false);
  check(
    '自动保存：新建前的内容已写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '第一段没保存的内容'
  );
  check('自动保存：新章已创建并切过去', (await exec('window.__cwTest.currentTitle()')) === '第2章：新章一');
  check('自动保存：切到新章后是干净状态', (await exec('window.__cwTest.dirty()')) === false);

  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('插入前没保存的内容')");
  await exec('window.__cwTest.insertAfter(0, "插入章")');
  check('自动保存：插入章节同样不弹询问框', (await exec('window.__cwTest.modalOpen()')) === false);
  check(
    '自动保存：插入前的内容已写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '插入前没保存的内容'
  );
  check(
    '自动保存：插入章位置正确',
    JSON.stringify(await exec('window.__cwTest.chapterNames()')) === JSON.stringify(['', '插入章', '新章一']),
    await exec('window.__cwTest.chapterNames()')
  );

  // 36. 一键整理本书：复用当前规则 + 确认框 + 整本备份 + 进度
  await exec("window.__cwTest.newBook('整本排版测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const fmtBookPath = await exec('window.__cwTest.state.bookPath');
  await exec("window.__cwTest.newChapter('第二章')");
  await exec("window.__cwTest.newChapter('第三章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec(`window.__cwTest.setText(' 他说,"第一段."')`);
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.setText('第二段   ')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec("window.__cwTest.setText('　　已经整理好。')");
  await exec('window.__cwTest.save()');
  const fmtOptions = { indent: '2', blankLines: 'single', trimTrailing: true, normalizePunct: true };
  await exec(`window.__cwTest.setFormatOptions(${JSON.stringify(fmtOptions)})`);

  await exec("document.getElementById('btn-format').click()");
  check(
    '整本排版：排版菜单里有「一键整理本书…」',
    (await exec('Boolean(document.querySelector(\'#format-menu button[data-action="apply-book"]\'))')) === true
  );
  await exec("document.getElementById('btn-format').click()");

  const fmtPreview = await exec(
    `window.api.formatPreviewBook(${JSON.stringify(fmtBookPath)}, ${JSON.stringify(fmtOptions)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '整本排版：预检查统计会改动的章数',
    Boolean(fmtPreview) && fmtPreview.chapterCount === 3 && fmtPreview.chaptersChanged === 2,
    fmtPreview && { chapterCount: fmtPreview.chapterCount, changed: fmtPreview.chaptersChanged }
  );
  check(
    '整本排版：预检查不写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === ' 他说,"第一段."'
  );

  const bookFormatPromise = exec('window.__cwTest.runFormatBook()');
  await waitFor('window.__cwTest.modalOpen()');
  check('整本排版：会先弹确认框', (await exec('window.__cwTest.dialog()')) === '一键整理本书');
  const fmtConfirmMessage = await exec('window.__cwTest.modalMessage()');
  check(
    '整本排版：确认框列出规则与要改的章数',
    fmtConfirmMessage.includes('段首缩进 2 字符') && fmtConfirmMessage.includes('2 章有改动'),
    fmtConfirmMessage.slice(0, 120)
  );
  check(
    '整本排版：确认框说明会先备份',
    fmtConfirmMessage.includes('整理备份'),
    fmtConfirmMessage.slice(0, 120)
  );
  await exec("window.__cwTest.answerModal('ok')");
  const bookFormatResult = await bookFormatPromise;
  check('整本排版：执行成功', bookFormatResult && bookFormatResult.ok === true, bookFormatResult);
  await sleep(400);
  const fmtMeta = await storage.readBookMeta(fmtBookPath);
  check(
    '整本排版：全书已写盘为整理后格式',
    (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[0].file)).text === '　　他说，"第一段。"' &&
      (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[1].file)).text === '　　第二段',
    {
      ch0: (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[0].file)).text,
      ch1: (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[1].file)).text
    }
  );
  check(
    '整本排版：已经整理好的章不动',
    (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[2].file)).text === '　　已经整理好。'
  );
  check(
    '整本排版：字数缓存已更新',
    fmtMeta.chapters[0].chars === 9 && fmtMeta.chapters[1].chars === 3,
    fmtMeta.chapters.map((chapter) => chapter.chars)
  );
  const fmtTrash = await fs.readdir(path.join(fmtBookPath, '_trash')).catch(() => []);
  const fmtBackupName = fmtTrash.find((name) => name.startsWith('整理备份-'));
  check('整本排版：原文备份到书内 _trash/整理备份-*', Boolean(fmtBackupName), fmtTrash);
  const fmtBackupText = await fs.readFile(
    path.join(fmtBookPath, '_trash', fmtBackupName, fmtMeta.chapters[0].file),
    'utf8'
  );
  check('整本排版：备份里是整理前的原文', fmtBackupText === ' 他说,"第一段."', fmtBackupText);
  check(
    '整本排版：进度提示在完成后收起',
    (await exec('window.__cwTest.formatBookProgressText()')) === ''
  );
  check(
    '整本排版：当前章已重新载入',
    (await exec('window.__cwTest.text()')) === '　　已经整理好。'
  );

  const fmtAgain = await exec('window.__cwTest.runFormatBook()');
  check(
    '整本排版：没有改动时不弹确认、直接提示',
    fmtAgain && fmtAgain.ok === true && fmtAgain.changed === 0 && (await exec('window.__cwTest.modalOpen()')) === false,
    fmtAgain
  );

  // 有未保存修改时先问「保存后整理 / 不保存 / 取消」
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('临时未保存的内容')");
  const fmtDirtyPromise = exec('window.__cwTest.runFormatBook()');
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '整本排版：当前章未保存会先问',
    (await exec('window.__cwTest.dialog()')) === '整理本书前先处理未保存的修改'
  );
  await exec("window.__cwTest.answerModal('save')");
  await waitFor("window.__cwTest.dialog() === '一键整理本书'");
  await exec("window.__cwTest.answerModal('cancel')");
  const fmtDirtyResult = await fmtDirtyPromise;
  check('整本排版：取消后不写盘', fmtDirtyResult && fmtDirtyResult.canceled === true, fmtDirtyResult);
  check(
    '整本排版：取消后磁盘上只多了刚保存的未整理内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '临时未保存的内容'
  );

  // 导出目录记忆：导出过的文件夹下次要记住（写进 config.json；坏值自动清洗）
  const { app } = require('electron');
  const configFile = path.join(app.getPath('userData'), 'config.json');
  const wantedDir = 'D:\\导出测试目录';
  const setDirRes = await exec(`window.api.setConfig({ lastExportDir: ${JSON.stringify(wantedDir)} })`);
  check(
    '导出目录记忆：能写进配置并读回',
    Boolean(setDirRes && setDirRes.ok === true && setDirRes.data.lastExportDir === wantedDir),
    setDirRes && setDirRes.data
  );
  await exec('window.api.setConfig({ lastExportDir: 12345 })');
  const badDirCfg = await exec('window.api.getConfig()');
  check(
    '导出目录记忆：非法值清洗成空（下次退回文档目录）',
    Boolean(badDirCfg && badDirCfg.ok === true && badDirCfg.data.lastExportDir === ''),
    badDirCfg && badDirCfg.data
  );
  await exec(`window.api.setConfig({ lastExportDir: ${JSON.stringify(wantedDir)} })`);
  let savedConfig = null;
  try {
    savedConfig = JSON.parse(await fs.readFile(configFile, 'utf8'));
  } catch {
    /* 读不到就当失败 */
  }
  check(
    '导出目录记忆：真的落进 config.json',
    Boolean(savedConfig && savedConfig.lastExportDir === wantedDir),
    savedConfig && savedConfig.lastExportDir
  );

  // 分卷：新建卷 / 卷内建章 / 侧栏分组 / 移卷 / 改名 / 导出带卷名 / 删卷
  const bookPathForVol = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const newVol = await exec("window.__cwTest.newVolume('第1卷：单篇')");
  check('分卷：新建卷成功', Boolean(newVol && newVol.ok === true), newVol);
  check(
    '分卷：卷出现在侧栏',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['第1卷：单篇'])
  );
  const volIds = await exec('window.__cwTest.volumeIds()');
  await exec("window.__cwTest.newChapterInVolume(0, '卷内章')");
  const namesAfterVol = await exec('window.__cwTest.chapterNames()');
  const volumesAfterVol = await exec('window.__cwTest.chapterVolumeIds()');
  const lastVolIndex = namesAfterVol.length - 1;
  check(
    '分卷：卷内新建的章被放进卷里',
    namesAfterVol[lastVolIndex] === '卷内章' && volumesAfterVol[lastVolIndex] === volIds[0],
    { namesAfterVol, volumesAfterVol }
  );
  check(
    '分卷：侧栏出现卷分组',
    (await exec('window.__cwTest.volumeHeaders()')).includes('第1卷：单篇')
  );

  const orphanIndex = volumesAfterVol.findIndex((v) => v === null);
  if (orphanIndex >= 0) {
    await exec(`window.__cwTest.moveChapterToVolumeAt(${orphanIndex}, 0)`);
    const movedVolumes = await exec('window.__cwTest.chapterVolumeIds()');
    check(
      '分卷：把章移到卷里',
      movedVolumes.filter((v) => v === volIds[0]).length >= 2,
      movedVolumes
    );
  }

  await exec("window.__cwTest.renameVolumeAt(0, '第1卷：改名')");
  check(
    '分卷：卷改名',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['第1卷：改名'])
  );

  const volClip = await exec(`window.api.copyBook(${JSON.stringify(bookPathForVol)})`);
  check('分卷：复制整本成功', Boolean(volClip && volClip.ok === true), volClip);
  const clipWithVolume = await clipboard.readText();
  check(
    '分卷：导出内容带卷名一行',
    typeof clipWithVolume === 'string' && clipWithVolume.includes('第1卷：改名'),
    typeof clipWithVolume === 'string' ? clipWithVolume.slice(0, 80) : String(clipWithVolume)
  );

  const chaptersBeforeDeleteVolume = (await exec('window.__cwTest.chapterTitles()')).length;
  await exec('window.__cwTest.deleteVolumeAt(0, true)');
  check('分卷：删卷后卷没了', (await exec('window.__cwTest.volumeNames()')).length === 0);
  check(
    '分卷：删卷不删章',
    (await exec('window.__cwTest.chapterTitles()')).length === chaptersBeforeDeleteVolume
  );
  check(
    '分卷：删卷后章节都回未分卷',
    (await exec('window.__cwTest.chapterVolumeIds()')).every((v) => v === null)
  );

  // 分卷：卷上下移动 + 跨卷拖拽
  await exec("window.__cwTest.newVolume('甲卷')");
  await exec("window.__cwTest.newVolume('乙卷')");
  await exec("window.__cwTest.newChapterInVolume(0, '甲一')");
  await exec("window.__cwTest.newChapterInVolume(1, '乙一')");
  check(
    '分卷：两个卷都在',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['甲卷', '乙卷'])
  );
  await exec('window.__cwTest.moveVolumeAt(1, 0)');
  check(
    '分卷：卷可以上下移动',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['乙卷', '甲卷'])
  );
  const volIdsOrdered = await exec('window.__cwTest.volumeIds()');
  const chapterVolsBeforeDrag = await exec('window.__cwTest.chapterVolumeIds()');
  const chapterInJia = chapterVolsBeforeDrag.findIndex((v) => v === volIdsOrdered[1]);
  check('分卷：找得到甲卷里的章', chapterInJia >= 0, chapterVolsBeforeDrag);
  await exec(`window.__cwTest.dragChapterTo(${chapterInJia}, 0, null)`);
  const chapterVolsAfterDrag = await exec('window.__cwTest.chapterVolumeIds()');
  check(
    '分卷：跨卷拖拽把章放进目标卷',
    chapterVolsAfterDrag.filter((v) => v === volIdsOrdered[0]).length >= 2,
    chapterVolsAfterDrag
  );

  // 37. 章节状态 + 备注：只改书目.json，章节 txt 一个字节不动
  await exec("window.__cwTest.newBook('状态备注测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const statusBookPath = await exec('window.__cwTest.state.bookPath');
  await exec("window.__cwTest.newChapter('待修章')");
  await exec("window.__cwTest.newChapter('完稿章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('第一章正文。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.setText('第二章正文。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec("window.__cwTest.setText('第三章正文。')");
  await exec('window.__cwTest.save()');

  // 记下三章 txt 的字节和 mtime：后面标状态、写备注后必须完全一致
  const statusMetaBefore = await storage.readBookMeta(statusBookPath);
  const statusTxtBefore = [];
  for (const chapter of statusMetaBefore.chapters) {
    const filePath = path.join(statusBookPath, chapter.file);
    const stat = await fs.stat(filePath);
    statusTxtBefore.push({
      file: chapter.file,
      text: await fs.readFile(filePath),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  }

  check(
    '章节状态：新书默认全是草稿、没有备注',
    JSON.stringify(await exec('window.__cwTest.chapterStatuses()')) ===
      JSON.stringify(['draft', 'draft', 'draft']) &&
      (await exec('window.__cwTest.chapterNotes()')).every((note) => note === '')
  );
  check(
    '章节状态：侧栏三个默认灰色圆点',
    JSON.stringify(await exec('window.__cwTest.chapterStatusDots()')) ===
      JSON.stringify(['draft', 'draft', 'draft'])
  );
  check('章节状态：草稿章没有备注图标', (await exec('window.__cwTest.chapterNoteMarks()')).length === 0);

  // 右键菜单：标记项 + 备注项（走真实 contextmenu 事件）
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))"
  );
  check(
    '章节状态：右键菜单有标记完稿/待修/草稿和编辑备注',
    JSON.stringify(await exec("Array.from(document.querySelectorAll('#context-menu button[data-action]')).map((b) => b.dataset.action)")) ===
      JSON.stringify(['status-done', 'status-revising', 'status-draft', 'edit-note', 'copy-platform', 'rename', 'move-volume', 'insert-before', 'insert-after', 'delete']),
    await exec("Array.from(document.querySelectorAll('#context-menu button[data-action]')).map((b) => b.dataset.action)")
  );
  check(
    '章节状态：当前状态的那一项打勾',
    (await exec("document.querySelector('#context-menu button[data-action=\"status-draft\"]').textContent")).includes('✓')
  );
  await exec("document.querySelector('#context-menu button[data-action=\"status-done\"]').click()");
  await waitFor("window.__cwTest.chapterStatuses()[0] === 'done'");
  check('章节状态：右键「标记为完稿」生效', (await exec('window.__cwTest.chapterStatuses()'))[0] === 'done');
  await exec("window.__cwTest.setChapterStatusAt(1, 'revising')");
  await exec("window.__cwTest.setChapterStatusAt(2, 'done')");
  check(
    '章节状态：圆点跟着状态走（完稿/待修/完稿）',
    JSON.stringify(await exec('window.__cwTest.chapterStatusDots()')) ===
      JSON.stringify(['done', 'revising', 'done'])
  );

  // 编辑备注：右键 → 编辑备注…（弹窗里填一句话）
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))"
  );
  await exec("document.querySelector('#context-menu button[data-action=\"edit-note\"]').click()");
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '章节备注：弹窗标题带章节名',
    (await exec('window.__cwTest.dialog()')).includes('章节备注'),
    await exec('window.__cwTest.dialog()')
  );
  await exec("document.getElementById('modal-input').value = '这章结尾要重写';");
  await exec("window.__cwTest.answerModal('ok')");
  await waitFor("window.__cwTest.chapterNotes()[2] === '这章结尾要重写'");
  check(
    '章节备注：侧栏出现 ✎ 标记、悬浮能看到备注',
    (await exec('window.__cwTest.chapterNoteMarks()')).length === 1 &&
      (await exec('window.__cwTest.chapterItemTitles()'))[2].includes('这章结尾要重写')
  );

  // 超过 200 字截断、空备注删除字段、非法状态拒绝
  const statusChapter1Id = statusMetaBefore.chapters[1].id;
  const statusChapter0Id = statusMetaBefore.chapters[0].id;
  const longNoteRes = await exec(
    `window.api.updateChapterMeta(${JSON.stringify(statusBookPath)}, ${JSON.stringify(statusChapter1Id)}, { note: '字'.repeat(250) })`
  );
  check(
    '章节备注：超过 200 字自动截断',
    Boolean(longNoteRes && longNoteRes.ok === true && longNoteRes.data.chapter.note.length === 200),
    longNoteRes && longNoteRes.data && longNoteRes.data.chapter
  );
  await exec(
    `window.api.updateChapterMeta(${JSON.stringify(statusBookPath)}, ${JSON.stringify(statusChapter1Id)}, { note: '' })`
  );
  const clearedMeta = await storage.readBookMeta(statusBookPath);
  check('章节备注：清空后备注字段被删除', clearedMeta.chapters[1].note === undefined);
  const badStatusRes = await exec(
    `window.api.updateChapterMeta(${JSON.stringify(statusBookPath)}, ${JSON.stringify(statusChapter0Id)}, { status: 'finished' })`
  );
  check(
    '章节状态：非法状态被拒绝（BAD_STATUS）',
    Boolean(badStatusRes && badStatusRes.ok === false && badStatusRes.code === 'BAD_STATUS'),
    badStatusRes
  );

  // 落盘检查：状态/备注进书目；txt 一个字节都不动
  const statusMetaAfter = await storage.readBookMeta(statusBookPath);
  check(
    '章节状态/备注：状态与备注写进书目.json',
    statusMetaAfter.chapters[0].status === 'done' &&
      statusMetaAfter.chapters[1].status === 'revising' &&
      statusMetaAfter.chapters[2].status === 'done' &&
      statusMetaAfter.chapters[2].note === '这章结尾要重写',
    statusMetaAfter.chapters.map((chapter) => ({ status: chapter.status, note: chapter.note }))
  );
  const statusRaw = JSON.parse(await fs.readFile(path.join(statusBookPath, '书目.json'), 'utf8'));
  check(
    '章节状态/备注：书目里没备注的章不带 note 字段',
    statusRaw.chapters[0].note === undefined && statusRaw.chapters[1].note === undefined
  );
  let statusTxtUntouched = true;
  for (const item of statusTxtBefore) {
    const filePath = path.join(statusBookPath, item.file);
    const stat = await fs.stat(filePath);
    const text = await fs.readFile(filePath);
    if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs || !text.equals(item.text)) {
      statusTxtUntouched = false;
    }
  }
  check('章节状态/备注：txt 内容、大小、mtime 一个字节都没动', statusTxtUntouched);

  // 书卡显示「完稿 X/Y 章」
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(250);
  const cardMetaTexts = await exec('window.__cwTest.bookCardMetaTexts()');
  check(
    '书卡：显示「完稿 2/3 章」',
    cardMetaTexts.some((text) => text.includes('完稿 2/3 章')),
    cardMetaTexts
  );

  // 重新打开：状态/备注从书目读回
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(statusBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '章节状态/备注：重新打开书后还在',
    JSON.stringify(await exec('window.__cwTest.chapterStatuses()')) ===
      JSON.stringify(['done', 'revising', 'done']) &&
      (await exec('window.__cwTest.chapterNotes()'))[2] === '这章结尾要重写'
  );

  // 38. 复制本章（平台格式）：只复制正文、段首缩进 + 段间空一行（空行带缩进），不写盘
  await exec("window.__cwTest.newBook('复制本章测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const copyBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.newChapter('第二章 未保存')");
  await exec("window.__cwTest.newChapter('第三章 空章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('风从海面吹来。\\n他收起了帆。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.setText('这一章还没保存。\\n第二段。')");

  // 记下复制前磁盘状态：复制本章全程只读，txt / 书目.json 的章节记录都不该被改写
  const copyMeta = await storage.readBookMeta(copyBookPath);
  const copyChaptersBefore = JSON.stringify(copyMeta.chapters);
  const copyFiles = copyMeta.chapters.map((chapter) => path.join(copyBookPath, chapter.file));
  const copyStatBefore = [];
  for (const filePath of copyFiles) {
    const stat = await fs.stat(filePath);
    copyStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // Ctrl+Shift+C：当前章有未保存内容时，编辑区里的最新内容参与复制
  await clipboard.writeText('E2E-SENTINEL');
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true }))"
  );
  const clipCurrent = await waitForClipboard((text) => text !== 'E2E-SENTINEL');
  check(
    '复制本章：Ctrl+Shift+C 把当前章正文按平台格式送进剪贴板',
    clipCurrent === '　　这一章还没保存。\r\n　　\r\n　　第二段。\r\n',
    JSON.stringify(clipCurrent)
  );
  check(
    '复制本章：剪贴板里只有正文、不含章名',
    !clipCurrent.includes('第二章 未保存') && !clipCurrent.includes('第2章'),
    JSON.stringify(clipCurrent)
  );
  check('复制本章：未保存内容参与复制、但复制后仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '复制本章：没保存的正文没有偷偷写盘',
    (await exec('window.__cwTest.chapterTextAt(1)')) === ''
  );

  // 右键章节（非当前章）→「复制本章（平台格式）」：读磁盘内容，也同样套格式
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))"
  );
  check(
    '复制本章：右键菜单有「复制本章（平台格式）」',
    (await exec("document.querySelector('#context-menu button[data-action=\"copy-platform\"]').textContent")).includes(
      '复制本章（平台格式）'
    )
  );
  await clipboard.writeText('E2E-SENTINEL-2');
  await exec("document.querySelector('#context-menu button[data-action=\"copy-platform\"]').click()");
  const clipSaved = await waitForClipboard((text) => text !== 'E2E-SENTINEL-2');
  check(
    '复制本章：右键复制已保存章也套平台格式',
    clipSaved === '　　风从海面吹来。\r\n　　\r\n　　他收起了帆。\r\n',
    JSON.stringify(clipSaved)
  );
  check(
    '复制本章：右键复制的是被点的那一章、不是当前章',
    !clipSaved.includes('这一章还没保存'),
    JSON.stringify(clipSaved)
  );

  // 空章：给提示，绝不拿空字符串覆盖剪贴板
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await clipboard.writeText('KEEP-ME');
  const emptyCopy = await exec('window.__cwTest.copyChapterPlatformAt(2)');
  check(
    '复制本章：空章给出 empty 标记、剪贴板没被覆盖',
    Boolean(emptyCopy && emptyCopy.empty === true) && (await readClipboard()) === 'KEEP-ME',
    emptyCopy
  );

  // 全程只读：章节 txt 的大小 / mtime 没变；书目里的章节记录也没被复制动作改写
  // （切章会正常更新「上次打开章节」，所以只比较 chapters 数组，不比较整个书目文件）
  let copyFilesUntouched = true;
  for (let i = 0; i < copyFiles.length; i += 1) {
    const stat = await fs.stat(copyFiles[i]);
    if (stat.size !== copyStatBefore[i].size || stat.mtimeMs !== copyStatBefore[i].mtimeMs) {
      copyFilesUntouched = false;
    }
  }
  const copyMetaAfter = await storage.readBookMeta(copyBookPath);
  check(
    '复制本章：章节 txt 与书目的章节记录都没被改写（纯读 + 剪贴板）',
    copyFilesUntouched && JSON.stringify(copyMetaAfter.chapters) === copyChaptersBefore
  );

  // 39. 范围 / 分卷导出（v0.5-3）：全书 / 某卷 / 第 X–Y 章，文件名和内容都按范围来
  await exec("window.__cwTest.newBook('范围导出测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const exportBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.newVolume('上卷')");
  const exportVolumeIds = await exec('window.__cwTest.volumeIds()');
  await exec("window.__cwTest.newChapterInVolume(0, '上卷一')");
  await exec("window.__cwTest.newVolume('下卷')");
  await exec("window.__cwTest.newChapterInVolume(1, '下卷二')");
  await exec("window.__cwTest.newChapterInVolume(1, '下卷三')");
  const exportTexts = ['楔子正文。', '上卷第一章正文。', '下卷第二章正文。', '下卷第三章正文。'];
  for (let i = 0; i < exportTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(exportTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  check(
    '范围导出：准备了一本 4 章 / 2 卷的书',
    (await exec('window.__cwTest.chapterNames()')).length === 4 &&
      (await exec('window.__cwTest.volumeNames()')).length === 2,
    {
      chapters: await exec('window.__cwTest.chapterNames()'),
      volumes: await exec('window.__cwTest.volumeNames()')
    }
  );
  const exportMeta = await storage.readBookMeta(exportBookPath);
  const exportDiskTexts = [];
  const exportFiles = [];
  const exportStatBefore = [];
  for (const chapter of exportMeta.chapters) {
    const filePath = path.join(exportBookPath, chapter.file);
    exportFiles.push(filePath);
    exportDiskTexts.push((await storage.loadChapterText(exportBookPath, chapter.file)).text);
    const stat = await fs.stat(filePath);
    exportStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check('范围导出：四章正文都已落盘', JSON.stringify(exportDiskTexts) === JSON.stringify(exportTexts), exportDiskTexts);

  const exportDir = path.join(path.dirname(booksRoot), 'exports');
  await fs.mkdir(exportDir, { recursive: true });
  const { dialog } = require('electron');
  const originalShowSaveDialog = dialog.showSaveDialog;
  let lastSaveOptions = null;
  const withSavePath = (filePath) => {
    lastSaveOptions = null;
    dialog.showSaveDialog = async (_win, options) => {
      lastSaveOptions = options;
      return { canceled: false, filePath };
    };
  };
  const restoreSaveDialog = () => {
    dialog.showSaveDialog = originalShowSaveDialog;
  };
  const openExportDialogFromMenu = async () => {
    await exec(
      "document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action=\"txt\"]').click()"
    );
    await waitFor('window.__cwTest.exportDialogOpen() === true');
  };
  const chooseExportRange = async (from, to) => {
    await exec(
      "document.querySelector('input[name=\"export-scope\"][value=\"range\"]').click()"
    );
    await exec(
      `(() => { const f = document.getElementById('export-from'); f.value = ${JSON.stringify(String(from))}; f.dispatchEvent(new Event('input', { bubbles: true })); const t = document.getElementById('export-to'); t.value = ${JSON.stringify(String(to))}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
  };

  // 39a. 打开对话框：默认全书 4 章 29 字、默认文件名 = 书名.txt
  await openExportDialogFromMenu();
  const summaryAll = await waitForSummary('将导出 4 章');
  check(
    '范围导出：默认全书 4 章 29 字，默认文件名 = 书名.txt',
    summaryAll.includes('将导出 4 章 · 29 字') && summaryAll.includes('范围导出测试书.txt'),
    summaryAll
  );

  // 39b. 范围不合法：起始章大于结束章 / 超出章数 → 明确提示 + 禁用导出
  await chooseExportRange(3, 1);
  const badRangeSummary = await waitForSummary('起始章不能大于结束章');
  check(
    '范围导出：起始章大于结束章时提示、导出按钮不可点',
    badRangeSummary.includes('起始章不能大于结束章') &&
      (await exec('window.__cwTest.exportConfirmDisabled()')) === true,
    badRangeSummary
  );
  await chooseExportRange(0, 9);
  const outOfRangeSummary = await waitForSummary('章节范围要在第 1–4 章之间');
  check(
    '范围导出：范围超出第 1–4 章时提示',
    outOfRangeSummary.includes('章节范围要在第 1–4 章之间') &&
      (await exec('window.__cwTest.exportConfirmDisabled()')) === true,
    outOfRangeSummary
  );
  await chooseExportRange(2, 2);
  const singleSummary = await waitForSummary('范围导出测试书-第2章.txt');
  check(
    '范围导出：单章范围显示 1 章、文件名带第2章',
    singleSummary.includes('将导出 1 章') && singleSummary.includes('范围导出测试书-第2章.txt'),
    singleSummary
  );

  // 39c. 按卷导出：摘要只算这一卷；保存对话框默认文件名带卷名，文件里只有这一卷
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    `(() => { const select = document.getElementById('export-volume'); select.value = ${JSON.stringify(exportVolumeIds[0])}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  );
  const volumeSummary = await waitForSummary('范围导出测试书-上卷.txt');
  check(
    '范围导出：按卷摘要显示 1 章、文件名带卷名',
    volumeSummary.includes('将导出 1 章') && volumeSummary.includes('范围导出测试书-上卷.txt'),
    volumeSummary
  );
  const volumeExportPath = path.join(exportDir, 'volume-export.txt');
  withSavePath(volumeExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(volumeExportPath);
  } finally {
    restoreSaveDialog();
  }
  check('范围导出：确认后对话框收起', (await exec('window.__cwTest.exportDialogOpen()')) === false);
  check(
    '范围导出：保存对话框默认文件名 = 书名-卷名.txt',
    Boolean(lastSaveOptions) &&
      path.basename(lastSaveOptions.defaultPath) === '范围导出测试书-上卷.txt',
    lastSaveOptions && lastSaveOptions.defaultPath
  );
  const expectedVolumeText = exporter.composeBook(exportMeta, exportDiskTexts, {
    mode: 'volume',
    volumeId: exportVolumeIds[0]
  });
  const volumeFileText = await fs.readFile(volumeExportPath, 'utf8');
  check(
    '范围导出：按卷导出只有这一卷、章号仍是全书第 2 章',
    volumeFileText === `\uFEFF${expectedVolumeText}` &&
      volumeFileText.includes('第2章：上卷一') &&
      volumeFileText.includes('上卷第一章正文。') &&
      !volumeFileText.includes('下卷') &&
      !volumeFileText.includes('楔子正文'),
    volumeFileText
  );

  // 39d. 第 3–4 章（跨卷）：文件名带范围，内容只有这两章，章号不重排
  await openExportDialogFromMenu();
  await chooseExportRange(3, 4);
  const rangeSummary = await waitForSummary('范围导出测试书-第3-4章.txt');
  check(
    '范围导出：章节范围摘要 2 章 16 字、文件名带第3-4章',
    rangeSummary.includes('将导出 2 章 · 16 字') &&
      rangeSummary.includes('范围导出测试书-第3-4章.txt'),
    rangeSummary
  );
  const rangeExportPath = path.join(exportDir, 'range-export.txt');
  withSavePath(rangeExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(rangeExportPath);
  } finally {
    restoreSaveDialog();
  }
  check(
    '范围导出：保存对话框默认文件名 = 书名-第3-4章.txt',
    Boolean(lastSaveOptions) &&
      path.basename(lastSaveOptions.defaultPath) === '范围导出测试书-第3-4章.txt',
    lastSaveOptions && lastSaveOptions.defaultPath
  );
  const expectedRangeText = exporter.composeBook(exportMeta, exportDiskTexts, {
    mode: 'range',
    from: 3,
    to: 4
  });
  const rangeFileText = await fs.readFile(rangeExportPath, 'utf8');
  check(
    '范围导出：第 3–4 章内容正确（跨卷带卷名、章号仍是第 3/4 章）',
    rangeFileText === `\uFEFF${expectedRangeText}` &&
      rangeFileText.includes('第3章：下卷二') &&
      rangeFileText.includes('第4章：下卷三') &&
      rangeFileText.includes('下卷') &&
      !rangeFileText.includes('上卷一') &&
      !rangeFileText.includes('楔子'),
    rangeFileText
  );

  // 39e. 全书导出：和以前完全一样（不传范围和传全书范围同结果）
  await openExportDialogFromMenu();
  await waitForSummary('范围导出测试书.txt');
  const allExportPath = path.join(exportDir, 'all-export.txt');
  withSavePath(allExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(allExportPath);
  } finally {
    restoreSaveDialog();
  }
  check(
    '范围导出：全书导出文件名 = 书名.txt',
    Boolean(lastSaveOptions) &&
      path.basename(lastSaveOptions.defaultPath) === '范围导出测试书.txt',
    lastSaveOptions && lastSaveOptions.defaultPath
  );
  const allFileText = await fs.readFile(allExportPath, 'utf8');
  check(
    '范围导出：全书导出和以前完全一样（四章都在）',
    allFileText === `\uFEFF${exporter.composeBook(exportMeta, exportDiskTexts)}` &&
      allFileText.includes('楔子正文。') &&
      allFileText.includes('上卷第一章正文。') &&
      allFileText.includes('下卷第二章正文。') &&
      allFileText.includes('下卷第三章正文。'),
    allFileText.slice(0, 120)
  );

  // 39f. 当前章未保存内容参与范围导出（只参与拼接，不写盘）
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec("window.__cwTest.setText('还没保存的下卷内容。')");
  await openExportDialogFromMenu();
  await chooseExportRange(3, 3);
  // 等范围摘要（文件名是范围专属的；「含未保存内容」在全书摘要里也会有，不能单独当等待条件）
  const unsavedSummary = await waitForSummary('范围导出测试书-第3章.txt');
  check(
    '范围导出：摘要提示含当前章未保存内容、文件名带第3章',
    unsavedSummary.includes('含当前章未保存内容') &&
      unsavedSummary.includes('范围导出测试书-第3章.txt'),
    unsavedSummary
  );
  const unsavedExportPath = path.join(exportDir, 'unsaved-export.txt');
  withSavePath(unsavedExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(unsavedExportPath);
  } finally {
    restoreSaveDialog();
  }
  const unsavedFileText = await fs.readFile(unsavedExportPath, 'utf8');
  check(
    '范围导出：未保存正文进了导出文件、旧正文没进去',
    unsavedFileText.includes('还没保存的下卷内容。') &&
      !unsavedFileText.includes('下卷第二章正文。') &&
      unsavedFileText.includes('第3章：下卷二'),
    unsavedFileText
  );
  check(
    '范围导出：导出未保存内容后仍保持未保存、磁盘没被偷偷改写',
    (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.chapterTextAt(2)')) === '下卷第二章正文。'
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // 39g. 保存对话框点取消：不写文件、不报错
  const cancelExportPath = path.join(exportDir, 'cancel-export.txt');
  await openExportDialogFromMenu();
  await waitForSummary('范围导出测试书.txt');
  let cancelDialogOpened = false;
  dialog.showSaveDialog = async () => {
    cancelDialogOpened = true;
    return { canceled: true };
  };
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await sleep(500);
  } finally {
    restoreSaveDialog();
  }
  check(
    '范围导出：取消保存对话框不写文件、仍停在编辑页',
    cancelDialogOpened &&
      !(await fileExists(cancelExportPath)) &&
      (await exec('window.__cwTest.view()')) === 'editor'
  );

  // 39h. Esc 关闭导出对话框
  await openExportDialogFromMenu();
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('范围导出：Esc 关闭导出对话框', (await exec('window.__cwTest.exportDialogOpen()')) === false);

  // 39i. 全程只读：章节 txt 的大小 / mtime 没变，书目里的 chapters 也没被导出改写
  let exportFilesUntouched = true;
  for (let i = 0; i < exportFiles.length; i += 1) {
    const stat = await fs.stat(exportFiles[i]);
    if (stat.size !== exportStatBefore[i].size || stat.mtimeMs !== exportStatBefore[i].mtimeMs) {
      exportFilesUntouched = false;
    }
  }
  const exportMetaAfter = await storage.readBookMeta(exportBookPath);
  check(
    '范围导出：章节 txt 与书目的章节记录都没被导出改写（纯读）',
    exportFilesUntouched &&
      JSON.stringify(exportMetaAfter.chapters) === JSON.stringify(exportMeta.chapters)
  );

  // 40. 继续上次写作 + Ctrl+G 跳章（v0.5-4）
  await exec("window.__cwTest.newBook('继续写作测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const resumeBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.newChapter('夜雨')");
  await exec("window.__cwTest.newChapter('远行')");
  await exec("window.__cwTest.newChapter('归途')");
  const resumeTexts = ['起风正文。', '夜雨正文。', '远行正文。', '归途正文。'];
  for (let i = 0; i < resumeTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(resumeTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  check(
    '继续写作：准备了 4 章且正文都已落盘',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：夜雨', '第3章：远行', '第4章：归途'])
  );

  // 跳章 / 继续写作全程只读正文：先记下 4 个 txt 的大小和 mtime
  const resumeMeta = await storage.readBookMeta(resumeBookPath);
  const resumeFiles = resumeMeta.chapters.map((chapter) => path.join(resumeBookPath, chapter.file));
  const resumeStatBefore = [];
  for (const filePath of resumeFiles) {
    const stat = await fs.stat(filePath);
    resumeStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 40a. 切到第 4 章后回书架：顶部出现「继续写《书名》· 第4章」
  await exec("window.__cwTest.switchTo(3, 'discard')");
  const resumeChapterId = await exec('window.__cwTest.currentChapterId()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitFor('window.__cwTest.continueVisible() === true');
  const continueText = await exec('window.__cwTest.continueText()');
  check(
    '继续写作：书架顶部显示上次这本书和第 4 章',
    continueText.includes('继续写《继续写作测试书》') && continueText.includes('第4章：归途'),
    continueText
  );
  const continueMetaText = await exec('window.__cwTest.continueMeta()');
  check(
    '继续写作：入口显示最后写作时间和总章数',
    continueMetaText.includes('最后写作') && continueMetaText.includes('共 4 章'),
    continueMetaText
  );

  const recentOnShelf = await exec('window.api.getRecentBook()');
  check(
    '继续写作：lastBook 记录了路径 / 章节 id / 下标 / 章名 / 时间戳',
    recentOnShelf.ok === true &&
      recentOnShelf.data.path === resumeBookPath &&
      recentOnShelf.data.title === '继续写作测试书' &&
      recentOnShelf.data.chapterId === resumeChapterId &&
      recentOnShelf.data.chapterIndex === 3 &&
      recentOnShelf.data.chapterName === '归途' &&
      recentOnShelf.data.at > 0,
    recentOnShelf
  );
  const diskConfig = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '继续写作：lastBook 真的写进了 config.json，没碰书库',
    diskConfig.lastBook &&
      diskConfig.lastBook.path === resumeBookPath &&
      diskConfig.lastBook.chapterId === resumeChapterId &&
      diskConfig.lastBook.chapterIndex === 3,
    diskConfig.lastBook
  );

  // 40b. 点一下入口：打开书并回到上次那一章
  await exec('window.__cwTest.clickContinue()');
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '继续写作：点一下就回到上次编辑的第 4 章',
    (await exec('window.__cwTest.currentIndex()')) === 3 &&
      (await exec('window.__cwTest.currentTitle()')) === '第4章：归途'
  );

  // 40c. Ctrl+G：输入章号 → 回车跳过去
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  check(
    'Ctrl+G：打开跳章对话框，默认提示共 4 章',
    (await exec('window.__cwTest.jumpSummary()')).includes('共 4 章'),
    await exec('window.__cwTest.jumpSummary()')
  );
  await exec("window.__cwTest.setJumpQuery('2')");
  const jumpNumberSummary = await exec('window.__cwTest.jumpSummary()');
  check(
    'Ctrl+G：输入章号 2 精确显示第2章：夜雨、跳转按钮可用',
    jumpNumberSummary.includes('第2章：夜雨') &&
      (await exec('window.__cwTest.jumpConfirmDisabled()')) === false,
    jumpNumberSummary
  );
  await exec(
    "document.getElementById('jump-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
  );
  await waitFor("window.__cwTest.currentTitle() === '第2章：夜雨'");
  check(
    'Ctrl+G：回车跳到第 2 章并收起对话框',
    (await exec('window.__cwTest.jumpDialogOpen()')) === false &&
      (await exec('window.__cwTest.currentIndex()')) === 1
  );

  // 40d. Ctrl+G：章名关键词 → 列出结果并点选
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('远')");
  const jumpNameSummary = await exec('window.__cwTest.jumpSummary()');
  const jumpResultTexts = await exec('window.__cwTest.jumpResultTexts()');
  check(
    'Ctrl+G：章名关键词找到 1 章并列出（带状态）',
    jumpNameSummary.includes('找到 1 章匹配') &&
      jumpResultTexts.length === 1 &&
      jumpResultTexts[0].includes('第3章：远行') &&
      jumpResultTexts[0].includes('草稿'),
    jumpResultTexts
  );
  await exec('window.__cwTest.clickJumpResult(0)');
  await waitFor("window.__cwTest.currentTitle() === '第3章：远行'");
  check('Ctrl+G：点结果跳到第 3 章', (await exec('window.__cwTest.currentIndex()')) === 2);

  // 40e. 章号越界：明确提示 + 禁用跳转；Esc 关闭
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('99')");
  const jumpOutSummary = await exec('window.__cwTest.jumpSummary()');
  check(
    'Ctrl+G：章号超出范围时提示 1–4 且跳转按钮不可点',
    jumpOutSummary.includes('没有第 99 章') &&
      jumpOutSummary.includes('1–4') &&
      (await exec('window.__cwTest.jumpConfirmDisabled()')) === true,
    jumpOutSummary
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('Ctrl+G：Esc 关闭跳章对话框', (await exec('window.__cwTest.jumpDialogOpen()')) === false);

  // 40f. 跳章碰到未保存内容：照常弹「保存 / 不保存 / 取消」，选不保存后磁盘不变
  await exec("window.__cwTest.setText('这是没保存的远行改动')");
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('1')");
  await exec(
    "document.getElementById('jump-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
  );
  await waitFor('window.__cwTest.modalOpen() === true');
  check(
    'Ctrl+G：有未保存修改时先弹「切换章节前保存」',
    (await exec('window.__cwTest.dialog()')) === '切换章节前保存',
    await exec('window.__cwTest.dialog()')
  );
  await exec("window.__cwTest.answerModal('discard')");
  await waitFor("window.__cwTest.currentTitle() === '第1章：起风'");
  check(
    'Ctrl+G：选「不保存」后跳章成功，未保存内容没有偷偷写盘',
    (await exec('window.__cwTest.chapterTextAt(2)')) === '远行正文。' &&
      (await exec('window.__cwTest.jumpDialogOpen()')) === false
  );

  // 40g. lastOpenChapterId 失效（例如手改书目/旧数据）时打开书要兜底到第 1 章
  const fallbackMeta = await storage.readBookMeta(resumeBookPath);
  await storage.writeBookMeta(resumeBookPath, { ...fallbackMeta, lastOpenChapterId: 'ch_999' });
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(resumeBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '继续写作：书目里的上次章节失效时回退到第 1 章（不报错）',
    (await exec('window.__cwTest.currentIndex()')) === 0,
    await exec('window.__cwTest.currentTitle()')
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitFor('window.__cwTest.continueVisible() === true');
  check(
    '继续写作：兜底到第 1 章后，书架入口也跟着更新',
    (await exec('window.__cwTest.continueText()')).includes('第1章：起风'),
    await exec('window.__cwTest.continueText()')
  );
  // 书架页按 Ctrl+G 不应该弹跳章框（只在写作页生效）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  check('Ctrl+G：书架页不会弹出跳章对话框', (await exec('window.__cwTest.jumpDialogOpen()')) === false);

  // 40h. 全程只读正文：4 个 txt 的大小 / mtime 没变
  let resumeFilesUntouched = true;
  for (let i = 0; i < resumeFiles.length; i += 1) {
    const stat = await fs.stat(resumeFiles[i]);
    if (stat.size !== resumeStatBefore[i].size || stat.mtimeMs !== resumeStatBefore[i].mtimeMs) {
      resumeFilesUntouched = false;
    }
  }
  check('继续写作 / 跳章：章节 txt 大小和 mtime 一个都没变（纯读）', resumeFilesUntouched);

  // 40i. 书被删掉后入口自动隐藏，不会指向不存在的位置
  await exec("window.__cwTest.deleteBookByFolder('继续写作测试书', { skipConfirm: true })");
  await waitFor('window.__cwTest.continueVisible() === false');
  check(
    '继续写作：上次那本书被删掉后入口自动隐藏',
    (await exec('window.__cwTest.continueVisible()')) === false
  );

  // 41. 书目 schemaVersion + 同步冲突副本检测（v0.5-5）
  await exec("window.__cwTest.newBook('冲突检测测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const conflictBookPath = await exec('window.__cwTest.bookPathValue()');
  const conflictMetaPath = path.join(conflictBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('起风正文。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 41a. 新建书的书目落盘带当前格式版本
  const conflictMetaRaw = JSON.parse(await fs.readFile(conflictMetaPath, 'utf8'));
  check(
    'schemaVersion：新建书的书目带 schemaVersion=1',
    conflictMetaRaw.schemaVersion === 1,
    conflictMetaRaw.schemaVersion
  );

  // 41b. 模拟同步盘在书文件夹里生成冲突副本（OneDrive 英文名 + 坚果云中文名）
  const conflictNormalFile = path.join(conflictBookPath, conflictMetaRaw.chapters[0].file);
  const conflictNormalStat = await fs.stat(conflictNormalFile);
  const conflictNames = [
    '001-未命名 (conflicted copy 2026-10-31).txt',
    '书目-冲突副本.json'
  ];
  await fs.writeFile(path.join(conflictBookPath, conflictNames[0]), '冲突副本里的旧稿。', 'utf8');
  await fs.writeFile(path.join(conflictBookPath, conflictNames[1]), '{"chapters":[]}', 'utf8');
  const conflictStats = [];
  for (const name of conflictNames) {
    const stat = await fs.stat(path.join(conflictBookPath, name));
    conflictStats.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  await exec('window.__cwTest.refreshShelf()');
  const conflictBadge = await waitFor("window.__cwTest.shelfConflictBadgeText('冲突检测测试书')");
  check(
    '冲突副本：书卡标黄提示 2 个同步冲突副本',
    conflictBadge.includes('检测到同步冲突副本') && conflictBadge.includes('2'),
    conflictBadge
  );
  check(
    '冲突副本：书卡带 has-conflict 标记、没被当成损坏',
    (await exec("window.__cwTest.conflictCardHasClass('冲突检测测试书', 'has-conflict')")) === true &&
      (await exec("window.__cwTest.conflictCardHasClass('冲突检测测试书', 'corrupt')")) === false
  );

  // 冲突副本不能变成章节，也不能妨碍正常打开
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(conflictBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '冲突副本：打开书后章节仍是 1 章（副本没有被读成章节）',
    JSON.stringify(await exec('window.__cwTest.chapterNames()')) === JSON.stringify(['起风'])
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 41c. 点提示看明细：列出文件名、明确不自动合并；Esc 关闭
  const conflictOpened = await exec("window.__cwTest.openConflictDialogFor('冲突检测测试书')");
  check(
    '冲突副本：点提示能打开明细弹层',
    conflictOpened === true && (await exec('window.__cwTest.conflictDialogOpen()')) === true
  );
  const conflictDialogFiles = await exec('window.__cwTest.conflictFileTexts()');
  check(
    '冲突副本：明细弹层列出两个副本文件名',
    conflictDialogFiles.length === 2 && conflictNames.every((name) => conflictDialogFiles.includes(name)),
    conflictDialogFiles
  );
  const conflictDialogSummary = await exec('window.__cwTest.conflictSummary()');
  check(
    '冲突副本：弹层明确「只提示、不自动合并或删除」',
    conflictDialogSummary.includes('不会自动合并') && conflictDialogSummary.includes('2'),
    conflictDialogSummary
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('冲突副本：Esc 关闭明细弹层', (await exec('window.__cwTest.conflictDialogOpen()')) === false);

  // 41d. 全程只读：冲突文件、正常章节 txt、书目 chapters 都没被改动
  let conflictFilesUntouched = true;
  for (let i = 0; i < conflictNames.length; i += 1) {
    const stat = await fs.stat(path.join(conflictBookPath, conflictNames[i]));
    if (stat.size !== conflictStats[i].size || stat.mtimeMs !== conflictStats[i].mtimeMs) {
      conflictFilesUntouched = false;
    }
  }
  const conflictNormalAfter = await fs.stat(conflictNormalFile);
  const conflictMetaAfter = await storage.readBookMeta(conflictBookPath);
  check(
    '冲突副本：提示全程没有改动/删除副本文件，也没有动章节 txt',
    conflictFilesUntouched &&
      conflictNormalAfter.size === conflictNormalStat.size &&
      conflictNormalAfter.mtimeMs === conflictNormalStat.mtimeMs &&
      conflictMetaAfter.chapters.length === 1 &&
      conflictMetaAfter.chapters[0].file === conflictMetaRaw.chapters[0].file &&
      (await fs.readFile(path.join(conflictBookPath, conflictNames[0]), 'utf8')) === '冲突副本里的旧稿。'
  );

  // 41e. 手动把副本移走后，提示自动消失
  for (const name of conflictNames) await fs.unlink(path.join(conflictBookPath, name));
  await exec('window.__cwTest.refreshShelf()');
  check(
    '冲突副本：手动移走后书卡提示消失',
    (await exec("window.__cwTest.shelfConflictBadgeText('冲突检测测试书')")) === ''
  );

  // 41f. 旧书兼容：v0.4.1 形状（没有 schemaVersion）照常读、写盘才补
  const conflictLegacyRaw = JSON.parse(await fs.readFile(conflictMetaPath, 'utf8'));
  delete conflictLegacyRaw.schemaVersion;
  await fs.writeFile(conflictMetaPath, JSON.stringify(conflictLegacyRaw, null, 2), 'utf8');
  const conflictLegacyRead = await storage.readBookMeta(conflictBookPath);
  check(
    '旧书目兼容：没有 schemaVersion 也能读，内存里按 1 处理',
    conflictLegacyRead.schemaVersion === 1 && conflictLegacyRead.chapters.length === 1,
    conflictLegacyRead.schemaVersion
  );
  await exec('window.__cwTest.refreshShelf()');
  check(
    '旧书目兼容：书架照常显示这本书（不标损坏）',
    (await exec("window.__cwTest.conflictCardHasClass('冲突检测测试书', 'corrupt')")) === false
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(conflictBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '旧书目兼容：打开后章节正常',
    (await exec('window.__cwTest.currentTitle()')).includes('起风')
  );
  await exec("window.__cwTest.renameChapterAt(0, '起风改名')");
  const conflictMigratedRaw = JSON.parse(await fs.readFile(conflictMetaPath, 'utf8'));
  check(
    '旧书目兼容：正常写盘后补上 schemaVersion=1，章名改动照常生效',
    conflictMigratedRaw.schemaVersion === 1 && conflictMigratedRaw.chapters[0].name === '起风改名',
    { version: conflictMigratedRaw.schemaVersion, name: conflictMigratedRaw.chapters[0].name }
  );

  // 42. 本书历史面板（v0.6-1）：统一列出 / 预览 / 还原 _trash 备份
  await exec("window.__cwTest.newBook('历史面板测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const historyBookPath = await exec('window.__cwTest.bookPathValue()');
  const historyMetaPath = path.join(historyBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('现在第一章。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.newChapter('夜雨')");
  await exec("window.__cwTest.setText('现在第二章。')");
  await exec('window.__cwTest.save()');
  let historyMeta = await storage.readBookMeta(historyBookPath);
  const historyFile1 = historyMeta.chapters[0].file;
  const historyFile2 = historyMeta.chapters[1].file;
  const historyTrash = path.join(historyBookPath, '_trash');
  const replaceBackupName = '替换备份-2026-10-31-210000';
  const formatBackupName = '整理备份-2026-10-31-200000';
  const deletedTrashName = '2026-10-31-215000-003-已删章节.txt';
  await fs.mkdir(path.join(historyTrash, replaceBackupName), { recursive: true });
  await fs.writeFile(path.join(historyTrash, replaceBackupName, historyFile1), '替换前的第一章。\r\n', 'utf8');
  await fs.writeFile(path.join(historyTrash, replaceBackupName, historyFile2), '替换前的第二章。\r\n', 'utf8');
  await fs.writeFile(path.join(historyTrash, replaceBackupName, '003-已删.txt'), '已经不在书里的旧章。\r\n', 'utf8');
  await fs.mkdir(path.join(historyTrash, formatBackupName));
  await fs.writeFile(path.join(historyTrash, formatBackupName, historyFile1), '整理前的第一章。\r\n', 'utf8');
  await fs.writeFile(path.join(historyTrash, deletedTrashName), '被删章节的正文。\r\n', 'utf8');

  const historyTxtBefore = [];
  for (const file of [historyFile1, historyFile2]) {
    const stat = await fs.stat(path.join(historyBookPath, file));
    historyTxtBefore.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const historyMetaBefore = await fs.readFile(historyMetaPath, 'utf8');
  const historyBackupBefore = await fs.stat(path.join(historyTrash, replaceBackupName, historyFile1));

  const waitForHistoryDisk = async (file, expected, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      const loaded = await storage.loadChapterText(historyBookPath, file).catch(() => null);
      if (loaded && loaded.text === expected) return loaded;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待磁盘正文超时：${file} :: ${loaded && loaded.text}`);
      }
      await sleep(120);
    }
  };

  // 42a. 写作页入口 + 汇总 + 只读扫描
  const historyOpened = await exec('window.__cwTest.openHistoryForCurrentBook()');
  check(
    '本书历史：写作页能打开历史面板',
    historyOpened === true && (await exec('window.__cwTest.historyOpen()')) === true
  );
  const historySummaryText = await exec('window.__cwTest.historySummary()');
  check(
    '本书历史：面板汇总 4 组备份（替换/整理/删章/书目）',
    historySummaryText.includes('4 组') && historySummaryText.includes('6 个文件'),
    historySummaryText
  );
  const historyGroupsNow = await exec('window.__cwTest.historyGroups()');
  const historyLabels = historyGroupsNow.map((group) => group.sourceLabel);
  check(
    '本书历史：来源分类正确（整本替换 / 整本整理 / 删除章节 / 书目备份）',
    ['整本替换', '整本整理', '删除章节', '书目备份'].every((label) => historyLabels.includes(label)),
    historyLabels
  );
  const replaceIndex = await exec("window.__cwTest.historyGroupIndexBySource('replace')");
  const replaceGroup = historyGroupsNow[replaceIndex];
  check(
    '本书历史：替换组 3 个文件，只有 2 个当前章节可还原',
    replaceGroup &&
      replaceGroup.fileCount === 3 &&
      replaceGroup.restorableCount === 2 &&
      replaceGroup.files.filter((file) => file.restorable).length === 2 &&
      replaceGroup.files.some((file) => file.name === '003-已删.txt' && !file.restorable),
    replaceGroup
  );
  const historyGroupTexts = await exec('window.__cwTest.historyGroupTexts()');
  check(
    '本书历史：面板显示来源、时间、文件数',
    historyGroupTexts.length === 4 &&
      historyGroupTexts.some(
        (text) =>
          text.includes('整本替换') &&
          text.includes('2026-10-31 21:00') &&
          text.includes('3 个文件')
      ),
    historyGroupTexts
  );

  // 42b. 预览：只读，能看到备份原文；标题带来源与文件名
  check(
    '本书历史：替换组第一个文件有预览按钮',
    (await exec(`window.__cwTest.clickHistoryFileButton(${replaceIndex}, 0, '预览')`)) === true
  );
  await waitFor('window.__cwTest.historyPreviewVisible() === true');
  const historyPreviewText = await exec('window.__cwTest.historyPreviewText()');
  check(
    '本书历史：预览显示备份里的原文',
    historyPreviewText.includes('替换前的第一章。'),
    historyPreviewText
  );
  const historyPreviewTitle = await exec('window.__cwTest.historyPreviewTitle()');
  check(
    '本书历史：预览标题带来源与文件名',
    historyPreviewTitle.includes('整本替换') && historyPreviewTitle.includes(historyFile1),
    historyPreviewTitle
  );

  // 42c. 打开 / 预览全程只读：章节 txt、书目、备份文件都没被改
  let historyReadOnly = true;
  for (const before of historyTxtBefore) {
    const stat = await fs.stat(path.join(historyBookPath, before.file));
    if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) historyReadOnly = false;
  }
  const historyBackupAfter = await fs.stat(path.join(historyTrash, replaceBackupName, historyFile1));
  check(
    '本书历史：打开/预览不改章节 txt、不改书目、不改备份',
    historyReadOnly &&
      (await fs.readFile(historyMetaPath, 'utf8')) === historyMetaBefore &&
      historyBackupAfter.size === historyBackupBefore.size &&
      historyBackupAfter.mtimeMs === historyBackupBefore.mtimeMs
  );

  // 42d. 还原单章：二次确认 → 覆盖磁盘 → 当前编辑区跟着重载 → 先备份当前内容
  check(
    '本书历史：点「还原」会弹确认框',
    (await exec(`window.__cwTest.clickHistoryFileButton(${replaceIndex}, 0, '还原')`)) === true
  );
  await waitFor('window.__cwTest.modalOpen()');
  check('本书历史：单章还原确认框标题', (await exec('window.__cwTest.dialog()')) === '还原这一章');
  await exec("window.__cwTest.answerModal('ok')");
  await waitForHistoryDisk(historyFile1, '替换前的第一章。\n');
  check(
    '本书历史：还原单章后磁盘正文变成备份内容',
    (await storage.loadChapterText(historyBookPath, historyFile1)).text === '替换前的第一章。\n'
  );
  check(
    '本书历史：还原单章不打断当前正在看的章',
    (await exec('window.__cwTest.text()')) === '现在第二章。',
    await exec('window.__cwTest.text()')
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check(
    '本书历史：切到被还原的章，编辑区是备份内容',
    (await exec('window.__cwTest.text()')) === '替换前的第一章。\n',
    await exec('window.__cwTest.text()')
  );
  check(
    '本书历史：没点到的那一章不受影响',
    (await storage.loadChapterText(historyBookPath, historyFile2)).text === '现在第二章。'
  );
  historyMeta = await storage.readBookMeta(historyBookPath);
  check(
    '本书历史：字数缓存按还原后的正文更新',
    historyMeta.chapters[0].chars === 8,
    historyMeta.chapters.map((chapter) => chapter.chars)
  );
  const historyTrashAfterSingle = await fs.readdir(historyTrash);
  const historyRestoreDirs = historyTrashAfterSingle
    .filter((name) => name.startsWith('还原前备份-'))
    .sort();
  check(
    '本书历史：还原前把当前内容备份到 还原前备份-*',
    historyRestoreDirs.length >= 1,
    historyTrashAfterSingle
  );
  const historyRestoreDir = historyRestoreDirs[historyRestoreDirs.length - 1];
  check(
    '本书历史：还原前备份里是还原前的正文',
    (await fs.readFile(path.join(historyTrash, historyRestoreDir, historyFile1), 'utf8')) ===
      '现在第一章。'
  );

  // 42e. 还原整组：只还原当前章节，跳过已删章节，逐章先备份当前内容
  // 单章还原后多了一个「还原前备份」组，列表会重排，重新按来源找一次下标
  const replaceIndexForGroup = await exec("window.__cwTest.historyGroupIndexBySource('replace')");
  const groupRestoreClicked = await exec(
    `window.__cwTest.clickHistoryGroupRestore(${replaceIndexForGroup})`
  );
  check('本书历史：替换组显示「还原整组」按钮', groupRestoreClicked === true);
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '本书历史：整组还原确认框标题',
    (await exec('window.__cwTest.dialog()')) === '还原整组备份'
  );
  await exec("window.__cwTest.answerModal('ok')");
  await waitForHistoryDisk(historyFile2, '替换前的第二章。\n');
  check(
    '本书历史：整组还原把另一章也还原了',
    (await storage.loadChapterText(historyBookPath, historyFile2)).text === '替换前的第二章。\n'
  );
  check(
    '本书历史：整组还原不复活已删章节（003-已删.txt 没有回到书里）',
    (await fileExists(path.join(historyBookPath, '003-已删.txt'))) === false
  );
  const historyTrashAfterGroup = (await fs.readdir(historyTrash))
    .filter((name) => name.startsWith('还原前备份-'))
    .sort();
  const latestGroupRestoreDir = historyTrashAfterGroup[historyTrashAfterGroup.length - 1];
  const groupRestoreFiles = (await fs.readdir(path.join(historyTrash, latestGroupRestoreDir))).sort();
  check(
    '本书历史：整组还原前把两章当前内容都备份了',
    JSON.stringify(groupRestoreFiles) === JSON.stringify([historyFile1, historyFile2].sort()),
    groupRestoreFiles
  );
  check(
    '本书历史：整组还原前的备份是还原前正文',
    (await fs.readFile(path.join(historyTrash, latestGroupRestoreDir, historyFile2), 'utf8')) ===
      '现在第二章。'
  );

  // 42f. 找回删除的章节：只把 txt 放回书文件夹，不自动加回章节列表、不覆盖同名文件
  const deleteIndex = await exec("window.__cwTest.historyGroupIndexBySource('delete')");
  const deleteGroup = (await exec('window.__cwTest.historyGroups()'))[deleteIndex];
  check(
    '本书历史：删章备份标记为可从 _trash 放回',
    deleteGroup &&
      deleteGroup.files[0].name === '003-已删章节.txt' &&
      deleteGroup.files[0].restorable === true,
    deleteGroup
  );
  check(
    '本书历史：点「放回书文件夹」',
    (await exec(`window.__cwTest.clickHistoryFileButton(${deleteIndex}, 0, '放回书文件夹')`)) === true
  );
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '本书历史：删章还原确认框说明不改章节列表',
    (await exec('window.__cwTest.dialog()')) === '把删除的章节放回书文件夹'
  );
  await exec("window.__cwTest.answerModal('ok')");
  await waitForFile(path.join(historyBookPath, '003-已删章节.txt'));
  check(
    '本书历史：删章 txt 已放回书文件夹（内容原样）',
    (await fs.readFile(path.join(historyBookPath, '003-已删章节.txt'), 'utf8')) ===
      '被删章节的正文。\r\n'
  );
  const historyMetaAfterDelete = await storage.readBookMeta(historyBookPath);
  check(
    '本书历史：放回删章不改章节列表和章号',
    historyMetaAfterDelete.chapters.length === 2 &&
      JSON.stringify(historyMetaAfterDelete.chapters.map((chapter) => chapter.file)) ===
        JSON.stringify([historyFile1, historyFile2]),
    historyMetaAfterDelete.chapters.map((chapter) => chapter.file)
  );

  // 同一份删章备份再放一次：书里已有同名文件，拒绝覆盖
  const deleteIndexAgain = await exec("window.__cwTest.historyGroupIndexBySource('delete')");
  const repeatDeletePromise = exec(`window.__cwTest.restoreHistoryFileAt(${deleteIndexAgain}, 0)`);
  await waitFor('window.__cwTest.modalOpen()');
  await exec("window.__cwTest.answerModal('ok')");
  const repeatDelete = await repeatDeletePromise;
  check(
    '本书历史：书里已有同名文件时不覆盖（会报错）',
    repeatDelete && repeatDelete.ok === false && /没有覆盖/.test(repeatDelete.message || ''),
    repeatDelete
  );
  check(
    '本书历史：不覆盖后书里的同名文件保持原样',
    (await fs.readFile(path.join(historyBookPath, '003-已删章节.txt'), 'utf8')) ===
      '被删章节的正文。\r\n'
  );

  // 42g. 书目备份：可预览，但不提供还原（避免旧书目覆盖当前章节列表）
  const bookmetaIndex = await exec("window.__cwTest.historyGroupIndexBySource('bookmeta')");
  const bookmetaPreview = await exec(`window.__cwTest.previewHistoryAt(${bookmetaIndex}, 0)`);
  check(
    '本书历史：书目备份可预览（只读）',
    bookmetaPreview && bookmetaPreview.text.includes('"chapters"'),
    bookmetaPreview && bookmetaPreview.text.slice(0, 80)
  );
  const bookmetaGroup = (await exec('window.__cwTest.historyGroups()'))[bookmetaIndex];
  check(
    '本书历史：书目备份不提供还原',
    bookmetaGroup.files[0].restorable === false &&
      (await exec(`window.__cwTest.clickHistoryFileButton(${bookmetaIndex}, 0, '还原')`)) === false
  );

  // 42h. Esc 先收预览、再关面板
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check(
    '本书历史：Esc 先收起预览、面板还在',
    (await exec('window.__cwTest.historyPreviewVisible()')) === false &&
      (await exec('window.__cwTest.historyOpen()')) === true
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('本书历史：再按 Esc 关闭面板', (await exec('window.__cwTest.historyOpen()')) === false);

  // 42i. 入口：导出菜单 + 书卡右键菜单都能打开
  check(
    '本书历史：导出菜单有「本书历史…」',
    (await exec('window.__cwTest.exportMenuTexts()')).includes('本书历史…')
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const bookMenuTexts = await exec('window.__cwTest.bookMenuTexts()');
  check('本书历史：书卡右键菜单有「本书历史…」', bookMenuTexts.includes('本书历史…'), bookMenuTexts);
  const shelfHistoryOpened = await exec(
    `window.__cwTest.openHistoryForPath(${JSON.stringify(historyBookPath)}, '历史面板测试书')`
  );
  check(
    '本书历史：书架也能打开同一本书的历史',
    shelfHistoryOpened === true && (await exec('window.__cwTest.historyOpen()')) === true
  );
  check(
    '本书历史：书架打开时也列出备份（含后加的还原前备份）',
    (await exec('window.__cwTest.historyGroupCount()')) >= 4
  );
  await exec('window.__cwTest.closeHistory()');

  // 42j. 旧数据兼容：v0.4.1 形状（没有 schemaVersion）的书目也能看历史
  const historyOldRaw = JSON.parse(await fs.readFile(historyMetaPath, 'utf8'));
  delete historyOldRaw.schemaVersion;
  await fs.writeFile(historyMetaPath, JSON.stringify(historyOldRaw, null, 2), 'utf8');
  const historyOldRead = await storage.readBookMeta(historyBookPath);
  check(
    '本书历史：没有 schemaVersion 的旧书目照常读',
    historyOldRead.chapters.length === 2 && historyOldRead.schemaVersion === 1,
    historyOldRead.schemaVersion
  );
  const oldHistoryOpened = await exec(
    `window.__cwTest.openHistoryForPath(${JSON.stringify(historyBookPath)}, '历史面板测试书')`
  );
  check(
    '本书历史：旧书目打开历史面板照常列出备份',
    oldHistoryOpened === true && (await exec('window.__cwTest.historyGroupCount()')) >= 4
  );
  await exec('window.__cwTest.closeHistory()');

  // 43. 可选每日快照（v0.6-2，默认关）：Ctrl+S 时当天首次留上一版，按天数清理
  const snapshotDefaults = await exec('window.api.getConfig()');
  check(
    '每日快照：默认关闭、保留 7 天（没有配置字段也按默认）',
    snapshotDefaults &&
      snapshotDefaults.ok &&
      snapshotDefaults.data.snapshotEnabled === false &&
      snapshotDefaults.data.snapshotKeepDays === 7,
    snapshotDefaults && snapshotDefaults.data
  );

  await exec('window.__cwTest.openSettings()');
  const snapshotSettingsBefore = await exec('window.__cwTest.snapshotSettings()');
  check(
    '每日快照：设置里有开关，默认不勾、7 天',
    snapshotSettingsBefore && snapshotSettingsBefore.enabled === false && snapshotSettingsBefore.keepDays === 7,
    snapshotSettingsBefore
  );
  await exec("window.__cwTest.setCheck('settings-snapshot-enabled', true)");
  await exec("window.__cwTest.setSelect('settings-snapshot-days', '3')");
  await exec('window.__cwTest.saveSettings()');
  await waitFor(
    'window.api.getConfig().then((r) => r.ok && r.data.snapshotEnabled === true && r.data.snapshotKeepDays === 3)'
  );
  const snapshotCfgDisk = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '每日快照：开关和保留天数真的落进 config.json',
    snapshotCfgDisk.snapshotEnabled === true && snapshotCfgDisk.snapshotKeepDays === 3,
    { enabled: snapshotCfgDisk.snapshotEnabled, days: snapshotCfgDisk.snapshotKeepDays }
  );

  // 43a. 打开一本 v0.4.1 形状的旧书（42j 刚去掉 schemaVersion），保存时留快照
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.switchTo(0)');
  const snapshotLegacyRaw = JSON.parse(await fs.readFile(historyMetaPath, 'utf8'));
  check(
    '每日快照：v0.4.1 形状旧书目（没有 schemaVersion）照常打开',
    snapshotLegacyRaw.schemaVersion === undefined && snapshotLegacyRaw.chapters.length === 2,
    { version: snapshotLegacyRaw.schemaVersion, chapters: snapshotLegacyRaw.chapters.length }
  );

  const snapshotMeta = await storage.readBookMeta(historyBookPath);
  const snapshotFile0 = snapshotMeta.chapters[0].file;
  const snapshotFile1 = snapshotMeta.chapters[1].file;
  const snapshotTrash = path.join(historyBookPath, '_trash');
  const snapshotSource0 = await fs.readFile(path.join(historyBookPath, snapshotFile0));
  const snapshotSource0Text = snapshotSource0.toString('utf8').replace(/^\uFEFF/, '');
  const today = new Date();
  const snapshotDay = `快照-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
    today.getDate()
  ).padStart(2, '0')}`;
  const snapshotTodayDir = path.join(snapshotTrash, snapshotDay);

  await exec("window.__cwTest.setText('快照测试：第一版')");
  const snapshotSave1 = await exec('window.__cwTest.save()');
  check(
    '每日快照：开启后第一次保存会留下当天快照',
    snapshotSave1 &&
      snapshotSave1.ok &&
      snapshotSave1.data.snapshot &&
      snapshotSave1.data.snapshot.taken === true &&
      snapshotSave1.data.snapshot.dir === snapshotDay,
    snapshotSave1 && snapshotSave1.data && snapshotSave1.data.snapshot
  );
  const snapshotPath0 = path.join(snapshotTodayDir, snapshotFile0);
  check(
    '每日快照：快照复制的是保存前的上一版（字节原样）',
    (await fs.readFile(snapshotPath0)).equals(snapshotSource0)
  );
  check(
    '每日快照：快照里不是刚保存的新正文',
    !(await fs.readFile(snapshotPath0, 'utf8')).includes('快照测试：第一版')
  );

  const snapshotStat0 = await fs.stat(snapshotPath0);
  await exec("window.__cwTest.setText('快照测试：第二版')");
  const snapshotSave2 = await exec('window.__cwTest.save()');
  check(
    '每日快照：同一章当天第二次保存不再复制',
    snapshotSave2 &&
      snapshotSave2.ok &&
      snapshotSave2.data.snapshot.taken === false &&
      snapshotSave2.data.snapshot.reason === 'ALREADY_TODAY',
    snapshotSave2 && snapshotSave2.data && snapshotSave2.data.snapshot
  );
  const snapshotStat0After = await fs.stat(snapshotPath0);
  check(
    '每日快照：当天快照仍是第一份，不被后来的保存覆盖',
    (await fs.readFile(snapshotPath0)).equals(snapshotSource0) &&
      snapshotStat0After.mtimeMs === snapshotStat0.mtimeMs &&
      (await fs.readdir(snapshotTodayDir)).length === 1
  );
  check(
    '每日快照：正文照常保存（快照不改变保存结果）',
    (await storage.loadChapterText(historyBookPath, snapshotFile0)).text === '快照测试：第二版'
  );
  const snapshotLegacyAfter = JSON.parse(await fs.readFile(historyMetaPath, 'utf8'));
  check(
    '每日快照：旧书保存后补 schemaVersion，章节顺序/文件名不变',
    snapshotLegacyAfter.schemaVersion === 1 &&
      JSON.stringify(snapshotLegacyAfter.chapters.map((chapter) => chapter.file)) ===
        JSON.stringify([snapshotFile0, snapshotFile1]),
    snapshotLegacyAfter.chapters.map((chapter) => chapter.file)
  );

  // 43b. 和「本书历史」联动：能看到、能预览、能还原
  await exec('window.__cwTest.openHistoryForCurrentBook()');
  const snapshotGroupIndex = await exec("window.__cwTest.historyGroupIndexBySource('snapshot')");
  const snapshotGroups = await exec('window.__cwTest.historyGroups()');
  const snapshotGroup = snapshotGroupIndex >= 0 ? snapshotGroups[snapshotGroupIndex] : null;
  const snapshotFileIndex = snapshotGroup
    ? snapshotGroup.files.findIndex((file) => file.name === snapshotFile0)
    : -1;
  check(
    '每日快照：本书历史里出现「每日快照」组，文件可还原',
    snapshotGroup &&
      snapshotGroup.sourceLabel === '每日快照' &&
      snapshotGroup.fileCount === 1 &&
      snapshotFileIndex >= 0 &&
      snapshotGroup.files[snapshotFileIndex].restorable === true,
    snapshotGroup
  );
  const snapshotPreview = await exec(
    `window.__cwTest.previewHistoryAt(${snapshotGroupIndex}, ${snapshotFileIndex})`
  );
  check(
    '每日快照：历史面板能预览快照原文（只读）',
    snapshotPreview && snapshotPreview.text === snapshotSource0Text,
    snapshotPreview && snapshotPreview.text
  );
  const snapshotRestorePromise = exec(
    `window.__cwTest.restoreHistoryFileAt(${snapshotGroupIndex}, ${snapshotFileIndex})`
  );
  await waitFor('window.__cwTest.modalOpen()');
  await exec("window.__cwTest.answerModal('ok')");
  const snapshotRestore = await snapshotRestorePromise;
  check(
    '每日快照：能从本书历史还原当天快照',
    snapshotRestore &&
      snapshotRestore.ok &&
      snapshotRestore.data &&
      snapshotRestore.data.restored === 1 &&
      snapshotRestore.data.sourceLabel === '每日快照',
    snapshotRestore
  );
  check(
    '每日快照：还原后正文回到快照内容，并留下还原前备份',
    (await storage.loadChapterText(historyBookPath, snapshotFile0)).text ===
      snapshotSource0Text.replace(/\r\n/g, '\n')
  );
  await exec('window.__cwTest.closeHistory()');

  // 43c. 保留天数：只清理应用生成的「快照-YYYYMMDD」，旧目录删、其它都不动
  const snapshotOldDir = path.join(snapshotTrash, '快照-20200101');
  const snapshotFutureDir = path.join(snapshotTrash, '快照-29991231');
  const snapshotUnknownDir = path.join(snapshotTrash, '我的备份-20200101');
  for (const dir of [snapshotOldDir, snapshotFutureDir, snapshotUnknownDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'keep.txt'), '别动我\n', 'utf8');
  }
  await fs.writeFile(path.join(snapshotTrash, '快照-20200101.txt'), '散文件也别动\n', 'utf8');

  await exec('window.__cwTest.switchTo(1)');
  const snapshotSource1 = await fs.readFile(path.join(historyBookPath, snapshotFile1));
  await exec("window.__cwTest.setText('第二章快照测试')");
  const snapshotSave3 = await exec('window.__cwTest.save()');
  check(
    '每日快照：换一章当天也能各留一份',
    snapshotSave3 && snapshotSave3.ok && snapshotSave3.data.snapshot.taken === true,
    snapshotSave3 && snapshotSave3.data && snapshotSave3.data.snapshot
  );
  check(
    '每日快照：第二章快照内容也是保存前的上一版',
    (await fs.readFile(path.join(snapshotTodayDir, snapshotFile1))).equals(snapshotSource1)
  );
  check(
    '每日快照：超出保留天数的旧快照目录被清理',
    (await fs.readFile(path.join(snapshotTodayDir, snapshotFile1))).equals(snapshotSource1) &&
      !(await fileExists(snapshotOldDir)) &&
      snapshotSave3.data.snapshot.cleanup.removed.includes('快照-20200101'),
    snapshotSave3.data.snapshot.cleanup
  );
  check(
    '每日快照：未来日期、未知目录、散文件都原样保留',
    (await fileExists(path.join(snapshotFutureDir, 'keep.txt'))) &&
      (await fileExists(path.join(snapshotUnknownDir, 'keep.txt'))) &&
      (await fileExists(path.join(snapshotTrash, '快照-20200101.txt')))
  );
  check(
    '每日快照：当天快照目录里有这一章的两个文件',
    (await fs.readdir(snapshotTodayDir)).sort().join('|') === [snapshotFile0, snapshotFile1].sort().join('|')
  );

  // 43d. 关掉开关：后续保存不再留快照；写作页设置里不显示全局快照项
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setCheck('settings-snapshot-enabled', false)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.snapshotEnabled === false)');
  const snapshotCfgOff = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check('每日快照：关掉后 config.json 里是 false', snapshotCfgOff.snapshotEnabled === false);

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.newChapter('关掉快照后')");
  await exec('window.__cwTest.openSettings()');
  check(
    '每日快照：写作页设置里不显示全局快照开关',
    (await exec(
      "document.getElementById('settings-snapshot-field').classList.contains('hidden') === true"
    )) === true
  );
  await exec('window.__cwTest.closeSettings()');
  await exec("window.__cwTest.setText('关掉快照后的正文')");
  const snapshotSave4 = await exec('window.__cwTest.save()');
  check(
    '每日快照：关掉开关后保存不再留快照',
    snapshotSave4 &&
      snapshotSave4.ok &&
      snapshotSave4.data.snapshot.reason === 'DISABLED' &&
      snapshotSave4.data.snapshot.taken === false,
    snapshotSave4 && snapshotSave4.data && snapshotSave4.data.snapshot
  );
  check(
    '每日快照：关掉后当天快照目录没有多出新章文件',
    (await fs.readdir(snapshotTodayDir)).length === 2
  );

  // 44. 每日字数统计 + 写作目标（v0.6-3，提案 3.2）
  // 只统计「保存动作」带来的正字数增量；统计文件在 userData/stats.json，绝不写进书库；
  // 目标可选（0 = 不设目标），旧配置缺字段按默认 0。
  const statsPath = path.join(userData, 'stats.json');
  const readStatsDisk = async () => {
    try {
      return JSON.parse(await fs.readFile(statsPath, 'utf8'));
    } catch {
      return null;
    }
  };
  const readConfigDisk = async () => JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));

  const statsConfigBefore = await exec('window.api.getConfig()');
  check(
    '每日统计：旧配置没有 dailyGoal 时按不设目标启动',
    statsConfigBefore && statsConfigBefore.ok && statsConfigBefore.data.dailyGoal === 0,
    statsConfigBefore && statsConfigBefore.data && statsConfigBefore.data.dailyGoal
  );

  const statsInitial = await exec('window.__cwTest.refreshStats()');
  check(
    '每日统计：摘要是今天 + 近 30 天，未设目标时 0%',
    statsInitial &&
      statsInitial.day === statsLib.localDayKey() &&
      statsInitial.goal === 0 &&
      statsInitial.goalPercent === 0 &&
      statsInitial.goalMet === false &&
      statsInitial.days.length === 30 &&
      statsInitial.days[29].day === statsInitial.day,
    statsInitial && {
      day: statsInitial.day,
      goal: statsInitial.goal,
      days: statsInitial.days && statsInitial.days.length
    }
  );
  const statsTodayBefore = statsInitial.todayChars;
  const statsMeta = await storage.readBookMeta(historyBookPath);
  const statsCurrentId = await exec('window.__cwTest.currentChapterId()');
  const statsChapter = statsMeta.chapters.find((chapter) => chapter.id === statsCurrentId);
  check('每日统计：当前章在书目里（用于算增量）', Boolean(statsChapter), statsCurrentId);
  const statsDiskBefore = await readStatsDisk();
  const statsBookBefore =
    statsDiskBefore && statsDiskBefore.days && statsDiskBefore.days[statsInitial.day]
      ? statsDiskBefore.days[statsInitial.day].books[statsMeta.id] || 0
      : 0;

  const statsBaseText = (await storage.loadChapterText(historyBookPath, statsChapter.file)).text;
  const statsAppend1 = '第一次增加五字';
  await exec(`window.__cwTest.setText(${JSON.stringify(statsBaseText + statsAppend1)})`);
  const statsAfterTyping = await exec('window.__cwTest.refreshStats()');
  check(
    '每日统计：未保存的输入不计入今天',
    statsAfterTyping.todayChars === statsTodayBefore,
    { before: statsTodayBefore, after: statsAfterTyping.todayChars }
  );
  const statsSave1 = await exec('window.__cwTest.save()');
  const statsDelta1 = chaptersLib.countChars(statsAppend1);
  check(
    '每日统计：保存后按正字数增量累计',
    statsSave1 &&
      statsSave1.ok &&
      statsSave1.data.statsDelta === statsDelta1 &&
      statsSave1.data.stats.todayChars === statsTodayBefore + statsDelta1,
    statsSave1 && statsSave1.data && { delta: statsSave1.data.statsDelta, stats: statsSave1.data.stats }
  );
  const statsTodayAfter1 = statsTodayBefore + statsDelta1;
  const statsDisk1 = await readStatsDisk();
  check(
    '每日统计：stats.json 落在应用配置目录，按书分桶',
    statsDisk1 &&
      statsDisk1.version === 1 &&
      statsDisk1.days[statsInitial.day].books[statsMeta.id] === statsBookBefore + statsDelta1,
    statsDisk1 && statsDisk1.days && statsDisk1.days[statsInitial.day]
  );
  check(
    '每日统计：书库/书内不出现 stats.json',
    !(await fileExists(path.join(historyBookPath, 'stats.json'))) &&
      !(await fileExists(path.join(booksRoot, 'stats.json')))
  );

  // 44a. 删字不倒扣；删完再写只累计这次新增
  await exec("window.__cwTest.setText('短')");
  const statsSaveShrink = await exec('window.__cwTest.save()');
  check(
    '每日统计：删字不扣今天进度（增量 0，没有负数）',
    statsSaveShrink &&
      statsSaveShrink.ok &&
      statsSaveShrink.data.statsDelta === 0 &&
      statsSaveShrink.data.stats.todayChars === statsTodayAfter1,
    statsSaveShrink && statsSaveShrink.data && statsSaveShrink.data.stats
  );
  const statsAppend2 = '再写三个字';
  await exec(`window.__cwTest.setText(${JSON.stringify(`短${statsAppend2}`)})`);
  const statsSave2 = await exec('window.__cwTest.save()');
  const statsDelta2 = chaptersLib.countChars(statsAppend2);
  check(
    '每日统计：删后再写只累计这次的新增',
    statsSave2 &&
      statsSave2.ok &&
      statsSave2.data.statsDelta === statsDelta2 &&
      statsSave2.data.stats.todayChars === statsTodayAfter1 + statsDelta2,
    statsSave2 && statsSave2.data && statsSave2.data.stats
  );
  const statsTodayAfter2 = statsTodayAfter1 + statsDelta2;

  // 44b. 书架顶部今日字数 + 设置里的目标和近 30 天柱状图
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const statsShelfText = await exec('window.__cwTest.shelfStatsText()');
  check(
    '每日统计：书架顶部显示今天字数',
    (await exec('window.__cwTest.shelfStatsVisible()')) === true && statsShelfText.includes('今天 +'),
    statsShelfText
  );

  await exec('window.__cwTest.openSettings()');
  check(
    '每日统计：设置里默认 0（不设目标），写作统计可见',
    (await exec('window.__cwTest.dailyGoalSettings()')) === 0 &&
      (await exec('window.__cwTest.statsSettingsVisible()')) === true
  );
  check('每日统计：近 30 天柱状图有 30 根柱子', (await exec('window.__cwTest.statsChartBarCount()')) === 30);
  const statsHeights = await exec('window.__cwTest.statsChartBarHeights()');
  check(
    '每日统计：今天那根柱子有高度，空白天为 0',
    Array.isArray(statsHeights) &&
      statsHeights.length === 30 &&
      parseFloat(statsHeights[29]) > 0 &&
      parseFloat(statsHeights[0]) === 0,
    statsHeights
  );
  const statsChartSummaryBefore = await exec('window.__cwTest.statsChartSummary()');
  check(
    '每日统计：柱状图摘要显示今天/近 30 天/未设目标',
    statsChartSummaryBefore.includes('今天') &&
      statsChartSummaryBefore.includes('近 30 天') &&
      statsChartSummaryBefore.includes('未设目标'),
    statsChartSummaryBefore
  );

  const statsGoal = statsTodayAfter2 + 100;
  await exec(`window.__cwTest.setInput('settings-daily-goal', ${statsGoal})`);
  await exec('window.__cwTest.saveSettings()');
  await waitFor(`window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === ${statsGoal})`);
  const statsCfgDisk = await readConfigDisk();
  check('每日统计：目标真的落进 config.json', statsCfgDisk.dailyGoal === statsGoal, statsCfgDisk.dailyGoal);
  const statsAfterGoal = await exec('window.__cwTest.statsSummary()');
  check(
    '每日统计：目标生效后按今天字数算完成度',
    statsAfterGoal &&
      statsAfterGoal.goal === statsGoal &&
      statsAfterGoal.goalPercent === Math.floor((statsTodayAfter2 / statsGoal) * 100) &&
      statsAfterGoal.goalMet === false,
    statsAfterGoal && { goal: statsAfterGoal.goal, percent: statsAfterGoal.goalPercent }
  );
  const statsShelfGoal = await exec('window.__cwTest.shelfStatsText()');
  check(
    '每日统计：书架显示目标与百分比',
    statsShelfGoal.includes('目标') && statsShelfGoal.includes('%'),
    statsShelfGoal
  );
  const statsShelfWidth = await exec('window.__cwTest.shelfGoalWidth()');
  check('每日统计：书架目标进度条有宽度', parseFloat(statsShelfWidth) > 0, statsShelfWidth);

  await exec('window.__cwTest.openSettings()');
  check(
    '每日统计：重新打开设置回填目标',
    (await exec('window.__cwTest.dailyGoalSettings()')) === statsGoal
  );
  const statsChartSummaryGoal = await exec('window.__cwTest.statsChartSummary()');
  check(
    '每日统计：柱状图摘要带目标',
    statsChartSummaryGoal.includes('目标') && statsChartSummaryGoal.includes('今天'),
    statsChartSummaryGoal
  );
  await exec('window.__cwTest.closeSettings()');

  // 44c. 写作页状态栏显示今日 / 目标 + 细进度条；按书设置里不显示全局统计项
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsStatusText = await exec('window.__cwTest.statusStatsText()');
  check(
    '每日统计：状态栏显示今日 / 目标',
    (await exec('window.__cwTest.statusStatsVisible()')) === true &&
      statsStatusText.includes('今日') &&
      statsStatusText.includes('/') &&
      statsStatusText.includes('字'),
    statsStatusText
  );
  const statsStatusWidth = await exec('window.__cwTest.statusGoalWidth()');
  check('每日统计：状态栏细进度条有宽度', parseFloat(statsStatusWidth) > 0, statsStatusWidth);
  await exec('window.__cwTest.openSettings()');
  check(
    '每日统计：写作页设置里不显示全局目标/柱状图',
    (await exec('window.__cwTest.statsSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');

  // 44d. 达标：目标 = 今天 + 1，再写 1 个字 → 已达标 / 100%
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const statsGoalMet = statsTodayAfter2 + 1;
  await exec('window.__cwTest.openSettings()');
  await exec(`window.__cwTest.setInput('settings-daily-goal', ${statsGoalMet})`);
  await exec('window.__cwTest.saveSettings()');
  await waitFor(`window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === ${statsGoalMet})`);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsMeta3 = await storage.readBookMeta(historyBookPath);
  const statsCurrentId3 = await exec('window.__cwTest.currentChapterId()');
  const statsChapter3 = statsMeta3.chapters.find((chapter) => chapter.id === statsCurrentId3);
  const statsText3 = (await storage.loadChapterText(historyBookPath, statsChapter3.file)).text;
  await exec(`window.__cwTest.setText(${JSON.stringify(`${statsText3}一`)})`);
  const statsSaveMet = await exec('window.__cwTest.save()');
  check(
    '每日统计：达到目标后标记已达标且进度 100%',
    statsSaveMet &&
      statsSaveMet.ok &&
      statsSaveMet.data.stats.todayChars === statsGoalMet &&
      statsSaveMet.data.stats.goalMet === true &&
      statsSaveMet.data.stats.goalPercent === 100,
    statsSaveMet && statsSaveMet.data && statsSaveMet.data.stats
  );
  check(
    '每日统计：达标后状态栏进度条 100%',
    (await exec('window.__cwTest.statusGoalWidth()')) === '100%',
    await exec('window.__cwTest.statusGoalWidth()')
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const statsShelfMet = await exec('window.__cwTest.shelfStatsText()');
  check('每日统计：书架显示已达标', statsShelfMet.includes('已达标'), statsShelfMet);

  // 44e. 目标设为 0 = 关掉：书架/状态栏不再显示目标，但今天字数保留
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setInput('settings-daily-goal', '0')");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === 0)');
  const statsShelfOff = await exec('window.__cwTest.shelfStatsText()');
  check(
    '每日统计：目标设为 0 后书架不再显示目标',
    !statsShelfOff.includes('目标') &&
      (await exec('window.__cwTest.shelfGoalWidth()')) === '0%' &&
      statsShelfOff.includes('今天 +'),
    statsShelfOff
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsStatusOff = await exec('window.__cwTest.statusStatsText()');
  check(
    '每日统计：目标关掉后状态栏只显示今天字数',
    statsStatusOff.includes('今日') && !statsStatusOff.includes('/'),
    statsStatusOff
  );

  // 44f. 多本书：同一份 stats.json 按书分桶，今天总字数相加
  const statsTodayBeforeBook2 = (await exec('window.__cwTest.statsSummary()')).todayChars;
  await exec("window.__cwTest.newBook('每日统计第二本')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsBook2Id = await exec('window.__cwTest.bookId()');
  const statsBook2Text = '第二本书写三个字';
  await exec(`window.__cwTest.setText(${JSON.stringify(statsBook2Text)})`);
  const statsSaveBook2 = await exec('window.__cwTest.save()');
  const statsBook2Chars = chaptersLib.countChars(statsBook2Text);
  check(
    '每日统计：多本书按书分桶、总字数相加',
    statsSaveBook2 &&
      statsSaveBook2.ok &&
      statsSaveBook2.data.stats.todayChars === statsTodayBeforeBook2 + statsBook2Chars,
    statsSaveBook2 && statsSaveBook2.data && statsSaveBook2.data.stats
  );
  const statsDiskBook2 = await readStatsDisk();
  const statsDayBooks = statsDiskBook2.days[statsLib.localDayKey()].books;
  check(
    '每日统计：stats.json 里两本书各自记字数',
    statsDayBooks[statsBook2Id] === statsBook2Chars &&
      statsDayBooks[statsMeta.id] >= statsBookBefore + statsDelta1 + statsDelta2 + 1,
    { book2: statsDayBooks[statsBook2Id], firstBook: statsDayBooks[statsMeta.id] }
  );
  check(
    '每日统计：统计文件只存在 userData（不在书架根目录）',
    (await fileExists(statsPath)) && !(await fileExists(path.join(booksRoot, 'stats.json')))
  );

  // 44g. 统计写盘失败不能阻塞正文保存（临时把 stats.json 换成同名目录，原子 rename 必然失败）
  const statsFailBackup = `${statsPath}.fail-backup`;
  await fs.rename(statsPath, statsFailBackup);
  await fs.mkdir(statsPath);
  let statsFailRestored = false;
  try {
    const statsFailTodayBefore = (await exec('window.__cwTest.statsSummary()')).todayChars;
    const statsFailBookPath = await exec('window.__cwTest.bookPathValue()');
    const statsFailText = '统计写盘失败也要保存正文';
    await exec(`window.__cwTest.setText(${JSON.stringify(statsFailText)})`);
    const statsFailSave = await exec('window.__cwTest.save()');
    check(
      '每日统计：统计写盘失败不阻塞正文保存，只把原因带回来',
      statsFailSave &&
        statsFailSave.ok === true &&
        statsFailSave.data.stats === null &&
        typeof statsFailSave.data.statsError === 'string' &&
        statsFailSave.data.statsError.length > 0,
      statsFailSave && statsFailSave.data && {
        stats: statsFailSave.data.stats,
        statsError: statsFailSave.data.statsError
      }
    );
    const statsFailMeta = await storage.readBookMeta(statsFailBookPath);
    const statsFailChapterId = await exec('window.__cwTest.currentChapterId()');
    const statsFailChapter = statsFailMeta.chapters.find((chapter) => chapter.id === statsFailChapterId);
    check(
      '每日统计：统计失败时正文照常落盘',
      statsFailChapter && (await storage.loadChapterText(statsFailBookPath, statsFailChapter.file)).text === statsFailText,
      statsFailChapter && statsFailChapter.file
    );
    await fs.rm(statsPath, { recursive: true, force: true });
    await fs.rename(statsFailBackup, statsPath);
    statsFailRestored = true;
    const statsRecovered = await exec('window.__cwTest.refreshStats()');
    check(
      '每日统计：统计文件恢复后照常读回，失败的那次不虚增内存数字',
      statsRecovered && statsRecovered.todayChars === statsFailTodayBefore,
      { before: statsFailTodayBefore, after: statsRecovered && statsRecovered.todayChars }
    );
    // 恢复后下一次保存还能继续累计（缓存没有因为失败而前进）
    const statsAfterFailText = (await storage.loadChapterText(statsFailBookPath, statsFailChapter.file)).text + '一';
    await exec(`window.__cwTest.setText(${JSON.stringify(statsAfterFailText)})`);
    const statsAfterFailSave = await exec('window.__cwTest.save()');
    check(
      '每日统计：统计写盘恢复后继续正常累计',
      statsAfterFailSave &&
        statsAfterFailSave.ok &&
        statsAfterFailSave.data.stats &&
        statsAfterFailSave.data.stats.todayChars === statsFailTodayBefore + 1,
      statsAfterFailSave && statsAfterFailSave.data && statsAfterFailSave.data.stats
    );
  } finally {
    if (!statsFailRestored) {
      // 检查中途失败时把临时目录换回真正的 stats.json，避免后续复跑/调试遇到坏状态
      await fs.rm(statsPath, { recursive: true, force: true }).catch(() => {});
      await fs.rename(statsFailBackup, statsPath).catch(() => {});
    }
  }

  // 44h. 码字日历 + 连续写作天数 + 月度汇总（v0.8-1，提案 N1）
  // 跨天数据来自 scripts/e2e-stats-seed.js：启动前已写进临时 userData/stats.json，
  // 种子月 = 两个月前（3 天：120 / 80 / 200 字），昨天 150 字；今天的字数由前面 44 组保存产生。
  const calendarSeed = statsSeedLib.buildSeed();
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitFor("window.__cwTest.shelfStreakText().includes('连续')");
  const calendarShelfStreak = await exec('window.__cwTest.shelfStreakText()');
  const statsDiskNow = await readStatsDisk();
  const expectedStreak = statsLib.streak(statsDiskNow, { now: new Date() });
  check(
    '码字日历：书架顶部显示连续写作天数',
    calendarShelfStreak.includes('连续') &&
      calendarShelfStreak.includes(String(expectedStreak.current)) &&
      expectedStreak.best === calendarSeed.bestStreak,
    { shelf: calendarShelfStreak, expectedStreak }
  );
  const statsFileStatBefore = await fs.stat(statsPath);
  await exec('window.__cwTest.openSettings()');
  const calendarStats = await exec('window.__cwTest.statsSummary()');
  const calendarNow = await exec('window.__cwTest.statsCalendar()');
  const streakNow = await exec('window.__cwTest.statsStreak()');
  const todayParts = statsLib.parseDayKey(calendarSeed.todayKey);
  const currentPrefix = `${todayParts.year}-${String(todayParts.month).padStart(2, '0')}-`;
  const sumOfDays = (prefix) =>
    Object.entries(statsDiskNow.days || {})
      .filter(([day]) => day.startsWith(prefix))
      .reduce(
        (sum, [, entry]) =>
          sum + Object.values((entry && entry.books) || {}).reduce((a, n) => a + Math.max(0, Number(n) || 0), 0),
        0
      );
  const countWrittenDays = (prefix) =>
    Object.entries(statsDiskNow.days || {}).filter(
      ([day, entry]) =>
        day.startsWith(prefix) &&
        Object.values((entry && entry.books) || {}).some((n) => Math.max(0, Number(n) || 0) > 0)
    ).length;
  const expectedMonthTotal = sumOfDays(currentPrefix);
  const expectedMonthWrittenDays = countWrittenDays(currentPrefix);
  const calendarTodayCell = calendarNow && calendarNow.days.find((item) => item.day === calendarSeed.todayKey);
  check(
    '码字日历：默认显示本月，今天格子就是今天保存的字数',
    calendarNow &&
      calendarNow.year === todayParts.year &&
      calendarNow.month === todayParts.month &&
      calendarNow.isCurrentMonth === true &&
      calendarNow.today === calendarSeed.todayKey &&
      calendarNow.days.length === statsLib.daysInMonth(todayParts.year, todayParts.month) &&
      calendarTodayCell &&
      calendarTodayCell.chars === calendarStats.todayChars &&
      calendarTodayCell.today === true &&
      calendarTodayCell.future === false,
    calendarNow && { year: calendarNow.year, month: calendarNow.month, todayCell: calendarTodayCell }
  );
  check(
    '码字日历：本月合计 / 写字天数与 stats.json 一致',
    calendarNow.total === expectedMonthTotal && calendarNow.writtenDays === expectedMonthWrittenDays,
    { view: { total: calendarNow.total, writtenDays: calendarNow.writtenDays }, expectedMonthTotal, expectedMonthWrittenDays }
  );
  check(
    '码字日历：连续写作天数来自 stats.json（昨天 + 今天 = 2 天，最长 3 天）',
    streakNow &&
      streakNow.current === expectedStreak.current &&
      streakNow.best === expectedStreak.best &&
      expectedStreak.current === 2 &&
      expectedStreak.best === 3,
    { streakNow, expectedStreak }
  );
  check(
    '码字日历：设置里显示月份标题、当月格子和「今天 / 本月」按钮状态',
    (await exec('window.__cwTest.calendarVisible()')) === true &&
      (await exec('window.__cwTest.calendarLabel()')) === calendarNow.label &&
      (await exec('window.__cwTest.calendarCellCount()')) === calendarNow.days.length &&
      (await exec('window.__cwTest.calendarNextDisabled()')) === true &&
      (await exec('window.__cwTest.calendarTodayDisabled()')) === true &&
      (await exec('window.__cwTest.calendarPrevDisabled()')) === false &&
      (await exec('window.__cwTest.calendarSummaryText()')).includes('本月') &&
      (await exec('window.__cwTest.calendarSummaryText()')).includes('写了') &&
      (await exec('window.__cwTest.calendarStreakText()')).includes('最长') &&
      (await exec('window.__cwTest.calendarStreakText()')).includes('连续'),
    await exec('window.__cwTest.calendarSummaryText()')
  );

  // 44h-1. 设目标 100：翻到种子月验证「每日达标 / 月度达标天数 / 色阶」
  await exec("window.__cwTest.setInput('settings-daily-goal', 100)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === 100)');
  await exec('window.__cwTest.openSettings()');
  await exec('window.__cwTest.calendarShift(-1)');
  await exec('window.__cwTest.calendarShift(-1)');
  const calendarSeedView = await exec('window.__cwTest.statsCalendar()');
  const calendarSeedLabel = await exec('window.__cwTest.calendarLabel()');
  const calendarSeedSummary = await exec('window.__cwTest.calendarSummaryText()');
  const calendarSeedStreak = await exec('window.__cwTest.calendarStreakText()');
  const seedCells = [];
  for (const item of calendarSeed.seedDays) {
    seedCells.push(await exec(`window.__cwTest.calendarDayInfo(${JSON.stringify(item.day)})`));
  }
  check(
    '码字日历：翻到种子月，月度汇总 / 最高一天正确',
    calendarSeedView &&
      calendarSeedView.year === calendarSeed.seedYear &&
      calendarSeedView.month === calendarSeed.seedMonth &&
      calendarSeedView.label === calendarSeed.seedMonthLabel &&
      calendarSeedView.goal === 100 &&
      calendarSeedView.total === calendarSeed.monthTotal &&
      calendarSeedView.writtenDays === calendarSeed.monthWrittenDays &&
      calendarSeedView.goalDays === 2 &&
      calendarSeedView.average === calendarSeed.monthAverage &&
      calendarSeedView.bestDay &&
      calendarSeedView.bestDay.day === calendarSeed.monthBestDay &&
      calendarSeedView.bestDay.chars === calendarSeed.monthBestChars &&
      calendarSeedView.isCurrentMonth === false,
    calendarSeedView && {
      year: calendarSeedView.year,
      month: calendarSeedView.month,
      total: calendarSeedView.total,
      goalDays: calendarSeedView.goalDays
    }
  );
  check(
    '码字日历：种子月每日格子字数 / 达标 / 色阶正确',
    seedCells.every(
      (cell, index) =>
        cell &&
        cell.chars === calendarSeed.seedDays[index].chars &&
        cell.goalMet === calendarSeed.seedDays[index].chars >= 100 &&
        cell.today === false &&
        cell.future === false
    ) &&
      seedCells[0].level === 4 &&
      seedCells[1].level === 3 &&
      seedCells[2].level === 4,
    seedCells
  );
  check(
    '码字日历：UI 标题 / 月度汇总 / 连续天数跟着翻月更新',
    calendarSeedLabel === calendarSeed.seedMonthLabel &&
      calendarSeedSummary.includes(`${calendarSeed.seedMonth}月`) &&
      calendarSeedSummary.includes(`${calendarSeed.monthTotal} 字`) &&
      calendarSeedSummary.includes(`写了 ${calendarSeed.monthWrittenDays} 天`) &&
      calendarSeedSummary.includes(`日均 ${calendarSeed.monthAverage} 字`) &&
      calendarSeedSummary.includes('达标 2 天') &&
      calendarSeedSummary.includes('最高') &&
      calendarSeedStreak.includes('已连续写作 2 天') &&
      calendarSeedStreak.includes('最长 3 天') &&
      (await exec('window.__cwTest.calendarNextDisabled()')) === false &&
      (await exec('window.__cwTest.calendarTodayDisabled()')) === false,
    { label: calendarSeedLabel, summary: calendarSeedSummary, streak: calendarSeedStreak }
  );

  // 44h-2. 翻回本月 / 不允许翻到未来 / 「本月」按钮；全程只读取 stats.json
  await exec('window.__cwTest.calendarShift(1)');
  await exec('window.__cwTest.calendarShift(1)');
  const calendarBackLabel = await exec('window.__cwTest.calendarLabel()');
  const calendarFutureBlocked = await exec('window.__cwTest.calendarShift(1)');
  await exec('window.__cwTest.calendarShift(-1)');
  await exec('window.__cwTest.calendarGoToday()');
  check(
    '码字日历：翻回本月、不允许翻到未来、「本月」按钮可用',
    calendarBackLabel === calendarNow.label &&
      (await exec('window.__cwTest.calendarNextDisabled()')) === true &&
      calendarFutureBlocked === false &&
      (await exec('window.__cwTest.calendarLabel()')) === calendarNow.label &&
      (await exec('window.__cwTest.calendarTodayDisabled()')) === true,
    { calendarBackLabel, calendarFutureBlocked, label: await exec('window.__cwTest.calendarLabel()') }
  );
  const statsFileStatAfter = await fs.stat(statsPath);
  const statsDiskFinal = await readStatsDisk();
  const configDiskFinal = await readConfigDisk();
  check(
    '码字日历：翻月 / 看日历只读，stats.json 大小与修改时间不变',
    statsFileStatAfter.size === statsFileStatBefore.size && statsFileStatAfter.mtimeMs === statsFileStatBefore.mtimeMs,
    { before: { size: statsFileStatBefore.size, mtimeMs: statsFileStatBefore.mtimeMs }, after: { size: statsFileStatAfter.size, mtimeMs: statsFileStatAfter.mtimeMs } }
  );
  check(
    '码字日历：日历 / 连续天数只现算，不往 stats.json 写缓存字段',
    Object.keys(statsDiskFinal).sort().join('|') === 'days|version' &&
      Object.keys(statsDiskFinal.days).every((day) => Object.keys(statsDiskFinal.days[day]).join('|') === 'books')
  );
  check(
    '码字日历：不新增配置字段（目标仍是既有 dailyGoal）',
    !('calendar' in configDiskFinal) && !('statsCalendar' in configDiskFinal) && !('streak' in configDiskFinal)
  );

  // 44h-3. 收尾：目标改回 0；写作页按书设置里不显示全局日历
  await exec("window.__cwTest.setInput('settings-daily-goal', '0')");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === 0)');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  check(
    '码字日历：写作页按书设置里不显示（全局统计）',
    (await exec('window.__cwTest.calendarVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');

  // 44i. 写作时长统计（v0.8-2，提案 N2）：可选、默认关；只记时长不记内容
  // 只写临时 userData 的 stats.json / config.json；书库 / 书目 / 章节 txt 不受影响。
  const writeTimerDay = statsLib.localDayKey();
  const waitForStatsSeconds = async (atLeast, timeout = 8000) => {
    const startedAt = Date.now();
    for (;;) {
      const disk = await readStatsDisk();
      const seconds = statsLib.daySeconds(disk, writeTimerDay);
      if (seconds >= atLeast) return { disk, seconds };
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待写作时长落盘超时：${seconds} < ${atLeast}`);
      }
      await sleep(120);
    }
  };
  const writeTimerConfigBefore = await readConfigDisk();
  const writeTimerStatsBefore = await readStatsDisk();
  check(
    '写作时长：默认关（config 里没有开启；旧 stats 没有 seconds）',
    writeTimerConfigBefore.writeDurationEnabled !== true &&
      (await exec('window.api.getConfig().then((r) => r.ok && r.data.writeDurationEnabled === false)')) === true &&
      statsLib.daySeconds(writeTimerStatsBefore, writeTimerDay) === 0
  );
  check(
    '写作时长：默认关时写作页不显示计时按钮',
    (await exec('window.__cwTest.timerVisible()')) === false &&
      (await exec('window.__cwTest.timerStart()')) === false
  );

  // 44i-1. 设置里开启（全局设置：要在书架页打开）；开关落进 config.json
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  check(
    '写作时长：设置里有开关，默认未勾选且按书设置里不显示',
    (await exec('window.__cwTest.durationSettingsVisible()')) === true &&
      (await exec('window.__cwTest.durationSettingsChecked()')) === false &&
      (await exec('window.__cwTest.durationSettingsSummary()')).includes('未开启')
  );
  await exec("window.__cwTest.setCheck('settings-write-duration', true)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.writeDurationEnabled === true)');
  const writeTimerConfigOn = await readConfigDisk();
  check(
    '写作时长：开启后开关真的落进 config.json，只新增 writeDurationEnabled 一个字段',
    writeTimerConfigOn.writeDurationEnabled === true &&
      writeTimerConfigOn.dailyGoal === 0 &&
      JSON.stringify(Object.keys(writeTimerConfigOn).filter((key) => /duration|timer/i.test(key))) ===
        '["writeDurationEnabled"]',
    writeTimerConfigOn
  );
  check('写作时长：书架页不显示计时按钮（只在写作页）', (await exec('window.__cwTest.timerVisible()')) === false);

  // 44i-2. 打开书 → 手动开始 / 暂停：按实际经过的整秒记进 stats.json，不碰字数
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const timerBookEntriesBefore = (await fs.readdir(historyBookPath)).sort().join('|');
  check(
    '写作时长：开启后写作页出现计时按钮，默认不走表',
    (await exec('window.__cwTest.timerVisible()')) === true &&
      (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerText()')).includes('写作计时')
  );
  const timerStatsBeforeStart = await readStatsDisk();
  const timerSecondsBeforeStart = statsLib.daySeconds(timerStatsBeforeStart, writeTimerDay);
  const timerCharsBeforeStart = statsLib.dayTotal(timerStatsBeforeStart, writeTimerDay);
  check('写作时长：点开始后进入计时状态', (await exec('window.__cwTest.timerStart()')) === true && (await exec('window.__cwTest.timerRunning()')) === true);
  await sleep(1400);
  await exec('window.__cwTest.timerPause()');
  check(
    '写作时长：暂停后按钮显示已暂停的秒表，本次时长 ≥ 1 秒',
    (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerText()')).includes('已暂停') &&
      (await exec('window.__cwTest.timerSessionSeconds()')) >= 1
  );
  const timerStatsAfterPause = await readStatsDisk();
  const timerSecondsAfterPause = statsLib.daySeconds(timerStatsAfterPause, writeTimerDay);
  check(
    '写作时长：暂停时把整秒写进 stats.json，字数一点没变',
    timerSecondsAfterPause >= timerSecondsBeforeStart + 1 &&
      timerSecondsAfterPause <= timerSecondsBeforeStart + 4 &&
      statsLib.dayTotal(timerStatsAfterPause, writeTimerDay) === timerCharsBeforeStart &&
      Object.keys(timerStatsAfterPause.days[writeTimerDay] || {}).sort().join('|') === 'books|seconds',
    { timerSecondsBeforeStart, timerSecondsAfterPause }
  );

  // 44i-3. 界面 / 统计摘要 / 码字日历都跟着显示时长（只读，不再写盘）
  await exec('window.__cwTest.refreshStats()');
  const timerSummary = await exec('window.__cwTest.statsSummary()');
  check(
    '写作时长：统计摘要带 writeDurationEnabled / todaySeconds，与磁盘一致',
    timerSummary &&
      timerSummary.writeDurationEnabled === true &&
      timerSummary.todaySeconds === timerSecondsAfterPause &&
      (await exec('window.__cwTest.statsChartSummary()')).includes('今日写作') &&
      (await exec('window.__cwTest.durationSettingsSummary()')).includes('今天写作')
  );
  const timerCalendar = await exec('window.__cwTest.statsCalendar()');
  const timerCalendarCell = timerCalendar && timerCalendar.days.find((item) => item.day === writeTimerDay);
  check(
    '写作时长：码字日历今天格子 / 月度汇总带「用时」',
    timerCalendar &&
      timerCalendar.totalSeconds === timerSecondsAfterPause &&
      timerCalendarCell &&
      timerCalendarCell.seconds === timerSecondsAfterPause &&
      (await exec(`window.__cwTest.calendarDayInfo(${JSON.stringify(writeTimerDay)})`)).seconds === timerSecondsAfterPause &&
      (await exec('window.__cwTest.calendarSummaryText()')).includes('用时')
  );

  // 44i-4. 计时中上报（30 秒定时器同一路径）：整秒落盘、零头留在内存，不重复计数
  await exec('window.__cwTest.timerStart()');
  await sleep(1200);
  await exec('window.__cwTest.timerFlush()');
  const timerAfterFlush = await waitForStatsSeconds(timerSecondsAfterPause + 1);
  check(
    '写作时长：计时中上报只加整秒、不足 1 秒留在内存',
    timerAfterFlush.seconds >= timerSecondsAfterPause + 1 &&
      timerAfterFlush.seconds <= timerSecondsAfterPause + 3 &&
      (await exec('window.__cwTest.timerUnsentSeconds()')) <= 1 &&
      (await exec('window.__cwTest.timerRunning()')) === true
  );
  await exec('window.__cwTest.timerPause()');

  // 44i-5. 离开写作页自动停表并上报；回写作页从 0 开始、不会自己走表
  await exec('window.__cwTest.timerStart()');
  await sleep(1300);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const timerAfterLeave = await waitForStatsSeconds(timerAfterFlush.seconds + 1);
  check(
    '写作时长：回书架自动停表，并把没上报的整秒记下',
    timerAfterLeave.seconds >= timerAfterFlush.seconds + 1 &&
      (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerVisible()')) === false
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '写作时长：重新打开书后秒表从 0 开始，不会自己计时',
    (await exec('window.__cwTest.timerVisible()')) === true &&
      (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerSessionSeconds()')) === 0 &&
      (await exec('window.__cwTest.timerText()')) === '写作计时'
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 44i-6. 关掉开关：主进程不再接收时长；写作页按钮消失，历史秒数保留
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setCheck('settings-write-duration', false)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.writeDurationEnabled === false)');
  const timerGateBeforeStat = await fs.stat(statsPath);
  const timerGateBefore = await readStatsDisk();
  const timerGateResult = await exec('window.api.addStatsDuration({ seconds: 300 })');
  await sleep(200);
  const timerGateAfterStat = await fs.stat(statsPath);
  const timerGateAfter = await readStatsDisk();
  check(
    '写作时长：关掉后主进程直接忽略上报，stats.json 一个字节都不动',
    timerGateResult &&
      timerGateResult.ok === true &&
      timerGateResult.data.recorded === 0 &&
      timerGateResult.data.disabled === true &&
      timerGateAfterStat.size === timerGateBeforeStat.size &&
      timerGateAfterStat.mtimeMs === timerGateBeforeStat.mtimeMs &&
      JSON.stringify(timerGateAfter) === JSON.stringify(timerGateBefore)
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const timerOffStatBefore = await fs.stat(statsPath);
  await sleep(1200);
  const timerOffStatAfter = await fs.stat(statsPath);
  check(
    '写作时长：关掉后写作页不再显示按钮、也开不了计时（历史时长仍保留）',
    (await exec('window.__cwTest.timerVisible()')) === false &&
      (await exec('window.__cwTest.timerStart()')) === false &&
      timerOffStatAfter.size === timerOffStatBefore.size &&
      timerOffStatAfter.mtimeMs === timerOffStatBefore.mtimeMs &&
      statsLib.daySeconds(await readStatsDisk(), writeTimerDay) === timerAfterLeave.seconds
  );

  // 44i-7. 只写 userData、兼容旧数据：书库没有 stats.json / 临时文件 / 新备份目录
  const timerUserDataEntries = await fs.readdir(userData);
  const timerBookEntriesAfter = (await fs.readdir(historyBookPath)).sort().join('|');
  check(
    '写作时长：只写 userData/stats.json，书内目录一个文件都没多',
    !timerUserDataEntries.some((name) => name.includes('.tmp-')) &&
      (await fileExists(statsPath)) &&
      !(await fileExists(path.join(historyBookPath, 'stats.json'))) &&
      !(await fileExists(path.join(booksRoot, 'stats.json'))) &&
      timerBookEntriesAfter === timerBookEntriesBefore,
    { before: timerBookEntriesBefore, after: timerBookEntriesAfter }
  );
  const timerDiskFinal = await readStatsDisk();
  const timerSeedMonthView = statsLib.monthView(timerDiskFinal, {
    year: calendarSeed.seedYear,
    month: calendarSeed.seedMonth,
    now: new Date()
  });
  check(
    '写作时长：旧统计（没有 seconds 的种子天）照常读，时长按 0 处理',
    timerSeedMonthView.totalSeconds === 0 &&
      timerSeedMonthView.days.every((item) => item.seconds === 0) &&
      calendarSeed.seedDays.every(
        (item) => Object.keys(timerDiskFinal.days[item.day] || {}).join('|') === 'books'
      ) &&
      Object.keys(timerDiskFinal).sort().join('|') === 'days|version'
  );

  // 44j. 书卡作者 / 简介 + 书架分组 / 标签（v0.8-3，提案 N3）
  // 只写 书目.json 的可选字段；分组只是书架视图，不动书文件夹 / 章节 txt。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '书籍信息：没有任何分组时，书架不显示分组筛选条',
    (await exec('window.__cwTest.shelfGroupBarVisible()')) === false
  );
  const infoBookTitle = '信息卡测试书';
  await exec(`window.__cwTest.newBook(${JSON.stringify(infoBookTitle)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const infoBookPath = await exec('window.__cwTest.bookPathValue()');
  const infoBookFolder = path.basename(infoBookPath);
  const infoMetaPath = path.join(infoBookPath, '书目.json');
  const infoChapter = (await storage.readBookMeta(infoBookPath)).chapters[0];
  const infoTxtPath = path.join(infoBookPath, infoChapter.file);
  await exec("window.__cwTest.setText('书籍信息测试正文。')");
  await exec('window.__cwTest.save()');
  const infoTxtBytesBefore = await fs.readFile(infoTxtPath);
  const infoTxtStatBefore = await fs.stat(infoTxtPath);
  const infoContentFiles = (names) =>
    names.filter((name) => name !== '书目.json' && name !== '书目.json.bak').sort();
  const infoDirBefore = infoContentFiles(await fs.readdir(infoBookPath));
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const infoMenuTexts = await exec('window.__cwTest.bookMenuTexts()');
  check('书籍信息：书卡右键菜单有「书籍信息…」', infoMenuTexts.includes('书籍信息…'), infoMenuTexts);
  await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(infoBookPath)})`);
  check('书籍信息：菜单能打开（不是点了没反应）', (await exec('window.__cwTest.bookMenuOpen()')) === true);
  await exec("window.__cwTest.clickBookMenuAction('info')");
  await waitFor('window.__cwTest.bookInfoDialogOpen()');
  const infoEmptyValues = await exec('window.__cwTest.bookInfoValues()');
  check(
    '书籍信息：旧书（没有可选字段）打开弹层时四项都是空值',
    infoEmptyValues &&
      infoEmptyValues.author === '' &&
      infoEmptyValues.group === '' &&
      infoEmptyValues.tags === '' &&
      infoEmptyValues.brief === '' &&
      (await exec('window.__cwTest.bookInfoBookText()')).includes(infoBookTitle),
    infoEmptyValues
  );

  // 44j-1. 填作者 / 分组 / 标签 / 简介 → 保存：清洗后写进 书目.json，正文一个字节不动
  await exec("window.__cwTest.setBookInfoField('author', ' 测试作者 ')");
  await exec("window.__cwTest.setBookInfoField('group', '玄幻')");
  await exec("window.__cwTest.setBookInfoField('tags', '爽文，升级、爽文')");
  await exec("window.__cwTest.setBookInfoField('brief', '第一行简介\\r\\n\\r\\n\\r\\n第二行简介')");
  const infoSaveResult = await exec('window.__cwTest.saveBookInfoDialog()');
  await waitFor('!window.__cwTest.bookInfoDialogOpen()');
  const infoMetaOnDisk = JSON.parse(await fs.readFile(infoMetaPath, 'utf8'));
  check(
    '书籍信息：保存后 书目.json 里作者 / 分组 / 简介按规则清洗、标签去重',
    infoSaveResult &&
      infoSaveResult.ok === true &&
      infoSaveResult.changed === true &&
      infoMetaOnDisk.author === '测试作者' &&
      infoMetaOnDisk.group === '玄幻' &&
      infoMetaOnDisk.brief === '第一行简介\n\n第二行简介' &&
      JSON.stringify(infoMetaOnDisk.tags) === JSON.stringify(['爽文', '升级']),
    { result: infoSaveResult, meta: infoMetaOnDisk }
  );
  check(
    '书籍信息：保存只改书目，章节 txt 字节 / mtime / 文件名 / 书内文件数都没变',
    JSON.stringify(await fs.readFile(infoTxtPath)) === JSON.stringify(infoTxtBytesBefore) &&
      (await fs.stat(infoTxtPath)).mtimeMs === infoTxtStatBefore.mtimeMs &&
      JSON.stringify(infoContentFiles(await fs.readdir(infoBookPath))) === JSON.stringify(infoDirBefore),
    { entries: await fs.readdir(infoBookPath) }
  );
  const infoCard = await exec(`window.__cwTest.bookCardInfo(${JSON.stringify(infoBookFolder)})`);
  check(
    '书籍信息：书卡显示作者 / 分组与标签 / 简介',
    infoCard &&
      infoCard.author.includes('测试作者') &&
      infoCard.tags.includes('分组：玄幻') &&
      infoCard.tags.includes('#爽文') &&
      infoCard.tags.includes('#升级') &&
      infoCard.brief.includes('第一行简介') &&
      infoCard.brief.includes('第二行简介'),
    infoCard
  );
  const infoShelfPayload = await exec(`window.__cwTest.shelfBookInfo(${JSON.stringify(infoBookFolder)})`);
  check(
    '书籍信息：书架列表带 author / brief / group / tags（供筛选和搜索用）',
    infoShelfPayload &&
      infoShelfPayload.author === '测试作者' &&
      infoShelfPayload.group === '玄幻' &&
      JSON.stringify(infoShelfPayload.tags) === JSON.stringify(['爽文', '升级']),
    infoShelfPayload
  );

  // 44j-2. 书架搜索：作者 / 分组 / 标签都能命中
  await exec("window.__cwTest.setShelfQuery('测试作者')");
  check(
    '书籍信息：按作者能在书架上搜到',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes(infoBookTitle)
  );
  await exec("window.__cwTest.setShelfQuery('爽文')");
  check(
    '书籍信息：按标签能在书架上搜到',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes(infoBookTitle)
  );
  await exec("window.__cwTest.setShelfQuery('玄幻')");
  check(
    '书籍信息：按分组能在书架上搜到',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes(infoBookTitle)
  );
  await exec("window.__cwTest.setShelfQuery('')");

  // 44j-3. 分组筛选：一本短篇书 + 一本已存在的未分组书
  await exec("window.__cwTest.newBook('信息卡乙')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const infoBookBPath = await exec('window.__cwTest.bookPathValue()');
  await exec('window.__cwTest.backToShelf()');
  const infoBookBResult = await exec(
    `window.api.updateBookInfo(${JSON.stringify(infoBookBPath)}, { author: '乙作者', group: '短篇' })`
  );
  await exec('window.__cwTest.refreshShelf()');
  const infoGroupOptions = await exec('window.__cwTest.shelfGroupOptions()');
  const infoGroupValues = infoGroupOptions.map((item) => item.value);
  check(
    '书籍信息：有分组后书架出现分组筛选（全部分组 / 未分组 / 短篇 / 玄幻）',
    infoBookBResult &&
      infoBookBResult.ok === true &&
      (await exec('window.__cwTest.shelfGroupBarVisible()')) === true &&
      infoGroupValues.includes('') &&
      infoGroupValues.includes('__none__') &&
      infoGroupValues.includes('短篇') &&
      infoGroupValues.includes('玄幻'),
    infoGroupValues
  );
  await exec("window.__cwTest.setShelfGroup('玄幻')");
  const infoFilteredXuanhuan = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书籍信息：选「玄幻」只显示这一组的书',
    infoFilteredXuanhuan.includes(infoBookTitle) &&
      !infoFilteredXuanhuan.includes('信息卡乙'),
    infoFilteredXuanhuan
  );
  const historyTitle = (await storage.readBookMeta(historyBookPath)).title;
  await exec("window.__cwTest.setShelfGroup('__none__')");
  const infoFilteredNone = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书籍信息：选「未分组」只显示没有分组的书',
    infoFilteredNone.includes(historyTitle) &&
      !infoFilteredNone.includes(infoBookTitle) &&
      !infoFilteredNone.includes('信息卡乙'),
    { filtered: infoFilteredNone, historyTitle }
  );
  const infoAllCount = (await exec('window.__cwTest.shelfTitles()')).length;
  await exec("window.__cwTest.setShelfGroup('')");
  const infoAllFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书籍信息：回到「全部分组」显示所有书（筛选只影响显示）',
    infoAllFiltered.length === infoAllCount && infoAllFiltered.includes(infoBookTitle),
    { shown: infoAllFiltered.length, total: infoAllCount }
  );
  await exec("window.__cwTest.setShelfGroup('短篇')");
  await exec("window.__cwTest.setShelfQuery('测试作者')");
  check(
    '书籍信息：分组筛选和搜索能叠加（短篇 + 测试作者 = 空）',
    (await exec('window.__cwTest.shelfFilteredTitles()')).length === 0
  );
  await exec("window.__cwTest.setShelfQuery('乙作者')");
  check(
    '书籍信息：分组筛选和搜索能叠加（短篇 + 乙作者 = 信息卡乙）',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes('信息卡乙')
  );
  await exec("window.__cwTest.setShelfQuery('')");

  // 44j-4. 取消不写盘；清空分组后筛选条自动更新、选中状态回到全部
  const infoMetaBeforeCancel = await fs.readFile(infoMetaPath);
  await exec("window.__cwTest.setShelfGroup('玄幻')");
  await exec(`window.__cwTest.openBookInfoForPath(${JSON.stringify(infoBookPath)})`);
  await exec("window.__cwTest.setBookInfoField('author', '不该保存的作者')");
  await exec('window.__cwTest.closeBookInfoDialog()');
  await sleep(200);
  check(
    '书籍信息：点取消不写盘（书目字节不变）',
    JSON.stringify(await fs.readFile(infoMetaPath)) === JSON.stringify(infoMetaBeforeCancel)
  );
  await exec(`window.__cwTest.openBookInfoForPath(${JSON.stringify(infoBookPath)})`);
  await exec("window.__cwTest.setBookInfoField('group', '')");
  await exec('window.__cwTest.saveBookInfoDialog()');
  await waitFor('!window.__cwTest.bookInfoDialogOpen()');
  const infoGroupOptionsAfter = (await exec('window.__cwTest.shelfGroupOptions()')).map((item) => item.value);
  const infoMetaAfterClear = JSON.parse(await fs.readFile(infoMetaPath, 'utf8'));
  check(
    '书籍信息：清空分组后从书目删掉该字段，筛选项里也没有「玄幻」了',
    !('group' in infoMetaAfterClear) && !infoGroupOptionsAfter.includes('玄幻') &&
      infoGroupOptionsAfter.includes('短篇')
  );
  check(
    '书籍信息：当前选中的分组不见了时，筛选自动回到「全部分组」',
    (await exec('window.__cwTest.shelfGroupValue()')) === '' &&
      (await exec('window.__cwTest.shelfFilteredTitles()')).length === infoAllCount
  );

  // 44j-5. 旧书兼容 / 不新增配置字段
  const historyMetaRaw = JSON.parse(await fs.readFile(path.join(historyBookPath, '书目.json'), 'utf8'));
  const historyShelfInfo = await exec(
    `window.__cwTest.shelfBookInfo(${JSON.stringify(path.basename(historyBookPath))})`
  );
  check(
    '书籍信息：旧书书目没有被补字段，书架上的书籍信息是空值',
    !('author' in historyMetaRaw) &&
      !('brief' in historyMetaRaw) &&
      !('group' in historyMetaRaw) &&
      !('tags' in historyMetaRaw) &&
      historyShelfInfo &&
      historyShelfInfo.author === '' &&
      historyShelfInfo.brief === '' &&
      historyShelfInfo.group === '' &&
      historyShelfInfo.tags.length === 0,
    { meta: historyMetaRaw, shelf: historyShelfInfo }
  );
  const infoConfigDisk = await readConfigDisk();
  check(
    '书籍信息：不新增任何配置字段（作者 / 分组 / 标签只存在书目里）',
    !Object.keys(infoConfigDisk).some((key) => /author|brief|bookinfo|tags|group/i.test(key)),
    Object.keys(infoConfigDisk)
  );
  const infoMetaFinal = JSON.parse(await fs.readFile(infoMetaPath, 'utf8'));
  check(
    '书籍信息：作者 / 简介 / 标签仍在，章节文件一个没多',
    infoMetaFinal.author === '测试作者' &&
      infoMetaFinal.brief === '第一行简介\n\n第二行简介' &&
      JSON.stringify(infoMetaFinal.tags) === JSON.stringify(['爽文', '升级']) &&
      JSON.stringify(infoContentFiles(await fs.readdir(infoBookPath))) === JSON.stringify(infoDirBefore)
  );

  // 45. 导出 EPUB（v0.7-1）：整本书 → EPUB 3；分卷做目录级、一章一个 XHTML、纯文字封面
  await exec("window.__cwTest.newBook('EPUB导出测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const epubBookPath = await exec('window.__cwTest.bookPathValue()');
  const epubMetaPath = path.join(epubBookPath, '书目.json');
  await exec("window.__cwTest.newVolume('上卷')");
  await exec("window.__cwTest.newChapterInVolume(0, '上卷一')");
  await exec("window.__cwTest.newChapterInVolume(0, '上卷二')");
  const epubTexts = [
    '楔子里的一段 & 符号。\n\n第二段 <比较>。',
    '上卷第一章正文。',
    '上卷第二章正文。'
  ];
  for (let i = 0; i < epubTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(epubTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  const epubMetaBefore = await storage.readBookMeta(epubBookPath);
  const epubDiskTexts = [];
  const epubStatBefore = [];
  const epubFilesOnDisk = [];
  for (const chapter of epubMetaBefore.chapters) {
    const filePath = path.join(epubBookPath, chapter.file);
    epubFilesOnDisk.push(filePath);
    epubDiskTexts.push((await storage.loadChapterText(epubBookPath, chapter.file)).text);
    const stat = await fs.stat(filePath);
    epubStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    'EPUB 导出：准备了一本 3 章 / 1 卷的书（第 1 章未分卷）',
    epubMetaBefore.chapters.length === 3 &&
      (await exec('window.__cwTest.volumeNames()')).join(',') === '上卷' &&
      JSON.stringify(epubDiskTexts) === JSON.stringify(epubTexts),
    { chapters: epubMetaBefore.chapters.length, texts: epubDiskTexts }
  );

  // 45a. 入口：导出菜单里有「导出 EPUB…」
  check(
    'EPUB 导出：导出菜单有「导出 EPUB…」',
    (await exec('window.__cwTest.exportMenuTexts()')).includes('导出 EPUB…'),
    await exec('window.__cwTest.exportMenuTexts()')
  );

  const epubDir = path.join(path.dirname(booksRoot), 'epub-exports');
  await fs.mkdir(epubDir, { recursive: true });
  const epubPath = path.join(epubDir, 'book.epub');
  withSavePath(epubPath);
  try {
    await exec(
      "document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action=\"epub\"]').click()"
    );
    await waitForFile(epubPath);
  } finally {
    restoreSaveDialog();
  }
  check(
    'EPUB 导出：保存对话框默认文件名 = 书名.epub，类型带 epub',
    Boolean(lastSaveOptions) &&
      path.basename(lastSaveOptions.defaultPath) === 'EPUB导出测试书.epub' &&
      Array.isArray(lastSaveOptions.filters) &&
      lastSaveOptions.filters.some((filter) => Array.isArray(filter.extensions) && filter.extensions.includes('epub')),
    lastSaveOptions && { defaultPath: lastSaveOptions.defaultPath, filters: lastSaveOptions.filters }
  );

  const epubBuffer = await fs.readFile(epubPath);
  const epubZip = readZip(epubBuffer);
  const epubEntries = new Map(epubZip.entries.map((entry) => [entry.name, entry]));
  const epubText = (name) => {
    const entry = epubEntries.get(name);
    return entry ? entry.data.toString('utf8') : '';
  };
  check(
    'EPUB 导出：mimetype 第一个、不压缩、没有扩展字段，内容正确',
    epubZip.entries[0].name === 'mimetype' &&
      epubZip.entries[0].method === 0 &&
      epubZip.entries[0].data.toString('utf8') === 'application/epub+zip' &&
      epubBuffer.readUInt16LE(6) === 0 &&
      epubBuffer.readUInt16LE(28) === 0,
    { first: epubZip.entries[0].name, method: epubZip.entries[0].method }
  );
  check(
    'EPUB 导出：container.xml 指向 OEBPS/content.opf',
    epubText('META-INF/container.xml').includes('full-path="OEBPS/content.opf"')
  );
  const epubOpf = epubText('OEBPS/content.opf');
  const epubManifestHrefs = [...epubOpf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((match) => match[1]);
  const epubSpine = [...epubOpf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  check(
    'EPUB 导出：OPF 书名 / 语言 / 标识齐全，manifest 里每个文件都在包里',
    epubOpf.includes('<dc:title>EPUB导出测试书</dc:title>') &&
      epubOpf.includes('<dc:language>zh-CN</dc:language>') &&
      /urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(epubOpf) &&
      epubManifestHrefs.length >= 8 &&
      epubManifestHrefs.every((href) => epubEntries.has(`OEBPS/${href}`)),
    { hrefs: epubManifestHrefs }
  );
  check(
    'EPUB 导出：spine = 封面 → 未分卷章 → 卷名页 → 卷内章',
    JSON.stringify(epubSpine) === JSON.stringify(['cover', 'ch1', 'vol1', 'ch2', 'ch3']),
    epubSpine
  );
  check(
    'EPUB 导出：分卷是二级目录（上卷带两章）',
    epubText('OEBPS/nav.xhtml').includes('<a href="text/volume-0001.xhtml">上卷</a>') &&
      epubText('OEBPS/nav.xhtml').includes('<li><a href="text/chapter-0001.xhtml">第1章</a></li>') &&
      epubText('OEBPS/nav.xhtml').includes('<li><a href="text/chapter-0002.xhtml">第2章：上卷一</a></li>') &&
      epubText('OEBPS/nav.xhtml').includes('<li><a href="text/chapter-0003.xhtml">第3章：上卷二</a></li>') &&
      (epubText('OEBPS/nav.xhtml').match(/<ol>/g) || []).length === 2,
    epubText('OEBPS/nav.xhtml')
  );
  check(
    'EPUB 导出：一章一个 XHTML，章名 / 章号与 TXT 导出一致',
    epubText('OEBPS/text/chapter-0001.xhtml').includes('<h1 class="chapter-title">第1章</h1>') &&
      epubText('OEBPS/text/chapter-0002.xhtml').includes('<h1 class="chapter-title">第2章：上卷一</h1>') &&
      epubText('OEBPS/text/volume-0001.xhtml').includes('<h1 class="part-title">上卷</h1>')
  );
  check(
    'EPUB 导出：正文按段落输出、特殊字符都转义了',
    epubText('OEBPS/text/chapter-0001.xhtml').includes('<p>楔子里的一段 &amp; 符号。</p>') &&
      epubText('OEBPS/text/chapter-0001.xhtml').includes('<p>第二段 &lt;比较&gt;。</p>') &&
      !epubText('OEBPS/text/chapter-0001.xhtml').includes('楔子里的一段 & 符号'),
    epubText('OEBPS/text/chapter-0001.xhtml')
  );
  check(
    'EPUB 导出：纯文字封面页带书名与章数 / 卷数',
    epubText('OEBPS/cover.xhtml').includes('<h1 class="cover-title">EPUB导出测试书</h1>') &&
      epubText('OEBPS/cover.xhtml').includes('共 3 章 · 1 卷'),
    epubText('OEBPS/cover.xhtml')
  );
  check(
    'EPUB 导出：排版用 CSS 做段首缩进 2 字 + 段间空一行',
    epubText('OEBPS/style.css').includes('text-indent: 2em') &&
      epubText('OEBPS/style.css').includes('margin: 0 0 1.75em 0')
  );
  let epubXmlOk = true;
  let epubXmlChecked = 0;
  let epubXmlError = '';
  for (const entry of epubZip.entries) {
    if (!/\.(xhtml|opf|ncx|xml)$/.test(entry.name)) continue;
    try {
      assertWellFormedXml(entry.data.toString('utf8'), entry.name);
      epubXmlChecked += 1;
    } catch (err) {
      epubXmlOk = false;
      epubXmlError = err.message;
      break;
    }
  }
  check(
    'EPUB 导出：所有 XML 文件都合法（含容器 / OPF / 目录 / 章节页）',
    epubXmlOk && epubXmlChecked >= 9,
    { checked: epubXmlChecked, error: epubXmlError }
  );

  // 45b. 当前章未保存的内容进 EPUB，但绝不写盘
  await exec("window.__cwTest.switchTo(1, 'discard')");
  const epubUnsavedText = '这段还没保存，但 EPUB 里必须有';
  await exec(`window.__cwTest.setText(${JSON.stringify(epubUnsavedText)})`);
  const epubUnsavedPath = path.join(epubDir, 'unsaved.epub');
  withSavePath(epubUnsavedPath);
  try {
    await exec("document.querySelector('#export-menu button[data-action=\"epub\"]').click()");
    await waitForFile(epubUnsavedPath);
  } finally {
    restoreSaveDialog();
  }
  const epubUnsavedZip = readZip(await fs.readFile(epubUnsavedPath));
  const epubUnsavedChapter = epubUnsavedZip.entries
    .find((entry) => entry.name === 'OEBPS/text/chapter-0002.xhtml')
    .data.toString('utf8');
  check(
    'EPUB 导出：当前章未保存内容进了 EPUB，磁盘正文没被偷偷改写',
    epubUnsavedChapter.includes(epubUnsavedText) &&
      !epubUnsavedChapter.includes('上卷第一章正文。') &&
      (await storage.loadChapterText(epubBookPath, epubMetaBefore.chapters[1].file)).text ===
        '上卷第一章正文。' &&
      (await exec('window.__cwTest.dirty()')) === true,
    { chapter: epubUnsavedChapter, dirty: await exec('window.__cwTest.dirty()') }
  );

  // 45c. 取消保存对话框：不写文件、仍停在编辑页
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: null });
  try {
    await exec("document.querySelector('#export-menu button[data-action=\"epub\"]').click()");
    await sleep(500);
  } finally {
    restoreSaveDialog();
  }
  check(
    'EPUB 导出：取消保存对话框不写文件、仍停在编辑页',
    !(await fileExists(path.join(epubDir, 'cancel.epub'))) &&
      (await exec("window.__cwTest.view() === 'editor'"))
  );

  // 45d. 只读 + 目录记忆：章节 txt 大小 / mtime、书目 chapters 都没被导出改写
  await exec("window.__cwTest.switchTo(2, 'discard')");
  let epubFilesUntouched = true;
  for (let i = 0; i < epubFilesOnDisk.length; i += 1) {
    const stat = await fs.stat(epubFilesOnDisk[i]);
    if (stat.size !== epubStatBefore[i].size || stat.mtimeMs !== epubStatBefore[i].mtimeMs) {
      epubFilesUntouched = false;
    }
  }
  const epubMetaAfter = await storage.readBookMeta(epubBookPath);
  let epubConfigNow = null;
  try {
    epubConfigNow = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
  } catch {
    /* 读不到就当失败 */
  }
  check(
    'EPUB 导出：章节 txt 与书目的章节记录都没被导出改写（纯读）',
    epubFilesUntouched &&
      JSON.stringify(epubMetaAfter.chapters) === JSON.stringify(epubMetaBefore.chapters),
    { untouched: epubFilesUntouched }
  );
  check(
    'EPUB 导出：导出过的目录被记住，下次默认还开在这里',
    Boolean(epubConfigNow && epubConfigNow.lastExportDir === epubDir),
    epubConfigNow && epubConfigNow.lastExportDir
  );

  // 45e. 旧数据兼容：v0.4.1 形状（没有 schemaVersion）的书照常导出，且导出不改书目
  await exec("window.__cwTest.newBook('EPUB旧书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const epubLegacyBookPath = await exec('window.__cwTest.bookPathValue()');
  const epubLegacyMetaPath = path.join(epubLegacyBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('旧书正文。')");
  await exec('window.__cwTest.save()');
  const epubLegacyRaw = JSON.parse(await fs.readFile(epubLegacyMetaPath, 'utf8'));
  delete epubLegacyRaw.schemaVersion;
  // 再模拟一本真正的 v0.4.1 旧书：去掉本轮新增之外的所有可选字段
  for (const chapter of epubLegacyRaw.chapters) {
    delete chapter.status;
    delete chapter.note;
  }
  await fs.writeFile(epubLegacyMetaPath, JSON.stringify(epubLegacyRaw, null, 2), 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(epubLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    'EPUB 导出：没有 schemaVersion 的旧书照常打开',
    (await exec('window.__cwTest.currentTitle()')).includes('起风')
  );
  const epubLegacyExportPath = path.join(epubDir, 'legacy.epub');
  withSavePath(epubLegacyExportPath);
  try {
    await exec("document.querySelector('#export-menu button[data-action=\"epub\"]').click()");
    await waitForFile(epubLegacyExportPath);
  } finally {
    restoreSaveDialog();
  }
  const epubLegacyZip = readZip(await fs.readFile(epubLegacyExportPath));
  const epubLegacyOpf = epubLegacyZip.entries
    .find((entry) => entry.name === 'OEBPS/content.opf')
    .data.toString('utf8');
  const epubLegacyAfter = JSON.parse(await fs.readFile(epubLegacyMetaPath, 'utf8'));
  check(
    'EPUB 导出：v0.4.1 形状旧书（没有 schemaVersion）照常导出，书目没被补字段',
    epubLegacyOpf.includes('<dc:title>EPUB旧书</dc:title>') &&
      epubLegacyZip.names.includes('OEBPS/text/chapter-0001.xhtml') &&
      epubLegacyAfter.schemaVersion === undefined,
    { version: epubLegacyAfter.schemaVersion, names: epubLegacyZip.names }
  );

  // 46. 校对面板（v0.7-2，提案 5.1）：只报告、不改动；当前章 / 整本都能跑，点一条跳到正文
  await exec("window.__cwTest.newBook('校对测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const pfBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '海边')");
  await exec("window.__cwTest.newChapter('长夜')");
  await exec("window.__cwTest.newChapter('尾声')");
  // 第 1 章：半角逗号 1 处、3 次「突然」、连续标点「？！？」、3 个连续空行
  const pfCh1 = '他走在海边,风很大。\n突然下雨了，突然又停了，突然又下起来。\n他喊：「？！？」\n\n\n';
  // 第 2 章：一段 520 字的超长段落（字符互不相同，避免顺手触发重复用词）
  const pfLongText = Array.from({ length: 520 }, (_v, i) =>
    String.fromCharCode(0x4e00 + ((i * 61 + 7) % 1500))
  ).join('');
  // 第 3 章：干净正文（只有 1 个空行，不算多余空行）
  const pfClean = '雨停了。\n\n他收起伞。';
  const pfTexts = [pfCh1, pfLongText, pfClean];
  for (let i = 0; i < pfTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(pfTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const pfMetaBefore = await storage.readBookMeta(pfBookPath);
  const pfDiskBefore = [];
  const pfStatBefore = [];
  for (const chapter of pfMetaBefore.chapters) {
    const filePath = path.join(pfBookPath, chapter.file);
    pfDiskBefore.push((await storage.loadChapterText(pfBookPath, chapter.file)).text);
    const stat = await fs.stat(filePath);
    pfStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '校对：准备了一本 3 章的书（第 1 章有 4 类可疑、第 2 章超长段落、第 3 章干净）',
    JSON.stringify(pfDiskBefore) === JSON.stringify(pfTexts) &&
      pfLongText.length === 520 &&
      (await exec('window.__cwTest.chapterTitles()')).join(',') === '第1章：海边,第2章：长夜,尾声',
    {
      texts: pfDiskBefore.map((text) => text.length),
      diskEqual: JSON.stringify(pfDiskBefore) === JSON.stringify(pfTexts),
      titles: await exec('window.__cwTest.chapterTitles()')
    }
  );

  // 46a. 入口 + 打开面板自动检查当前章（只读，不写盘）
  check(
    '校对：写作页顶栏有「校对」按钮',
    (await exec("document.getElementById('btn-proofread').textContent")) === '校对'
  );
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 4 处可疑')");
  const pfCurrent = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对：打开面板自动检查当前章，4 类问题各 1 条',
    pfCurrent &&
      pfCurrent.scope === 'current' &&
      pfCurrent.total === 4 &&
      pfCurrent.byRule['halfwidth-punct'] === 1 &&
      pfCurrent.byRule['repeat-word'] === 1 &&
      pfCurrent.byRule['punct-run'] === 1 &&
      pfCurrent.byRule['blank-lines'] === 1 &&
      pfCurrent.byRule['long-paragraph'] === 0 &&
      (await exec('window.__cwTest.proofreadRowCount()')) === 4,
    pfCurrent
  );
  check(
    '校对：结果按规则分类、带行号 / 位置 / 上下文片段',
    (await exec('window.__cwTest.proofreadRuleTexts()')).join(',') ===
      '半角标点,重复用词,连续标点,多余空行' &&
      (await exec('window.__cwTest.proofreadRowTexts()')).every((text) =>
        /第 \d+ 行 · 第 \d+ 字/.test(text)
      ) &&
      (await exec('window.__cwTest.proofreadRowTexts()')).some((text) =>
        text.includes('半角标点「,」建议改成「，」')
      ),
    await exec('window.__cwTest.proofreadRowTexts()')
  );
  check(
    '校对：检查过程只读——当前章仍是已保存状态',
    (await exec('window.__cwTest.dirty()')) === false &&
      (await exec('window.__cwTest.text()')) === pfCh1 &&
      (await exec('window.__cwTest.proofreadSummary()')).includes('半角标点 1')
  );

  // 46b. 点结果跳到正文：选中那一处标点，面板关闭，正文不变
  const pfCommaIssue = pfCurrent.issues.find((issue) => issue.rule === 'halfwidth-punct');
  const pfCommaRow = pfCurrent.issues.indexOf(pfCommaIssue);
  await exec(`window.__cwTest.clickProofreadRow(${pfCommaRow})`);
  await waitFor('window.__cwTest.proofreadPanelOpen() === false');
  const pfCommaSelection = await exec('window.__cwTest.selection()');
  const pfCommaText = await exec('window.__cwTest.selectionText()');
  check(
    '校对：点「半角标点」结果会选中正文里的那一处并关闭面板',
    pfCommaIssue.index === pfCh1.indexOf(',') &&
      pfCommaSelection.start === pfCh1.indexOf(',') &&
      pfCommaSelection.end === pfCh1.indexOf(',') + 1 &&
      pfCommaText === ',' &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await storage.loadChapterText(pfBookPath, pfMetaBefore.chapters[0].file)).text === pfCh1,
    { issue: pfCommaIssue, selection: pfCommaSelection, text: pfCommaText }
  );

  // 46c. 整本校对：列出涉及哪几章，点长段落结果会切章并定位
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 4 处可疑')");
  await exec("window.__cwTest.setProofreadScope('book')");
  const pfBookRun = await exec('window.__cwTest.proofreadRun()');
  const pfBook = await exec('window.__cwTest.proofreadPayload()');
  const pfLongIssue = pfBook && pfBook.issues.find((issue) => issue.rule === 'long-paragraph');
  check(
    '校对：整本模式通读全书（3 章），共 5 处：第 1 章 4 处 + 第 2 章超长段落',
    pfBookRun &&
      pfBookRun.ok === true &&
      pfBookRun.scope === 'book' &&
      pfBook &&
      pfBook.scope === 'book' &&
      pfBook.chapterCount === 3 &&
      pfBook.chapterHitCount === 2 &&
      pfBook.total === 5 &&
      pfBook.byRule['long-paragraph'] === 1 &&
      Boolean(pfLongIssue) &&
      pfLongIssue.chapterIndex === 1 &&
      pfLongIssue.message.includes('520 字') &&
      (await exec('window.__cwTest.proofreadSummary()')).includes('全书 3 章共 5 处可疑，涉及 2 章'),
    { run: pfBookRun, payload: pfBook }
  );
  check(
    '校对：整本结果带章名（长夜），干净的第 3 章没有结果',
    (await exec('window.__cwTest.proofreadRowTexts()')).some((text) => text.includes('第2章：长夜')) &&
      !(await exec('window.__cwTest.proofreadRowTexts()')).some((text) => text.includes('尾声')) &&
      pfBook.issues.every((issue) => issue.chapterIndex !== 2)
  );
  const pfLongRow = pfBook.issues.indexOf(pfLongIssue);
  await exec(`window.__cwTest.clickProofreadRow(${pfLongRow})`);
  await waitFor(
    `window.__cwTest.currentTitle().includes('长夜') && window.__cwTest.selectionText() === ${JSON.stringify(
      pfLongText.slice(0, 24)
    )}`
  );
  const pfLongSelectionText = await exec('window.__cwTest.selectionText()');
  check(
    '校对：点整本里的「超长段落」会切到那一章并选中段首',
    (await exec('window.__cwTest.currentTitle()')).includes('第2章：长夜') &&
      pfLongSelectionText === pfLongText.slice(0, 24) &&
      (await exec('window.__cwTest.proofreadPanelOpen()')) === false &&
      (await exec('window.__cwTest.dirty()')) === false,
    pfLongSelectionText
  );

  // 46d. 当前章未保存的内容参与检查，但绝不写盘
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setProofreadScope('current')");
  const pfUnsavedText = `${pfCh1}还没有保存的半角逗号,`;
  await exec(`window.__cwTest.setText(${JSON.stringify(pfUnsavedText)})`);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 5 处可疑')");
  const pfUnsaved = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对：当前章未保存的内容也参与检查（多出一处半角逗号），磁盘没被改',
    pfUnsaved &&
      pfUnsaved.total === 5 &&
      pfUnsaved.byRule['halfwidth-punct'] === 2 &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await storage.loadChapterText(pfBookPath, pfMetaBefore.chapters[0].file)).text === pfCh1,
    { payload: pfUnsaved }
  );
  // 丢弃未保存内容，回到磁盘上的正文
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check(
    '校对：放弃未保存内容后正文回到磁盘版本（校对没有偷偷保存）',
    (await exec('window.__cwTest.text()')) === pfCh1 && (await exec('window.__cwTest.dirty()')) === false
  );

  // 46e. 连续标点不误报「……」；Esc 关闭面板
  await exec(`window.__cwTest.setText(${JSON.stringify('他……没说完。\n\n他喊：「？！？」')})`);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 1 处可疑')");
  const pfPunct = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对：省略号不误报，连续标点只报「？！？」这一处',
    pfPunct &&
      pfPunct.total === 1 &&
      pfPunct.byRule['punct-run'] === 1 &&
      pfPunct.issues[0].message === '连续 3 个标点「？！？」',
    pfPunct
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('校对：Esc 关闭面板', (await exec('window.__cwTest.proofreadPanelOpen()')) === false);
  // 把正文恢复成磁盘上的第 1 章（未保存的测试改动直接丢弃）
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // 46f. 干净章：0 条结果 + 明确提示
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章没有发现可疑的地方')");
  check(
    '校对：干净章显示 0 条结果与「没有发现可疑」提示',
    (await exec('window.__cwTest.proofreadPayload()')).total === 0 &&
      (await exec('window.__cwTest.proofreadRowCount()')) === 0 &&
      (await exec("document.querySelector('#proofread-results .proofread-empty').textContent")) ===
        '这一章没有发现可疑的地方'
  );
  await exec('window.__cwTest.closeProofreadPanel()');

  // 46g. 全程只读：章节 txt 大小 / mtime、书目 chapters、_trash 都没变化
  let pfFilesUntouched = true;
  for (let i = 0; i < pfMetaBefore.chapters.length; i += 1) {
    const stat = await fs.stat(path.join(pfBookPath, pfMetaBefore.chapters[i].file));
    if (stat.size !== pfStatBefore[i].size || stat.mtimeMs !== pfStatBefore[i].mtimeMs) {
      pfFilesUntouched = false;
    }
  }
  const pfMetaAfter = await storage.readBookMeta(pfBookPath);
  check(
    '校对：章节 txt 与书目 chapters 都没被改写，也没有生成 _trash（纯读）',
    pfFilesUntouched &&
      JSON.stringify(pfMetaAfter.chapters) === JSON.stringify(pfMetaBefore.chapters) &&
      !(await fileExists(path.join(pfBookPath, '_trash'))),
    { untouched: pfFilesUntouched }
  );

  // 46h. 旧数据兼容：v0.4.1 形状（没有 schemaVersion、章节没有 status/note）照常校对
  await exec("window.__cwTest.newBook('校对旧书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const pfLegacyBookPath = await exec('window.__cwTest.bookPathValue()');
  const pfLegacyMetaPath = path.join(pfLegacyBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec(`window.__cwTest.setText(${JSON.stringify('旧书正文,有一个半角逗号。')})`);
  await exec('window.__cwTest.save()');
  const pfLegacyRaw = JSON.parse(await fs.readFile(pfLegacyMetaPath, 'utf8'));
  delete pfLegacyRaw.schemaVersion;
  for (const chapter of pfLegacyRaw.chapters) {
    delete chapter.status;
    delete chapter.note;
  }
  await fs.writeFile(pfLegacyMetaPath, JSON.stringify(pfLegacyRaw, null, 2), 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(pfLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 1 处可疑')");
  const pfLegacyAfter = JSON.parse(await fs.readFile(pfLegacyMetaPath, 'utf8'));
  check(
    '校对：没有 schemaVersion 的旧书照常打开并校对，书目不被补字段',
    (await exec('window.__cwTest.currentTitle()')).includes('起风') &&
      (await exec('window.__cwTest.proofreadPayload()')).total === 1 &&
      pfLegacyAfter.schemaVersion === undefined &&
      pfLegacyAfter.chapters.every((chapter) => chapter.status === undefined && chapter.note === undefined),
    { version: pfLegacyAfter.schemaVersion }
  );
  await exec('window.__cwTest.closeProofreadPanel()');

  // 47. 灵感箱（v0.7-3，提案 3.4）：碎片是书架 _碎片 里的普通 txt；插入只改编辑区、不写盘
  const fragDir = path.join(booksRoot, '_碎片');
  const fragStamp = fragmentsLib.formatDateStamp();
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const fragBookCountBefore = (await exec('window.__cwTest.shelfTitles()')).length;
  check(
    '灵感箱：书架有「＋ 碎片」按钮',
    (await exec("document.getElementById('btn-add-fragment').textContent")).includes('碎片') &&
      (await exec("Boolean(document.getElementById('btn-add-fragment'))")) === true
  );

  // 47a. 书架「＋ 碎片」：纯文本框 → 原子写到 _碎片\YYYY-MM-DD-1.txt，UTF-8 无 BOM + CRLF
  await exec('window.__cwTest.openFragmentDialog()');
  check(
    '灵感箱：点「＋ 碎片」弹出记录框，标记为未保存的写盘动作',
    (await exec('window.__cwTest.fragmentDialogOpen()')) === true &&
      (await exec('window.__cwTest.fragmentCounterText()')) === '0 字'
  );
  await exec(`window.__cwTest.setFragmentText(${JSON.stringify('第一段\n第二段')})`);
  check(
    '灵感箱：记录框实时数字数（不含空白）',
    (await exec('window.__cwTest.fragmentCounterText()')) === '6 字'
  );
  const fragFirstSave = await exec('window.__cwTest.saveFragment()');
  check(
    '灵感箱：保存第一条碎片，文件名按当天日期编号',
    fragFirstSave &&
      fragFirstSave.ok === true &&
      fragFirstSave.name === `${fragStamp}-1.txt` &&
      fragFirstSave.chars === 6,
    fragFirstSave
  );
  const fragFirstPath = path.join(fragDir, `${fragStamp}-1.txt`);
  const fragFirstBytes = await fs.readFile(fragFirstPath);
  check(
    '灵感箱：碎片是普通 txt（UTF-8 无 BOM、CRLF），落在书架 _碎片 文件夹',
    fragFirstBytes[0] !== 0xef &&
      fragFirstBytes.toString('utf8') === '第一段\r\n第二段' &&
      !(await fileExists(path.join(booksRoot, '书目.json'))),
    { head: fragFirstBytes.subarray(0, 6).toString('hex') }
  );
  check(
    '灵感箱：保存后弹层自动关闭，书架上没有多出「_碎片」这本书',
    (await exec('window.__cwTest.fragmentDialogOpen()')) === false &&
      (await exec('window.__cwTest.shelfTitles()')).length === fragBookCountBefore &&
      !(await exec('window.__cwTest.shelfTitles()')).includes('_碎片') &&
      !(await exec('window.__cwTest.shelfTitles()')).includes(fragDir)
  );

  // 47b. 第二条：Ctrl+Enter 保存；空内容不写盘
  await exec('window.__cwTest.openFragmentDialog()');
  await exec("window.__cwTest.setFragmentText('第三条')");
  await exec(
    "document.getElementById('fragment-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))"
  );
  await waitFor('window.__cwTest.fragmentDialogOpen() === false');
  check(
    '灵感箱：Ctrl+Enter 保存第二条，当天序号递增为 -2',
    (await fileExists(path.join(fragDir, `${fragStamp}-2.txt`))) === true &&
      (await fs.readFile(path.join(fragDir, `${fragStamp}-2.txt`), 'utf8')) === '第三条'
  );
  await exec('window.__cwTest.openFragmentDialog()');
  await exec("window.__cwTest.setFragmentText('   \\n\\t  ')");
  const fragEmptySave = await exec('window.__cwTest.saveFragment()');
  const fragDirAfterEmpty = (await fs.readdir(fragDir)).filter((name) => /\.txt$/i.test(name)).sort();
  check(
    '灵感箱：空白内容被拦下，不写空文件',
    fragEmptySave &&
      fragEmptySave.ok === false &&
      fragEmptySave.message.includes('空的') &&
      fragDirAfterEmpty.length === 2 &&
      (await exec('window.__cwTest.fragmentDialogOpen()')) === true
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  check('灵感箱：Esc 关闭记录框', (await exec('window.__cwTest.fragmentDialogOpen()')) === false);

  // 47c. 写作页「插入碎片…」：列表最新在前、预览只读、按打开面板前的位置插入（不写盘）
  await exec("window.__cwTest.newBook('灵感箱测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const fragBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('开头。结尾。')");
  await exec('window.__cwTest.save()');
  // 再加一章：后面要验证「插入只改编辑区」时，靠切章丢弃未保存内容并从磁盘重新读回来
  await exec("window.__cwTest.newChapter('第二章')");
  await waitFor("window.__cwTest.currentTitle().includes('第二章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");
  await exec('window.__cwTest.setCaret(3)');
  const fragMetaBeforeParsed = await storage.readBookMeta(fragBookPath);
  const fragChaptersBefore = JSON.stringify(fragMetaBeforeParsed.chapters);
  const fragDiskBefore = await fs.readFile(
    path.join(fragBookPath, fragMetaBeforeParsed.chapters[0].file),
    'utf8'
  );
  check(
    '灵感箱：写作页顶栏有「插入碎片…」按钮',
    (await exec("document.getElementById('btn-insert-fragment').textContent")) === '插入碎片…'
  );
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor(
    'window.__cwTest.insertFragmentDialogOpen() && window.__cwTest.fragmentRowCount() === 2 && window.__cwTest.fragmentSelectedName() !== ""'
  );
  check(
    '灵感箱：插入面板列出 _碎片 里的 txt（最新在前）并自动预览第一条',
    (await exec('window.__cwTest.fragmentSummary()')).includes('共 2 条碎片') &&
      (await exec('window.__cwTest.fragmentList()')).map((item) => item.name).join(',') ===
        `${fragStamp}-2.txt,${fragStamp}-1.txt` &&
      (await exec('window.__cwTest.fragmentSelectedName()')) === `${fragStamp}-2.txt` &&
      (await exec('window.__cwTest.fragmentPreviewText()')) === '第三条' &&
      (await exec('window.__cwTest.fragmentInsertDisabled()')) === false
  );
  check(
    '灵感箱：插入面板显示插入位置（打开面板前的光标处）',
    (await exec('window.__cwTest.fragmentHint()')).includes('第 4 字'),
    await exec('window.__cwTest.fragmentHint()')
  );
  await exec('window.__cwTest.clickFragmentRow(1)');
  await waitFor(`window.__cwTest.fragmentSelectedName() === ${JSON.stringify(`${fragStamp}-1.txt`)}`);
  check(
    '灵感箱：点另一条会切换预览，内容只读展示',
    (await exec('window.__cwTest.fragmentPreviewText()')) === '第一段\n第二段' &&
      (await exec('window.__cwTest.fragmentPreviewName()')).includes('6 字')
  );
  const fragInsertResult = await exec('window.__cwTest.insertSelectedFragment()');
  const fragTextAfterInsert = await exec('window.__cwTest.text()');
  const fragDiskAfterInsert = await fs.readFile(
    path.join(fragBookPath, (await storage.readBookMeta(fragBookPath)).chapters[0].file),
    'utf8'
  );
  check(
    '灵感箱：碎片插到打开面板前的光标处（开头。|结尾。），面板关闭',
    fragInsertResult &&
      fragInsertResult.ok === true &&
      fragTextAfterInsert === '开头。第一段\n第二段结尾。' &&
      (await exec('window.__cwTest.insertFragmentDialogOpen()')) === false,
    { result: fragInsertResult, text: fragTextAfterInsert }
  );
  check(
    '灵感箱：插入后仍是未保存，磁盘正文没变，原碎片文件还在',
    (await exec('window.__cwTest.dirty()')) === true &&
      fragDiskAfterInsert === fragDiskBefore &&
      (await fileExists(fragFirstPath)) &&
      (await fs.readFile(fragFirstPath, 'utf8')) === '第一段\r\n第二段' &&
      (await fs.readFile(path.join(fragDir, `${fragStamp}-2.txt`), 'utf8')) === '第三条'
  );
  check(
    '灵感箱：插入后光标落在插入内容的末尾',
    (await exec('window.__cwTest.selection()')).start === 3 + '第一段\n第二段'.length,
    await exec('window.__cwTest.selection()')
  );

  // 47d. 有选区时用碎片替换选区；原碎片仍然保留
  await exec('window.__cwTest.setCaret(0)');
  await exec(
    "const el = document.getElementById('editor'); el.focus(); el.setSelectionRange(0, 3);"
  );
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.fragmentSelectedName() !== ""');
  await exec('window.__cwTest.clickFragmentRow(0)');
  await waitFor(`window.__cwTest.fragmentSelectedName() === ${JSON.stringify(`${fragStamp}-2.txt`)}`);
  const fragReplaceResult = await exec('window.__cwTest.insertSelectedFragment()');
  check(
    '灵感箱：有选区时用碎片替换选中的文字（只改编辑区）',
    fragReplaceResult &&
      fragReplaceResult.ok === true &&
      (await exec('window.__cwTest.text()')) === '第三条第一段\n第二段结尾。' &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await fs.readFile(path.join(fragDir, `${fragStamp}-2.txt`), 'utf8')) === '第三条'
  );
  // 插入不写盘：切到第 2 章再切回来，未保存的插入内容被丢弃，正文 / 书目 chapters 与插入前一致
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");
  const fragMetaAfterParsed = await storage.readBookMeta(fragBookPath);
  check(
    '灵感箱：插入过程没有写章节 txt / 书目.json，也没生成 _trash',
    (await exec('window.__cwTest.text()')) === '开头。结尾。' &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await fs.readFile(
        path.join(fragBookPath, fragMetaAfterParsed.chapters[0].file),
        'utf8'
      )) === fragDiskBefore &&
      JSON.stringify(fragMetaAfterParsed.chapters) === fragChaptersBefore &&
      !(await fileExists(path.join(fragBookPath, '_trash')))
  );

  // 47e. 自己放进 _碎片 的普通 txt 也能插入；刷新只读
  await fs.writeFile(path.join(fragDir, '手工碎片.txt'), '手工放进来的灵感', 'utf8');
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.fragmentRowCount() === 3');
  const fragManual = await exec('window.__cwTest.refreshFragments()');
  check(
    '灵感箱：直接放进 _碎片 的 txt 也会列出来（不需要应用生成）',
    fragManual &&
      fragManual.ok === true &&
      fragManual.total === 3 &&
      (await exec('window.__cwTest.fragmentRowTexts()')).some((text) => text.includes('手工碎片.txt'))
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  check(
    '灵感箱：Esc 关闭插入面板，正文与磁盘都不变',
    (await exec('window.__cwTest.insertFragmentDialogOpen()')) === false &&
      (await exec('window.__cwTest.text()')) === '开头。结尾。'
  );

  // 47f. 旧数据兼容：v0.4.1 形状的书照常打开 / 插入碎片，书目不被补字段
  await exec("window.__cwTest.newBook('灵感箱旧书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const fragLegacyBookPath = await exec('window.__cwTest.bookPathValue()');
  const fragLegacyMetaPath = path.join(fragLegacyBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('旧书正文。')");
  await exec('window.__cwTest.save()');
  const fragLegacyRaw = JSON.parse(await fs.readFile(fragLegacyMetaPath, 'utf8'));
  delete fragLegacyRaw.schemaVersion;
  for (const chapter of fragLegacyRaw.chapters) {
    delete chapter.status;
    delete chapter.note;
  }
  await fs.writeFile(fragLegacyMetaPath, JSON.stringify(fragLegacyRaw, null, 2), 'utf8');
  const fragLegacyBefore = await fs.readFile(fragLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.setCaret(0)');
  await exec('window.__cwTest.openInsertFragmentDialog()');
  await waitFor('window.__cwTest.fragmentRowCount() === 3 && window.__cwTest.fragmentSelectedName() !== ""');
  // 这时最新的是手工放进去的 txt，用名字明确选当天第 2 条，别依赖列表下标
  await exec(`window.__cwTest.selectFragmentByName(${JSON.stringify(`${fragStamp}-2.txt`)})`);
  await waitFor(`window.__cwTest.fragmentSelectedName() === ${JSON.stringify(`${fragStamp}-2.txt`)}`);
  const fragLegacyInsert = await exec('window.__cwTest.insertSelectedFragment()');
  const fragLegacyAfter = await fs.readFile(fragLegacyMetaPath, 'utf8');
  check(
    '灵感箱：没有 schemaVersion 的旧书照常打开、插入碎片，书目不被补字段',
    (await exec('window.__cwTest.currentTitle()')).includes('起风') &&
      fragLegacyInsert &&
      fragLegacyInsert.ok === true &&
      (await exec('window.__cwTest.text()')) === '第三条旧书正文。' &&
      fragLegacyAfter === fragLegacyBefore &&
      fragLegacyAfter.includes('"schemaVersion"') === false,
    { text: await exec('window.__cwTest.text()') }
  );
  // 回到磁盘内容（single chapter 没法靠切章丢弃，直接把编辑区恢复成 baseText，仍是未保存状态清零）
  await exec("window.__cwTest.setText('旧书正文。')");
  await exec('window.__cwTest.refreshShelf()');
  // _碎片 全程只有 3 个 txt，没有临时文件残留；书架书目数量 / 书卡都没被碎片影响
  const fragFinalNames = (await fs.readdir(fragDir)).filter((name) => /\.txt$/i.test(name)).sort();
  check(
    '灵感箱：_碎片 里只有 3 条 txt，没有原子写临时文件残留，书架书目数量不变',
    fragFinalNames.length === 3 &&
      (await fs.readdir(fragDir)).every((name) => !name.startsWith('.')) &&
      (await exec('window.__cwTest.shelfTitles()')).length === fragBookCountBefore + 2,
    { names: fragFinalNames, books: await exec('window.__cwTest.shelfTitles()') }
  );

  // 48. 敏感词预检（v0.7-3，提案 5.2）：词表归作者管理、应用不内置词表；只报告、不改动、不写盘
  const sensitiveDir = path.join(userData, '敏感词');
  await fs.mkdir(sensitiveDir, { recursive: true });
  const sensitiveWordsPath = path.join(sensitiveDir, '我的词表.txt');
  await fs.writeFile(sensitiveWordsPath, '色情\r\n暴力\r\n色情\r\n\r\n', 'utf8');
  const sensitiveWordsBytesBefore = await fs.readFile(sensitiveWordsPath);
  const sensitiveWordsStatBefore = await fs.stat(sensitiveWordsPath);

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const sensitiveSetPath = await exec(
    `window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveWordsPath)})`
  );
  const sensitiveCfgDisk = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '敏感词预检：词表路径真的落进 config.json',
    sensitiveSetPath === sensitiveWordsPath && sensitiveCfgDisk.sensitiveWordsPath === sensitiveWordsPath,
    { set: sensitiveSetPath, disk: sensitiveCfgDisk.sensitiveWordsPath }
  );

  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  // 词表状态是异步读回来的，等它显示出来再断言
  await waitFor("window.__cwTest.sensitiveSettingsStatus().includes('2 个词')");
  check(
    '敏感词预检：设置里显示词表路径、词数与跳过的重复行',
    (await exec('window.__cwTest.sensitiveSettingsVisible()')) === true &&
      (await exec('window.__cwTest.sensitiveSettingsPath()')) === sensitiveWordsPath &&
      (await exec('window.__cwTest.sensitiveSettingsStatus()')).includes('2 个词') &&
      (await exec('window.__cwTest.sensitiveSettingsStatus()')).includes('1 个重复'),
    await exec('window.__cwTest.sensitiveSettingsStatus()')
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  // 48b. 当前章预检：命中词、行号列号、上下文；点结果只改选区、不改正文
  await exec("window.__cwTest.newBook('敏感词测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const sensitiveBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  const sensitiveChapterOne = '第一行没有。\n第二行有色情和暴力。\n第三行又见色情。';
  await exec(`window.__cwTest.setText(${JSON.stringify(sensitiveChapterOne)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('夜雨')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await exec("window.__cwTest.setText('这里只有暴力。')");
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");

  // 写作页的「设置」是按书设置：词表是全局的，不该在这里出现
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '敏感词预检：写作页的按书设置里不显示全局词表',
    (await exec('window.__cwTest.sensitiveSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  const sensitiveMetaBefore = await storage.readBookMeta(sensitiveBookPath);
  const sensitiveChaptersBefore = JSON.stringify(sensitiveMetaBefore.chapters);
  const sensitiveStatsBefore = [];
  for (const chapter of sensitiveMetaBefore.chapters) {
    const stat = await fs.stat(path.join(sensitiveBookPath, chapter.file));
    sensitiveStatsBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  check(
    '敏感词预检：导出菜单里有「敏感词预检…」入口',
    (await exec('window.__cwTest.exportMenuTexts()')).includes('敏感词预检…')
  );
  await exec(
    "document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action=\"sensitive\"]').click()"
  );
  await waitFor("window.__cwTest.sensitivePanelOpen() === true");
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章命中 3 处')");
  const sensitiveCurrent = await exec('window.__cwTest.sensitivePayload()');
  check(
    '敏感词预检：打开面板自动检查当前章（3 处、2 个词、词表 2 个词）',
    sensitiveCurrent &&
      sensitiveCurrent.ok === true &&
      sensitiveCurrent.scope === 'current' &&
      sensitiveCurrent.total === 3 &&
      sensitiveCurrent.wordHitCount === 2 &&
      JSON.stringify(sensitiveCurrent.byWord.map((item) => [item.word, item.count])) ===
        JSON.stringify([
          ['色情', 2],
          ['暴力', 1]
        ]) &&
      (await exec('window.__cwTest.sensitiveWordListText()')).includes('2 个词') &&
      (await exec('window.__cwTest.sensitiveRowCount()')) === 3,
    sensitiveCurrent
  );
  const sensitiveRowTexts = await exec('window.__cwTest.sensitiveRowTexts()');
  check(
    '敏感词预检：结果行带命中词、行号列号与上下文',
    sensitiveRowTexts[0].includes('「色情」') &&
      sensitiveRowTexts[0].includes('第 2 行 · 第 5 字') &&
      sensitiveRowTexts[0].includes('第二行有') &&
      (await exec('window.__cwTest.sensitiveWordTexts()')).join(',') === '「色情」,「暴力」,「色情」',
    sensitiveRowTexts[0]
  );
  check(
    '敏感词预检：渲染层只拿词表数量，不拿词表内容',
    sensitiveCurrent.wordList &&
      sensitiveCurrent.wordList.count === 2 &&
      sensitiveCurrent.wordList.words === undefined
  );
  await exec('window.__cwTest.clickSensitiveRow(0)');
  await waitFor('window.__cwTest.sensitivePanelOpen() === false');
  check(
    '敏感词预检：点结果定位到命中位置（只选中，不改正文）',
    (await exec('window.__cwTest.selectionText()')) === '色情' &&
      (await exec('window.__cwTest.selection()')).start === 11 &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  const sensitiveStatsAfterCurrent = [];
  for (const item of sensitiveStatsBefore) {
    const stat = await fs.stat(path.join(sensitiveBookPath, item.file));
    sensitiveStatsAfterCurrent.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '敏感词预检：当前章扫描只读（txt 大小+mtime、书目、无 _trash 都没变）',
    JSON.stringify(sensitiveStatsAfterCurrent) === JSON.stringify(sensitiveStatsBefore) &&
      JSON.stringify((await storage.readBookMeta(sensitiveBookPath)).chapters) === sensitiveChaptersBefore &&
      !(await fileExists(path.join(sensitiveBookPath, '_trash')))
  );

  // 48c. 整本预检：跨章命中、带章名；点第 2 章的结果会切章并选中
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章命中 3 处')");
  await exec("window.__cwTest.setSensitiveScope('book')");
  const sensitiveBookRun = await exec('window.__cwTest.sensitiveRun()');
  const sensitiveBookPayload = await exec('window.__cwTest.sensitivePayload()');
  check(
    '敏感词预检：整本命中 4 处、涉及 2 章、2 个词',
    sensitiveBookRun &&
      sensitiveBookRun.ok === true &&
      sensitiveBookPayload.scope === 'book' &&
      sensitiveBookPayload.total === 4 &&
      sensitiveBookPayload.chapterCount === 2 &&
      sensitiveBookPayload.chapterHitCount === 2 &&
      sensitiveBookPayload.wordHitCount === 2 &&
      (await exec('window.__cwTest.sensitiveSummary()')).includes(
        '全书 2 章命中 4 处，涉及 2 章、2 个词'
      ),
    sensitiveBookPayload
  );
  const sensitiveBookRows = await exec('window.__cwTest.sensitiveRowTexts()');
  check(
    '敏感词预检：整本结果带章名（第1章 3 条 / 第2章 1 条）',
    sensitiveBookRows.filter((text) => text.includes('第1章：起风')).length === 3 &&
      sensitiveBookRows.filter((text) => text.includes('第2章：夜雨')).length === 1,
    sensitiveBookRows
  );
  const sensitiveNightIndex = sensitiveBookPayload.matches.findIndex((match) => match.chapterIndex === 1);
  check('敏感词预检：整本结果里能找到第 2 章的命中', sensitiveNightIndex >= 0, sensitiveNightIndex);
  await exec(`window.__cwTest.clickSensitiveRow(${sensitiveNightIndex})`);
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await waitFor('window.__cwTest.sensitivePanelOpen() === false');
  check(
    '敏感词预检：点整本结果会切章并选中命中的词',
    (await exec('window.__cwTest.selectionText()')) === '暴力' &&
      (await exec('window.__cwTest.currentTitle()')).includes('夜雨')
  );

  // 48d. 当前章未保存的内容参与检查，但绝不写盘
  await exec("window.__cwTest.setText('这里只有暴力。另外加了色情。')");
  check('敏感词预检：先制造未保存修改', (await exec('window.__cwTest.dirty()')) === true);
  await exec("window.__cwTest.setSensitiveScope('current')");
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章命中 2 处')");
  const sensitiveUnsaved = await exec('window.__cwTest.sensitivePayload()');
  const sensitiveDiskDuringUnsaved = await fs.readFile(
    path.join(sensitiveBookPath, sensitiveMetaBefore.chapters[1].file),
    'utf8'
  );
  check(
    '敏感词预检：未保存的内容参与检查，但磁盘正文没变',
    sensitiveUnsaved.total === 2 && sensitiveDiskDuringUnsaved === '这里只有暴力。'
  );
  await exec('window.__cwTest.closeSensitivePanel()');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  check(
    '敏感词预检：丢弃未保存内容后读到磁盘旧正文',
    (await exec('window.__cwTest.text()')) === '这里只有暴力。'
  );

  // 48e. 词表出问题要说清楚（不存在 / 编码异常 / 空词表），应用照常可用
  const sensitiveMovedPath = `${sensitiveWordsPath}.moved`;
  await fs.rename(sensitiveWordsPath, sensitiveMovedPath);
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('词表文件不存在')");
  check(
    '敏感词预检：词表文件不存在时明确提示，不误报',
    (await exec('window.__cwTest.sensitiveRowCount()')) === 0 &&
      (await exec('window.__cwTest.sensitiveWordListText()')).includes('不存在') &&
      (await exec('window.__cwTest.sensitivePayload()')) === null
  );
  await exec('window.__cwTest.closeSensitivePanel()');
  await fs.rename(sensitiveMovedPath, sensitiveWordsPath);

  const sensitiveBadPath = path.join(sensitiveDir, '伪装词表.txt');
  await fs.writeFile(sensitiveBadPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  await exec(`window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveBadPath)})`);
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('不像是纯文本')");
  check(
    '敏感词预检：词表编码异常（二进制）有明确提示',
    (await exec('window.__cwTest.sensitiveRowCount()')) === 0 &&
      (await exec('window.__cwTest.sensitiveWordListText()')).includes('UTF-8')
  );
  await exec('window.__cwTest.closeSensitivePanel()');

  const sensitiveEmptyPath = path.join(sensitiveDir, '空词表.txt');
  await fs.writeFile(sensitiveEmptyPath, '\r\n\r\n   \r\n', 'utf8');
  await exec(`window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveEmptyPath)})`);
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('没有有效的词')");
  check(
    '敏感词预检：空词表有明确提示',
    (await exec('window.__cwTest.sensitiveRowCount()')) === 0
  );
  await exec('window.__cwTest.closeSensitivePanel()');
  // 恢复成可用词表，并确认配置也跟着恢复
  await exec(`window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveWordsPath)})`);
  const sensitiveCfgAfter = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const sensitiveWordsBytesAfter = await fs.readFile(sensitiveWordsPath);
  const sensitiveWordsStatAfter = await fs.stat(sensitiveWordsPath);
  check(
    '敏感词预检：词表文件只读（字节与修改时间都没变），配置路径恢复',
    sensitiveWordsBytesAfter.equals(sensitiveWordsBytesBefore) &&
      sensitiveWordsStatAfter.mtimeMs === sensitiveWordsStatBefore.mtimeMs &&
      sensitiveCfgAfter.sensitiveWordsPath === sensitiveWordsPath
  );

  // 48f. 旧数据兼容：v0.4.1 形状的书（没有 schemaVersion）照常预检，书目不被补字段
  const sensitiveLegacyMetaPath = path.join(fragLegacyBookPath, '书目.json');
  const sensitiveLegacyBefore = await fs.readFile(sensitiveLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章没有命中')");
  const sensitiveLegacyAfter = await fs.readFile(sensitiveLegacyMetaPath, 'utf8');
  check(
    '敏感词预检：没有 schemaVersion 的旧书照常预检，书目不被补字段',
    sensitiveLegacyAfter === sensitiveLegacyBefore &&
      sensitiveLegacyAfter.includes('"schemaVersion"') === false &&
      (await exec('window.__cwTest.sensitivePayload()')).total === 0
  );

  // 48g. Esc 关闭面板
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor('window.__cwTest.sensitivePanelOpen() === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check(
    '敏感词预检：Esc 关闭面板',
    (await exec('window.__cwTest.sensitivePanelOpen()')) === false
  );

  // 49. 朗读本章（v0.7-3，提案 5.3）：系统语音只读正文、不改字、不写盘。
  // E2E 换假语音引擎（ttsInstallFakeSpeech），不依赖机器装没装语音，也不会真的出声。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('朗读测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const ttsBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  const ttsChapterOne =
    '　　雨停的时候，灯塔的光扫过海面。\n\n　　看守人把旧钟擦了一遍。\n\n　　“你听见了吗？”他问。\n\n　　远处只有浪声。';
  await exec(`window.__cwTest.setText(${JSON.stringify(ttsChapterOne)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('夜雨')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await exec(`window.__cwTest.setText('　　夜里的雨点敲在铁皮屋顶上。\\n\\n　　他翻到最后一页。')`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");

  const ttsMetaBefore = await storage.readBookMeta(ttsBookPath);
  const ttsChaptersBefore = JSON.stringify(ttsMetaBefore.chapters);
  const ttsStatsBefore = [];
  for (const chapter of ttsMetaBefore.chapters) {
    const stat = await fs.stat(path.join(ttsBookPath, chapter.file));
    ttsStatsBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  check(
    '朗读：写作页顶栏有「朗读」按钮',
    (await exec("document.getElementById('btn-tts').textContent")) === '朗读'
  );
  check(
    '朗读：Electron 里有系统语音接口（真机窗口不需要额外依赖）',
    (await exec('window.__cwTest.ttsSupported()')) === true
  );

  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor('window.__cwTest.ttsChunks().length > 0');
  const ttsChunks = await exec('window.__cwTest.ttsChunks()');
  check(
    '朗读：按自然段切分（4 段、位置与编辑区一致、首尾空白不进朗读）',
    ttsChunks.length === 4 &&
      ttsChunks.every((chunk) => ttsChapterOne.slice(chunk.start, chunk.end) === chunk.text) &&
      ttsChunks[0].text === '雨停的时候，灯塔的光扫过海面。' &&
      ttsChunks[1].paragraph === 2 &&
      ttsChunks[3].text === '远处只有浪声。',
    ttsChunks
  );
  const ttsFirstSpeech = await exec('window.__cwTest.ttsFakeState()');
  check(
    '朗读：打开后从第一段开始念（刚载入时光标在全文末尾，按从头念）',
    (await exec('window.__cwTest.ttsIndex()')) === 0 &&
      ttsFirstSpeech.last &&
      ttsFirstSpeech.last.text === ttsChunks[0].text &&
      (await exec('window.__cwTest.ttsStatus()')) === 'playing' &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('正在朗读 第 1/4 段'),
    ttsFirstSpeech
  );
  check(
    '朗读：小条显示当前段落预览（只显示文字，不改正文）',
    (await exec('window.__cwTest.ttsPreviewText()')).includes('雨停的时候') &&
      (await exec('window.__cwTest.ttsPreviewTitle()')) === ttsChunks[0].text
  );

  // 49b. 一段读完自动接下一段；暂停 / 继续；上一段 / 下一段；语速 / 语音；跟随高亮
  await exec('window.__cwTest.ttsFakeFinish()');
  await waitFor('window.__cwTest.ttsIndex() === 1');
  const ttsSecondSpeech = await exec('window.__cwTest.ttsFakeState()');
  check(
    '朗读：一段读完自动接下一段',
    ttsSecondSpeech.last.text === ttsChunks[1].text &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('第 2/4 段')
  );
  await exec("document.getElementById('btn-tts-play').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'paused'");
  check(
    '朗读：暂停（引擎暂停、按钮变回「播放」、状态显示已暂停）',
    (await exec('window.__cwTest.ttsFakeState()')).paused === true &&
      (await exec('window.__cwTest.ttsPlayLabel()')) === '▶ 播放' &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('已暂停')
  );
  await exec("document.getElementById('btn-tts-play').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  check(
    '朗读：继续（引擎 resume、按钮变回「暂停」）',
    (await exec('window.__cwTest.ttsFakeState()')).paused === false &&
      (await exec('window.__cwTest.ttsPlayLabel()')) === '⏸ 暂停'
  );
  await exec("document.getElementById('btn-tts-next').click()");
  await waitFor('window.__cwTest.ttsIndex() === 2');
  check(
    '朗读：下一段按钮跳段并继续念',
    (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[2].text
  );
  await exec("document.getElementById('btn-tts-prev').click()");
  await waitFor('window.__cwTest.ttsIndex() === 1');
  check(
    '朗读：上一段按钮跳回上一段',
    (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[1].text
  );
  await exec(
    "(() => { const el = document.getElementById('tts-rate'); el.value = '1.5'; el.dispatchEvent(new Event('change', { bubbles: true })); })()"
  );
  await waitFor('window.__cwTest.ttsRate() === 1.5');
  check(
    '朗读：语速改变后当前段用新语速重念',
    (await exec('window.__cwTest.ttsFakeState()')).last.rate === 1.5
  );
  const ttsVoiceOptions = await exec('window.__cwTest.ttsVoiceOptions()');
  check(
    '朗读：语音下拉列出系统语音（默认 + 各语音）',
    ttsVoiceOptions[0] === '系统默认' && ttsVoiceOptions.some((text) => text.includes('测试语音 A'))
  );
  await exec(
    "(() => { const el = document.getElementById('tts-voice'); el.value = 'fake-voice-b'; el.dispatchEvent(new Event('change', { bubbles: true })); })()"
  );
  await waitFor("window.__cwTest.ttsVoice() === 'fake-voice-b'");
  check(
    '朗读：换语音后按所选语音重念',
    (await exec('window.__cwTest.ttsFakeState()')).last.voiceURI === 'fake-voice-b'
  );
  await exec("document.getElementById('tts-follow').click();");
  await waitFor('window.__cwTest.ttsFollowState() === true');
  check(
    '朗读：开启跟随高亮会选中当前段落（只改选区，不改文字）',
    (await exec('window.__cwTest.selectionText()')) === ttsChunks[1].text &&
      (await exec('window.__cwTest.text()')) === ttsChapterOne &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  await exec('window.__cwTest.ttsFakeFinish()');
  await waitFor('window.__cwTest.ttsIndex() === 2');
  check(
    '朗读：跟随高亮随朗读推进到下一段',
    (await exec('window.__cwTest.selectionText()')) === ttsChunks[2].text
  );

  // 49c. 停止 / 再播放 / 出错提示
  await exec("document.getElementById('btn-tts-stop').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'idle'");
  check(
    '朗读：停止后不再念（引擎取消、状态「已停止」）',
    (await exec('window.__cwTest.ttsFakeState()')).hasPending === false &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('已停止')
  );
  await exec("document.getElementById('btn-tts-play').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  check(
    '朗读：停止后再点播放从当前段继续',
    (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[2].text
  );
  await exec('window.__cwTest.ttsFakeError()');
  await waitFor('window.__cwTest.ttsStatusError() === true');
  check(
    '朗读：系统语音报错时有明确的中文提示',
    (await exec('window.__cwTest.ttsStatus()')) === 'error' &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('系统语音出错')
  );

  // 49d. 从光标处开始念；Esc 停止并收起
  await exec('window.__cwTest.ttsClose()');
  await waitFor('window.__cwTest.ttsBarOpen() === false');
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec(`window.__cwTest.ttsSetCaret(${Number(ttsChunks[3].start)})`);
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  check(
    '朗读：从光标所在段落开始念（不是永远从头念）',
    (await exec('window.__cwTest.ttsIndex()')) === 3 &&
      (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[3].text
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.ttsBarOpen() === false');
  check(
    '朗读：Esc 停止并收起朗读条',
    (await exec('window.__cwTest.ttsStatus()')) === 'idle'
  );

  // 49e. 编辑正文会立刻停止朗读（避免拿旧段落继续念）
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  await exec(`window.__cwTest.setText(${JSON.stringify('　　改了一个字。')})`);
  await waitFor('window.__cwTest.ttsBarOpen() === false');
  check(
    '朗读：编辑正文会立刻停止并收起朗读条（不拿旧段落继续念）',
    (await exec('window.__cwTest.ttsStatus()')) === 'idle' &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.ttsFakeState()')).hasPending === false
  );
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await exec('window.__cwTest.switchTo(0)');
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(ttsChapterOne)}`);

  // 49f. 全程只读：txt 大小 + mtime、书目 chapters、无 _trash 都没变
  const ttsStatsAfter = [];
  for (const item of ttsStatsBefore) {
    const stat = await fs.stat(path.join(ttsBookPath, item.file));
    ttsStatsAfter.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '朗读：全程只读正文（txt 大小+mtime、书目 chapters、无 _trash 都没变）',
    JSON.stringify(ttsStatsAfter) === JSON.stringify(ttsStatsBefore) &&
      JSON.stringify((await storage.readBookMeta(ttsBookPath)).chapters) === ttsChaptersBefore &&
      !(await fileExists(path.join(ttsBookPath, '_trash')))
  );

  // 49g. 切章停止；空章节有明确提示
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  await exec("window.__cwTest.switchTo(1)");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  check(
    '朗读：切章会停止朗读并收起小条',
    (await exec('window.__cwTest.ttsBarOpen()')) === false &&
      (await exec('window.__cwTest.ttsStatus()')) === 'idle'
  );
  await exec("window.__cwTest.newChapter('空章')");
  await waitFor("window.__cwTest.currentTitle().includes('空章')");
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'error'");
  check(
    '朗读：空章节明确提示「没有可朗读的正文」，不会开始念',
    (await exec('window.__cwTest.ttsStatusText()')).includes('没有可朗读的正文') &&
      (await exec('window.__cwTest.ttsFakeState()')).spoken.length === 0
  );
  await exec('window.__cwTest.ttsClose()');

  // 49h. 旧数据兼容：v0.4.1 形状的书（没有 schemaVersion）照常朗读，书目不被补字段
  const ttsLegacyMetaPath = path.join(fragLegacyBookPath, '书目.json');
  const ttsLegacyBefore = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  const ttsLegacyChunks = await exec('window.__cwTest.ttsChunks()');
  const ttsLegacyAfter = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  check(
    '朗读：没有 schemaVersion 的旧书照常朗读，书目不被补字段',
    ttsLegacyChunks.length > 0 &&
      ttsLegacyAfter === ttsLegacyBefore &&
      ttsLegacyAfter.includes('"schemaVersion"') === false
  );
  await exec('window.__cwTest.ttsClose()');

  // 50. 编辑器小件（v0.7-4，提案 4.1）：选中字数 / 超长段落提示 / 不可见字符 ␣ / Alt+↑↓ 段落导航 / 章节字数对比。
  // 全部只读、可开关：标记只画在 #editor-marks 影子层上，正文 txt 一个字节都不动、不写盘。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('编辑器小件测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const marksBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '长段')");
  const marksLongStartText = '他沿着堤岸往回走，风把衣角吹得猎猎作响。';
  const marksLongParagraph = `　　${marksLongStartText.repeat(55)}`;
  const marksText = [
    '　　开头一段，有全角空格和行尾空白。  ',
    marksLongParagraph,
    '　　结尾一段。'
  ].join('\n');
  await exec(`window.__cwTest.setText(${JSON.stringify(marksText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('短章')");
  await waitFor("window.__cwTest.currentTitle().includes('短章')");
  const marksShortText = '　　这一章很短。\n\n　　只有两段。';
  await exec(`window.__cwTest.setText(${JSON.stringify(marksShortText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");

  const marksExpectedOne = chaptersLib.countChars(marksText);
  const marksExpectedTwo = chaptersLib.countChars(marksShortText);
  const marksChapterChars = await exec('window.__cwTest.chapterCharsTexts()');
  check(
    '编辑器小件：章节列表每项显示字数（保存后跟书目缓存一致）',
    marksChapterChars.length === 2 &&
      marksChapterChars[0] === String(marksExpectedOne) &&
      marksChapterChars[1] === String(marksExpectedTwo),
    marksChapterChars
  );
  check(
    '编辑器小件：这一章比上一章短很多时，状态栏给「比上章短」软提示',
    (await exec('window.__cwTest.charCountWarn()')) === true &&
      (await exec('window.__cwTest.charCountText()')).includes('比上章短')
  );
  check(
    '编辑器小件：章节条目 tooltip 也写明「比上章短」（只提示，不改任何东西）',
    (await exec('window.__cwTest.chapterItemTitles()'))[1].includes('比上章短')
  );

  await exec('window.__cwTest.switchTo(0)');
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(marksText)}`);
  const marksMetaBefore = JSON.stringify((await storage.readBookMeta(marksBookPath)).chapters);
  const marksTxtBefore = [];
  for (const chapter of JSON.parse(marksMetaBefore)) {
    const stat = await fs.stat(path.join(marksBookPath, chapter.file));
    marksTxtBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 50b. 「排版 ▾」里的两个开关：打开后标记层显示，正文不动
  await exec('window.__cwTest.openFormatMenu()');
  const marksMenuTexts = await exec(
    "Array.from(document.querySelectorAll('#format-menu button')).map((el) => el.textContent)"
  );
  check(
    '编辑器小件：「排版 ▾」菜单里有「显示不可见字符」「超长段落提示」两个开关',
    marksMenuTexts.some((text) => text.includes('显示不可见字符')) &&
      marksMenuTexts.some((text) => text.includes('超长段落提示'))
  );
  await exec(
    `document.querySelector('#format-menu button[data-action="toggle-invisibles"]').click()`
  );
  await waitFor('window.__cwTest.marksFlags().invisibles === true');
  check(
    '编辑器小件：打开「不可见字符」后标记层显示，正文仍是干净状态',
    (await exec('window.__cwTest.marksOverlayVisible()')) === true &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  await exec('window.__cwTest.openFormatMenu()');
  await exec(
    `document.querySelector('#format-menu button[data-action="toggle-long-para"]').click()`
  );
  await waitFor('window.__cwTest.marksFlags().longParagraphs === true');
  await exec('window.__cwTest.openFormatMenu()');
  const marksCheckedMenu = await exec(
    "Array.from(document.querySelectorAll('#format-menu button[data-on=\"1\"]')).map((el) => el.textContent)"
  );
  check(
    '编辑器小件：开着的开关在菜单里显示 ✓',
    marksCheckedMenu.length === 2 && marksCheckedMenu.every((text) => text.startsWith('✓')),
    marksCheckedMenu
  );
  await exec('window.__cwTest.openFormatMenu()'); // 收起菜单

  // 50c. 不可见字符：全角空格逐个标 ␣，行尾空白只标一处；标记层文字与正文一一对应
  check(
    '编辑器小件：全角空格逐个标 ␣、行尾空白只标一处（行尾全角空格不重复算）',
    (await exec('window.__cwTest.marksFullwidthCount()')) === 6 &&
      (await exec('window.__cwTest.marksTrailingCount()')) === 1,
    {
      fullwidth: await exec('window.__cwTest.marksFullwidthCount()'),
      trailing: await exec('window.__cwTest.marksTrailingCount()')
    }
  );
  check(
    '编辑器小件：标记层的文字与正文一一对应（只多了 ␣ / · 两个标记字符）',
    (await exec("window.__cwTest.marksText().split('␣').join('').split('·').join('')")) === marksText
  );
  const marksMetrics = await exec('window.__cwTest.marksMetrics()');
  check(
    '编辑器小件：标记层与编辑区同宽同高、字体/行高一致（标记位置对得上）',
    marksMetrics.visible &&
      Math.abs(marksMetrics.overlayWidth - marksMetrics.contentWidth) <= 0.5 &&
      Math.abs(marksMetrics.overlayScrollHeight - marksMetrics.contentHeight) <= 1 &&
      marksMetrics.editorFontFamily === marksMetrics.overlayFontFamily &&
      marksMetrics.overlayLineHeight === marksMetrics.editorLineHeight &&
      Math.abs(parseFloat(marksMetrics.overlayFontSize) - parseFloat(marksMetrics.editorFontSize)) <= 0.1,
    marksMetrics
  );

  // 50d. 超长段落：识别 1 段，左侧黄线按行画（不是只画第一行），状态栏标签可跳转
  const marksLongFragments = (await exec('window.__cwTest.longParaRects()'))[0] || [];
  check(
    '编辑器小件：超长段落识别 1 段，左侧黄线按行画出来（每行一条）',
    (await exec('window.__cwTest.marksLongParaCount()')) === 1 &&
      marksLongFragments.length >= 3 &&
      (await exec('window.__cwTest.longParaBarCount()')) === marksLongFragments.length &&
      (await exec('window.__cwTest.longParaBarRects()')).every(
        (rect) => rect.width <= 4 && rect.height > 10
      ),
    { fragments: marksLongFragments.length, bars: await exec('window.__cwTest.longParaBarCount()') }
  );
  check(
    '编辑器小件：状态栏「超长段落 1 段」标签给出段数与行号提示',
    (await exec('window.__cwTest.longParaChipVisible()')) === true &&
      (await exec('window.__cwTest.longParaChipText()')) === '超长段落 1 段' &&
      (await exec('window.__cwTest.longParaChipTitle()')).includes('第 2 行')
  );
  await exec('window.__cwTest.setCaret(0)');
  await exec('window.__cwTest.clickLongParaChip()');
  check(
    '编辑器小件：点「超长段落」标签跳到段首（只移动光标，不改字）',
    (await exec('window.__cwTest.caret()')) === marksText.indexOf(marksLongStartText)
  );

  // 50e. 选中字数：只选了文字才显示，段数按触及的非空行算
  await exec('window.__cwTest.selectRange(0, 10)');
  check(
    '编辑器小件：选中后状态栏显示「选中 N 字 / M 段」',
    (await exec('window.__cwTest.selectionStatsVisible()')) === true &&
      (await exec('window.__cwTest.selectionStatsText()')) ===
        `选中 ${chaptersLib.countChars(marksText.slice(0, 10))} 字 / 1 段`
  );
  await exec(`window.__cwTest.selectRange(0, ${marksText.length})`);
  check(
    '编辑器小件：跨 3 段选择显示 3 段（空行不算段）',
    (await exec('window.__cwTest.selectionStatsText()')) ===
      `选中 ${chaptersLib.countChars(marksText)} 字 / 3 段`
  );
  await exec('window.__cwTest.selectRange(3, 3)');
  check(
    '编辑器小件：取消选择后选中字数隐藏',
    (await exec('window.__cwTest.selectionStatsVisible()')) === false
  );

  // 50f. 段落导航：Alt+↑/↓ 在段首之间跳（跳过段首缩进）
  const marksFirstStart = marksText.indexOf('开头一段');
  const marksSecondStart = marksText.indexOf(marksLongStartText);
  const marksThirdStart = marksText.indexOf('结尾一段');
  await exec('window.__cwTest.selectRange(0, 0)');
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↓ 从章首跳到第一段段首（段首缩进之后）',
    (await exec('window.__cwTest.caret()')) === marksFirstStart
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↓ 再去下一段段首',
    (await exec('window.__cwTest.caret()')) === marksSecondStart
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↑ 回上一段段首',
    (await exec('window.__cwTest.caret()')) === marksFirstStart
  );
  await exec(`window.__cwTest.selectRange(${marksSecondStart + 5}, ${marksSecondStart + 5})`);
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：光标在段中间时 Alt+↑ 回到本段开头',
    (await exec('window.__cwTest.caret()')) === marksSecondStart
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↓ 从段首去下一段段首',
    (await exec('window.__cwTest.caret()')) === marksThirdStart
  );

  // 50g. 滚动时标记层 / 左侧黄线跟着正文走
  await exec('window.__cwTest.setEditorScroll(0)');
  const marksTopsBefore = (await exec('window.__cwTest.longParaBarRects()')).map((rect) => rect.top);
  const marksScrolled = await exec('window.__cwTest.setEditorScroll(140)');
  const marksScrollMetrics = await exec('window.__cwTest.marksMetrics()');
  const marksTopsAfter = (await exec('window.__cwTest.longParaBarRects()')).map((rect) => rect.top);
  check(
    '编辑器小件：滚动时标记层跟随，超长段落黄线跟着正文走',
    marksScrolled > 0 &&
      marksScrollMetrics.scrollLocked === true &&
      Math.abs(marksScrollMetrics.overlayScrollTop - marksScrollMetrics.editorScrollTop) < 0.5 &&
      marksTopsAfter.length === marksTopsBefore.length &&
      marksTopsAfter.every((top, index) => Math.abs(marksTopsBefore[index] - marksScrolled - top) <= 1),
    { marksScrolled, scrollLocked: marksScrollMetrics.scrollLocked }
  );
  await exec('window.__cwTest.setEditorScroll(0)');

  // 50h. 关掉开关：标记层收起，正文 / 书目 / txt 都不动
  await exec("window.__cwTest.setMarksToggle('invisibles', false)");
  check(
    '编辑器小件：关掉「不可见字符」后只剩超长段落黄线',
    (await exec('window.__cwTest.marksFullwidthCount()')) === 0 &&
      (await exec('window.__cwTest.marksTrailingCount()')) === 0 &&
      (await exec('window.__cwTest.marksLongParaCount()')) === 1 &&
      (await exec('window.__cwTest.marksOverlayVisible()')) === true
  );
  await exec("window.__cwTest.setMarksToggle('longParagraphs', false)");
  check(
    '编辑器小件：两个开关都关掉后标记层收起，正文一个字都不变',
    (await exec('window.__cwTest.marksOverlayVisible()')) === false &&
      (await exec('window.__cwTest.longParaGutterVisible()')) === false &&
      (await exec('window.__cwTest.longParaChipVisible()')) === false &&
      (await exec('window.__cwTest.text()')) === marksText &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  const marksTxtAfter = [];
  for (const item of marksTxtBefore) {
    const stat = await fs.stat(path.join(marksBookPath, item.file));
    marksTxtAfter.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '编辑器小件：全程只读（txt 大小+mtime、书目 chapters、无 _trash 都没变）',
    JSON.stringify(marksTxtAfter) === JSON.stringify(marksTxtBefore) &&
      JSON.stringify((await storage.readBookMeta(marksBookPath)).chapters) === marksMetaBefore &&
      !(await fileExists(path.join(marksBookPath, '_trash')))
  );

  // 50i. 旧数据兼容：v0.4.1 形状的老书照常显示标记，书目不被补字段
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const marksLegacyBefore = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec(
    "window.__cwTest.setMarksToggle('invisibles', true); window.__cwTest.setMarksToggle('longParagraphs', true);"
  );
  await waitFor('window.__cwTest.marksOverlayVisible() === true');
  const marksLegacyAfter = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  check(
    '编辑器小件：没有 schemaVersion 的旧书照常用标记，书目不被补字段',
    (await exec('window.__cwTest.marksLineCount()')) >= 1 &&
      marksLegacyAfter === marksLegacyBefore &&
      marksLegacyAfter.includes('"schemaVersion"') === false
  );
  await exec(
    "window.__cwTest.setMarksToggle('invisibles', false); window.__cwTest.setMarksToggle('longParagraphs', false);"
  );

  // 51. 专注模式（提案 3.5）：隐藏左栏与顶栏、F11 / 按钮进出、Esc 退出、打字机模式。
  // 全部只改显示（DOM class + textarea.scrollTop）：不改正文、不写盘、不写配置、不碰书目。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  // 书架页按 F11 不应该进专注模式（只在写作页生效）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  check(
    '专注模式：书架页按 F11 不进入专注模式（只在写作页生效）',
    (await exec('window.__cwTest.view()')) === 'shelf' &&
      (await exec('window.__cwTest.focusState()')).on === false
  );

  await exec("window.__cwTest.newBook('专注模式测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const focusBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '长夜')");
  // 80 行短句（每行都不够宽，换行不受左栏隐藏影响，便于校验滚动位置还原）
  const focusLines = [];
  for (let i = 1; i <= 80; i += 1) focusLines.push(`第${i}行：他沿着堤岸往回走，风很轻。`);
  const focusText = focusLines.join('\n');
  await exec(`window.__cwTest.setText(${JSON.stringify(focusText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  const focusNormal = await exec('window.__cwTest.focusState()');
  await exec('window.__cwTest.setCaret(0)');
  const focusScrollBefore = await exec('window.__cwTest.setEditorScroll(120)');
  check(
    '专注模式：进入前是普通写作页（左栏 / 顶栏 / 分隔条都在）',
    focusNormal.on === false &&
      focusNormal.sidebarDisplay !== 'none' &&
      focusNormal.headerDisplay !== 'none' &&
      focusNormal.resizerDisplay !== 'none' &&
      focusNormal.barVisible === false
  );

  // 只读基线：专注模式全程不应该改 config、书目、章节 txt
  const focusMetaBefore = await fs.readFile(path.join(focusBookPath, '书目.json'), 'utf8');
  const focusConfigBefore = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const focusTxtBefore = [];
  for (const chapter of JSON.parse(focusMetaBefore).chapters) {
    const stat = await fs.stat(path.join(focusBookPath, chapter.file));
    focusTxtBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 51a. 顶栏「专注」按钮进入：左栏 / 分隔条 / 顶栏收起，正文占满，极简退出条出现
  await exec("document.getElementById('btn-focus').click()");
  await waitFor('window.__cwTest.focusState().on === true');
  const focusOn = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：进入后左栏 / 分隔条 / 顶栏隐藏，正文占满，状态栏和退出条还在',
    focusOn.viewHasClass === true &&
      focusOn.bodyHasClass === true &&
      focusOn.sidebarDisplay === 'none' &&
      focusOn.resizerDisplay === 'none' &&
      focusOn.headerDisplay === 'none' &&
      focusOn.barVisible === true &&
      focusOn.statusbarDisplay !== 'none' &&
      focusOn.editorWidth >= focusNormal.editorWidth + focusNormal.sidebarWidth + 6 - 1,
    {
      editorWidth: focusOn.editorWidth,
      normalWidth: focusNormal.editorWidth,
      sidebarWidth: focusNormal.sidebarWidth
    }
  );
  check(
    '专注模式：退出条显示章名、「打字机」开关和「退出专注 Esc」',
    focusOn.focusTitle === focusOn.chapterTitle &&
      focusOn.chapterTitle.includes('长夜') &&
      focusOn.typewriterLabel === '打字机' &&
      focusOn.typewriterDataOn === '0' &&
      focusOn.exitLabel.includes('退出专注') &&
      focusOn.exitLabel.includes('Esc'),
    { title: focusOn.focusTitle, exit: focusOn.exitLabel }
  );

  // 51b. F11 再按一次退出：布局、章节栏宽度、滚动位置都复原
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  const focusOff = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：F11 再按一次退出，左栏 / 顶栏 / 分隔条原样回来',
    focusOff.viewHasClass === false &&
      focusOff.bodyHasClass === false &&
      focusOff.sidebarDisplay !== 'none' &&
      focusOff.headerDisplay !== 'none' &&
      focusOff.resizerDisplay !== 'none' &&
      focusOff.barVisible === false
  );
  check(
    '专注模式：退出后编辑区宽度 / 章节栏宽度回到原样（布局不留残迹）',
    Math.abs(focusOff.editorWidth - focusNormal.editorWidth) <= 1 &&
      Math.abs(focusOff.sidebarWidth - focusNormal.sidebarWidth) <= 1,
    { editor: focusOff.editorWidth, normal: focusNormal.editorWidth }
  );
  check(
    '专注模式：退出后滚动位置回到进入前（120px，按光标相对屏幕位置还原）',
    Math.abs(focusOff.editorScrollTop - focusScrollBefore) <= 2,
    { before: focusScrollBefore, after: focusOff.editorScrollTop }
  );

  // 51c. F11 进入、Esc 退出（真实键盘路径）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  check(
    '专注模式：写作页按 F11 进入专注模式',
    (await exec('window.__cwTest.focusState()')).barVisible === true &&
      (await exec('window.__cwTest.focusState()')).sidebarDisplay === 'none'
  );
  await exec('window.__cwTest.setEditorScroll(300)');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  const focusEscOff = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：Esc 退出并恢复普通布局与进入前的滚动位置',
    focusEscOff.viewHasClass === false &&
      focusEscOff.sidebarDisplay !== 'none' &&
      focusEscOff.barVisible === false &&
      Math.abs(focusEscOff.editorScrollTop - focusScrollBefore) <= 2,
    { scroll: focusEscOff.editorScrollTop, expected: focusScrollBefore }
  );

  // 51d. Esc 的优先级：有弹层时先关弹层，专注模式还在
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.findPanelOpen() === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.findPanelOpen() === false');
  check(
    '专注模式：弹层开着时 Esc 先关弹层，专注模式不受影响',
    (await exec('window.__cwTest.focusState()')).on === true
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  check(
    '专注模式：弹层关了再按 Esc 才退出专注模式',
    (await exec('window.__cwTest.view()')) === 'editor' &&
      (await exec('window.__cwTest.focusState()')).barVisible === false
  );

  // 51e. 打字机模式：光标行保持在正文区上方约 1/3 处
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec('window.__cwTest.setEditorScroll(0)');
  await exec('window.__cwTest.setCaret(0)');
  await exec("document.getElementById('btn-focus-typewriter').click()");
  await waitFor('window.__cwTest.focusState().typewriter === true');
  const focusTwOn = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：退出条「打字机」开关带 ✓（只记内存）',
    focusTwOn.typewriterLabel.startsWith('✓') && focusTwOn.typewriterDataOn === '1'
  );
  const focusLinePos = focusText.indexOf('第40行');
  await exec(`document.getElementById('editor').setSelectionRange(${focusLinePos}, ${focusLinePos})`);
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))"
  );
  await waitFor('window.__cwTest.focusMetrics().scrollTop > 0');
  const focusTw = await exec('window.__cwTest.focusMetrics()');
  const focusTwExpected = Math.min(
    Math.max(Math.round(focusTw.caretTop - focusTw.clientHeight / 3), 0),
    focusTw.maxScrollTop
  );
  check(
    '专注模式：打字机模式把光标行放到正文区上方约 1/3 处',
    Math.abs(focusTw.scrollTop - focusTwExpected) <= 2 &&
      Math.abs(focusTw.caretTop - focusTw.scrollTop - focusTw.clientHeight / 3) <= 2,
    {
      scrollTop: focusTw.scrollTop,
      expected: focusTwExpected,
      caretTop: focusTw.caretTop,
      clientHeight: focusTw.clientHeight
    }
  );
  await exec('window.__cwTest.setCaret(0)');
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }))"
  );
  await waitFor('window.__cwTest.focusMetrics().scrollTop === 0');
  check(
    '专注模式：光标回到章首时正文滚回顶部，不会滚出界',
    (await exec('window.__cwTest.focusMetrics()')).scrollTop === 0
  );
  await exec(`document.getElementById('editor').setSelectionRange(${focusText.length}, ${focusText.length})`);
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))"
  );
  await waitFor('window.__cwTest.focusMetrics().scrollTop > 0');
  const focusTwEnd = await exec('window.__cwTest.focusMetrics()');
  check(
    '专注模式：光标在章尾时最多滚到最底部（不会滚出正文）',
    focusTwEnd.maxScrollTop > 0 && Math.abs(focusTwEnd.scrollTop - focusTwEnd.maxScrollTop) <= 2,
    { scrollTop: focusTwEnd.scrollTop, max: focusTwEnd.maxScrollTop }
  );
  // 关掉打字机：再移动光标就不该自动滚了
  await exec("document.getElementById('btn-focus-typewriter').click()");
  await waitFor('window.__cwTest.focusState().typewriter === false');
  await exec('window.__cwTest.setEditorScroll(50)');
  await exec(`document.getElementById('editor').setSelectionRange(${focusLinePos}, ${focusLinePos})`);
  const focusTwOffBefore = await exec('window.__cwTest.focusMetrics()');
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))"
  );
  await sleep(250);
  const focusTwOffAfter = await exec('window.__cwTest.focusMetrics()');
  check(
    '专注模式：关掉「打字机」后移动光标不再自动滚动（正文没被动过）',
    Math.abs(focusTwOffAfter.scrollTop - focusTwOffBefore.scrollTop) <= 1 &&
      (await exec('window.__cwTest.text()')) === focusText
  );

  // 51f. 全程只读：config.json / 书目.json / 章节 txt 一个字节都没变（专注模式不写配置）
  const focusMetaAfter = await fs.readFile(path.join(focusBookPath, '书目.json'), 'utf8');
  const focusConfigAfter = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const focusTxtAfter = [];
  for (const item of focusTxtBefore) {
    const stat = await fs.stat(path.join(focusBookPath, item.file));
    focusTxtAfter.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '专注模式：全程只读（config.json、书目.json、章节 txt 都没变）',
    focusConfigAfter === focusConfigBefore &&
      focusMetaAfter === focusMetaBefore &&
      JSON.stringify(focusTxtAfter) === JSON.stringify(focusTxtBefore) &&
      !(await fileExists(path.join(focusBookPath, '_trash')))
  );
  check(
    '专注模式：没有把专注 / 打字机状态写进配置（开关只记内存）',
    focusConfigAfter.includes('focus') === false &&
      focusConfigAfter.includes('typewriter') === false
  );

  // 51g. 回书架自动退出专注模式；重新打开书是普通布局
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const focusShelfState = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：回书架自动退出（不留在专注布局里）',
    focusShelfState.on === false && focusShelfState.viewHasClass === false && focusShelfState.barVisible === false
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(focusBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const focusReopen = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：重新打开书是普通布局（专注模式不跨会话、不自动进入）',
    focusReopen.on === false &&
      focusReopen.sidebarDisplay !== 'none' &&
      focusReopen.headerDisplay !== 'none' &&
      focusReopen.barVisible === false
  );

  // 51h. 旧数据兼容：v0.4.1 形状（没有 schemaVersion、章节没有 status/note）的书照常进出专注模式
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const focusLegacyBefore = await fs.readFile(fragLegacyMetaPath, 'utf8');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec('window.__cwTest.focusTypewriter(true)');
  await exec('window.__cwTest.setCaret(0)');
  const focusLegacyOn = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：旧书照常进入专注模式并显示章名',
    focusLegacyOn.barVisible === true && focusLegacyOn.focusTitle === focusLegacyOn.chapterTitle
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  const focusLegacyAfter = await fs.readFile(fragLegacyMetaPath, 'utf8');
  check(
    '专注模式：旧书书目不被补 schemaVersion / 状态 / 备注（一个字节都没变）',
    focusLegacyAfter === focusLegacyBefore &&
      focusLegacyBefore.includes('"schemaVersion"') === false
  );
  await exec('window.__cwTest.focusTypewriter(false)');

  // 52. 崩溃与错误日志（提案 7.4）：主进程异常 / 未处理的 Promise / IPC 错误 / 保存失败
  // 写进 userData\logs；日志不含任何正文、写不进去也不影响写作；设置里有「打开日志文件夹」。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const logDir = path.join(userData, 'logs');
  const logNamePattern = /^chapter-writer-\d{4}-\d{2}-\d{2}(\.\d{1,3})?\.log$/;
  const readLogs = async () => {
    let names = [];
    try {
      names = await fs.readdir(logDir);
    } catch {
      return { names: [], text: '' };
    }
    const logs = names.filter((name) => logNamePattern.test(name)).sort();
    let text = '';
    for (const name of logs) {
      try {
        text += await fs.readFile(path.join(logDir, name), 'utf8');
      } catch {
        /* 正在滚动 / 被占用：下一轮再读 */
      }
    }
    return { names, text };
  };
  const waitForLog = async (needle, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      const { text } = await readLogs();
      if (text.includes(needle)) return text;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待日志超时：${needle} :: ${text.slice(-800)}`);
      }
      await sleep(120);
    }
  };

  // 52a. 启动就有一条 app-start：日志目录在 userData\logs，按天命名，只记版本 / 平台 / pid
  const logInfoResult = await exec('window.api.logInfo()');
  check(
    '诊断日志：日志目录是 userData\\logs，文件按天命名（chapter-writer-YYYY-MM-DD.log）',
    logInfoResult.ok === true &&
      logInfoResult.data.dir === logDir &&
      Array.isArray(logInfoResult.data.files) &&
      logInfoResult.data.files.length >= 1 &&
      logNamePattern.test(logInfoResult.data.files[0].name) &&
      logInfoResult.data.limits.maxFiles === 12 &&
      logInfoResult.data.limits.maxFileBytes === 256 * 1024,
    logInfoResult
  );
  const startupLogText = await waitForLog('INFO app-start');
  check(
    '诊断日志：启动记一条 info（版本 / 平台 / pid），不是每次按键都写',
    startupLogText.includes(`app=${require('../package.json').version}`) &&
      startupLogText.includes('win32') &&
      startupLogText.includes('pid=') &&
      startupLogText.includes(`启动：v${require('../package.json').version}`),
    startupLogText.slice(0, 300)
  );

  // 52b. 设置 → 诊断日志：全局设置里有「打开日志文件夹」，按书设置里不显示
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const logSettingsStatus = await exec('window.__cwTest.logSettingsStatus()');
  check(
    '诊断日志：设置里显示日志份数 / 大小，并说明不含正文',
    typeof logSettingsStatus === 'string' &&
      logSettingsStatus.includes('日志文件') &&
      logSettingsStatus.includes('不含正文'),
    logSettingsStatus
  );
  await exec("document.getElementById('btn-open-logs').click()");
  await waitFor(`window.__cwTest.logSettingsStatus().includes(${JSON.stringify(logDir)})`);
  check(
    '诊断日志：点「打开日志文件夹」回报日志目录（自检环境不弹资源管理器）',
    (await exec('window.__cwTest.logSettingsStatus()')).includes(logDir)
  );
  await exec('window.__cwTest.closeSettings()');
  await exec("window.__cwTest.openBookPath(" + JSON.stringify(focusBookPath) + ')');
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '诊断日志：按书设置里不显示日志分组（日志是整个应用一份）',
    (await exec('window.__cwTest.logSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');

  // 记录一份「日志操作前」的配置 / 书目 / 正文，稍后逐字节比对（日志不能碰书库与配置）
  const logMetaPath = path.join(focusBookPath, '书目.json');
  const logChapterMeta = JSON.parse(await fs.readFile(logMetaPath, 'utf8'));
  const logChapter = logChapterMeta.chapters[0];
  const logChapterPath = path.join(focusBookPath, logChapter.file);
  const logMetaBefore = await fs.readFile(logMetaPath, 'utf8');
  const logConfigBefore = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const logTxtBefore = await fs.readFile(logChapterPath, 'utf8');

  // 52c. IPC 未捕获错误：照常返回失败，同时日志里有一条（频道 + 错误码 + 文件名）
  const ipcFail = await exec(
    `window.api.loadChapter(${JSON.stringify(focusBookPath)}, '不存在的章节.txt')`
  );
  check(
    '诊断日志：IPC 错误照常返回失败，界面行为不变',
    ipcFail.ok === false && ipcFail.code === 'CHAPTER_MISSING',
    ipcFail
  );
  const ipcLogText = await waitForLog('不存在的章节.txt');
  const ipcLogBlock = ipcLogText.slice(Math.max(0, ipcLogText.indexOf('不存在的章节.txt') - 200));
  check(
    '诊断日志：IPC 未捕获错误记一条（错误码 + IPC 频道 + 出错文件名，含栈）',
    ipcLogBlock.includes('ERROR ipc-error') &&
      ipcLogBlock.includes('code=CHAPTER_MISSING') &&
      ipcLogBlock.includes('不存在的章节.txt') &&
      ipcLogBlock.includes('stack:'),
    ipcLogBlock.slice(0, 500)
  );

  // 52d. 保存失败：把章节文件设成只读让真实写盘失败 → 日志有 save-failed，但绝不含正文
  const saveFailMarker = 'E2E_SAVE_FAIL_MARKER';
  const saveFailBody = '这一段正文绝对不应该出现在日志文件里面';
  await fs.chmod(logChapterPath, 0o444);
  let failedSave;
  try {
    failedSave = await exec(
      `window.api.saveChapter(${JSON.stringify(focusBookPath)}, ${JSON.stringify(logChapter.id)}, ${JSON.stringify(
        `${saveFailMarker} ${saveFailBody}`
      )})`
    );
  } finally {
    await fs.chmod(logChapterPath, 0o666);
  }
  check(
    '诊断日志：真实写盘失败时保存照常返回错误',
    failedSave.ok === false && ['EPERM', 'EACCES', 'EBUSY'].includes(failedSave.code),
    failedSave
  );
  const saveFailLogText = await waitForLog('save-failed');
  const saveFailBlock = saveFailLogText.slice(Math.max(0, saveFailLogText.indexOf('save-failed') - 200));
  check(
    '诊断日志：保存失败记一条（错误码 + 章节文件路径 + 频道），绝不含正文',
    saveFailBlock.includes('ERROR save-failed') &&
      saveFailBlock.includes(`code=${failedSave.code}`) &&
      saveFailBlock.includes('channel=chapter:save') &&
      saveFailBlock.includes(logChapter.file) &&
      saveFailLogText.includes(saveFailMarker) === false &&
      saveFailLogText.includes(saveFailBody) === false,
    saveFailBlock.slice(0, 500)
  );
  check(
    '诊断日志：保存失败后章节 txt 与 书目.json 一个字节都没变',
    (await fs.readFile(logChapterPath, 'utf8')) === logTxtBefore &&
      (await fs.readFile(logMetaPath, 'utf8')) === logMetaBefore
  );

  // 52e. 主进程未处理的 Promise / 未捕获异常：都记一条，进程不能崩，界面给固定提示
  void Promise.reject(new Error('E2E_UNHANDLED_REJECTION_MARKER'));
  const rejectionLogText = await waitForLog('E2E_UNHANDLED_REJECTION_MARKER');
  check(
    '诊断日志：未处理的 Promise 记一条 unhandledRejection（含错误信息）',
    rejectionLogText.includes('ERROR unhandledRejection'),
    rejectionLogText.slice(-300)
  );
  setTimeout(() => {
    throw new Error('E2E_UNCAUGHT_EXCEPTION_MARKER');
  }, 0);
  const uncaughtLogText = await waitForLog('E2E_UNCAUGHT_EXCEPTION_MARKER');
  check(
    '诊断日志：主进程未捕获异常记一条 uncaughtException（含错误信息与栈），应用没退出',
    uncaughtLogText.includes('ERROR uncaughtException') &&
      uncaughtLogText.includes('stack:') &&
      (await exec('1 + 1')) === 2,
    uncaughtLogText.slice(-400)
  );
  await waitFor("(window.__cwTest.lastInternalError() || {}).kind === 'uncaughtException'");
  const internalError = await exec('window.__cwTest.lastInternalError()');
  check(
    '诊断日志：内部错误只在界面弹一句固定提示（不含错误细节 / 正文），写作页还能用',
    internalError &&
      internalError.kind === 'uncaughtException' &&
      typeof internalError.message === 'string' &&
      internalError.message.includes('日志') &&
      internalError.message.includes('MARKER') === false &&
      (await exec('window.__cwTest.text()')).length > 0,
    internalError
  );

  // 记录错误本身不写配置：日志功能不新增任何配置项，旧 config 照常启动
  const logConfigAfterLogging = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  check(
    '诊断日志：记录错误不写 config.json（没有日志开关，旧配置照常）',
    logConfigAfterLogging === logConfigBefore
  );

  // 52f. 日志写不进去也绝不影响写作：把 logs 目录换成一个同名文件
  const logsBackup = `${logDir}-off`;
  await fs.rm(logsBackup, { recursive: true, force: true });
  await fs.rename(logDir, logsBackup);
  await fs.writeFile(logDir, '占住日志目录位置，模拟日志写不进去');
  const ipcFailWhileBroken = await exec(
    `window.api.loadChapter(${JSON.stringify(focusBookPath)}, '写日志失败时的错误.txt')`
  );
  check(
    '诊断日志：写日志失败时 IPC 仍照常返回结果（日志失败被吞掉）',
    ipcFailWhileBroken.ok === false && ipcFailWhileBroken.code === 'CHAPTER_MISSING'
  );
  await exec("window.__cwTest.setText('写日志失败时，保存正文也必须成功。')");
  const saveWhileBroken = await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  check(
    '诊断日志：写日志失败时保存正文照常成功（日志绝不影响写作）',
    saveWhileBroken && saveWhileBroken.ok === true && (await exec('window.__cwTest.dirty()')) === false,
    saveWhileBroken
  );
  await fs.unlink(logDir);
  await fs.rename(logsBackup, logDir);
  // 恢复后照常写日志（不会因为失败过一次就永久停写）
  await exec(`window.api.loadChapter(${JSON.stringify(focusBookPath)}, '恢复后的错误.txt')`);
  const recoveredLogText = await waitForLog('恢复后的错误.txt');
  check(
    '诊断日志：日志目录恢复后继续记录（不会一次失败就永久停写）',
    recoveredLogText.includes('恢复后的错误.txt')
  );

  // 52g. 整份日志都不含正文：拿几段本轮 / 前面几组真的写过的正文去搜
  const allLogs = await readLogs();
  const bodySamples = [
    '风从海面吹来',
    '他沿着堤岸往回走',
    '第40行：',
    saveFailMarker,
    saveFailBody,
    '写日志失败时，保存正文也必须成功'
  ];
  check(
    '诊断日志：所有日志文件里都没有正文（正文只进书库，不进日志）',
    allLogs.names.length >= 1 &&
      allLogs.names.every((name) => logNamePattern.test(name)) &&
      bodySamples.every((sample) => allLogs.text.includes(sample) === false),
    bodySamples.filter((sample) => allLogs.text.includes(sample))
  );
  const bookEntries = await fs.readdir(focusBookPath);
  check(
    '诊断日志：日志只写 userData\\logs，书文件夹里没有多出日志文件',
    (await fileExists(logDir)) &&
      bookEntries.includes('logs') === false &&
      bookEntries.some((name) => /\.log$/i.test(name)) === false,
    bookEntries
  );
  const finalConfig = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const logConfigKeys = ['logInfo', 'logEnabled', 'logLevel', 'logDir', 'logs', 'diagnosticLog'].filter(
    (key) => key in finalConfig
  );
  check(
    '诊断日志：配置里不新增任何日志字段（日志功能不需要作者手动配置）',
    logConfigKeys.length === 0,
    logConfigKeys
  );

  // 53. 正文全文搜索索引（提案 7.3）：书架搜索升级成能搜正文。
  // 索引只写 userData\search-index.json（不进书库、不含正文），靠每章 mtime/size 增量更新。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const searchIndexPath = path.join(userData, 'search-index.json');
  const ensureSearchIndex = async (force) => {
    const res = await exec(
      `window.__cwTest.ensureSearchIndex({ force: ${force ? 'true' : 'false'} })`
    );
    if (!res) throw new Error('建正文索引失败');
    return res;
  };
  const waitShelfContent = async (query, predicate = () => true, timeout = 20000) => {
    const startedAt = Date.now();
    let state = null;
    for (;;) {
      state = await exec('window.__cwTest.shelfContentState()');
      if (state && state.query === query && !state.loading && predicate(state)) return state;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待正文搜索结果超时：${query} :: ${JSON.stringify(state)}`);
      }
      await sleep(150);
    }
  };
  const addSearchChapter = async (name, text) => {
    await exec(`window.__cwTest.newChapter(${JSON.stringify(name)})`);
    await waitFor(`window.__cwTest.currentTitle().includes(${JSON.stringify(name)})`);
    await exec(`window.__cwTest.setText(${JSON.stringify(text)})`);
    await exec('window.__cwTest.save()');
    await waitFor('window.__cwTest.dirty() === false');
  };

  // 53a. 书架加载后索引自动建好：只写 userData，书库 / 书文件夹里都没有索引文件
  const searchStatus = await ensureSearchIndex(false);
  check(
    '正文搜索：书架加载后自动建好索引（userData\\search-index.json，不在书库）',
    searchStatus &&
      searchStatus.file === searchIndexPath &&
      searchStatus.books >= 1 &&
      searchStatus.chapters >= 1 &&
      searchStatus.bytes > 0 &&
      searchStatus.ready === true &&
      String(searchStatus.builtAt || '').length > 10,
    {
      file: searchStatus && searchStatus.file,
      books: searchStatus && searchStatus.books,
      chapters: searchStatus && searchStatus.chapters
    }
  );
  check(
    '正文搜索：索引只在 userData，书库根目录 / 书文件夹里都没有多出索引文件',
    (await fileExists(searchIndexPath)) &&
      (await fileExists(path.join(booksRoot, 'search-index.json'))) === false &&
      (await fileExists(path.join(bookDir, 'search-index.json'))) === false &&
      (await fs.readdir(booksRoot)).every((name) => !/search-index/i.test(name))
  );

  // 53b. 造一本已知正文的书：三章，前两章带同一个少见短语，第三章不带
  await exec("window.__cwTest.newBook('正文搜索测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const searchBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '旧车站')");
  const searchText1 = '雨还在下。他撑着一把青柠色的雨伞，站在旧车站的月台上。\n风从海面吹来。';
  const searchText2 = '夜雨敲着窗。青柠色的雨伞靠在门边，滴着水。\n她一直没有回来。';
  const searchText3 = '清晨的街道很安静，只有早点摊的蒸汽。';
  await exec(`window.__cwTest.setText(${JSON.stringify(searchText1)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await addSearchChapter('夜雨', searchText2);
  await addSearchChapter('清晨', searchText3);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const searchMetaPath = path.join(searchBookPath, '书目.json');
  const searchMeta = JSON.parse(await fs.readFile(searchMetaPath, 'utf8'));
  const searchChapterFiles = searchMeta.chapters.map((chapter) => chapter.file);
  const searchBuilt = await ensureSearchIndex(true);
  check(
    '正文搜索：新书 / 新章进入索引（每章都有 mtime/size 指纹）',
    searchBuilt.books >= 2 && searchBuilt.chapters >= 4 && searchMeta.chapters.length === 3,
    { books: searchBuilt.books, chapters: searchBuilt.chapters }
  );
  const indexRaw = await fs.readFile(searchIndexPath, 'utf8');
  const indexParsed = JSON.parse(indexRaw);
  const indexBook = indexParsed.books.find((book) => book.folder === path.basename(searchBookPath));
  check(
    '正文搜索：索引里只有哈希位图和文件指纹，不存正文（正文句子不在索引文件里）',
    indexBook &&
      indexBook.chapters.length === 3 &&
      indexBook.chapters.every((chapter) => chapter.mtimeMs > 0 && chapter.size > 0) &&
      indexBook.chapters.every((chapter) => !('text' in chapter)) &&
      indexRaw.includes('青柠色的雨伞') === false &&
      indexRaw.includes('早点摊的蒸汽') === false &&
      indexBook.bloom.length > 8 &&
      indexBook.bloomBits > 0,
    { chapters: indexBook && indexBook.chapters.length }
  );

  // 53c. 书架搜正文：书名 / 章名没命中，但正文命中两章；结果带上下文，搜索全程只读
  const searchConfigBefore = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const searchMetaBefore = await fs.readFile(searchMetaPath, 'utf8');
  const searchTxtBefore = [];
  for (const file of searchChapterFiles) {
    searchTxtBefore.push(await fs.readFile(path.join(searchBookPath, file), 'utf8'));
  }
  check(
    '正文搜索：搜索框提示写明可以搜正文',
    String(await exec("document.getElementById('shelf-search').placeholder")).includes('正文')
  );
  await exec("window.__cwTest.setShelfQuery('青柠色的雨伞')");
  const contentHit = await waitShelfContent('青柠色的雨伞', (state) => state.results.length === 2);
  check(
    '正文搜索：能搜到正文，结果显示书名 + 章名 + 命中上下文',
    contentHit.visible === true &&
      contentHit.results.length === 2 &&
      contentHit.results[0].bookTitle === '正文搜索测试书' &&
      contentHit.results[0].chapterIndex === 0 &&
      contentHit.results[0].chapterName === '旧车站' &&
      contentHit.results[1].chapterIndex === 1 &&
      contentHit.results[1].chapterName === '夜雨' &&
      contentHit.results.every((row) => row.snippet && row.snippet.match === '青柠色的雨伞') &&
      contentHit.results[0].snippet.before.includes('一把') &&
      contentHit.results[0].snippet.after.includes('的月台'),
    contentHit.results.map((row) => ({ name: row.chapterName, snippet: row.snippet }))
  );
  check(
    '正文搜索：摘要显示「正文命中 N 处 / 已查几本」，书名与章名过滤仍然有效',
    contentHit.summary.includes('正文命中 2 处') &&
      (await exec('window.__cwTest.shelfSearchSummary()')).includes('正文命中 2 处') &&
      (await exec('window.__cwTest.shelfContentRowTexts()')).some(
        (text) =>
          text.includes('正文搜索测试书') &&
          text.includes('第1章：旧车站') &&
          text.includes('青柠色的雨伞')
      ) &&
      (await exec('window.__cwTest.shelfFilteredTitles()')).length === 0,
    contentHit.summary
  );
  const searchTxtAfter = [];
  for (const file of searchChapterFiles) {
    searchTxtAfter.push(await fs.readFile(path.join(searchBookPath, file), 'utf8'));
  }
  check(
    '正文搜索：搜索过程只读（config.json / 书目.json / 章节 txt 一个字节都没变）',
    (await fs.readFile(path.join(userData, 'config.json'), 'utf8')) === searchConfigBefore &&
      (await fs.readFile(searchMetaPath, 'utf8')) === searchMetaBefore &&
      searchTxtAfter.join('\n') === searchTxtBefore.join('\n')
  );

  // 53d. 点正文结果：直接打开那一章并选中命中位置（只移动选区 / 滚动，不改正文）
  await exec('window.__cwTest.clickShelfContentResult(1)');
  await waitFor("window.__cwTest.view() === 'editor'");
  const openedSearch = {
    path: await exec('window.__cwTest.bookPathValue()'),
    index: await exec('window.__cwTest.currentIndex()'),
    selected: await exec('window.__cwTest.selectionText()'),
    text: await exec('window.__cwTest.text()'),
    dirty: await exec('window.__cwTest.dirty()')
  };
  check(
    '正文搜索：点结果直接打开那一章并选中命中位置（不改正文、不产生未保存修改）',
    openedSearch.path === searchBookPath &&
      openedSearch.index === 1 &&
      openedSearch.selected === '青柠色的雨伞' &&
      openedSearch.text === searchText2 &&
      openedSearch.dirty === false,
    openedSearch
  );

  // 53e / 53f. 没命中时的提示；一个字不搜正文
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('绝对不存在的词组xyz')");
  const contentMiss = await waitShelfContent(
    '绝对不存在的词组xyz',
    (state) => state.results.length === 0 && !state.error
  );
  check(
    '正文搜索：正文没有命中时给出明确提示，不冒充找到',
    contentMiss.visible === true &&
      contentMiss.results.length === 0 &&
      contentMiss.summary.includes('正文没有找到') &&
      (await exec('window.__cwTest.shelfSearchSummary()')).includes('没有匹配')
  );
  await exec("window.__cwTest.setShelfQuery('雨')");
  await sleep(700);
  const shortQuery = await exec('window.__cwTest.shelfContentState()');
  check(
    '正文搜索：一个字不搜正文（最少两个字，避免全书架都命中）',
    shortQuery.visible === false && shortQuery.results.length === 0
  );

  // 53g. 外部改 txt（mtime / size 变了）：强制校验后索引跟着更新，旧正文不再命中
  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(150);
  const externalText = '外部的月光照在窗台上，像是没有人收的旧信。';
  const externalChapterFile = searchChapterFiles[2];
  await fs.writeFile(path.join(searchBookPath, externalChapterFile), externalText, 'utf8');
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('外部的月光')");
  const externalHit = await waitShelfContent('外部的月光', (state) => state.results.length === 1);
  check(
    '正文搜索：外部改过 txt（mtime / size 变了）后重建索引，能搜到新内容',
    externalHit.results.length === 1 && externalHit.results[0].chapterIndex === 2,
    externalHit.results
  );
  await exec("window.__cwTest.setShelfQuery('早点摊的蒸汽')");
  const externalOld = await waitShelfContent('早点摊的蒸汽', (state) => state.results.length === 0);
  check('正文搜索：外部删掉的旧正文不会再命中（索引不留旧文本）', externalOld.results.length === 0);

  // 53h. 改章名 / 删章节：只改元数据或剔除，书名 / 章名 / 章节数与磁盘一致
  await exec("window.__cwTest.setShelfQuery('')");
  const renamed = await exec(
    `window.api.renameChapter(${JSON.stringify(searchBookPath)}, ${JSON.stringify(
      searchMeta.chapters[0].id
    )}, '改名后的站台')`
  );
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('青柠色的雨伞')");
  const renamedHit = await waitShelfContent('青柠色的雨伞', (state) => state.results.length === 2);
  check(
    '正文搜索：改章名后索引跟着更新（结果还是那两章，章名已变）',
    renamed.ok === true && renamedHit.results[0].chapterName === '改名后的站台',
    renamedHit.results.map((row) => row.chapterName)
  );
  const deletedChapter = await exec(
    `window.api.deleteChapter(${JSON.stringify(searchBookPath)}, ${JSON.stringify(
      searchMeta.chapters[2].id
    )})`
  );
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('外部的月光')");
  const deletedHit = await waitShelfContent('外部的月光', (state) => state.results.length === 0);
  const searchBookEntries = await fs.readdir(searchBookPath);
  check(
    '正文搜索：删掉的章节从索引消失（文件进 _trash，不真删）',
    deletedChapter.ok === true &&
      deletedHit.results.length === 0 &&
      searchBookEntries.includes('_trash') &&
      (await fs.readdir(path.join(searchBookPath, '_trash'))).some((name) =>
        name.includes(externalChapterFile)
      ),
    searchBookEntries
  );

  // 53i. 整本书删掉后从索引消失
  await exec("window.__cwTest.setShelfQuery('')");
  await exec("window.__cwTest.newBook('索引删除测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const disposableBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec(`window.__cwTest.setText('这本书里有一句「要被删掉的一本书」的独有正文。')`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const disposableBuilt = await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('要被删掉的一本书')");
  const disposableHit = await waitShelfContent('要被删掉的一本书', (state) => state.results.length === 1);
  const disposableDelete = await exec(
    `window.api.deleteBook(${JSON.stringify(disposableBookPath)})`
  );
  const afterDeleteBuilt = await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('要被删掉的一本书')");
  const disposableGone = await waitShelfContent('要被删掉的一本书', (state) => state.results.length === 0);
  check(
    '正文搜索：整本书删掉后从索引消失（索引书数跟着减）',
    disposableHit.results.length === 1 &&
      disposableDelete.ok === true &&
      disposableGone.results.length === 0 &&
      afterDeleteBuilt.books === disposableBuilt.books - 1 &&
      (await fileExists(disposableBookPath)) === false,
    { before: disposableBuilt.books, after: afterDeleteBuilt.books }
  );

  // 53j. 结果分页：9 条命中先显示 8 条，「显示更多」再展开；limit 生效并标记 truncated
  await exec("window.__cwTest.setShelfQuery('')");
  await exec("window.__cwTest.newBook('正文分页测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.renameChapterAt(0, '第1页')");
  for (let i = 0; i < 9; i += 1) {
    if (i > 0) {
      await exec(`window.__cwTest.newChapter('第${i + 1}页')`);
      await waitFor(`window.__cwTest.currentTitle().includes('第${i + 1}页')`);
    }
    await exec(`window.__cwTest.setText(${JSON.stringify(`分页测试词出现在第${i + 1}章。`)} )`);
    await exec('window.__cwTest.save()');
    await waitFor('window.__cwTest.dirty() === false');
  }
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await ensureSearchIndex(true);
  await exec("window.__cwTest.setShelfQuery('分页测试词')");
  const paged = await waitShelfContent('分页测试词', (state) => state.results.length === 9);
  const firstPage = {
    rows: paged.rowCount,
    more: paged.moreVisible,
    summary: paged.summary
  };
  const afterMore = await exec('window.__cwTest.clickShelfContentMore()');
  await sleep(150);
  const secondPage = await exec('window.__cwTest.shelfContentState()');
  check(
    '正文搜索：结果分页显示（先 8 条，「显示更多」展开剩下的）',
    firstPage.rows === 8 &&
      firstPage.more === true &&
      firstPage.summary.includes('显示 8 条') &&
      afterMore === 16 &&
      secondPage.rowCount === 9 &&
      secondPage.moreVisible === false,
    { firstPage, afterMore, rows: secondPage.rowCount }
  );
  const limitedSearch = await exec("window.api.searchContent('分页测试词', { limit: 4 })");
  check(
    '正文搜索：limit 生效并标记 truncated（分页 / 限量由主进程兜底）',
    limitedSearch.ok === true &&
      limitedSearch.data.results.length === 4 &&
      limitedSearch.data.limit === 4 &&
      limitedSearch.data.truncated === true
  );

  // 53k. 旧数据兼容 + 索引不出现正文 + 配置不新增字段
  await exec("window.__cwTest.setShelfQuery('旧书正文')");
  const legacyHit = await waitShelfContent('旧书正文', (state) => state.results.length >= 1);
  check(
    '正文搜索：v0.4.1 旧书（没有 schemaVersion）照常能搜正文，书目不被补字段',
    legacyHit.results.some((row) => row.bookTitle === '灵感箱旧书') &&
      (await fs.readFile(fragLegacyMetaPath, 'utf8')).includes('"schemaVersion"') === false,
    legacyHit.results.map((row) => row.bookTitle)
  );
  const finalIndexRaw = await fs.readFile(searchIndexPath, 'utf8');
  const finalConfigAfterSearch = JSON.parse(
    await fs.readFile(path.join(userData, 'config.json'), 'utf8')
  );
  const searchConfigKeys = [
    'searchIndex',
    'searchIndexPath',
    'contentSearch',
    'searchEnabled',
    'bodySearch'
  ].filter((key) => key in finalConfigAfterSearch);
  check(
    '正文搜索：配置不新增任何搜索字段（索引全自动，作者不用配置）',
    searchConfigKeys.length === 0,
    searchConfigKeys
  );
  check(
    '正文搜索：索引文件里始终没有正文（拿本轮写过的正文句子核对）',
    finalIndexRaw.includes('青柠色的雨伞') === false &&
      finalIndexRaw.includes('分页测试词') === false &&
      finalIndexRaw.includes(searchText2.replace(/\n/g, '')) === false
  );
  check(
    '正文搜索：搜索不会在书文件夹里生成任何文件（索引只在 userData）',
    (await fs.readdir(searchBookPath)).every((name) => !/search-index|search_cache/i.test(name)) &&
      (await fs.readdir(booksRoot)).every((name) => !/search-index|search_cache/i.test(name))
  );

  // 54. 检查更新（提案 7.1）：手动检查 GitHub Release → 提示有新版本 → 打开下载页。
  //     网络全部走主进程的假响应（update:test-mock），E2E 不真连 GitHub；
  //     不下载、不安装、不写配置、不写书库。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const updateConfigPath = path.join(userData, 'config.json');
  const updateConfigBefore = await fs.readFile(updateConfigPath, 'utf8');
  const updateBookMetaPath = path.join(focusBookPath, '书目.json');
  const updateBookMetaBefore = await fs.readFile(updateBookMetaPath, 'utf8');
  const updateBookMetaJson = JSON.parse(updateBookMetaBefore);
  const updateChapterPath = path.join(focusBookPath, updateBookMetaJson.chapters[0].file);
  const updateTxtBefore = await fs.readFile(updateChapterPath, 'utf8');
  const updateBookFilesBefore = (await fs.readdir(focusBookPath)).sort().join('|');
  const updateUserDataBefore = (await fs.readdir(userData)).sort().join('|');
  const pkgVersion = require('../package.json').version;
  const setUpdateMock = (mock) =>
    exec(`window.__cwTest.setUpdateMock(${JSON.stringify(mock)})`);
  const releaseBody = (tag, extra = {}) => ({
    tag_name: tag,
    name: `${tag} · 自检`,
    html_url: `https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/${tag}`,
    published_at: '2026-11-01T00:00:00Z',
    prerelease: false,
    draft: false,
    ...extra
  });

  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const initialUpdate = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：设置里有「检查更新」分组，显示当前版本，初始没有下载按钮',
    (await exec('window.__cwTest.updateGroupVisible()')) === true &&
      initialUpdate.version === `v${pkgVersion}` &&
      initialUpdate.status === 'idle' &&
      initialUpdate.downloadVisible === false &&
      initialUpdate.text.includes('尚未检查'),
    initialUpdate
  );

  // 还没检查就点下载页：只给提示，绝不打开任意地址
  const beforeCheckOpen = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：还没检查就点「打开下载页」只给提示，不打开任何地址',
    beforeCheckOpen.ok === true &&
      beforeCheckOpen.data.opened === false &&
      beforeCheckOpen.data.url === '' &&
      /先/.test(beforeCheckOpen.data.message || ''),
    beforeCheckOpen
  );

  // 54a. 发现新版本：显示版本号 + 下载页按钮，地址只能是本仓库 Release
  await setUpdateMock({ type: 'json', body: releaseBody('v9.9.9') });
  const newerResult = await exec('window.__cwTest.checkUpdateNow()');
  const newerStatus = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：发现新版本时显示「新版本 + 当前版本」，并出现「打开下载页」',
    newerResult.status === 'update' &&
      newerResult.latestVersion === '9.9.9' &&
      newerResult.currentVersion === pkgVersion &&
      newerStatus.status === 'update' &&
      newerStatus.text.includes('发现新版本 v9.9.9') &&
      newerStatus.text.includes(`当前 v${pkgVersion}`) &&
      newerStatus.downloadVisible === true,
    { newerResult, newerStatus }
  );
  const downloadResult = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：下载页是本仓库的 GitHub Release 地址（自检环境只回报、不弹浏览器）',
    downloadResult.ok === true &&
      downloadResult.data.opened === false &&
      downloadResult.data.url ===
        'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v9.9.9' &&
      /自检/.test(downloadResult.data.note || ''),
    downloadResult
  );

  // 54b. 已是最新：下载按钮收起，上一轮的地址也不能再被打开
  await setUpdateMock({ type: 'json', body: releaseBody(`v${pkgVersion}`) });
  const latestResult = await exec('window.__cwTest.checkUpdateNow()');
  const latestStatus = await exec('window.__cwTest.updateStatus()');
  const staleOpen = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：同版本时显示「已是最新版本」，下载按钮收起',
    latestResult.status === 'latest' &&
      latestStatus.text.includes('已是最新版本') &&
      latestStatus.downloadVisible === false,
    { latestResult, latestStatus }
  );
  check(
    '检查更新：检查到「已是最新」后不能再用上一轮的地址打开下载页',
    staleOpen.ok === true && staleOpen.data.opened === false && staleOpen.data.url === '',
    staleOpen
  );

  // 54c. 更旧的版本（例如本机是开发版）不提示降级
  await setUpdateMock({ type: 'json', body: releaseBody('v0.1.0') });
  const olderResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：GitHub 上版本更旧时仍显示「已是最新版本」，不会提示降级',
    olderResult.status === 'latest' && olderResult.latestVersion === '0.1.0',
    olderResult
  );

  // 54d. 网络失败 / 超时 / HTTP 错误 / 限流 / 坏 JSON：都只给一句提示，设置弹层照常可用
  await setUpdateMock({ type: 'network-error' });
  const networkResult = await exec('window.__cwTest.checkUpdateNow()');
  const networkStatus = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：没网时给友好提示（连不上 GitHub），不影响写作',
    networkResult.status === 'error' &&
      networkResult.code === 'NETWORK' &&
      networkStatus.text.includes('连不上 GitHub') &&
      networkStatus.downloadVisible === false,
    networkResult
  );

  await setUpdateMock({ type: 'timeout' });
  const timeoutResult = await exec('window.__cwTest.checkUpdateNow()');
  const timeoutStatus = await exec('window.__cwTest.updateStatus()');
  check(
    '检查更新：超时给友好提示，不卡住设置弹层',
    timeoutResult.status === 'error' &&
      timeoutResult.code === 'TIMEOUT' &&
      timeoutStatus.text.includes('超时'),
    timeoutResult
  );

  await setUpdateMock({ type: 'http', status: 500, text: '' });
  const serverResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：GitHub 返回 5xx 时说明「暂时不可用」，不是假装没更新',
    serverResult.status === 'error' &&
      serverResult.code === 'HTTP_ERROR' &&
      serverResult.message.includes('HTTP 500'),
    serverResult
  );

  await setUpdateMock({ type: 'http', status: 403, text: '' });
  const limitedResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：GitHub 限流时提示「请求太频繁」',
    limitedResult.status === 'error' &&
      limitedResult.code === 'RATE_LIMIT' &&
      limitedResult.message.includes('频繁'),
    limitedResult
  );

  await setUpdateMock({ type: 'http', status: 200, text: '{not json' });
  const badJsonResult = await exec('window.__cwTest.checkUpdateNow()');
  check(
    '检查更新：返回的不是 JSON 时提示「格式不对」，不崩',
    badJsonResult.status === 'error' &&
      badJsonResult.code === 'BAD_JSON' &&
      badJsonResult.message.includes('格式不对'),
    badJsonResult
  );

  // 54e. 恶意 / 坏的 html_url 不能把作者带到别的网站：退回按 tag 拼的官方下载页
  await setUpdateMock({
    type: 'json',
    body: releaseBody('v9.9.9', { html_url: 'http://evil.example/steal' })
  });
  const unsafeResult = await exec('window.__cwTest.checkUpdateNow()');
  const unsafeOpen = await exec('window.api.openUpdateDownload()');
  check(
    '检查更新：Release 里的坏链接被丢掉，只使用本仓库的官方下载页',
    unsafeResult.status === 'update' &&
      unsafeResult.releaseUrl ===
        'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v9.9.9' &&
      unsafeOpen.data.url === unsafeResult.releaseUrl,
    { unsafeResult, unsafeOpen }
  );

  // 54f. 只读：检查更新不写配置 / 不写书目 / 不改正文 / 不多出文件
  check(
    '检查更新：全程只读（config / 书目 / 章节 txt 一个字节都没变）',
    (await fs.readFile(updateConfigPath, 'utf8')) === updateConfigBefore &&
      (await fs.readFile(updateBookMetaPath, 'utf8')) === updateBookMetaBefore &&
      (await fs.readFile(updateChapterPath, 'utf8')) === updateTxtBefore
  );
  check(
    '检查更新：书库和 userData 没有多出任何文件（不下载、不缓存更新包）',
    (await fs.readdir(focusBookPath)).sort().join('|') === updateBookFilesBefore &&
      (await fs.readdir(userData)).sort().join('|') === updateUserDataBefore
  );
  const updateConfigJson = JSON.parse(await fs.readFile(updateConfigPath, 'utf8'));
  const updateConfigKeys = [
    'updateCheckOnStartup',
    'updateFeed',
    'updateFeedUrl',
    'lastUpdateCheck',
    'autoUpdate',
    'updateChannel'
  ].filter((key) => key in updateConfigJson);
  check(
    '检查更新：配置不新增任何更新字段（检查只存在内存里，不需要作者配置）',
    updateConfigKeys.length === 0,
    updateConfigKeys
  );

  // 54g. 按书设置里不显示「检查更新」（一个应用一个版本，和诊断日志同一处理）
  await exec('window.__cwTest.closeSettings()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(focusBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '检查更新：按书设置里不显示更新分组（更新是整个应用的事）',
    (await exec('window.__cwTest.updateGroupVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 55. 多窗口（提案 7.2，作者 2026-11-01 03:45 拍板）：
  //     书卡右键「在新窗口打开」/ 禁止同书双开 / 跨窗口删改拦截 / 各自编辑保存 /
  //     关一个窗口不退出、最后窗口关闭才退出 / 各自未保存拦截 / 继续上次写作 /
  //     书架刷新 / 旧书兼容 / 书库无多余文件。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const normPath = (p) => path.resolve(String(p || '')).toLowerCase();
  const liveWindows = () => windowsInfo().filter((window) => !window.destroyed);
  const waitWindows = async (count, timeout = 20000) => {
    const startedAt = Date.now();
    for (;;) {
      const list = liveWindows();
      if (list.length === count) return list;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待窗口数 ${count} 超时：当前 ${JSON.stringify(liveWindows())}`);
      }
      await sleep(100);
    }
  };
  const waitIn = async (windowId, expr, timeout = 20000) => {
    const startedAt = Date.now();
    for (;;) {
      let value;
      try {
        value = await execIn(windowId, expr);
      } catch {
        /* 窗口刚开 / 刚切页，稍后再试 */
      }
      if (value) return value;
      if (Date.now() - startedAt > timeout) throw new Error(`窗口 ${windowId} 等待超时：${expr}`);
      await sleep(120);
    }
  };
  const makeWindowBook = async (title, chapterName, text) => {
    const created = await storage.createBook(booksRoot, title);
    const chapter = created.meta.chapters[0];
    await storage.saveChapterText(created.path, chapter.file, text);
    chapter.name = chapterName;
    chapter.chars = chaptersLib.countChars(text);
    await storage.writeBookMeta(created.path, created.meta);
    const meta = await storage.readBookMeta(created.path);
    return { path: created.path, meta, file: meta.chapters[0].file, chapterId: meta.chapters[0].id };
  };
  const readBookChapter = async (book) =>
    (await storage.loadChapterText(book.path, book.file)).text;

  const initialWindows = liveWindows();
  check(
    '多窗口：开始时只有一个窗口（前面 646 项仍是单窗口语义）',
    initialWindows.length === 1,
    initialWindows
  );
  const primaryId = initialWindows[0].id;
  const mwBookA = await makeWindowBook('多窗口甲', '甲章', '甲书正文');
  const mwBookB = await makeWindowBook('多窗口乙', '乙章', '乙书正文');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 55a. 书卡右键入口「在新窗口打开」：真的点界面菜单，新窗口打开指定书
  check(
    '多窗口：书卡右键菜单有「在新窗口打开」',
    (await exec('window.__cwTest.bookMenuTexts()')).some((text) => text.includes('在新窗口打开'))
  );
  check(
    '多窗口：右键菜单确实是界面上的书卡菜单',
    (await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(mwBookA.path)})`)) === true &&
      (await exec('window.__cwTest.bookMenuOpen()')) === true
  );
  await exec('window.__cwTest.clickBookMenuAction("open-new-window")');
  const afterOpen = await waitWindows(2);
  const winAInfo = afterOpen.find((window) => window.bookPath === normPath(mwBookA.path));
  check('多窗口：新窗口打开了刚点的那本书', Boolean(winAInfo), afterOpen);
  check(
    '多窗口：新窗口进入写作页并显示那本书',
    (await waitIn(winAInfo.id, "window.__cwTest.view() === 'editor'")) === true &&
      normPath(await waitIn(winAInfo.id, 'window.__cwTest.bookPathValue()')) === normPath(mwBookA.path)
  );
  check('多窗口：原窗口仍停在书架（没有跟着切走）', (await exec('window.__cwTest.view()')) === 'shelf');
  check(
    '多窗口：打开登记里有 2 个窗口 / 1 本开着的书',
    registryCounts().windows === 2 &&
      registryCounts().openBooks === 1 &&
      openBookRegistry().length === 1
  );

  // 55b. 禁止同一本书开两个窗口：再点一次只是聚焦已有窗口，窗口数不增
  const duplicate = await exec(`window.api.openBookInNewWindow(${JSON.stringify(mwBookA.path)})`);
  check(
    '多窗口：同一本书再开 → 聚焦已有窗口，不新建',
    Boolean(duplicate && duplicate.ok === true && duplicate.data.focused === true) &&
      duplicate.data.windowId === winAInfo.id,
    duplicate
  );
  await sleep(300);
  check(
    '多窗口：重复打开后窗口数不增、登记仍是那一本',
    liveWindows().length === 2 && registryCounts().openBooks === 1 && openBookRegistry().length === 1
  );
  await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(mwBookA.path)})`);
  await exec('window.__cwTest.clickBookMenuAction("open-new-window")');
  await sleep(400);
  check(
    '多窗口：从右键入口重复打开也不新增窗口',
    liveWindows().length === 2 && registryCounts().windows === 2
  );

  // 55c. 两个窗口各开一本书，各自编辑 / 保存互不干扰
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(mwBookB.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check('多窗口：两个窗口各开一本书（登记两本）', registryCounts().openBooks === 2);
  check(
    '多窗口：开第二本书不影响另一个窗口正开的书',
    normPath(await waitIn(winAInfo.id, 'window.__cwTest.bookPathValue()')) === normPath(mwBookA.path)
  );
  await execIn(winAInfo.id, "window.__cwTest.setText('甲窗口写入的内容')");
  check(
    '多窗口：A 窗口未保存不影响 B 窗口的脏状态',
    (await execIn(winAInfo.id, 'window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  const saveA = await execIn(winAInfo.id, 'window.__cwTest.save()');
  check('多窗口：A 窗口保存成功', Boolean(saveA && saveA.ok === true), saveA);
  const recentAfterA = await exec('window.api.getRecentBook()');
  check(
    '多窗口：继续上次写作按最近写作的窗口（刚保存的 A）',
    Boolean(recentAfterA && recentAfterA.ok === true) &&
      normPath(recentAfterA.data.path) === normPath(mwBookA.path) &&
      recentAfterA.data.chapterId === mwBookA.chapterId,
    recentAfterA
  );
  await exec("window.__cwTest.setText('乙窗口写入的内容')");
  const saveB = await exec('window.__cwTest.save()');
  check('多窗口：B 窗口保存成功', Boolean(saveB && saveB.ok === true), saveB);
  check(
    '多窗口：两个窗口保存后磁盘内容各是各的',
    (await readBookChapter(mwBookA)) === '甲窗口写入的内容' &&
      (await readBookChapter(mwBookB)) === '乙窗口写入的内容'
  );
  const recentAfterB = await exec('window.api.getRecentBook()');
  check(
    '多窗口：继续上次写作跟着最近一次保存的窗口走（B）',
    Boolean(recentAfterB && recentAfterB.ok === true) &&
      normPath(recentAfterB.data.path) === normPath(mwBookB.path),
    recentAfterB
  );

  // 55d. 跨窗口删改拦截：B 窗口删除 / 改名 / 整理 / 导入 A 窗口正开着的书 → 拒绝
  const metaAPath = path.join(mwBookA.path, '书目.json');
  const metaABefore = await fs.readFile(metaAPath, 'utf8');
  const deleteBookDenied = await exec(`window.api.deleteBook(${JSON.stringify(mwBookA.path)})`);
  check(
    '多窗口：A 删 B 正开着的书被拒绝并提示先关 / 先切窗口',
    Boolean(deleteBookDenied && deleteBookDenied.ok === false) &&
      deleteBookDenied.code === 'CROSS_WINDOW_BUSY' &&
      /另一个窗口/.test(deleteBookDenied.message),
    deleteBookDenied
  );
  const deleteChapterDenied = await exec(
    `window.api.deleteChapter(${JSON.stringify(mwBookA.path)}, ${JSON.stringify(mwBookA.chapterId)})`
  );
  check(
    '多窗口：A 删 B 正开着的章节被拒绝',
    Boolean(deleteChapterDenied && deleteChapterDenied.ok === false) &&
      deleteChapterDenied.code === 'CROSS_WINDOW_BUSY',
    deleteChapterDenied
  );
  const renameDenied = await exec(
    `window.api.renameBook(${JSON.stringify(mwBookA.path)}, '偷改书名')`
  );
  check(
    '多窗口：A 改 B 正开着的书名被拒绝',
    Boolean(renameDenied && renameDenied.ok === false) && renameDenied.code === 'CROSS_WINDOW_BUSY',
    renameDenied
  );
  const formatDenied = await exec(`window.api.formatBook(${JSON.stringify(mwBookA.path)}, {})`);
  check(
    '多窗口：A 整理 B 正开着的书被拒绝',
    Boolean(formatDenied && formatDenied.ok === false) && formatDenied.code === 'CROSS_WINDOW_BUSY',
    formatDenied
  );
  const mwImportSrc = path.join(userData, 'mw-import-src', '多窗口甲');
  await fs.mkdir(mwImportSrc, { recursive: true });
  await fs.writeFile(path.join(mwImportSrc, '001-外来.txt'), '外来正文', 'utf8');
  const importDenied = await exec(
    `window.api.importBooks([${JSON.stringify(mwImportSrc)}], { mode: 'chapters' })`
  );
  check(
    '多窗口：导入会覆盖 B 正开着的书时被拒绝',
    Boolean(importDenied && importDenied.ok === false) && importDenied.code === 'CROSS_WINDOW_BUSY',
    importDenied
  );
  check(
    '多窗口：被拒绝的删改没有动书 / 章 / 书目 / 回收目录',
    (await fileExists(mwBookA.path)) &&
      (await fileExists(path.join(mwBookA.path, mwBookA.file))) &&
      (await fs.readFile(metaAPath, 'utf8')) === metaABefore &&
      (await fileExists(path.join(mwBookA.path, '_trash'))) === false
  );
  await execIn(winAInfo.id, "window.__cwTest.setText('甲窗口被拦截后仍能写')");
  const saveAfterDenied = await execIn(winAInfo.id, 'window.__cwTest.save()');
  check(
    '多窗口：被拦截的删改没有影响另一个窗口继续保存',
    Boolean(saveAfterDenied && saveAfterDenied.ok === true) &&
      (await readBookChapter(mwBookA)) === '甲窗口被拦截后仍能写'
  );

  // 55e. 影子文件：书 / 章被外部（另一个窗口）删掉后保存必须失败，绝不 mkdir 重建
  const mwBookC = await makeWindowBook('多窗口影子', '影子章', '影子正文');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(mwBookC.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const shadowChapterPath = path.join(mwBookC.path, mwBookC.file);
  const shadowBytes = await fs.readFile(shadowChapterPath);
  await fs.unlink(shadowChapterPath);
  const shadowFilesBefore = (await fs.readdir(mwBookC.path)).sort().join('|');
  await exec("window.__cwTest.setText('章节被外部删掉后还想保存')");
  const shadowSave = await exec('window.__cwTest.save()');
  check(
    '多窗口：章节文件被删后保存被阻止（CHAPTER_MISSING）',
    Boolean(shadowSave && shadowSave.ok === false) && shadowSave.code === 'CHAPTER_MISSING',
    shadowSave
  );
  check(
    '多窗口：没有重新长出影子 txt / 临时文件',
    (await fileExists(shadowChapterPath)) === false &&
      (await fs.readdir(mwBookC.path)).sort().join('|') === shadowFilesBefore
  );
  await fs.writeFile(shadowChapterPath, shadowBytes);
  await fs.rm(mwBookC.path, { recursive: true, force: true });
  await exec("window.__cwTest.setText('整本书被外部删掉后还想保存')");
  const missingBookSave = await exec('window.__cwTest.save()');
  check(
    '多窗口：书文件夹被删后保存被阻止（BOOK_MISSING）',
    Boolean(missingBookSave && missingBookSave.ok === false) && missingBookSave.code === 'BOOK_MISSING',
    missingBookSave
  );
  check('多窗口：没有 mkdir 重建书文件夹 / 影子文件', (await fileExists(mwBookC.path)) === false);
  await exec('void window.__cwTest.backToShelf()');
  await waitIn(primaryId, 'window.__cwTest.modalOpen() === true');
  await exec("window.__cwTest.answerModal('discard')");
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 55f. 两个窗口各自未保存拦截：关一个窗口只问这个窗口，取消不影响另一个窗口
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(mwBookB.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await execIn(winAInfo.id, "window.__cwTest.setText('关窗前的未保存内容')");
  await exec("window.__cwTest.setText('B 窗口的未保存内容')");
  setRealClose(true);
  resetCloseReady(null);
  closeWindow(winAInfo.id);
  await waitIn(winAInfo.id, 'window.__cwTest.modalOpen() === true');
  check(
    '多窗口：关窗询问只出现在被关的窗口',
    (await exec('window.__cwTest.modalOpen()')) === false
  );
  check(
    '多窗口：另一个窗口保持自己的未保存状态（没被牵连）',
    liveWindows().length === 2 && (await exec('window.__cwTest.dirty()')) === true
  );
  await execIn(winAInfo.id, "window.__cwTest.answerModal('cancel')");
  await sleep(500);
  check(
    '多窗口：取消关窗后该窗口还在、内容还在',
    liveWindows().length === 2 &&
      (await execIn(winAInfo.id, 'window.__cwTest.dirty()')) === true &&
      (await waitIn(winAInfo.id, "window.__cwTest.view() === 'editor'")) === true
  );
  closeWindow(winAInfo.id);
  await waitIn(winAInfo.id, 'window.__cwTest.modalOpen() === true');
  await execIn(winAInfo.id, "window.__cwTest.answerModal('discard')");
  await waitWindows(1);
  check(
    '多窗口：关掉一个窗口应用不退出（还剩最后一个窗口）',
    windowAllClosed() === false && liveWindows().length === 1
  );
  check(
    '多窗口：关掉窗口后释放打开登记',
    registryCounts().openBooks === 1 &&
      openBookRegistry().every((item) => item.windowId !== String(winAInfo.id)) &&
      openBookRegistry().some((item) => item.bookPath === normPath(mwBookB.path)),
    openBookRegistry()
  );
  check(
    '多窗口：被丢弃的未保存内容没有偷偷写盘',
    (await readBookChapter(mwBookA)) === '甲窗口被拦截后仍能写'
  );
  check('多窗口：关窗回执来自被关的窗口', getCloseReady(winAInfo.id) === true);

  // 55g. 关掉一个窗口后书可以重新打开；「继续上次写作」/ 最近窗口跟着更新
  const saveBAfterClose = await exec('window.__cwTest.save()');
  check('多窗口：剩下的窗口照常保存', Boolean(saveBAfterClose && saveBAfterClose.ok === true));
  const reopenA = await exec(`window.api.openBookInNewWindow(${JSON.stringify(mwBookA.path)})`);
  check(
    '多窗口：窗口关掉后同一本书可以重新打开',
    Boolean(reopenA && reopenA.ok === true && reopenA.data.focused === false),
    reopenA
  );
  const winA2Info = (await waitWindows(2)).find((window) => window.bookPath === normPath(mwBookA.path));
  check('多窗口：重新打开的窗口登记正确', Boolean(winA2Info));
  check(
    '多窗口：重新打开的窗口进入写作页',
    (await waitIn(winA2Info.id, "window.__cwTest.view() === 'editor'")) === true &&
      normPath(await waitIn(winA2Info.id, 'window.__cwTest.bookPathValue()')) === normPath(mwBookA.path)
  );
  check(
    '多窗口：最近使用的窗口就是刚开的新窗口',
    mostRecentWindowId() === String(winA2Info.id),
    { recent: mostRecentWindowId(), winA2: winA2Info.id }
  );
  const recentReopen = await exec('window.api.getRecentBook()');
  check(
    '多窗口：继续上次写作指向最近打开的 A 书',
    Boolean(recentReopen && recentReopen.ok === true) &&
      normPath(recentReopen.data.path) === normPath(mwBookA.path),
    recentReopen
  );
  closeWindow(winA2Info.id);
  await waitWindows(1);
  check('多窗口：关掉非最后窗口应用还在', windowAllClosed() === false);

  // 55h. 书架刷新：两个窗口都在书架时，一个窗口新建书，另一个窗口的书架自动刷新
  const openA3 = await exec(`window.api.openBookInNewWindow(${JSON.stringify(mwBookA.path)})`);
  check('多窗口：再次在新窗口打开 A', Boolean(openA3 && openA3.ok === true));
  const winA3Info = (await waitWindows(2)).find((window) => window.bookPath === normPath(mwBookA.path));
  check('多窗口：第三个窗口登记正确', Boolean(winA3Info));
  await waitIn(winA3Info.id, "window.__cwTest.view() === 'editor'");
  await execIn(winA3Info.id, 'window.__cwTest.backToShelf()');
  await waitIn(winA3Info.id, "window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '多窗口：两个窗口都停在书架',
    liveWindows().length === 2 && (await execIn(winA3Info.id, "window.__cwTest.view() === 'shelf'")) === true
  );
  await exec("window.__cwTest.newBook('多窗口新书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const shelfRefreshed = await waitIn(
    winA3Info.id,
    "window.__cwTest.shelfTitles().includes('多窗口新书')"
  );
  check('多窗口：一个窗口新建书，另一个窗口的书架自动刷新', shelfRefreshed === true);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  closeWindow(winA3Info.id);
  await waitWindows(1);
  check('多窗口：关掉非最后窗口应用还在（书架刷新窗口）', windowAllClosed() === false);

  // 55i. 旧数据兼容：v0.4.1 形状的旧书（没有 schemaVersion）能开在新窗口，书目不被补字段
  const legacyMetaBefore = await fs.readFile(fragLegacyMetaPath, 'utf8');
  const openLegacy = await exec(`window.api.openBookInNewWindow(${JSON.stringify(fragLegacyBookPath)})`);
  check(
    '多窗口：v0.4.1 旧书能开在新窗口',
    Boolean(openLegacy && openLegacy.ok === true && openLegacy.data.focused === false),
    openLegacy
  );
  const winLegacyInfo = (await waitWindows(2)).find(
    (window) => window.bookPath === normPath(fragLegacyBookPath)
  );
  check('多窗口：旧书窗口登记正确', Boolean(winLegacyInfo));
  check(
    '多窗口：旧书在新窗口正常显示章节',
    (await waitIn(winLegacyInfo.id, "window.__cwTest.view() === 'editor'")) === true &&
      (await waitIn(winLegacyInfo.id, 'window.__cwTest.chapterTitles().length > 0')) === true
  );
  const legacyMetaAfter = await fs.readFile(fragLegacyMetaPath, 'utf8');
  check(
    '多窗口：打开旧书不补 schemaVersion / 不改书目（逐字节一致）',
    legacyMetaAfter === legacyMetaBefore && legacyMetaBefore.includes('"schemaVersion"') === false
  );
  closeWindow(winLegacyInfo.id);
  await waitWindows(1);

  // 55j. 配置 / 书库不多出东西：窗口登记只存在内存里，窗口位置仍用现有 windowBounds
  const mwConfigPath = path.join(userData, 'config.json');
  const mwConfig = JSON.parse(await fs.readFile(mwConfigPath, 'utf8'));
  const mwConfigKeys = ['openWindows', 'openBooks', 'windowSessions', 'multiWindow', 'windows'].filter(
    (key) => key in mwConfig
  );
  check('多窗口：配置没有新增窗口登记字段（登记只在内存里）', mwConfigKeys.length === 0, mwConfigKeys);
  check(
    '多窗口：窗口位置大小仍用现有 windowBounds 一个字段',
    Boolean(mwConfig.windowBounds && Number.isFinite(mwConfig.windowBounds.width))
  );
  const dirA = (await fs.readdir(mwBookA.path)).sort().join('|');
  const dirB = (await fs.readdir(mwBookB.path)).sort().join('|');
  check(
    '多窗口：书文件夹没有多出影子 / 临时文件',
    !dirA.includes('.tmp-') && !dirB.includes('.tmp-') && !dirA.includes('_trash') && !dirB.includes('_trash'),
    { dirA, dirB }
  );
  const rootEntries = await fs.readdir(booksRoot);
  check(
    '多窗口：书库根目录没有多出临时导入 / 影子书',
    rootEntries.every(
      (name) =>
        !name.startsWith('.import-') &&
        !name.startsWith('mw-import') &&
        name !== '多窗口影子' &&
        !name.startsWith('多窗口影子')
    ),
    rootEntries
  );

  // 55k. 只关最后一个窗口才退出应用：关之前记下最近窗口的位置 / 大小
  check('多窗口：关闭前只剩最后一个窗口', liveWindows().length === 1);
  const primaryBounds = windowBounds(primaryId);
  resetCloseReady(null);
  closeWindow(primaryId);
  let windowsAllClosed = false;
  for (let i = 0; i < 100; i += 1) {
    if (windowAllClosed()) {
      windowsAllClosed = true;
      break;
    }
    await sleep(100);
  }
  check(
    '多窗口：最后一个窗口关闭后应用才退出（window-all-closed）',
    windowsAllClosed === true && liveWindows().length === 0
  );
  check(
    '多窗口：退出时打开登记已清空',
    registryCounts().windows === 0 && registryCounts().openBooks === 0,
    registryCounts()
  );
  check('多窗口：最后一个窗口的关窗回执允许关闭', getCloseReady(primaryId) === true);
  const mwConfigAfterQuit = JSON.parse(await fs.readFile(mwConfigPath, 'utf8'));
  check(
    '多窗口：上次窗口位置 / 大小按最近使用的窗口记下',
    Boolean(
      primaryBounds &&
        mwConfigAfterQuit.windowBounds &&
        mwConfigAfterQuit.windowBounds.x === primaryBounds.x &&
        mwConfigAfterQuit.windowBounds.y === primaryBounds.y &&
        mwConfigAfterQuit.windowBounds.width === primaryBounds.width &&
        mwConfigAfterQuit.windowBounds.height === primaryBounds.height
    ),
    { primaryBounds, saved: mwConfigAfterQuit.windowBounds }
  );

  return { ok: true, checks: checks.length, details: checks };
};
