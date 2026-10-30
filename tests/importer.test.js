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
  assert.equal(res.imported[0].kind, 'txts');
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
  assert.equal(res.imported[0].kind, 'txts');
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
