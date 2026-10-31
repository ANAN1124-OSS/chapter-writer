const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const history = require('../core/history');
const storage = require('../core/storage');

async function mkTmp(prefix = 'cw-history-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeBook(root, title = '历史测试书') {
  return storage.createBook(root, title);
}

async function writeBackupDir(bookPath, name, files) {
  const dir = path.join(bookPath, '_trash', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), text, 'utf8');
  }
  return dir;
}

async function listDirNames(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('历史：解析备份目录名里的时间戳', () => {
  const at = new Date(2026, 9, 31, 21, 30, 0).getTime();
  assert.equal(history.parseStampTime('2026-10-31-213000'), at);
  assert.equal(history.parseStampTime('2026-10-31-213000-2'), at);
  assert.equal(history.parseStampTime('2026-13-01-000000'), 0);
  assert.equal(history.parseStampTime('2026-02-30-120000'), 0);
  assert.equal(history.parseStampTime('乱七八糟'), 0);
  assert.equal(history.parseStampTime(''), 0);
  assert.equal(history.parseStampTime(null), 0);
});

test('历史：时间显示为本地时间（YYYY-MM-DD HH:mm）', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(history.formatHistoryTime(at), '2026-01-02 03:04');
  assert.equal(history.formatHistoryTime(0), '');
  assert.equal(history.formatHistoryTime('x'), '');
});

test('历史：删除章节的散文件（含撞名序号）不会把 3 位原文件名误当序号', () => {
  assert.deepEqual(history.parseDeletedName('2026-10-31-213000-001-起风.txt'), {
    stamp: '2026-10-31-213000',
    originalName: '001-起风.txt'
  });
  assert.deepEqual(history.parseDeletedName('2026-10-31-213000-2-001-起风.txt'), {
    stamp: '2026-10-31-213000',
    originalName: '001-起风.txt'
  });
  assert.deepEqual(history.parseDeletedName('2026-10-31-213000-12-003-夜雨.txt'), {
    stamp: '2026-10-31-213000',
    originalName: '003-夜雨.txt'
  });
  for (const bad of ['001-起风.txt', '2026-10-31-213000-书目.json', '', null, 42]) {
    assert.equal(history.parseDeletedName(bad), null, String(bad));
  }
});

test('历史：备份目录 / 散文件归类', () => {
  assert.equal(history.classifyDirName('替换备份-2026-10-31-213000').source, 'replace');
  assert.equal(history.classifyDirName('整理备份-2026-10-31-213000').source, 'format');
  assert.equal(history.classifyDirName('还原前备份-2026-10-31-213000').source, 'restore');
  assert.equal(history.classifyDirName('快照-2026-10-31-213000').source, 'snapshot');
  assert.equal(history.classifyDirName('随便一个文件夹').source, 'other');
  assert.equal(history.classifyDirName('../逃出去'), null);
  assert.equal(history.classifyDirName('.hidden'), null);

  assert.equal(history.classifyLooseName('书目.json.bak').source, 'bookmeta');
  const deleted = history.classifyLooseName('2026-10-31-213000-001-起风.txt');
  assert.equal(deleted.source, 'delete');
  assert.equal(deleted.originalName, '001-起风.txt');
  assert.equal(history.classifyLooseName('随便.txt').source, 'other');
  assert.equal(history.classifyLooseName('../逃出去.txt'), null);
  assert.equal(history.classifyLooseName('.tmp-1'), null);

  assert.equal(history.sourceLabel('replace'), '整本替换');
  assert.equal(history.sourceLabel('bookmeta'), '书目备份');
  assert.equal(history.sourceLabel('unknown'), '其他备份');
});

test('历史：扫描 _trash 与 书目.json.bak，标出还在书里的章节', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(bookPath, { recursive: true });
  await fs.writeFile(path.join(bookPath, '001-a.txt'), '现稿', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json.bak'), '{"chapters":[]}', 'utf8');

  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    '001-a.txt': '替换前的甲',
    '009-gone.txt': '替换前的乙',
    '说明.md': '人工备注'
  });
  await writeBackupDir(bookPath, '整理备份-2026-10-31-200000', { '001-a.txt': '整理前的甲' });
  await writeBackupDir(bookPath, '还原前备份-2026-10-31-220000-2', { '001-a.txt': '还原前的甲' });
  await writeBackupDir(bookPath, '快照-2026-10-31-230000', { '001-a.txt': '快照里的甲' });
  await writeBackupDir(bookPath, '随便一个文件夹', { 'x.txt': '未知' });
  await fs.writeFile(path.join(bookPath, '_trash', '2026-10-31-215000-009-gone.txt'), '已删章节', 'utf8');
  await fs.writeFile(path.join(bookPath, '_trash', '未知文件.bin'), '未知', 'utf8');
  await fs.writeFile(path.join(bookPath, '_trash', '.tmp-1'), '临时', 'utf8');

  const data = await history.listHistory(bookPath, { chapterFiles: ['001-a.txt'] });
  assert.equal(data.groupCount, 8);

  const bySource = (source) => data.groups.filter((group) => group.source === source);
  assert.equal(bySource('replace').length, 1);
  assert.equal(bySource('format').length, 1);
  assert.equal(bySource('restore').length, 1);
  assert.equal(bySource('snapshot').length, 1);
  assert.equal(bySource('delete').length, 1);
  assert.equal(bySource('bookmeta').length, 1);
  assert.equal(bySource('other').length, 2);

  const replace = bySource('replace')[0];
  assert.equal(replace.sourceLabel, '整本替换');
  assert.equal(replace.kind, 'dir');
  assert.equal(replace.fileCount, 3);
  assert.equal(replace.restorableCount, 1);
  const current = replace.files.find((file) => file.name === '001-a.txt');
  const gone = replace.files.find((file) => file.name === '009-gone.txt');
  const doc = replace.files.find((file) => file.name === '说明.md');
  assert.equal(current.restorable, true);
  assert.equal(current.inBook, true);
  assert.equal(gone.restorable, false);
  assert.equal(gone.inBook, false);
  assert.match(gone.reason, /不在书里/);
  assert.equal(doc.restorable, false);
  assert.equal(doc.previewable, true);

  const deleted = bySource('delete')[0];
  assert.equal(deleted.kind, 'file');
  assert.equal(deleted.files[0].name, '009-gone.txt');
  assert.equal(deleted.files[0].restorable, true);
  assert.equal(deleted.files[0].previewable, true);

  const meta = bySource('bookmeta')[0];
  assert.equal(meta.id, 'bak');
  assert.equal(meta.files[0].name, '书目.json.bak');
  assert.equal(meta.files[0].restorable, false);
  assert.equal(meta.restorableCount, 0);
  assert.match(meta.note, /只供查看/);

  // 有明确时间戳的组按时间倒序：快照 23:00 > 还原前 22:00 > 删章 21:50 > 替换 21:00 > 整理 20:00
  const stampOrder = data.groups
    .filter((group) => ['snapshot', 'restore', 'delete', 'replace', 'format'].includes(group.source))
    .map((group) => group.source);
  assert.deepEqual(stampOrder, ['snapshot', 'restore', 'delete', 'replace', 'format']);

  // 只读：扫描不删/不改任何备份或章节
  assert.equal(await fs.readFile(path.join(bookPath, '_trash', '未知文件.bin'), 'utf8'), '未知');
  assert.equal(await fs.readFile(path.join(bookPath, '001-a.txt'), 'utf8'), '现稿');
});

test('历史：没有 _trash、没有 .bak 的旧书返回空列表', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '空书');
  await fs.mkdir(bookPath, { recursive: true });
  const data = await history.listHistory(bookPath, { chapterFiles: [] });
  assert.equal(data.groupCount, 0);
  assert.equal(data.fileCount, 0);
  assert.deepEqual(data.groups, []);
  assert.equal(data.trashPath, path.join(bookPath, '_trash'));
});

test('历史：预览只读、去 BOM、拒绝目录穿越', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(path.join(bookPath, '_trash'), { recursive: true });
  await fs.writeFile(path.join(bookPath, '书目.json.bak'), '{"chapters":[{"file":"001-a.txt"}]}', 'utf8');
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    '001-a.txt': '\uFEFF替换前正文\r\n第二行'
  });

  const preview = await history.readHistoryFile(
    bookPath,
    'dir:替换备份-2026-10-31-210000',
    '001-a.txt'
  );
  assert.equal(preview.text, '替换前正文\r\n第二行');
  assert.equal(preview.truncated, false);
  assert.equal(preview.fileName, '001-a.txt');
  assert.equal(preview.sourceLabel, '整本替换');

  const bak = await history.readHistoryFile(bookPath, 'bak', '书目.json.bak');
  assert.match(bak.text, /001-a\.txt/);
  assert.equal(bak.source, 'bookmeta');

  await assert.rejects(
    history.readHistoryFile(bookPath, 'dir:替换备份-2026-10-31-210000', '../书目.json', {}),
    (err) => err.code === 'BAD_FILE'
  );
  await assert.rejects(history.readHistoryFile(bookPath, 'dir:../逃出去', 'x'), (err) => err.code === 'BAD_GROUP');
  await assert.rejects(
    history.readHistoryFile(bookPath, 'dir:替换备份-2026-10-31-210000', '不存在.txt'),
    (err) => err.code === 'HISTORY_FILE_MISSING'
  );
});

test('历史：大文件预览只读开头并标记 truncated', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(bookPath, { recursive: true });
  const bigText = '甲'.repeat(300000); // 900KB UTF-8，超过 512KB 上限
  await writeBackupDir(bookPath, '整理备份-2026-10-31-210000', { '001-big.txt': bigText });
  const preview = await history.readHistoryFile(bookPath, 'dir:整理备份-2026-10-31-210000', '001-big.txt');
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.length > 100000);
  assert.ok(preview.size > history.PREVIEW_MAX_BYTES);
});

test('历史：storage.listBookHistory 读取当前章节，书目损坏时也能列出备份', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '历史列表书');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 2);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一章现稿\n');
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二章现稿\n');
  await storage.renameBook(bookPath, '历史列表书-改名'); // 触发第二版书目，生成 .bak
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    [meta.chapters[0].file]: '第一章旧稿\n'
  });

  const listed = await storage.listBookHistory(bookPath);
  assert.equal(listed.title, '历史列表书-改名');
  assert.ok(listed.groups.length >= 2);
  const replace = listed.groups.find((group) => group.source === 'replace');
  assert.ok(replace);
  assert.equal(replace.files[0].inBook, true);
  assert.equal(replace.files[0].restorable, true);
  assert.ok(listed.groups.some((group) => group.source === 'bookmeta'));

  // 书目坏了：列表照常可用（章节按「不在书里」处理），预览备份不受影响
  await fs.writeFile(path.join(bookPath, '书目.json'), '{坏掉的', 'utf8');
  const broken = await storage.listBookHistory(bookPath);
  assert.equal(broken.title, '');
  const brokenReplace = broken.groups.find((group) => group.source === 'replace');
  assert.equal(brokenReplace.files[0].inBook, false);
  assert.equal(brokenReplace.files[0].restorable, false);
});

test('历史：还原单章覆盖书内正文，先把当前内容备份到 还原前备份-*', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '还原单章书');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const [file1, file2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file1, '第一章现稿。\n');
  await storage.saveChapterText(bookPath, file2, '第二章现稿。\n');
  meta = await storage.readBookMeta(bookPath);
  meta.chapters[0].chars = 6;
  meta.chapters[1].chars = 6;
  await storage.writeBookMeta(bookPath, meta);
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    [file1]: '第一章备份旧稿。\r\n',
    [file2]: '第二章备份旧稿。\r\n'
  });

  const result = await storage.restoreHistoryFile(
    bookPath,
    'dir:替换备份-2026-10-31-210000',
    file1
  );
  assert.equal(result.restored, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.restoreBackupDir);

  const restored = await storage.loadChapterText(bookPath, file1);
  assert.equal(restored.text, '第一章备份旧稿。\n');
  const untouched = await storage.loadChapterText(bookPath, file2);
  assert.equal(untouched.text, '第二章现稿。\n');

  const restoreDir = result.restoreBackupDir;
  assert.equal(await fs.readFile(path.join(restoreDir, file1), 'utf8'), '第一章现稿。\r\n');

  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters[0].chars, 8);
  assert.equal(meta.chapters[1].chars, 6);

  // 原备份不消耗，可以重复还原
  const again = await storage.listBookHistory(bookPath);
  const replace = again.groups.find((group) => group.source === 'replace');
  assert.equal(replace.fileCount, 2);
  assert.equal(replace.restorableCount, 2);
});

test('历史：还原整组只还原当前章节，已删章节不复活，逐章先备份当前内容', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '还原整组书');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const [file1, file2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file1, '第一章现稿。\n');
  await storage.saveChapterText(bookPath, file2, '第二章现稿。\n');
  await writeBackupDir(bookPath, '整理备份-2026-10-31-210000', {
    [file1]: '第一章整理前。\r\n',
    [file2]: '第二章整理前。\r\n',
    '003-已删.txt': '这一章已经不在书里。\r\n'
  });

  const result = await storage.restoreHistoryGroup(bookPath, 'dir:整理备份-2026-10-31-210000');
  assert.equal(result.restored, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.total, 3);

  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '第一章整理前。\n');
  assert.equal((await storage.loadChapterText(bookPath, file2)).text, '第二章整理前。\n');
  await assert.rejects(fs.access(path.join(bookPath, '003-已删.txt')), (err) => err.code === 'ENOENT');

  const restoreFiles = (await fs.readdir(result.restoreBackupDir)).sort();
  assert.deepEqual(restoreFiles, [file1, file2].sort());
  assert.equal(await fs.readFile(path.join(result.restoreBackupDir, file1), 'utf8'), '第一章现稿。\r\n');

  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 2);
  assert.equal(meta.chapters[0].chars, 7);
  assert.equal(meta.chapters[1].chars, 7);
  assert.equal(meta.schemaVersion, 1);
});

test('历史：还原删章备份只把 txt 放回书文件夹，不改章节列表、不覆盖同名文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '找回删章书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '现稿。\n');
  await storage.renameBook(bookPath, '找回删章书-改名');
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  await fs.mkdir(path.join(bookPath, '_trash'), { recursive: true });
  await fs.writeFile(
    path.join(bookPath, '_trash', '2026-10-31-215000-003-丢失的章节.txt'),
    '丢失章节的正文。\r\n',
    'utf8'
  );

  const result = await storage.restoreHistoryFile(
    bookPath,
    'file:2026-10-31-215000-003-丢失的章节.txt',
    '003-丢失的章节.txt'
  );
  assert.equal(result.restored, 1);
  assert.equal(result.addedToBook, false);
  assert.equal(result.needsRebuild, true);
  assert.equal(
    await fs.readFile(path.join(bookPath, '003-丢失的章节.txt'), 'utf8'),
    '丢失章节的正文。\r\n'
  );
  // 书目一个字节没动：不自动加回章节、不改章号
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);

  // 书里已有同名文件：拒绝覆盖（保护书里现在的内容）
  await assert.rejects(
    storage.restoreHistoryFile(
      bookPath,
      'file:2026-10-31-215000-003-丢失的章节.txt',
      '003-丢失的章节.txt'
    ),
    (err) => err.code === 'HISTORY_TARGET_EXISTS'
  );
  assert.equal(
    await fs.readFile(path.join(bookPath, '003-丢失的章节.txt'), 'utf8'),
    '丢失章节的正文。\r\n'
  );
});

test('历史：书目备份 / 未识别备份不能还原，缺组时报错清楚', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '不能还原书');
  await storage.renameBook(bookPath, '不能还原书-改名');
  await assert.rejects(storage.restoreHistoryFile(bookPath, 'bak', '书目.json.bak'), (err) => err.code === 'HISTORY_NOT_RESTORABLE');
  await assert.rejects(storage.restoreHistoryGroup(bookPath, 'bak'), (err) => err.code === 'HISTORY_NOT_RESTORABLE');
  await writeBackupDir(bookPath, '随便一个文件夹', { 'x.txt': '未知' });
  await assert.rejects(
    storage.restoreHistoryFile(bookPath, 'dir:随便一个文件夹', 'x.txt'),
    (err) => err.code === 'HISTORY_NOT_CURRENT' || err.code === 'HISTORY_NO_TARGET'
  );
  await assert.rejects(
    storage.restoreHistoryFile(bookPath, 'dir:替换备份-2999-01-01-000000', 'x.txt'),
    (err) => err.code === 'HISTORY_GROUP_MISSING'
  );
  await assert.rejects(
    storage.restoreHistoryFile(bookPath, 'dir:../逃出去', 'x.txt'),
    (err) => err.code === 'BAD_GROUP'
  );
});

test('历史：v0.4.1 形状的旧书目（无 schemaVersion / 无新字段）照样能看历史并还原', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '旧书');
  await fs.mkdir(bookPath, { recursive: true });
  const oldMeta = {
    version: 1,
    id: 'b_old',
    title: '旧书',
    titleTemplate: '第{n}章 {name}',
    fileSeq: 2,
    chapters: [
      { id: 'ch_001', file: '001-起风.txt', name: '起风', createdAt: '2026-10-30T00:00:00.000Z' },
      { id: 'ch_002', file: '002-夜雨.txt', name: '夜雨', createdAt: '2026-10-30T00:00:00.000Z' }
    ],
    lastOpenChapterId: 'ch_001'
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(oldMeta, null, 2), 'utf8');
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '旧书第一章。\n', 'utf8');
  await fs.writeFile(path.join(bookPath, '002-夜雨.txt'), '旧书第二章。\n', 'utf8');
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    '001-起风.txt': '旧书第一章备份。\r\n'
  });

  const listed = await storage.listBookHistory(bookPath);
  assert.equal(listed.title, '旧书');
  const replace = listed.groups.find((group) => group.source === 'replace');
  assert.equal(replace.files[0].restorable, true);

  const result = await storage.restoreHistoryFile(bookPath, replace.id, '001-起风.txt');
  assert.equal(result.restored, 1);
  assert.equal((await storage.loadChapterText(bookPath, '001-起风.txt')).text, '旧书第一章备份。\n');
  // 还原写盘时只补 schemaVersion（迁移），章节顺序/文件/章名不变
  const metaOnDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(metaOnDisk.schemaVersion, 1);
  assert.deepEqual(metaOnDisk.chapters.map((chapter) => chapter.file), ['001-起风.txt', '002-夜雨.txt']);
  assert.deepEqual(metaOnDisk.chapters.map((chapter) => chapter.name), ['起风', '夜雨']);
});
