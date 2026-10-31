const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const { atomicWriteFile } = require('../core/atomic');

async function mkTmp(prefix = 'cw-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('createBook：建文件夹、初始空章、合法书目', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '星海旅人');
  assert.equal(meta.title, '星海旅人');
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.fileSeq, 1);
  const files = (await fs.readdir(bookPath)).sort();
  assert.deepEqual(files, ['001-未命名.txt', '书目.json']);
  const metaOnDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(metaOnDisk.chapters[0].file, '001-未命名.txt');
});

test('createBook：同名自动加后缀，空书名兜底', async () => {
  const root = await mkTmp();
  const a = await storage.createBook(root, '草稿');
  const b = await storage.createBook(root, '草稿');
  const c = await storage.createBook(root, '   ');
  assert.notEqual(a.path, b.path);
  assert.ok(b.path.endsWith('草稿-2'));
  assert.equal(c.meta.title, '我的新书');
});

test('章节保存/读取往返：落盘 CRLF、无 BOM，读回 LF', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '测试书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '第一行\n第二行\n');
  const raw = await fs.readFile(path.join(bookPath, file));
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  assert.equal(hasBom, false, '不应有 BOM');
  assert.equal(raw.toString('utf8'), '第一行\r\n第二行\r\n');
  const loaded = await storage.loadChapterText(bookPath, file);
  assert.equal(loaded.text, '第一行\n第二行\n');
});

test('外部 BOM 文件也能正常读入', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '测试书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await fs.writeFile(path.join(bookPath, file), '\uFEFF带BOM的内容\r\n', 'utf8');
  const loaded = await storage.loadChapterText(bookPath, file);
  assert.equal(loaded.text, '带BOM的内容\n');
});

test('writeBookMeta：每次写入前生成 .bak（上一版）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份测试');
  let meta = await storage.readBookMeta(bookPath);
  await storage.renameBook(bookPath, '备份测试-改名');
  const bak = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8'));
  assert.equal(bak.title, '备份测试');
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.title, '备份测试-改名');
});

test('插入章节：新文件命名、旧文件不重命名、顺序正确', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '插入测试');
  await storage.createChapter(bookPath, 1, '起风');
  await storage.createChapter(bookPath, 2, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const before = meta.chapters.map((c) => c.file);
  assert.deepEqual(before, ['001-未命名.txt', '002-起风.txt', '003-夜雨.txt']);

  const inserted = await storage.createChapter(bookPath, 1, '灯塔');
  meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['', '灯塔', '起风', '夜雨']);
  assert.deepEqual(meta.chapters.map((c) => c.file), ['001-未命名.txt', '004-灯塔.txt', '002-起风.txt', '003-夜雨.txt']);
  // 旧文件在磁盘上原样存在，未被改名
  for (const f of before) {
    await fs.access(path.join(bookPath, f));
  }
  assert.equal(inserted.index, 1);
});

test('重命名章节：只改 name，不动文件名', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '重命名测试');
  const meta = await storage.readBookMeta(bookPath);
  const chapter = meta.chapters[0];
  const res = await storage.renameChapter(bookPath, chapter.id, '新的名字');
  assert.equal(res.chapter.name, '新的名字');
  assert.equal(res.chapter.file, chapter.file);
  await fs.access(path.join(bookPath, chapter.file));
});

test('删除章节：文件移入 _trash，json 移除，删空后自动补一章', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删除测试');
  await storage.createChapter(bookPath, 1, '甲');
  let meta = await storage.readBookMeta(bookPath);
  const target = meta.chapters[1];
  const res = await storage.deleteChapter(bookPath, target.id);
  assert.ok(res.trashPath.includes('_trash'));
  await fs.access(res.trashPath);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);
  // 删到空
  await storage.deleteChapter(bookPath, meta.chapters[0].id);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1, '空书自动补一章');
  assert.equal(meta.chapters[0].name, '');
});

test('listBooks：扫描、统计、损坏标记', async () => {
  const root = await mkTmp();
  await storage.createBook(root, '好书');
  const bad = await storage.createBook(root, '坏书');
  await storage.saveChapterText(bad.path, '001-未命名.txt', '内容内容');
  await fs.writeFile(path.join(bad.path, '书目.json'), '{ 这不是 json', 'utf8');
  // 无书目的子目录应被忽略
  await fs.mkdir(path.join(root, '普通文件夹'));
  // _ 开头的目录应被忽略
  await fs.mkdir(path.join(root, '_backup'));

  const books = await storage.listBooks(root);
  assert.equal(books.length, 2);
  const good = books.find((b) => b.folder === '好书');
  const corrupt = books.find((b) => b.folder === '坏书');
  assert.equal(good.status, 'ok');
  assert.equal(good.chapterCount, 1);
  assert.equal(corrupt.status, 'corrupt');
  assert.match(corrupt.reason, /解析失败/);
});

test('verifyBook 报告缺失的章节文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '缺失测试');
  await storage.createChapter(bookPath, 1, '夜雨');
  const meta = await storage.readBookMeta(bookPath);
  await fs.unlink(path.join(bookPath, meta.chapters[1].file));
  const report = await storage.verifyBook(bookPath);
  assert.equal(report.chapterCount, 2);
  assert.deepEqual(report.missing, [meta.chapters[1].file]);
});

test('原子写：目标被目录占用时抛错且不残留临时文件', async () => {
  const root = await mkTmp();
  const target = path.join(root, 'x.txt');
  await fs.mkdir(target); // 让 rename 失败
  await assert.rejects(() => atomicWriteFile(target, 'hello'));
  const leftovers = (await fs.readdir(root)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('路径越界防护：bookPath 之外的 file 被拒绝', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '越界测试');
  await assert.rejects(
    () => storage.loadChapterText(bookPath, '..\\..\\outside.txt'),
    (err) => err.code === 'BAD_PATH'
  );
  await assert.rejects(
    () => storage.saveChapterText(bookPath, 'C:\\Windows\\win.ini', 'x'),
    (err) => err.code === 'BAD_PATH'
  );
});

test('并发写操作串行化：改名不会被「记住上次章节」覆盖', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '并发测试');
  await storage.createChapter(bookPath, 1, '夜雨');
  const meta = await storage.readBookMeta(bookPath);
  const targetId = meta.chapters[1].id;

  await Promise.all([
    storage.renameChapter(bookPath, meta.chapters[0].id, '改名后'),
    storage.setLastOpenChapter(bookPath, targetId),
    storage.createChapter(bookPath, 2, '第三')
  ]);

  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters[0].name, '改名后', '改名不能被并发写覆盖');
  assert.equal(after.lastOpenChapterId, targetId);
  assert.equal(after.chapters.length, 3, '插入不能被并发写覆盖');
});

test('整本书兜底删除：移入书架 _trash，扫描时不再出现', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '待删的书');
  const dest = await storage.trashBook(root, bookPath);
  assert.ok(dest.includes('_trash'));
  await fs.access(path.join(dest, '书目.json'));
  const books = await storage.listBooks(root);
  assert.equal(books.length, 0);
  // 留在 _trash 里的书还能被人工读出来
  const meta = await storage.readBookMeta(dest);
  assert.equal(meta.title, '待删的书');
});

test('字数缓存：旧书首次扫描会补缓存，之后书架统计不再重读全书', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '字数缓存');
  const meta = await storage.readBookMeta(bookPath);
  // 直接写文件，模拟「没有 chars 缓存的旧书」
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '雨下了一夜。');
  const books = await storage.listBooks(root);
  assert.equal(books[0].totalChars, 6);
  const cached = await storage.readBookMeta(bookPath);
  assert.equal(cached.chapters[0].chars, 6, '首次扫描应把字数缓存写回书目');
  // 再扫一次结果一致
  const again = await storage.listBooks(root);
  assert.equal(again[0].totalChars, 6);
});

test('拖拽排序：只改书目顺序，章节文件一个都不改名', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '排序书');
  let meta = await storage.readBookMeta(bookPath);
  const firstId = meta.chapters[0].id;
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  meta = await storage.readBookMeta(bookPath);
  const filesBefore = meta.chapters.map((c) => c.file);
  const idsBefore = meta.chapters.map((c) => c.id);

  // 把第 3 章拖到最前
  const res = await storage.moveChapter(bookPath, idsBefore[2], 0);
  assert.equal(res.moved, true);
  assert.equal(res.from, 2);
  assert.equal(res.to, 0);
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.id), [idsBefore[2], idsBefore[0], idsBefore[1]]);
  assert.deepEqual(after.chapters.map((c) => c.file).sort(), filesBefore.slice().sort(), '文件名不能变');
  // 顺序颠倒后，原文件内容还跟着它自己的章节走
  await storage.saveChapterText(bookPath, after.chapters[0].file, '第三章的内容');
  const loaded = await storage.loadChapterText(bookPath, after.chapters[0].file);
  assert.equal(loaded.text, '第三章的内容');

  // 越界目标被夹住；原地移动返回 moved=false
  const clamped = await storage.moveChapter(bookPath, firstId, 999);
  assert.equal(clamped.to, after.chapters.length - 1);
  const noop = await storage.moveChapter(bookPath, firstId, clamped.to);
  assert.equal(noop.moved, false);
});

test('全书查找：跨章统计命中，返回上下文；只读不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '查找书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明走进屋里。\n阿明坐下。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '这里没有那个人。');
  await storage.createChapter(bookPath, 2, '第三章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[2].file, '阿明抬头看了看天。');

  const res = await storage.searchBook(bookPath, { query: '阿明' });
  assert.equal(res.totalMatches, 3);
  assert.equal(res.chapterCount, 2);
  assert.equal(res.results[0].count, 2);
  assert.equal(res.results[1].name, '第三章');
  assert.equal(res.results[0].matches[0].match, '阿明');
  assert.ok(res.results[0].matches[0].after.includes('走进'));

  const none = await storage.searchBook(bookPath, { query: '不存在的人' });
  assert.equal(none.totalMatches, 0);
  await assert.rejects(() => storage.searchBook(bookPath, { query: '  ' }), /不能为空/);
});

test('全书替换：先备份原文件到 _trash，再原子写盘并更新字数缓存', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '替换书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明说：阿明走了。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明回头。');
  meta = await storage.readBookMeta(bookPath);
  const firstFile = meta.chapters[0].file;
  const secondFile = meta.chapters[1].file;

  const res = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(res.chaptersChanged, 2);
  assert.equal(res.occurrences, 3);
  assert.ok(res.backupDir && res.backupDir.includes('替换备份-'));
  // 备份里是替换前的原文
  const backupText = await fs.readFile(path.join(res.backupDir, firstFile), 'utf8');
  assert.equal(backupText, '阿明说：阿明走了。');
  // 新内容已落盘（CRLF）
  const raw = await fs.readFile(path.join(bookPath, firstFile), 'utf8');
  assert.equal(raw, '小明说：小明走了。');
  assert.equal((await storage.loadChapterText(bookPath, secondFile)).text, '小明回头。');
  // 书目里的字数缓存跟着更新
  const updated = await storage.readBookMeta(bookPath);
  assert.equal(updated.chapters[0].chars, 9);
  assert.equal(updated.chapters[1].chars, 5);
  // 不命中的替换不产生备份目录
  const res2 = await storage.replaceInBook(bookPath, { query: '不存在', replacement: 'x' });
  assert.equal(res2.chaptersChanged, 0);
  assert.equal(res2.backupDir, null);
});

test('替换备份：列出最近一次整本替换的备份（最近在前）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份列表书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明来了。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明走了。');

  assert.deepEqual(await storage.listReplaceBackups(bookPath), [], '没替换过时没有备份');

  const first = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const list = await storage.listReplaceBackups(bookPath);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, path.basename(first.backupDir));
  assert.equal(list[0].fileCount, 2);
  assert.ok(list[0].totalBytes > 0);
  assert.deepEqual(
    list[0].files.slice().sort(),
    meta.chapters.map((chapter) => chapter.file).sort()
  );
});

test('替换备份：还原回替换前正文，并把当前内容再备份一份（可回头）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原书');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '阿明来了。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '小明来了。');

  const backupName = path.basename(replaced.backupDir);
  const res = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(res.restored, 1);
  assert.equal(res.skipped, 0);
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '阿明来了。');
  // 还原前把「替换后」的内容也备份了一份，点错了还能找回
  assert.ok(res.restoreBackupDir && res.restoreBackupDir.includes('还原前备份-'));
  const safety = await fs.readFile(path.join(res.restoreBackupDir, file0), 'utf8');
  assert.equal(safety, '小明来了。');
  // 字数缓存跟着还原后的正文更新
  const updated = await storage.readBookMeta(bookPath);
  assert.equal(updated.chapters[0].chars, 5);
  // 原替换备份还在（不消耗），可以再还原；还原前备份不算「替换备份」
  const list = await storage.listReplaceBackups(bookPath);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, backupName);
});

test('替换备份：非法目录名 / 不存在的备份 / 已删章节都被安全处理', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '安全书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明一。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明二。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);

  await assert.rejects(
    () => storage.restoreReplaceBackup(bookPath, `../${backupName}`),
    /不合法|不存在/
  );
  await assert.rejects(() => storage.restoreReplaceBackup(bookPath, '替换备份-2099'), /不存在/);

  // 删掉第二章后再还原：只还原还在书里的章节，已删章节跳过（不偷偷复活）
  await storage.deleteChapter(bookPath, meta.chapters[1].id);
  const res = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(res.restored, 1);
  assert.equal(res.skipped, 1);
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[0].file)).text, '阿明一。');
});
