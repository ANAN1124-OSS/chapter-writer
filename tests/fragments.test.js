const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const frag = require('../core/fragments');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-fragments-'));
}

async function readRoot(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('灵感箱：date stamp 用本机日期补零，坏日期退回今天', () => {
  assert.equal(frag.formatDateStamp(new Date(2026, 0, 5, 9, 30)), '2026-01-05');
  assert.equal(frag.formatDateStamp(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.match(frag.formatDateStamp(new Date('x')), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(frag.formatDateStamp('not-a-date'), /^\d{4}-\d{2}-\d{2}$/);
});

test('灵感箱：parseFragmentName 只认「YYYY-MM-DD-N.txt」且日期必须真实存在', () => {
  assert.deepEqual(frag.parseFragmentName('2026-10-31-1.txt'), { date: '2026-10-31', seq: 1 });
  assert.deepEqual(frag.parseFragmentName('2026-10-31-12.txt'), { date: '2026-10-31', seq: 12 });
  assert.equal(frag.parseFragmentName('2026-02-30-1.txt'), null, '2 月 30 日不是真实日期');
  assert.equal(frag.parseFragmentName('2026-13-01-1.txt'), null);
  assert.equal(frag.parseFragmentName('2026-10-31-0.txt'), null, '序号从 1 开始');
  assert.equal(frag.parseFragmentName('2026-10-31.txt'), null);
  assert.equal(frag.parseFragmentName('2026-10-31-1.md'), null);
  assert.equal(frag.parseFragmentName('随手记.txt'), null);
  assert.equal(frag.parseFragmentName(null), null);
  assert.equal(frag.isValidDayStamp('2026-10-31'), true);
  assert.equal(frag.isValidDayStamp('2026-10-32'), false);
});

test('灵感箱：nextFragmentName 在当天已有编号后递增，忽略别的日期 / 手工改名 / 坏名字', () => {
  assert.equal(frag.nextFragmentName([], new Date(2026, 9, 31, 12)), '2026-10-31-1.txt');
  assert.equal(
    frag.nextFragmentName(
      ['2026-10-31-1.txt', '2026-10-31-2.txt', '2026-10-30-9.txt', '随手记.txt', '2026-13-01-1.txt'],
      new Date(2026, 9, 31, 12)
    ),
    '2026-10-31-3.txt'
  );
  // 中间有洞也不回收（避免和回收站里的旧文件撞名）
  assert.equal(
    frag.nextFragmentName(['2026-10-31-1.txt', '2026-10-31-5.txt'], new Date(2026, 9, 31, 12)),
    '2026-10-31-6.txt'
  );
  assert.equal(frag.nextFragmentSerial(['2026-10-31-3.txt'], '2026-10-31'), 4);
  assert.equal(frag.nextFragmentSerial(['2026-10-31-3.txt'], '2026-11-01'), 1);
  assert.equal(frag.nextFragmentSerial(null, '2026-10-31'), 1);
});

test('灵感箱：cleanFragmentText 去 BOM / 统一换行 / 去首尾空白，空内容和超长明确拒绝', () => {
  const ok = frag.cleanFragmentText('\uFEFF第一段\r\n\r\n第二段\r\n');
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '第一段\n\n第二段');
  assert.equal(ok.chars, 6);
  assert.equal(frag.cleanFragmentText('\uFEFF').ok, false);
  assert.equal(frag.cleanFragmentText('   \n\t\u3000 ').ok, false);
  assert.equal(frag.cleanFragmentText(null).code, 'EMPTY');
  const tooLong = frag.cleanFragmentText('字'.repeat(11), { maxChars: 10 });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'TOO_LONG');
  assert.match(tooLong.message, /最多 10 字/);
  assert.equal(frag.cleanFragmentText('字'.repeat(10), { maxChars: 10 }).ok, true);
  // 内部空格 / 空行保留（只 trim 首尾）
  assert.equal(frag.cleanFragmentText('  甲\n\n  乙  ').text, '甲\n\n  乙');
});

test('灵感箱：previewText 压成一行并截断，sortFragments 最新在前且不改原数组', () => {
  assert.equal(frag.previewText('第一行\n\n第二行  第三行'), '第一行 第二行 第三行');
  assert.equal(frag.previewText('字'.repeat(10), 4), '字字字字…');
  assert.equal(frag.previewText('  '), '');
  const input = [
    { name: 'a.txt', mtimeMs: 100 },
    { name: 'b.txt', mtimeMs: 300 },
    { name: 'c.txt', mtimeMs: 200 }
  ];
  const sorted = frag.sortFragments(input);
  assert.deepEqual(sorted.map((item) => item.name), ['b.txt', 'c.txt', 'a.txt']);
  assert.deepEqual(input.map((item) => item.name), ['a.txt', 'b.txt', 'c.txt'], '原数组顺序不变');
  assert.deepEqual(frag.sortFragments(null), []);
});

test('灵感箱：文件名校验拒绝路径穿越 / 隐藏文件 / 非 txt', () => {
  assert.equal(frag.assertFragmentName('2026-10-31-1.txt'), '2026-10-31-1.txt');
  assert.equal(frag.assertFragmentName(' 随手记.txt '), '随手记.txt');
  for (const bad of ['', '   ', '../x.txt', 'sub/x.txt', '..\\x.txt', '.secret.txt', 'x.md', 'a:b.txt']) {
    assert.throws(() => frag.assertFragmentName(bad), /不合法/, bad);
  }
});

test('灵感箱：目录不存在时列表为空，而且列表动作不会创建文件夹', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const data = await store.list();
  assert.equal(data.total, 0);
  assert.deepEqual(data.fragments, []);
  assert.equal(data.dir, path.join(root, '_碎片'));
  assert.deepEqual(await readRoot(root), []);
});

test('灵感箱：新建碎片写进 _碎片、UTF-8 无 BOM + CRLF、内容与字数正确', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const result = await store.create('第一段\n第二段\n\n第三段', { now: new Date(2026, 9, 31, 12) });
  assert.equal(result.name, '2026-10-31-1.txt');
  assert.equal(result.dir, path.join(root, '_碎片'));
  assert.equal(result.path, path.join(root, '_碎片', '2026-10-31-1.txt'));
  assert.equal(result.chars, 9);
  assert.equal(result.length, 12);
  assert.ok(result.bytes > 0);
  const bytes = await fs.readFile(result.path);
  assert.notEqual(bytes[0], 0xef, '不写 BOM（和章节 txt 一致）');
  assert.equal(bytes.toString('utf8'), '第一段\r\n第二段\r\n\r\n第三段');
  // 书架根目录只多出一个 _碎片 文件夹，不碰 书目.json / 章节
  assert.deepEqual(await readRoot(root), ['_碎片']);
  assert.deepEqual(await readRoot(path.join(root, '_碎片')), ['2026-10-31-1.txt']);
});

test('灵感箱：同一天连续保存自动加序号，旧碎片一个字节都不动', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const now = new Date(2026, 9, 31, 12);
  const first = await store.create('第一条', { now });
  const firstStat = await fs.stat(first.path);
  const firstBytes = await fs.readFile(first.path);
  const second = await store.create('第二条', { now });
  const third = await store.create('第三条', { now });
  assert.deepEqual(
    [first.name, second.name, third.name],
    ['2026-10-31-1.txt', '2026-10-31-2.txt', '2026-10-31-3.txt']
  );
  assert.deepEqual(await fs.readFile(first.path), firstBytes, '第一条内容没被覆盖');
  assert.equal((await fs.stat(first.path)).mtimeMs, firstStat.mtimeMs);
  const otherDay = await store.create('换一天', { now: new Date(2026, 10, 1, 0, 5) });
  assert.equal(otherDay.name, '2026-11-01-1.txt');
  assert.equal((await store.list()).total, 4);
});

test('灵感箱：并发保存也各占一个序号，不互相覆盖', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const now = new Date(2026, 9, 31, 12);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_value, i) => store.create(`第 ${i} 条`, { now }))
  );
  const names = results.map((item) => item.name).sort();
  assert.equal(new Set(names).size, 8);
  assert.deepEqual(names, [
    '2026-10-31-1.txt',
    '2026-10-31-2.txt',
    '2026-10-31-3.txt',
    '2026-10-31-4.txt',
    '2026-10-31-5.txt',
    '2026-10-31-6.txt',
    '2026-10-31-7.txt',
    '2026-10-31-8.txt'
  ]);
  for (let i = 0; i < results.length; i += 1) {
    const disk = await fs.readFile(results[i].path, 'utf8');
    assert.equal(disk, `第 ${i} 条`, '每条内容都写进自己的文件');
  }
  const leftovers = (await fs.readdir(path.join(root, '_碎片'))).filter((name) => name.startsWith('.'));
  assert.deepEqual(leftovers, [], '原子写的临时文件没有残留');
});

test('灵感箱：空内容 / 纯空白 / 超长在写盘前就被拒绝，不留半截文件', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  await assert.rejects(store.create('   \n\t '), /空的/);
  await assert.rejects(store.create('', {}), /空的/);
  await assert.rejects(store.create('字'.repeat(frag.MAX_TEXT_CHARS + 1)), /碎片太长/);
  assert.deepEqual(await readRoot(path.join(root, '_碎片')), []);
});

test('灵感箱：列表只认顶层 .txt（含手工放进去的），忽略子目录 / 隐藏文件 / 非 txt，最新在前', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-30-1.txt'), '旧的', 'utf8');
  await fs.writeFile(path.join(dir, '2026-10-31-2.txt'), '新的\n第二行', 'utf8');
  await fs.writeFile(path.join(dir, '随手记.txt'), '手工放进去的', 'utf8');
  await fs.writeFile(path.join(dir, '.hidden.txt'), '隐藏', 'utf8');
  await fs.writeFile(path.join(dir, 'readme.md'), '# 不是 txt', 'utf8');
  await fs.mkdir(path.join(dir, '子目录'));
  await fs.writeFile(path.join(dir, '子目录', '2026-10-31-9.txt'), '嵌套的不算', 'utf8');
  // 用 utimes 固定修改时间，排序稳定可测
  const t1 = new Date(2026, 9, 30, 8, 0).getTime() / 1000;
  const t2 = new Date(2026, 9, 31, 9, 0).getTime() / 1000;
  const t3 = new Date(2026, 9, 31, 10, 0).getTime() / 1000;
  await fs.utimes(path.join(dir, '2026-10-30-1.txt'), t1, t1);
  await fs.utimes(path.join(dir, '2026-10-31-2.txt'), t2, t2);
  await fs.utimes(path.join(dir, '随手记.txt'), t3, t3);

  const store = frag.createFragmentStore(root);
  const data = await store.list();
  assert.equal(data.total, 3);
  assert.equal(data.truncated, false);
  assert.deepEqual(data.fragments.map((item) => item.name), [
    '随手记.txt',
    '2026-10-31-2.txt',
    '2026-10-30-1.txt'
  ]);
  const generated = data.fragments.find((item) => item.name === '2026-10-31-2.txt');
  assert.equal(generated.date, '2026-10-31');
  assert.equal(generated.seq, 2);
  assert.equal(generated.preview, '新的 第二行');
  const manual = data.fragments.find((item) => item.name === '随手记.txt');
  assert.equal(manual.date, null);
  assert.equal(manual.seq, null);
  assert.ok(manual.size > 0);
});

test('灵感箱：列表最多 300 条但总数照实报', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: 305 }, (_value, i) =>
      fs.writeFile(path.join(dir, `2026-10-31-${i + 1}.txt`), `碎片 ${i + 1}`, 'utf8')
    )
  );
  const data = await frag.createFragmentStore(root).list();
  assert.equal(data.total, 305);
  assert.equal(data.truncated, true);
  assert.equal(data.fragments.length, frag.LIST_LIMIT);
  assert.equal(data.fragments.every((item) => /^2026-10-31-\d+\.txt$/.test(item.name)), true);
});

test('灵感箱：读取单条碎片去 BOM / 统一换行 / 算字数，拒绝穿越和不存在', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-31-1.txt'), '\uFEFF第一行\r\n第二行\r\n', 'utf8');
  const store = frag.createFragmentStore(root);
  const one = await store.read('2026-10-31-1.txt');
  assert.equal(one.text, '第一行\n第二行\n');
  assert.equal(one.chars, 6);
  await assert.rejects(store.read('../书目.json'), /不合法/);
  await assert.rejects(store.read('sub/2026-10-31-1.txt'), /不合法/);
  await assert.rejects(store.read('2026-10-32-1.txt'), /不在/);
  await assert.rejects(store.read('不存在.txt'), /不在/);
  // 目录不能被当成碎片读
  await fs.mkdir(path.join(dir, '目录.txt'));
  await assert.rejects(store.read('目录.txt'), /不在/);
});

test('灵感箱：超过 4MB 的碎片拒绝读取（不硬塞进编辑区）', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  const big = Buffer.alloc(frag.MAX_READ_BYTES + 1, 0x41);
  await fs.writeFile(path.join(dir, '巨大.txt'), big);
  await assert.rejects(frag.createFragmentStore(root).read('巨大.txt'), /太大/);
});

test('灵感箱：_碎片 位置被同名文件占住时给出明确错误，不覆盖、不递归写', async () => {
  const root = await mkTmp();
  await fs.writeFile(path.join(root, '_碎片'), '不是文件夹', 'utf8');
  const store = frag.createFragmentStore(root);
  await assert.rejects(store.list(), /不是一个文件夹/);
  await assert.rejects(store.create('内容'), /不是一个文件夹/);
  assert.equal(await fs.readFile(path.join(root, '_碎片'), 'utf8'), '不是文件夹');
});
