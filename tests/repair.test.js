const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const repair = require('../core/repair');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-repair-'));
}

test('从目录 txt 重建：按创建序号排序、名字回填、损坏 json 被保留', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '旧书');
  await fs.mkdir(bookPath);
  // 故意打乱文件，模拟目录顺序和章节顺序不同
  await fs.writeFile(path.join(bookPath, '003-夜雨.txt'), '夜雨正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '002-未命名.txt'), '', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.equal(res.count, 3);
  assert.deepEqual(res.meta.chapters.map((c) => c.file), ['001-起风.txt', '002-未命名.txt', '003-夜雨.txt']);
  assert.deepEqual(res.meta.chapters.map((c) => c.name), ['起风', '', '夜雨']);
  assert.equal(res.meta.fileSeq, 3);
  // 损坏的 json 被改名为 .corrupt-*，不是被删掉
  const files = await fs.readdir(bookPath);
  assert.ok(files.some((f) => f.startsWith('书目.json.corrupt-')), '损坏文件应被保留');
  // 重建后可以正常读取
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 3);
});

test('无 txt 时重建报错，不产生书目', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '空目录');
  await fs.mkdir(bookPath);
  await assert.rejects(() => repair.rebuildFromFiles(bookPath), (err) => err.code === 'NO_FILES');
});

test('从 .bak 恢复：坏掉的书目换成上一版，坏文件被保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '恢复测试');
  // 制造一个 .bak：先改名一次（写入时自动生成 bak = 旧版）
  await storage.renameBook(bookPath, '恢复测试-第二版');
  // 现在把主文件写坏
  await fs.writeFile(path.join(bookPath, '书目.json'), '彻底坏掉', 'utf8');
  const res = await repair.restoreFromBak(bookPath);
  assert.equal(res.meta.title, '恢复测试');
  const files = await fs.readdir(bookPath);
  assert.ok(files.some((f) => f.startsWith('书目.json.corrupt-')));
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.title, '恢复测试');
});

test('没有 .bak 时给出可读错误', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '无备份');
  await assert.rejects(() => repair.restoreFromBak(bookPath), (err) => err.code === 'NO_BAK');
});
