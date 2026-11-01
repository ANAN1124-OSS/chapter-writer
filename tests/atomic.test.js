// 原子写的回归测试（v0.9 C-7 数据安全回归 C7）。
//
// 为什么单独一个文件：`core/atomic.js` 是「所有写盘都必须原子写」这条红线的**唯一实现**
// （临时文件 → fsync → rename，失败重试），但在此之前只有一个间接用例
// （storage.test.js 的「目标被目录占用时抛错且不残留临时文件」）。这一份把契约逐条钉住：
//   1. 重试策略：只重试 EPERM / EBUSY / EACCES / ENOTEMPTY；别的一律立刻抛，不白等。
//   2. 「要么旧完整版、要么新完整版」：失败时目标一个字节不动、临时文件不残留。
//   3. 临时文件必须和目标**同目录**（rename 不能跨卷）且以「.」开头（脏不了目录列表）。
//   4. fsync 必须在 rename **之前**（静态闸门：顺序不许调换，否则断电会丢内容）。
//   5. readJson / stripBom：BOM、坏 JSON 的行为。
//   6. 反回退：core/storage.js 与 main.js 不许绕过 atomic 直接写盘。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const atomic = require('../core/atomic');

const RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'];
const NON_RETRY_CODES = ['ENOENT', 'ENOSPC', 'EXDEV', 'EISDIR'];

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-atomic-'));
}

// 临时替换 fs/promises 的 rename（atomic.js 调用时查表，所以替换模块对象上的属性就能生效）。
// 返回 restore()，**必须**放在 finally 里调用，否则会把后面所有用例的写盘弄坏。
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

test('重试策略：可重试错误（EPERM / EBUSY / EACCES / ENOTEMPTY）会重试，成功后返回', async () => {
  for (const code of RETRY_CODES) {
    const dir = await mkTmp();
    const from = path.join(dir, 'a.txt');
    const to = path.join(dir, 'b.txt');
    await fs.writeFile(from, '内容', 'utf8');
    let attempts = 0;
    const real = fs.rename;
    const restore = patchRename(async (src, dest) => {
      attempts += 1;
      if (attempts <= 2) throw fsError(code);
      return real.call(fs, src, dest);
    });
    try {
      await atomic.renameWithRetry(from, to);
      assert.equal(attempts, 3, `${code} 应该在第 3 次成功`);
      assert.equal(await fs.readFile(to, 'utf8'), '内容');
      assert.equal(await fs.access(from).then(() => true, () => false), false);
    } finally {
      restore();
    }
  }
});

test('重试策略：不可重试错误立刻抛（不重试、不白等）：ENOENT / ENOSPC / EXDEV / EISDIR', async () => {
  for (const code of NON_RETRY_CODES) {
    const dir = await mkTmp();
    let attempts = 0;
    const restore = patchRename(async () => {
      attempts += 1;
      throw fsError(code);
    });
    try {
      await assert.rejects(
        () => atomic.renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { delay: 1 }),
        (err) => err.code === code
      );
      assert.equal(attempts, 1, `${code} 不该重试`);
    } finally {
      restore();
    }
  }
});

test('重试策略：重试用尽后抛最后一次错误（tries 生效，且最后一次不再 sleep）', async () => {
  const dir = await mkTmp();
  let attempts = 0;
  const restore = patchRename(async () => {
    attempts += 1;
    throw fsError('EBUSY');
  });
  try {
    await assert.rejects(
      () => atomic.renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { tries: 3, delay: 1 }),
      (err) => err.code === 'EBUSY'
    );
    assert.equal(attempts, 3);
    attempts = 0;
    await assert.rejects(
      () => atomic.renameWithRetry(path.join(dir, 'a'), path.join(dir, 'b'), { tries: 1, delay: 1 }),
      (err) => err.code === 'EBUSY'
    );
    assert.equal(attempts, 1, 'tries=1 只尝试一次');
  } finally {
    restore();
  }
});

test('atomicWriteFile：写盘失败时目标文件一个字节不动、临时文件不残留（绝不出现半截文件）', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '书目.json');
  await fs.writeFile(target, '旧完整版', 'utf8');
  // EACCES 是「可重试」但这里让它一直失败：最终必须抛错，且旧文件原样
  const restore = patchRename(async () => {
    throw fsError('EACCES');
  });
  try {
    await assert.rejects(() => atomic.atomicWriteFile(target, '新内容', 'utf8'), (err) => err.code === 'EACCES');
  } finally {
    restore();
  }
  assert.equal(await fs.readFile(target, 'utf8'), '旧完整版', '目标文件必须还是旧完整版');
  assert.deepEqual(await tmpEntries(dir), [], '失败后不许留下临时文件');
});

test('atomicWriteFile：临时文件与目标同目录、以「.」开头带 .tmp-，成功后自动消失', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '001-起风.txt');
  const seen = [];
  const real = fs.rename;
  const restore = patchRename(async (src, dest) => {
    seen.push({
      sameDir: path.dirname(src) === path.dirname(dest),
      base: path.basename(src),
      targetBase: path.basename(dest),
      existsBeforeRename: await fs.access(src).then(() => true, () => false)
    });
    return real.call(fs, src, dest);
  });
  try {
    await atomic.atomicWriteFile(target, '正文', 'utf8');
  } finally {
    restore();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sameDir, true, '临时文件必须和目标同目录（rename 不能跨卷）');
  assert.equal(seen[0].targetBase, '001-起风.txt');
  assert.match(seen[0].base, /^\.001-起风\.txt\.tmp-\d+-\d+-[a-z0-9]+$/);
  assert.equal(seen[0].existsBeforeRename, true, 'rename 之前临时文件必须已经写好');
  assert.deepEqual(await tmpEntries(dir), [], '成功后临时文件应已被 rename 走');
  assert.equal(await fs.readFile(target, 'utf8'), '正文');
});

test('静态闸门：临时文件 → fsync → rename 的顺序不许调换，失败路径要清理临时文件', async () => {
  const src = await fs.readFile(path.join(__dirname, '..', 'core', 'atomic.js'), 'utf8');
  const openAt = src.indexOf("fs.open(tmp, 'w')");
  const writeAt = src.indexOf('handle.writeFile(data, encoding)');
  const syncAt = src.indexOf('await handle.sync()');
  const closeAt = src.indexOf('await handle.close()', syncAt);
  const renameAt = src.indexOf('await renameWithRetry(tmp, filePath)');
  assert.ok(openAt > 0 && writeAt > openAt, '先 open 再 writeFile');
  assert.ok(syncAt > writeAt, '写完之后必须 fsync');
  assert.ok(closeAt > syncAt, 'fsync 之后才 close');
  assert.ok(renameAt > closeAt, 'fsync + close 之后才 rename');
  assert.match(src, /catch \(err\) \{[\s\S]*?fs\.unlink\(tmp\)/, '失败路径必须删掉临时文件');
  for (const name of ['atomicWriteFile', 'renameWithRetry', 'readJson', 'writeJsonAtomic', 'stripBom', 'sleep']) {
    assert.equal(typeof atomic[name], 'function', `导出 ${name} 不许被删`);
  }
});

test('atomicWriteFile：并发写不同的文件——临时文件名互不重复、全部成功、不留临时文件', async () => {
  const dir = await mkTmp();
  const bases = [];
  const real = fs.rename;
  const restore = patchRename(async (src, dest) => {
    bases.push(path.basename(src));
    return real.call(fs, src, dest);
  });
  const payloads = Array.from({ length: 20 }, (_, i) => `第${i}版 ` + 'x'.repeat(i * 37));
  try {
    await Promise.all(
      payloads.map((text, i) => atomic.atomicWriteFile(path.join(dir, `并发-${i}.txt`), text, 'utf8'))
    );
  } finally {
    restore();
  }
  assert.equal(bases.length, 20);
  assert.equal(new Set(bases).size, 20, '并发时临时文件名必须互不重复');
  assert.deepEqual(await tmpEntries(dir), [], '并发写不许留下临时文件');
  for (let i = 0; i < payloads.length; i += 1) {
    assert.equal(await fs.readFile(path.join(dir, `并发-${i}.txt`), 'utf8'), payloads[i]);
  }
});

test('atomicWriteFile：同一路径并发写也只会是「整份的某一版」，不会写出半截内容', async () => {
  // 实测（本机 Windows，5 轮）：同一路径 8 路以上同时 rename 时会争用到把 3 次重试耗尽 → 干净的 EPERM 失败；
  // 产品里同一个文件的写盘本来就被串行化（书锁 / 单窗口单书 / 一次只保存一章），所以这里钉的是红线：
  // **绝不出现半截文件**，失败也必须是可重试码且不留临时文件。
  const dir = await mkTmp();
  const target = path.join(dir, '并发.txt');
  const payloads = Array.from({ length: 5 }, (_, i) => `第${i}版 ` + 'x'.repeat(i * 37));
  const results = await Promise.allSettled(payloads.map((text) => atomic.atomicWriteFile(target, text, 'utf8')));
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.ok(
        ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(result.reason.code),
        `失败只允许是可重试的系统错误：${result.reason.code}`
      );
    }
  }
  assert.ok(results.some((result) => result.status === 'fulfilled'), '至少有一次要写成功');
  const finalText = await fs.readFile(target, 'utf8');
  assert.ok(payloads.includes(finalText), '最终内容必须是某一次的完整内容（不能是拼接 / 截断）');
  assert.deepEqual(await tmpEntries(dir), [], '并发写不许留下临时文件');
});

test('writeJsonAtomic / readJson：两空格缩进 + 结尾换行，能原样读回；BOM 开头也能读', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '书目.json');
  const obj = { version: 1, chapters: [{ id: 'ch_001', file: '001-起风.txt', name: '起风' }] };
  await atomic.writeJsonAtomic(file, obj);
  assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify(obj, null, 2)}\n`);
  assert.deepEqual(await atomic.readJson(file), obj);

  const bomFile = path.join(dir, '带BOM.json');
  await fs.writeFile(bomFile, `\uFEFF${JSON.stringify(obj)}`, 'utf8');
  assert.deepEqual(await atomic.readJson(bomFile), obj);
});

test('stripBom：只吃开头那个 BOM，普通文本 / 数字 / null 都安全', () => {
  assert.equal(atomic.stripBom('\uFEFFabc'), 'abc');
  assert.equal(atomic.stripBom('abc'), 'abc');
  assert.equal(atomic.stripBom('a\uFEFFb'), 'a\uFEFFb', '只有开头才算 BOM');
  assert.equal(atomic.stripBom(null), '');
  assert.equal(atomic.stripBom(undefined), '');
  assert.equal(atomic.stripBom(42), '42');
});

test('readJson：坏 JSON 直接抛错，不返回半份数据', async () => {
  const dir = await mkTmp();
  const broken = path.join(dir, '坏.json');
  await fs.writeFile(broken, '{"chapters": [', 'utf8');
  await assert.rejects(() => atomic.readJson(broken), (err) => err instanceof SyntaxError);
  await assert.rejects(() => atomic.readJson(path.join(dir, '不存在.json')), (err) => err.code === 'ENOENT');
});

test('反回退：core/storage.js 与 main.js 不许绕过原子写（不直接 writeFile / writeFileSync / createWriteStream）', async () => {
  const root = path.join(__dirname, '..');
  for (const rel of ['core/storage.js', 'main.js']) {
    const src = await fs.readFile(path.join(root, rel), 'utf8');
    for (const bad of ['fs.writeFile(', 'writeFileSync(', 'createWriteStream(', 'fs.appendFile(', 'appendFileSync(']) {
      assert.equal(src.includes(bad), false, `${rel} 不许出现 ${bad}（落盘必须经过 core/atomic.js）`);
    }
    assert.match(src, /require\('\.\/atomic'\)|require\('\.\/core\/atomic'\)/, `${rel} 必须用 core/atomic.js`);
  }
  // 唯一允许直接写文件的是导入暂存目录（core/importer.js）：那里写的是「还没成为书」的临时目录，
  // 写坏了直接丢掉整个暂存目录，不会污染任何已有书 / 章节。
  const importer = await fs.readFile(path.join(root, 'core', 'importer.js'), 'utf8');
  assert.equal(importer.includes('fs.writeFile('), true, 'importer 的暂存写入是有意的（不改就不该动它）');
});
