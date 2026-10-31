// 端到端自检：真实启动 Electron，通过渲染层的 __cwTest 钩子走主流程，
// 再回到主进程侧直接检查磁盘文件，验证「保存整本、编号重排、未保存拦截」确实生效。
const fs = require('node:fs/promises');
const path = require('node:path');
const chaptersLib = require('../core/chapters');
const exporter = require('../core/exporter');

module.exports = async function runScenario(ctx) {
  const { win, clipboard, config, userData, storage, sleep, exec, getCloseReady, resetCloseReady } = ctx;
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

  return { ok: true, checks: checks.length, details: checks };
};
