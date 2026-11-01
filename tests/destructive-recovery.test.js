// 破坏性操作可恢复性（v0.9 C-8，安全审计 C8）。
//
// 这一轮只管一件事：**破坏性操作失败时，书不能停在半成品上**。
// 已有用例（不在这里重复）：storage.test.js 的删章 / 整理 / 替换 / 还原成功路径与备份往返，
// tests/data-safety.test.js 的原子写失败、书目损坏恢复、同一秒撞名。
//
// 本文件钉住的是「中途失败」这一段：
//   1. 删章：文件先移 _trash、书目后写；书目写失败必须把文件**放回原处**（回滚），
//      连回滚都失败时报错要指明文件在 _trash、并能从「本书历史」放回书文件夹。
//   2. 整本整理 / 整本替换 / 还原到替换前：中途失败时错误信息必须带「已经改了几章」
//      和备份目录名（只给 _trash 下的名字，不含本机路径），原件都在、失败那一章原样、
//      修好之后重跑能把剩下的补齐。
//   3. 静态闸门：删章的顺序（先移文件再写书目）不许反过来；四个失败分支都走 batchFailure；
//      渲染层删「当前章」前必须先问未保存的修改。
//
// 做法：临时让 `fs.rename` 对**指定目标**失败（模拟杀软 / 同步盘 / 只读文件占住），
// `finally` 里一定还原，绝不影响别的用例。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');

// 源码闸门按 \n 切（仓库在 Windows 上检出是 CRLF，先归一化，免得闸门自己被换行符绊倒）
const readSource = (rel) => require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const STORAGE_SOURCE = readSource(path.join('core', 'storage.js'));
const RENDERER_SOURCE = readSource(path.join('renderer', 'renderer.js'));

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-destructive-'));
}

// 只让「目标路径匹配」的 rename 失败，其它 rename 走真实实现；返回 restore()，必须放 finally。
function patchRename(select) {
  const real = fs.rename;
  Object.defineProperty(fs, 'rename', {
    configurable: true,
    writable: true,
    value: async (from, to) => {
      const code = select(String(from), String(to));
      if (code) throw Object.assign(new Error(`${code}: 模拟失败`), { code });
      return real(from, to);
    }
  });
  return () => Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
}

async function tmpEntries(dir) {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

function functionBody(source, marker, indent) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `源码里找不到 ${marker}`);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `${marker} 的函数体没有正常结束`);
  return source.slice(start, end + indent.length + 2);
}

// ---------- 1. 删章：失败要回滚 ----------

test('删章：书目写盘失败时把章节文件放回原处，书保持删除前的样子', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删章回滚');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const file1 = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, file1, '第二章的正文，删不掉就得原样留着。');
  const metaPath = path.join(bookPath, '书目.json');
  const metaBefore = await fs.readFile(metaPath, 'utf8');
  const textBefore = await fs.readFile(path.join(bookPath, file1), 'utf8');

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}书目.json`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, meta.chapters[1].id).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed, '书目写不进去时删章必须报错，不能假装成功');
  assert.equal(failed.code, 'DELETE_FAILED');
  assert.match(failed.message, /删除本章中途停下/, '错误信息要说清是哪一步停了');
  assert.match(failed.message, /已经放回原处/, '回滚成功要说出来');
  assert.match(failed.message, /书还是删除前的样子/);
  // 文件回到书文件夹，内容一个字节没变
  assert.equal(await fs.readFile(path.join(bookPath, file1), 'utf8'), textBefore);
  // 书目一字节不动（这一章还在，点开还能读）
  assert.equal(await fs.readFile(metaPath, 'utf8'), metaBefore);
  // _trash 里没有残留的那一份（回滚是 rename 回去，不是复制）
  const trashEntries = await fs.readdir(path.join(bookPath, '_trash')).catch(() => []);
  assert.deepEqual(trashEntries.filter((name) => name.endsWith(file1)), []);
  assert.deepEqual(await tmpEntries(bookPath), []);
  // 恢复正常后重试：这次真的删掉，文件进 _trash
  const ok = await storage.deleteChapter(bookPath, meta.chapters[1].id);
  assert.ok(ok.trashPath.includes('_trash'));
  await fs.access(ok.trashPath);
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, 1);
});

test('删章：连「放回原处」都失败时报错指明文件在 _trash，历史里能把它放回去', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删章放不回去');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const file1 = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, file1, '放不回去也要让人找得到。');
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  const chapterId = meta.chapters[1].id;

  // 书目的 rename 失败；回滚时「把文件放回书文件夹」的 rename 也失败
  const restore = patchRename((from, to) =>
    to.endsWith(`${path.sep}书目.json`) || to.endsWith(`${path.sep}${file1}`) ? 'EPERM' : ''
  );
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, chapterId).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'DELETE_FAILED');
  assert.match(failed.message, /现在在 _trash\//, '要说清文件在哪个 _trash 目录（相对位置，不是本机路径）');
  assert.ok(failed.message.includes(file1), '要说清是哪个文件');
  assert.match(failed.message, /历史/);
  assert.ok(!failed.message.includes(root), '错误里不许出现本机临时目录的绝对路径');
  // 文件确实在书内 _trash（带时间戳前缀），书文件夹里没有了，书目还是完整的上一版
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.equal(trashNames.filter((name) => name.endsWith(file1)).length, 1);
  await assert.rejects(() => fs.access(path.join(bookPath, file1)));
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);

  // 从「本书历史」把删除的章节放回书文件夹 → 书目里这一章本来还在，书立刻恢复可用
  const history = await storage.listBookHistory(bookPath);
  const deleteGroup = history.groups.find((group) => group.source === 'delete');
  assert.ok(deleteGroup, '删除的章节必须能在历史里看到');
  const restored = await storage.restoreHistoryFile(bookPath, deleteGroup.id, file1);
  assert.equal(restored.restored, 1);
  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '放不回去也要让人找得到。');
  assert.deepEqual(await tmpEntries(bookPath), []);
});

test('删章：删最后一章且书目写盘失败，自动补的空章不会留在书里', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删最后一张');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '唯一的一章。');
  const txtBefore = (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt'));
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}书目.json`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, meta.chapters[0].id).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed && failed.code === 'DELETE_FAILED');
  const txtAfter = (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt'));
  assert.deepEqual(txtAfter, txtBefore, '「自动补的空章」不许留在书文件夹里当孤儿 txt');
  assert.equal(await fs.readFile(path.join(bookPath, file0), 'utf8'), '唯一的一章。');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  assert.deepEqual(await tmpEntries(bookPath), []);
  // 空章被挪进 _trash（不是真删），书还能照常删一次
  const after = await storage.deleteChapter(bookPath, meta.chapters[0].id);
  assert.ok(after.newChapter, '删空后照旧自动补一章');
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, 1);
});

// ---------- 2. 批次操作：中途失败要留下「现场」 ----------

const FORMAT_OPTIONS = { indent: '2', blankLines: 'keep', trimTrailing: true, normalizePunct: true };

test('整本整理：中途失败时报告已整理章数与备份目录，原件都在、失败章原样，修好重跑能补齐', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整理半途');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  let meta = await storage.readBookMeta(bookPath);
  const [f0, f1, f2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '第一段  ');
  await storage.saveChapterText(bookPath, f1, '第二段  ');
  await storage.saveChapterText(bookPath, f2, '第三段  ');
  meta = await storage.readBookMeta(bookPath);
  const metaPath = path.join(bookPath, '书目.json');
  const metaBefore = await fs.readFile(metaPath, 'utf8');

  // 第二张章写到一半失败（第一张已经整理好）
  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}${f1}`) ? 'EPERM' : ''));
  let failed = null;
  try {
    failed = await storage.formatBook(bookPath, FORMAT_OPTIONS).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'FORMAT_FAILED');
  assert.match(failed.message, /整本整理中途停下/);
  assert.match(failed.message, /已经整理好 1 章/);
  assert.match(failed.message, /整理备份-/);
  assert.ok(!failed.message.includes(root), '错误里不许出现本机绝对路径（只给 _trash 下的目录名）');
  // 已整理的那章：写盘生效；失败的那章与后面那章：一个字节没动
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '　　第一段');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '第二段  ');
  assert.equal((await storage.loadChapterText(bookPath, f2)).text, '第三段  ');
  // 原件都在备份里（第一、二章都在：第二章是先备份再写盘）
  const backupName = failed.message.match(/(整理备份-[^\s；]+)/)[1];
  const backupDir = path.join(bookPath, '_trash', backupName);
  assert.equal(await fs.readFile(path.join(backupDir, f0), 'utf8'), '第一段  ');
  assert.equal(await fs.readFile(path.join(backupDir, f1), 'utf8'), '第二段  ');
  await assert.rejects(() => fs.access(path.join(backupDir, f2)), '没改动的章不进备份');
  // 书目没写（字数缓存还是旧的），也没有临时文件
  assert.equal(await fs.readFile(metaPath, 'utf8'), metaBefore);
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 修好之后重跑：把剩下两章补齐，备份目录另起一个（不覆盖失败那次的现场）
  const again = await storage.formatBook(bookPath, FORMAT_OPTIONS);
  assert.equal(again.chaptersChanged, 2);
  assert.notEqual(path.basename(again.backupDir), backupName);
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '　　第二段');
  assert.equal((await storage.loadChapterText(bookPath, f2)).text, '　　第三段');
});

test('整本替换：中途失败时报告已替换章数与备份目录，备份里是替换前原文，重跑能补齐', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '替换半途');
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const [f0, f1] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '阿明来了。');
  await storage.saveChapterText(bookPath, f1, '阿明走了。');
  meta = await storage.readBookMeta(bookPath);
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}${f1}`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' }).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'REPLACE_FAILED');
  assert.match(failed.message, /整本替换中途停下/);
  assert.match(failed.message, /已经替换 1 章/);
  assert.match(failed.message, /替换备份-/);
  assert.ok(!failed.message.includes(root));
  // 第一章已经替换、第二章原样；备份里两章都是替换前的原文
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '小明来了。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '阿明走了。');
  const backupName = failed.message.match(/(替换备份-[^\s；]+)/)[1];
  const backupDir = path.join(bookPath, '_trash', backupName);
  assert.equal(await fs.readFile(path.join(backupDir, f0), 'utf8'), '阿明来了。');
  assert.equal(await fs.readFile(path.join(backupDir, f1), 'utf8'), '阿明走了。');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 重跑：只剩第二章要替换
  const again = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(again.chaptersChanged, 1);
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '小明走了。');
});

test('还原到替换前：中途失败报告已还原章数与还原前备份，重跑能把剩下的补上', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原半途');
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const [f0, f1] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '阿明一。');
  await storage.saveChapterText(bookPath, f1, '阿明二。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '小明一。');

  // 还原第一章能成功，第二章写盘失败
  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}${f1}`) ? 'EPERM' : ''));
  let failed = null;
  try {
    failed = await storage.restoreReplaceBackup(bookPath, backupName).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'RESTORE_FAILED');
  assert.match(failed.message, /还原到替换前中途停下/);
  assert.match(failed.message, /已经还原 1 章/);
  assert.match(failed.message, /还原前备份-/);
  assert.match(failed.message, /再点一次/);
  assert.ok(!failed.message.includes(root));
  // 第一章已还原，第二章还是替换后的内容；替换备份本身没被消耗
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '阿明一。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '小明二。');
  assert.equal((await storage.listReplaceBackups(bookPath)).length, 1);
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 重跑：第二章补上，且这次会先把「现在的第一章」再备份一份
  const again = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(again.restored, 2);
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '阿明一。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '阿明二。');
});

// ---------- 3. 静态闸门（防回退） ----------

test('静态闸门：删章必须「先移文件 → 再写书目」，失败分支必须回滚', () => {
  const body = functionBody(STORAGE_SOURCE, 'async function deleteChapter(', '');
  const moveAt = body.indexOf('moveToTrash(');
  const metaAt = body.indexOf('writeBookMeta(');
  assert.ok(moveAt >= 0 && metaAt >= 0, '删章必须既移文件又写书目');
  assert.ok(moveAt < metaAt, '顺序不许反过来：先写书目再移文件会留下「书目里没有了、文件还在」的孤儿');
  assert.match(body, /batchFailure\(/, '书目写盘失败必须走统一报错（带现场）');
  assert.match(body, /DELETE_FAILED/);
  assert.match(body, /fs\.rename\(trashPath/, '失败后必须尝试把文件放回原处');
});

test('静态闸门：三个批次操作的中途失败都要带「改了几章 + 备份目录名」', () => {
  const cases = [
    ['async function formatBook(', 'FORMAT_FAILED', '整理备份'],
    ['async function replaceInBook(', 'REPLACE_FAILED', '替换备份'],
    ['async function restoreReplaceBackup(', 'RESTORE_FAILED', '还原前备份']
  ];
  for (const [marker, code, label] of cases) {
    const body = functionBody(STORAGE_SOURCE, marker, '');
    assert.match(body, /try \{/, `${marker} 的循环必须在 try 里`);
    assert.ok(body.includes(`batchFailure(`), `${marker} 失败必须走 batchFailure`);
    assert.ok(body.includes(code), `${marker} 必须有稳定的错误码 ${code}`);
    assert.ok(body.includes('trashDirLabel('), `${marker} 必须报出备份目录（_trash 下的名字）`);
    assert.ok(!body.includes('${backupDir}'), `${marker} 不许把绝对路径直接拼进消息`);
    assert.ok(label.length > 0);
  }
  // 报错工具本身只用相对位置：_trash/<目录名>
  const helper = functionBody(STORAGE_SOURCE, 'function batchFailure(', '');
  assert.ok(helper.includes('describeForUi('), '原因先过脱敏');
  assert.ok(!helper.includes('bookPath'), 'batchFailure 拿不到也拼不出书的本机路径');
});

test('静态闸门：渲染层删「当前章」前必须先问未保存的修改', () => {
  const body = functionBody(RENDERER_SOURCE, 'async function deleteChapterAt(', '  ');
  const askAt = body.indexOf('askUnsaved(');
  const confirmAt = body.indexOf("title: '删除章节'");
  assert.ok(askAt >= 0, '删当前章前必须问未保存的修改（不能静默丢编辑区里的字）');
  assert.ok(confirmAt >= 0);
  assert.ok(askAt < confirmAt, '未保存的询问要排在删除确认之前');
  assert.match(body, /wasCurrent/);
  assert.match(body, /skipConfirm/);
  assert.match(body, /saveLabel: '保存后删除'/);
  // 批次操作失败后界面要回到磁盘的真相（三个失败分支都调了重载 helper）
  const reloadCalls = RENDERER_SOURCE.match(/await reloadAfterPartialFailure\(/g) || [];
  assert.ok(reloadCalls.length >= 3, '整理 / 替换 / 还原失败后都要按磁盘重载当前书');
  assert.match(RENDERER_SOURCE, /async function reloadAfterPartialFailure\(bookPath = null\)/);
});

test('静态闸门：错误文案不含本机路径（只给相对位置）', () => {
  const helper = functionBody(STORAGE_SOURCE, 'function batchFailure(', '');
  assert.ok(!/path\.join|bookPath|__dirname/.test(helper), 'batchFailure 自己不许拼路径');
  const label = functionBody(STORAGE_SOURCE, 'function trashDirLabel(', '');
  assert.ok(label.includes('path.basename('), '只取备份目录名，别把 bookPath 拼进去');
  assert.ok(label.includes('TRASH_DIR'));
});

// 兜底：本文件自己不许写死盘符 / 删文件（和别的测试脚本一个口径）
test('本文件只读约束：不出现真实书架路径、不删文件', () => {
  const source = require('node:fs').readFileSync(__filename, 'utf8');
  assert.ok(!/D:\\\\我的小说/.test(source));
  assert.ok(!/fs\.(rm|unlink)\(/.test(source), '测试里不许删文件（清理只走临时目录）');
  assert.ok(source.includes('mkdtemp'), '一律用系统临时目录');
});
