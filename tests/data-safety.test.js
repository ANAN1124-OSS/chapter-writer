// 数据安全回归（v0.9 C-7，安全审计 C7）。
//
// 只补「之前没人钉住」的场景，不改数据格式、不改行为契约。四条线：
//   1. `_trash` 备份完整性：整本替换 / 整本整理写盘前都留备份，**数量与内容对得上**；
//      同一秒内连做两次替换不能再共用同一个备份目录（老实现会盖掉前一份）。
//   2. 书目损坏恢复：半写 / 坏 JSON / 缺字段的读法，以及「从 .bak 恢复」的边界
//      （.bak 也坏时主文件必须一个字节都不动）。
//   3. 写盘失败不留半成品：书目 / 章节写盘失败时，磁盘上还是完整的上一个版本。
//   4. 原子写是唯一写盘通道（见 tests/atomic.test.js）。
//
// 已有用例（不在本文件里重复）：storage.test.js 的替换 / 整理 / 还原备份往返、
// repair.test.js 的重建与 .bak 恢复主流程、conflict.test.js 的同步副本识别。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const repair = require('../core/repair');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-data-safety-'));
}

// 临时让 rename 失败（模拟「文件被杀软 / 同步盘占住」）；返回 restore()，必须放 finally。
function patchRename(impl) {
  const real = fs.rename;
  Object.defineProperty(fs, 'rename', { value: impl, configurable: true, writable: true });
  return () => Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
}

function fsError(code) {
  return Object.assign(new Error(`${code}: 模拟失败`), { code });
}

async function tmpEntries(dir) {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

test('整本替换：同一秒内连做两次，各自留一份独立备份（不再共用同名目录 / 不盖掉前一份）', async (t) => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '同一秒两次替换');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '阿明来了。');

  // 冻结时钟（只冻 Date，不动 setTimeout）：两次替换的时间戳精确到秒，正常使用时两次之间
  // 隔了好几分钟不会撞名；这里把那唯一会撞名的情况**确定地**造出来。
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 1, 21, 30, 0).getTime() });
  const first = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const second = await storage.replaceInBook(bookPath, { query: '小明', replacement: '小红' });
  t.mock.timers.reset();

  assert.ok(first.backupDir && second.backupDir);
  assert.notEqual(second.backupDir, first.backupDir, '两次替换必须落在两个不同的备份目录');
  assert.match(path.basename(second.backupDir), /^替换备份-.*-2$/, '撞名时按老规矩加 -2');
  // 第一份备份是「最初的原文」，第二份是「第一次替换之后的正文」——各是各的，没有被覆盖
  assert.equal(await fs.readFile(path.join(first.backupDir, file0), 'utf8'), '阿明来了。');
  assert.equal(await fs.readFile(path.join(second.backupDir, file0), 'utf8'), '小明来了。');

  const list = await storage.listReplaceBackups(bookPath);
  assert.equal(list.length, 2, '两份备份都要能被「本书历史 / 还原到替换前」看到');
  assert.equal(list[0].name, path.basename(second.backupDir), '最近一次排最前');
  assert.equal(list[1].name, path.basename(first.backupDir));

  // 还原「最早那一份」= 回到最初正文（如果两次共用目录，这一步会还原成混合状态）
  const restored = await storage.restoreReplaceBackup(bookPath, list[1].name);
  assert.equal(restored.restored, 1);
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '阿明来了。');
});

test('整本替换备份：只备本次真正改动的章，内容是写盘前的原始字节（BOM / CRLF 原样）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '只备改动章');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  const meta = await storage.readBookMeta(bookPath);
  const [file0, file1, file2] = meta.chapters.map((chapter) => chapter.file);
  // 第 1、3 章命中；第 2 章不命中（不该被备份，更不该被改写）
  const raw0 = '\uFEFF阿明来了。\r\n第二段。\r\n';
  const raw2 = '阿明走了。';
  await fs.writeFile(path.join(bookPath, file0), raw0, 'utf8');
  await fs.writeFile(path.join(bookPath, file1), '这里没有那个人。', 'utf8');
  await fs.writeFile(path.join(bookPath, file2), raw2, 'utf8');

  const res = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(res.chaptersChanged, 2);
  const backupNames = (await fs.readdir(res.backupDir)).sort();
  assert.deepEqual(backupNames, [file0, file2].sort(), '备份里只该有本次改动的章');
  // 逐字节：copyFile 的备份必须和写盘前完全一致（含 BOM 与 CRLF），以后还原才能回到原样
  assert.equal(await fs.readFile(path.join(res.backupDir, file0), 'utf8'), raw0);
  assert.equal(await fs.readFile(path.join(res.backupDir, file2), 'utf8'), raw2);
  // 写盘后：CRLF 保留、BOM 不写回（读入时已剥掉），没命中的章一个字节没动
  assert.equal(await fs.readFile(path.join(bookPath, file0), 'utf8'), '小明来了。\r\n第二段。\r\n');
  assert.equal(await fs.readFile(path.join(bookPath, file1), 'utf8'), '这里没有那个人。');
});

test('整本整理备份：备份章数 == 预检查的「会改动 N 章」，内容与整理前逐字节一致', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整理备份完整性');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  let meta = await storage.readBookMeta(bookPath);
  const files = meta.chapters.map((chapter) => chapter.file);
  const raws = ['他说,"第一段。"\r\n第二段\r\n', '　　这一章本来就干净。\r\n', '他说..."第三段"'];
  for (let i = 0; i < files.length; i += 1) {
    await fs.writeFile(path.join(bookPath, files[i]), raws[i], 'utf8');
  }
  const options = { indent: '2', blankLines: 'single', normalizePunct: true, curlyQuotes: true, ellipsis: true };
  const preview = await storage.previewFormatBook(bookPath, options);
  assert.equal(preview.chaptersChanged, 2, '第 2 章本来就干净，不该算改动');

  const res = await storage.formatBook(bookPath, options);
  assert.equal(res.chaptersChanged, preview.chaptersChanged);
  const backupNames = (await fs.readdir(res.backupDir)).sort();
  assert.equal(backupNames.length, preview.chaptersChanged, '备份章数必须和「会改动 N 章」一致');
  for (const name of backupNames) {
    const index = files.indexOf(name);
    assert.ok(index >= 0, `备份里出现了不认识的章节文件：${name}`);
    assert.equal(await fs.readFile(path.join(res.backupDir, name), 'utf8'), raws[index], `${name} 的备份要和整理前逐字节一致`);
  }
  // 干净的那一章既没被备份，也没被改写
  assert.equal(backupNames.includes(files[1]), false);
  assert.equal(await fs.readFile(path.join(bookPath, files[1]), 'utf8'), raws[1]);
});

test('书目.json.bak：等于「上一版」的原始字节，不是重新序列化出来的', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份逐字节');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const before = await fs.readFile(metaPath, 'utf8');
  await storage.renameBook(bookPath, '备份逐字节-改名');
  assert.equal(await fs.readFile(bakPath, 'utf8'), before, '.bak 必须是改名前的完整原文');
  const after = await fs.readFile(metaPath, 'utf8');
  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).title, '备份逐字节-改名');
});

test('书目半写（截断）：读取报 PARSE_ERROR 且不写盘；从 .bak 恢复后章节与正文完整、坏文件留档', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '半写书目');
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一章正文。');
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二章正文。');
  // 造出「上一版」的 .bak（改名会先备份上一版），再把主文件截断成半写状态
  await storage.renameBook(bookPath, '半写书目-改名');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const full = await fs.readFile(metaPath, 'utf8');
  const truncated = full.slice(0, Math.floor(full.length * 0.6));
  await fs.writeFile(metaPath, truncated, 'utf8');
  const bakBefore = await fs.readFile(bakPath, 'utf8');

  await assert.rejects(() => storage.readBookMeta(bookPath), (err) => err.code === 'PARSE_ERROR');
  // 读取失败不许改动磁盘：主文件与 .bak 都原样
  assert.equal(await fs.readFile(metaPath, 'utf8'), truncated);
  assert.equal(await fs.readFile(bakPath, 'utf8'), bakBefore);
  assert.deepEqual(await tmpEntries(bookPath), []);

  const restored = await repair.restoreFromBak(bookPath);
  assert.equal(restored.meta.title, '半写书目', '恢复到 .bak 里的上一版');
  assert.equal(restored.meta.chapters.length, 2);
  const corrupt = (await fs.readdir(bookPath)).filter((name) => name.startsWith('书目.json.corrupt-'));
  assert.equal(corrupt.length, 1, '半写的书目必须留档，不是被删掉');
  assert.equal(await fs.readFile(path.join(bookPath, corrupt[0]), 'utf8'), truncated);
  // 恢复后正文一个字节没丢
  const after = await storage.readBookMeta(bookPath);
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[0].file)).text, '第一章正文。');
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[1].file)).text, '第二章正文。');
});

test('书目缺字段 / 坏形状：INVALID_META 明确报错，绝不半还原、不写盘', async () => {
  const cases = [
    { name: '章节记录不是对象', raw: { chapters: [42] } },
    { name: '章节缺少 file', raw: { chapters: [{ id: 'ch_001', name: '起风' }] } },
    { name: '章节 file 是空串', raw: { chapters: [{ file: '   ' }] } },
    { name: 'chapters 不是数组', raw: { chapters: { 1: { file: '001-起风.txt' } } } },
    { name: '顶层是数组', raw: [{ chapters: [] }] },
    { name: '顶层是 null', raw: null }
  ];
  for (const item of cases) {
    const root = await mkTmp();
    const bookPath = path.join(root, '坏形状');
    await fs.mkdir(bookPath);
    const metaPath = path.join(bookPath, '书目.json');
    const text = JSON.stringify(item.raw);
    await fs.writeFile(metaPath, text, 'utf8');
    await assert.rejects(
      () => storage.readBookMeta(bookPath),
      (err) => err.code === 'INVALID_META',
      item.name
    );
    assert.equal(await fs.readFile(metaPath, 'utf8'), text, `${item.name}：读失败不许写盘`);
  }
});

test('从 .bak 恢复：.bak 也坏时抛 BAK_INVALID，主文件一个字节都不动（不先改名 / 不盖掉）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '双坏');
  await fs.mkdir(bookPath);
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  await fs.writeFile(metaPath, '{ 主文件也坏', 'utf8');
  await fs.writeFile(bakPath, '{"chapters": [', 'utf8');
  await assert.rejects(() => repair.restoreFromBak(bookPath), (err) => err.code === 'BAK_INVALID');
  assert.equal(await fs.readFile(metaPath, 'utf8'), '{ 主文件也坏');
  assert.equal(await fs.readFile(bakPath, 'utf8'), '{"chapters": [');
  assert.equal(
    (await fs.readdir(bookPath)).some((name) => name.startsWith('书目.json.corrupt-')),
    false,
    '确认 .bak 能用之前不许把主文件改名'
  );
  // .bak 结构不完整（不是坏 JSON，而是没有 chapters）同样拒绝
  await fs.writeFile(bakPath, '{"title":"x"}', 'utf8');
  await assert.rejects(() => repair.restoreFromBak(bookPath), (err) => err.code === 'BAK_INVALID');
  assert.equal(await fs.readFile(metaPath, 'utf8'), '{ 主文件也坏');
});

test('书目写盘失败（文件被占）：主文件与 .bak 都还是完整的上一个版本、不留临时文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '写盘失败回退');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const mainBefore = await fs.readFile(metaPath, 'utf8');

  let attempts = 0;
  const restore = patchRename(async () => {
    attempts += 1;
    throw fsError('EACCES');
  });
  try {
    await assert.rejects(() => storage.renameBook(bookPath, '不该生效的新名'));
  } finally {
    restore();
  }
  assert.ok(attempts >= 1, '确实走到了 rename');
  assert.equal(await fs.readFile(metaPath, 'utf8'), mainBefore, '主文件必须还是上一版');
  assert.equal(JSON.parse(mainBefore).title, '写盘失败回退');
  assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).title, '写盘失败回退');
  assert.deepEqual(await tmpEntries(bookPath), [], '不许留下临时文件');
  // 失败之后恢复正常，下一次写盘照常（不会因为一次失败就把书卡成只读）
  await storage.renameBook(bookPath, '写盘失败回退-改名');
  assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).title, '写盘失败回退-改名');
  assert.equal(await fs.readFile(bakPath, 'utf8'), mainBefore, '恢复后的 .bak 是失败前的那一版');
});

test('章节保存失败：磁盘上还是完整的旧正文、书目不动、不留临时文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '章节保存失败');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '原来的正文。');
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  const textBefore = await fs.readFile(path.join(bookPath, file), 'utf8');

  const restore = patchRename(async () => {
    throw fsError('EPERM');
  });
  try {
    await assert.rejects(() => storage.saveChapterText(bookPath, file, '不该写进去的新正文。'), (err) => err.code === 'EPERM');
  } finally {
    restore();
  }
  assert.equal(await fs.readFile(path.join(bookPath, file), 'utf8'), textBefore, '旧正文必须完好');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore, '保存失败不该动书目');
  assert.deepEqual(await tmpEntries(bookPath), []);
  // 恢复正常后能正常保存
  await storage.saveChapterText(bookPath, file, '恢复后的新正文。');
  assert.equal((await storage.loadChapterText(bookPath, file)).text, '恢复后的新正文。');
});
