// E2E 第 59 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组只做「导入 / 导出边界」（v0.9 C-3，安全审计 C6）：书的 书目.json 可能来自别处（导入的文件夹），
// 书名 / 卷名 / 章名可以是 `../`、反斜杠、盘符、控制字符；导出 EPUB / DOCX 时它们只许进正文，
// 一个字节都不许进 zip 条目名（否则解压会写到包外面）；另存为的默认文件名也不许带路径分隔符。
// 导入侧：超大 txt（>128 MB）与二进制 / 坏编码 txt 必须被挡在读盘 / 建书之前，且不中断整批。
// 劫持另存为对话框、等文件落盘、读回 zip / XML 校验这几个工具都由场景交进来（组文件只 require
// node 内建，不碰产品代码；期望值来源是 core/zip 的 entryNameProblem 与 scripts/export-check.js）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group59ImportExport(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    storage,
    booksRoot,
    waitForFile,
    withSavePath,
    restoreSaveDialog,
    saveOptions,
    readZip,
    assertWellFormedXml,
    entryNameProblem,
    deleteBookWithRetry,
    importer: importerLib
  } = t;

  // 59. 导入 / 导出边界（v0.9 C-3，安全审计 C6）：
  //     书的 书目.json 可能来自别处（导入的文件夹），书名 / 卷名 / 章名可以是
  //     `../`、反斜杠、盘符、控制字符。导出 EPUB / DOCX 时它们只许进正文，
  //     一个字节都不许进 zip 条目名（否则解压会写到包外面）；另存为的默认文件名也不许带路径分隔符。
  //     导入侧：超大 txt（>128 MB）与二进制 / 坏编码 txt 必须被挡在读盘 / 建书之前，且不中断整批。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfCountBeforeC3 = (await storage.listBooks(booksRoot)).length;
  const c3BookTitle = '../../逃逸:书名';
  await exec(`window.__cwTest.newBook(${JSON.stringify(c3BookTitle)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const c3BookPath = await exec('window.__cwTest.bookPathValue()');
  const c3Meta = await storage.readBookMeta(c3BookPath);
  check(
    '导入导出边界：敌意书名能建书（文件夹名净化，书名原文照旧进书目）',
    path.resolve(path.dirname(c3BookPath)).toLowerCase() === path.resolve(booksRoot).toLowerCase() &&
      !/[\\/:*?"<>|]/.test(path.basename(c3BookPath)) &&
      c3Meta.title === c3BookTitle,
    { bookPath: c3BookPath, title: c3Meta.title }
  );
  await exec(`window.__cwTest.newVolume(${JSON.stringify('..\\..\\邪卷')})`);
  await exec(`window.__cwTest.newChapterInVolume(0, ${JSON.stringify('..\\..\\邪章')})`);
  await exec(`window.__cwTest.setText(${JSON.stringify('邪卷第一章正文。')})`);
  await exec('window.__cwTest.save()');
  const c3ChaosMeta = await storage.readBookMeta(c3BookPath);
  check(
    '导入导出边界：卷名 / 章名原文进书目（含反斜杠，故意不净化内容）',
    c3ChaosMeta.volumes.length === 1 &&
      c3ChaosMeta.volumes[0].name === '..\\..\\邪卷' &&
      c3ChaosMeta.chapters.some((chapter) => chapter.name === '..\\..\\邪章'),
    { volumes: c3ChaosMeta.volumes, names: c3ChaosMeta.chapters.map((chapter) => chapter.name) }
  );

  // 59a. EPUB：条目名白名单 + 敌意内容只在正文里
  const c3ExportDir = path.join(path.dirname(booksRoot), 'c3-exports');
  await fs.mkdir(c3ExportDir, { recursive: true });
  const c3EpubPath = path.join(c3ExportDir, 'evil.epub');
  withSavePath(c3EpubPath);
  let c3EpubResult;
  try {
    c3EpubResult = await exec(
      `window.api.exportEpub(${JSON.stringify(c3BookPath)}, null, null).then((r) => JSON.stringify(r))`
    ).then((text) => JSON.parse(text));
    await waitForFile(c3EpubPath);
  } finally {
    restoreSaveDialog();
  }
  check(
    '导入导出边界：EPUB 导出成功（2 章 / 1 卷）',
    Boolean(c3EpubResult && c3EpubResult.ok === true) &&
      c3EpubResult.data.chapterCount === 2 &&
      c3EpubResult.data.volumeCount === 1,
    c3EpubResult && c3EpubResult.data
  );
  check(
    '导入导出边界：EPUB 另存为默认文件名不含路径分隔符 / 非法字符',
    Boolean(saveOptions()) && path.basename(saveOptions().defaultPath) === '逃逸书名.epub',
    saveOptions() && saveOptions().defaultPath
  );
  const c3EpubZip = readZip(await fs.readFile(c3EpubPath));
  const c3EpubNameOk = c3EpubZip.names.every(
    (name) =>
      entryNameProblem(name) === '' &&
      /^(mimetype|META-INF\/container\.xml|OEBPS\/(content\.opf|nav\.xhtml|toc\.ncx|style\.css|cover\.xhtml|text\/(volume|chapter)-\d{4}\.xhtml))$/.test(
        name
      ) &&
      !name.includes('逃逸') &&
      !name.includes('邪') &&
      !name.includes('..') &&
      !name.includes('\\') &&
      !name.includes(':')
  );
  check(
    '导入导出边界：EPUB zip 条目名全是白名单形状，不含书名 / 卷名 / 章名与路径片段',
    c3EpubNameOk,
    c3EpubZip.names
  );
  const c3EpubByName = new Map(c3EpubZip.entries.map((entry) => [entry.name, entry]));
  const c3EpubText = (name) => (c3EpubByName.has(name) ? c3EpubByName.get(name).data.toString('utf8') : '');
  check(
    '导入导出边界：敌意书名 / 卷名 / 章名原样只出现在 EPUB 正文页面里',
    c3EpubText('OEBPS/cover.xhtml').includes('<h1 class="cover-title">../../逃逸:书名</h1>') &&
      c3EpubText('OEBPS/text/volume-0001.xhtml').includes('..\\..\\邪卷') &&
      c3EpubText('OEBPS/text/chapter-0002.xhtml').includes('第2章：..\\..\\邪章'),
    {
      cover: c3EpubText('OEBPS/cover.xhtml').slice(0, 200),
      chapter: c3EpubText('OEBPS/text/chapter-0002.xhtml').slice(0, 200)
    }
  );
  const c3Plan = JSON.parse(
    await exec(
      `window.api.exportPlan(${JSON.stringify(c3BookPath)}, null, null).then((r) => JSON.stringify(r))`
    )
  );
  check(
    '导入导出边界：导出预览给的三个默认文件名都不含路径分隔符（对话框只在当前目录落文件）',
    Boolean(c3Plan && c3Plan.ok === true) &&
      [c3Plan.data.fileName, c3Plan.data.epubFileName, c3Plan.data.docxFileName].every(
        (name) => typeof name === 'string' && name.length > 0 && !/[\\/:*?"<>|]/.test(name)
      ) &&
      c3Plan.data.epubFileName === '逃逸书名.epub' &&
      c3Plan.data.docxFileName === '逃逸书名.docx',
    c3Plan && c3Plan.data
  );

  // 59b. DOCX：条目名仍然只有固定七部位
  const c3DocxPath = path.join(c3ExportDir, 'evil.docx');
  const C3_DOCX_PARTS = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
    'docProps/app.xml'
  ];
  withSavePath(c3DocxPath);
  let c3DocxResult;
  try {
    c3DocxResult = await exec(
      `window.api.exportDocx(${JSON.stringify(c3BookPath)}, null, null).then((r) => JSON.stringify(r))`
    ).then((text) => JSON.parse(text));
    await waitForFile(c3DocxPath);
  } finally {
    restoreSaveDialog();
  }
  const c3DocxZip = readZip(await fs.readFile(c3DocxPath));
  check(
    '导入导出边界：DOCX zip 条目名只有固定七部位（不含书名 / 章名）',
    Boolean(c3DocxResult && c3DocxResult.ok === true) &&
      JSON.stringify(c3DocxZip.names) === JSON.stringify(C3_DOCX_PARTS) &&
      c3DocxZip.names.every((name) => entryNameProblem(name) === ''),
    c3DocxZip.names
  );
  const c3DocxDocument = c3DocxZip.entries.find((entry) => entry.name === 'word/document.xml').data.toString('utf8');
  assertWellFormedXml(c3DocxDocument, 'word/document.xml');
  check(
    '导入导出边界：敌意书名 / 章名原样只出现在 DOCX 正文里（XML 仍是合法文档）',
    c3DocxDocument.includes('>../../逃逸:书名</w:t>') &&
      c3DocxDocument.includes('>第2章：..\\..\\邪章</w:t>'),
    c3DocxDocument.slice(0, 400)
  );

  // 59c. 导入侧：超大 / 二进制 txt 挡在读盘之前，好书照常导入；书库里不留半成品
  const c3ImportSrc = path.join(path.dirname(booksRoot), 'c3-import-src');
  await fs.mkdir(c3ImportSrc, { recursive: true });
  await fs.writeFile(path.join(c3ImportSrc, '正常书.txt'), '第1章 开端\n\n正常正文。', 'utf8');
  await fs.writeFile(path.join(c3ImportSrc, '二进制书.txt'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  const c3HugePath = path.join(c3ImportSrc, '超大书.txt');
  await fs.writeFile(c3HugePath, '');
  // 稀疏文件：只改长度，不真的写 128 MB 字节
  await fs.truncate(c3HugePath, importerLib.MAX_IMPORT_BYTES + 1);
  const rootEntriesBeforeImport = await fs.readdir(booksRoot);
  const c3Import = JSON.parse(
    await exec(
      `window.api.importBooks([${JSON.stringify(c3ImportSrc)}], { mode: 'chapters' }).then((r) => JSON.stringify(r))`
    )
  );
  const c3ImportFailed = (c3Import && c3Import.ok === true && c3Import.data.failed) || [];
  const c3ImportImported = (c3Import && c3Import.ok === true && c3Import.data.imported) || [];
  check(
    '导入边界：收藏夹里好书照常导入，超大 / 二进制文件分别被拒（不中断整批）',
    c3ImportImported.length === 1 &&
      c3ImportImported[0].title === '正常书' &&
      c3ImportFailed.length === 2 &&
      c3ImportFailed.some((item) => /128 MB/.test(item.message) && /超大书/.test(item.message)) &&
      c3ImportFailed.some((item) => /不是纯文本/.test(item.message) && /二进制书/.test(item.message)),
    { imported: c3ImportImported.map((item) => item.title), failed: c3ImportFailed.map((item) => item.message) }
  );
  const rootEntriesAfterImport = await fs.readdir(booksRoot);
  check(
    '导入边界：被拒的文件没有建书、没有留下临时导入目录（正常书建了且只有一本）',
    !rootEntriesAfterImport.includes('超大书') &&
      !rootEntriesAfterImport.includes('二进制书') &&
      rootEntriesAfterImport.filter((name) => name === '正常书').length === 1 &&
      rootEntriesAfterImport.every((name) => !name.startsWith('.import-')) &&
      rootEntriesAfterImport.length === rootEntriesBeforeImport.length + 1,
    rootEntriesAfterImport
  );

  // 59d. 收尾：先回书架（不留下「正开着的书被删」的怪异状态），再删掉演练用的两本书
  //      （E2E 走书架 _trash 兜底，不碰回收站），最后刷新书架、确认数量回到演练前。
  //      删除带重试：Windows 上刚写完的文件偶尔被 Defender / 索引器短暂占用，
  //      `fs.rename` 会回 EPERM（同一次实测：几秒后手动 rename 立刻成功）；生产走回收站 API，不靠这里。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(300);
  const c3NormalPath = c3ImportImported[0].path;
  for (const bookToDelete of [c3BookPath, c3NormalPath]) {
    const deleted = await deleteBookWithRetry(bookToDelete);
    check(
      `导入导出边界：演练书已移入书架 _trash（${path.basename(bookToDelete)}）`,
      Boolean(deleted && deleted.ok === true) && deleted.data.method === 'move',
      deleted
    );
  }
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const c3ShelfAfter = (await storage.listBooks(booksRoot)).length;
  check(
    '导入导出边界：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    c3ShelfAfter === shelfCountBeforeC3,
    { before: shelfCountBeforeC3, after: c3ShelfAfter }
  );
};
