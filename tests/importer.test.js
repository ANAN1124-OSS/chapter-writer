const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const importer = require('../core/importer');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-import-'));
}

test('导入现成的章节写作器书：整本复制、内容一致、源文件夹保留', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '星海旅人');
  await storage.createChapter(created.path, 1, '夜雨');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '第一章内容');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.imported[0].title, '星海旅人');
  assert.equal(res.imported[0].chapters, 2);

  const importedPath = res.imported[0].path;
  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 2);
  assert.equal((await storage.loadChapterText(importedPath, meta.chapters[0].file)).text, '第一章内容');
  // 源文件夹仍然在（只复制不移动）
  await fs.access(path.join(created.path, '书目.json'));
});

test('导入一堆 txt：按文件名重建书目、内容完整、书名取文件夹名', async () => {
  const base = await mkTmp();
  const src = path.join(base, '旧稿');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '003-丙.txt'), '丙的正文', 'utf8');
  await fs.writeFile(path.join(src, '001-甲.txt'), '甲的正文', 'utf8');
  await fs.writeFile(path.join(src, '002-乙.txt'), '', 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.imported[0].chapters, 3);
  assert.equal(res.imported[0].title, '旧稿');

  const target = res.imported[0].path;
  assert.equal(path.basename(target), '旧稿');
  const meta = await storage.readBookMeta(target);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['甲', '乙', '丙']);
  assert.equal((await storage.loadChapterText(target, meta.chapters[0].file)).text, '甲的正文');
  // 书架扫描能看到这本新书
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 1);
  assert.equal(books[0].folder, '旧稿');
});

test('重复导入同名文件夹自动加 -2', async () => {
  const base = await mkTmp();
  const src = path.join(base, '旧稿');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-甲.txt'), '内容', 'utf8');
  const booksRoot = path.join(base, '书架');

  const first = await importer.importFolders(booksRoot, [src]);
  const second = await importer.importFolders(booksRoot, [src]);
  assert.equal(first.imported[0].folder, '旧稿');
  assert.equal(second.imported[0].folder, '旧稿-2');
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
});

test('没有书也没有 txt 的文件夹被跳过', async () => {
  const base = await mkTmp();
  const src = path.join(base, '空文件夹');
  await fs.mkdir(src);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /没有/);
});

test('书架目录里的文件夹不能再导入（避免自我复制）', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  const created = await storage.createBook(booksRoot, '已有的书');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 0);
  assert.match(res.skipped[0].reason, /已经在书架目录里/);
});

test('不能导入包含书架目录的上级文件夹', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  const res = await importer.importFolders(booksRoot, [base]);
  assert.equal(res.imported.length, 0);
  assert.match(res.skipped[0].reason, /不能导入包含书架目录/);
});

test('损坏的书目 + txt 会走「按 txt 重建」导入', async () => {
  const base = await mkTmp();
  const src = path.join(base, '坏书');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-甲.txt'), '甲', 'utf8');
  await fs.writeFile(path.join(src, '书目.json'), '{ 坏掉的', 'utf8');
  const booksRoot = path.join(base, '书架');

  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '甲');
});

test('不存在的路径记为跳过而不是崩溃', async () => {
  const base = await mkTmp();
  const res = await importer.importFolders(path.join(base, '书架'), [path.join(base, '不存在')]);
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /不是文件夹/);
});

test('导入小说收藏夹（自动分章模式）：每个 txt 一本书并拆分章节', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  await fs.writeFile(
    path.join(src, '第一本小说.txt'),
    '第1章 开端\n\n正文一\n\n第2章 转折\n\n正文二',
    'utf8'
  );
  await fs.writeFile(
    path.join(src, '第二本小说.txt'),
    '楔子\n\n引子内容\n\n第一章 雪夜\n\n雪夜正文',
    'utf8'
  );

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src], { mode: 'split' });
  assert.equal(res.imported.length, 2);
  assert.deepEqual(
    res.imported.map((b) => b.title).sort(),
    ['第一本小说', '第二本小说']
  );

  const first = res.imported.find((b) => b.title === '第一本小说');
  assert.equal(first.chapters, 2);
  const meta = await storage.readBookMeta(first.path);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['开端', '转折']);
  assert.equal((await storage.loadChapterText(first.path, meta.chapters[0].file)).text, '正文一');

  const second = res.imported.find((b) => b.title === '第二本小说');
  const meta2 = await storage.readBookMeta(second.path);
  assert.deepEqual(meta2.chapters.map((c) => c.name), ['楔子', '雪夜']);

  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
});

test('整本一章模式：没有标题行的短篇，一章「全文」', async () => {
  const base = await mkTmp();
  const src = path.join(base, '短篇');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '一个短篇 - 作者.txt'), '正文第一段。\n\n正文第二段。', 'utf8');
  const res = await importer.importFolders(path.join(base, '书架'), [src], { mode: 'raw' });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].title, '一个短篇 - 作者');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '全文');
  assert.ok((await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file)).text.includes('正文第二段'));
});

test('GBK 编码的小说能自动识别（默认按原文章节导入）', async () => {
  const base = await mkTmp();
  const src = path.join(base, 'GBK收藏');
  await fs.mkdir(src);
  // “第一章 中文”的 GBK 字节
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4]);
  await fs.writeFile(path.join(src, 'GBK小说.txt'), gbk);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].title, 'GBK小说');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '第一章 中文');
});

test('默认「按原文章节导入」：章名照抄原文、正文原样保留', async () => {
  const base = await mkTmp();
  const src = path.join(base, '原样');
  await fs.mkdir(src);
  const original = '第1章 开端\n\n正文一，带 全角空格　。\n\n第2章 转折\n\n正文二\n';
  await fs.writeFile(path.join(src, '一本书 - 作者.txt'), original, 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].chapters, 2);

  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['第1章 开端', '第2章 转折']);
  // 正文不做 trim：保留原文的空白行
  assert.equal((await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file)).text, '\n正文一，带 全角空格　。\n');
  assert.equal((await storage.loadChapterText(res.imported[0].path, meta.chapters[1].file)).text, '\n正文二\n');
});

test('整本一章模式：UTF-8 源文件按字节原样复制', async () => {
  const base = await mkTmp();
  const src = path.join(base, '字节一致');
  await fs.mkdir(src);
  // 故意包含标题行、全角空格、CRLF，验证一个字节都不改
  const original = '第1章 开端\r\n\r\n正文一，带 全角空格　。\r\n\r\n第2章 转折\r\n\r\n正文二\r\n';
  const buffer = Buffer.from(original, 'utf8');
  await fs.writeFile(path.join(src, '很长的书名 - 作者.txt'), buffer);

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src], { mode: 'raw' });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].chapters, 1, '不拆章，全文只有一章');

  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '全文');
  const importedBytes = await fs.readFile(path.join(res.imported[0].path, meta.chapters[0].file));
  assert.deepEqual(importedBytes, buffer, '导入的章节文件应与源 txt 字节完全一致');
});

test('收藏夹默认按原文章节导入：每本 txt 一本书、按原文标题拆章', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '书甲.txt'), '第1章 一\n\n甲正文\n\n第2章 二\n\n甲二段', 'utf8');
  await fs.writeFile(path.join(src, '书乙.txt'), '乙的整篇内容', 'utf8');
  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 2);

  const bookA = res.imported.find((b) => b.title === '书甲');
  const bookB = res.imported.find((b) => b.title === '书乙');
  assert.equal(bookA.chapters, 2);
  assert.equal(bookB.chapters, 1);
  const metaA = await storage.readBookMeta(bookA.path);
  assert.deepEqual(metaA.chapters.map((c) => c.name), ['第1章 一', '第2章 二']);
  const metaB = await storage.readBookMeta(bookB.path);
  assert.deepEqual(metaB.chapters.map((c) => c.name), ['']);

  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
});
