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

// v0.9 C-3（安全审计 C6）：导入是「整个 txt 读进内存 → 解码 → 切章」，
// 用大小闸门挡住病态大文件（免得主进程 OOM），用 NUL 闸门挡住二进制 / 坏编码，
// 而不是把一本乱码书塞进书架。
test('导入边界：大小闸门（纯逻辑）——上限内放过，超限回 FILE_TOO_LARGE，提示不含目录', () => {
  assert.equal(importer.importSizeProblem(0, '书'), null);
  assert.equal(importer.importSizeProblem(importer.MAX_IMPORT_BYTES, '书'), null);
  const over = importer.importSizeProblem(importer.MAX_IMPORT_BYTES + 1, '超大字');
  assert.equal(over.code, 'FILE_TOO_LARGE');
  assert.ok(over.message.includes('超大字'), over.message);
  assert.ok(over.message.includes('128 MB'), over.message);
  assert.ok(!over.message.includes('\\') && !over.message.includes('/'), '提示里不该带目录');
  // stat 拿不到 / 坏值不拦（交给后面的读盘报错）
  assert.equal(importer.importSizeProblem(NaN, '书'), null);
  assert.equal(importer.importSizeProblem(-1, '书'), null);
  assert.equal(importer.importSizeProblem(undefined, '书'), null);
  // 体量文案
  assert.equal(importer.formatImportSize(0), '0 B');
  assert.equal(importer.formatImportSize(512), '512 B');
  assert.equal(importer.formatImportSize(1536), '1.5 KB');
  assert.equal(importer.formatImportSize(128 * 1024 * 1024), '128 MB');
  assert.equal(importer.formatImportSize(3 * 1024 * 1024 * 1024), '3.0 GB');
});

test('导入边界：编码闸门（纯逻辑）——含 NUL 的当二进制，带 BOM 的 UTF-16 放过', () => {
  assert.equal(importer.isProbablyBinary(Buffer.from('正常中文文本', 'utf8')), false);
  assert.equal(importer.isProbablyBinary(Buffer.alloc(0)), false);
  assert.equal(importer.isProbablyBinary(null), false);
  assert.equal(importer.isProbablyBinary(Buffer.from([0x00, 0x01, 0x02])), true);
  assert.equal(importer.isProbablyBinary(Buffer.from('正文\u0000尾巴', 'utf8')), true);
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第1章 开端', 'utf16le')]);
  assert.equal(importer.hasUtf16Bom(utf16le), true);
  assert.equal(importer.isProbablyBinary(utf16le), false);
  assert.equal(importer.hasUtf16Bom(Buffer.from([0xfe, 0xff, 0x00])), true);
  assert.equal(importer.hasUtf16Bom(Buffer.from([0xef, 0xbb, 0xbf])), false);
});

test('导入边界：超过上限的 txt 直接拒绝，不建书、不留临时目录、不建书架目录', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const huge = path.join(src, '超大书.txt');
  await fs.writeFile(huge, '');
  // 稀疏文件：只把长度改到上限 +1，不真的写 128 MB 字节
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);
  const booksRoot = path.join(base, '书架');
  await assert.rejects(
    () => importer.importNovelFile(booksRoot, huge),
    (err) =>
      err.code === 'FILE_TOO_LARGE' &&
      err.message.includes('128 MB') &&
      err.message.includes('超大书') &&
      !err.message.includes(base)
  );
  const entries = await fs.readdir(booksRoot).catch(() => []);
  assert.deepEqual(entries, [], '被拒绝的导入不该在书架里留下任何东西');
});

test('导入边界：二进制 txt 不导入乱码书（NOT_TEXT，不建书）', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const bin = path.join(src, '其实是图片.txt');
  await fs.writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00, 0x01, 0x02]));
  const booksRoot = path.join(base, '书架');
  await assert.rejects(
    () => importer.importNovelFile(booksRoot, bin),
    (err) => err.code === 'NOT_TEXT' && err.message.includes('不是纯文本')
  );
  assert.deepEqual(await fs.readdir(booksRoot).catch(() => []), []);
});

test('导入边界：收藏夹里混着坏文件 → 好书照常导入、坏文件进 failed，不中断整批', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '好书.txt'), '第1章 开端\n\n正文。', 'utf8');
  await fs.writeFile(path.join(src, '坏书.txt'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].title, '好书');
  assert.equal(res.failed.length, 1);
  assert.ok(res.failed[0].source.endsWith('坏书.txt'));
  assert.ok(res.failed[0].message.includes('不是纯文本'), res.failed[0].message);
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 1);
});

test('导入边界：UTF-16（带 BOM）的 txt 照旧按原文导入，不被 NUL 闸门误伤', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const file = path.join(src, 'UTF16书.txt');
  await fs.writeFile(file, Buffer.from('\uFEFF第1章 开端\n\n正文。', 'utf16le'));
  const booksRoot = path.join(base, '书架');
  const res = await importer.importNovelFile(booksRoot, file);
  assert.equal(res.chapters, 1);
  const meta = await storage.readBookMeta(res.path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '第1章 开端');
  assert.ok((await storage.loadChapterText(res.path, meta.chapters[0].file)).text.includes('正文。'));
});
