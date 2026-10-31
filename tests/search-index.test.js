const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const search = require('../core/search-index');

async function mkTmp(prefix = 'cw-search-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

// 手写一本书（不经过 storage.createBook），字段形状与 v0.4.1 书目一致，且可选「旧书目」形状
async function makeBook(booksRoot, folder, title, chapters, options = {}) {
  const bookPath = path.join(booksRoot, folder);
  await fs.mkdir(bookPath, { recursive: true });
  const meta = {
    version: 1,
    id: options.id || `b_${folder}`,
    title,
    titleTemplate: '第{num}章',
    fileSeq: chapters.length,
    chapters: [],
    createdAt: '2026-10-31T12:00:00.000Z'
  };
  if (!options.oldShape) meta.schemaVersion = 1;
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    const file = `${pad3(i + 1)}-${chapter.slug || chapter.name || `章${i + 1}`}.txt`;
    await fs.writeFile(path.join(bookPath, file), chapter.text, 'utf8');
    meta.chapters.push({
      id: chapter.id || `ch_${pad3(i + 1)}`,
      file,
      name: chapter.name || '',
      createdAt: '2026-10-31T12:00:00.000Z'
    });
    if (Number.isFinite(chapter.chars)) meta.chapters[meta.chapters.length - 1].chars = chapter.chars;
  }
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { bookPath, meta };
}

async function readMeta(bookPath) {
  return JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
}

async function writeMeta(bookPath, meta) {
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function makeStore(userData, options = {}) {
  return search.createSearchStore({
    userDataDir: userData,
    validateIntervalMs: 0, // 单测里每次 ensure 都做全量校验，外部改 txt 能立刻发现
    ...options
  });
}

test('正文索引：查询归一化（去首尾空白 + 小写）与双字哈希稳定', () => {
  assert.equal(search.normalizeQuery('  林婉儿  '), '林婉儿');
  assert.equal(search.normalizeQuery('Hello World'), 'hello world');
  assert.equal(search.normalizeQuery(null), '');
  const one = search.queryBigrams('林婉儿');
  assert.equal(one.length, 2); // 林婉、婉儿
  assert.deepEqual(search.queryBigrams('林婉儿'), one);
  assert.equal(search.queryBigrams('林').length, 0);
  assert.equal(search.bigramHash(0x6797, 0x5a49), search.bigramHash(0x6797, 0x5a49));
  assert.notEqual(search.bigramHash(0x6797, 0x5a49), search.bigramHash(0x5a49, 0x6797));
});

test('正文索引：Bloom 位图对文中出现过的双字绝不漏报，编码解码往返一致', () => {
  const texts = ['林婉儿撑着一把青柠色的雨伞，站在旧车站的月台上。', '雨还在下，钟停在 3:17。'];
  const built = search.makeBookBloom(texts);
  assert.ok(built.bits >= search.MIN_BLOOM_BITS);
  assert.ok(built.items > 0);
  for (const query of ['青柠色', '旧车站', '林婉儿', '3:17', '雨还在下']) {
    for (const hash of search.queryBigrams(query)) {
      assert.equal(search.bloomHas(built.bloom, built.bits, hash), true, `不能漏报：${query}`);
    }
  }
  const encoded = search.encodeBloom(built.bloom);
  const decoded = search.decodeBloom(encoded, built.bits);
  assert.ok(Buffer.isBuffer(decoded));
  assert.deepEqual(decoded, built.bloom);
  assert.equal(search.decodeBloom('不是 base64', built.bits + 8), null);
  assert.equal(search.decodeBloom('', built.bits), null);
  // 位数与字节数对不上（索引被截断 / 损坏）时不给位图：搜索按「本书永远是候选」处理
  assert.equal(search.decodeBloom(encoded, built.bits * 2), null);
});

test('正文索引：空书不误报（全零位图）', () => {
  const built = search.makeBookBloom([]);
  assert.equal(built.items, 0);
  for (const hash of search.queryBigrams('青柠')) {
    assert.equal(search.bloomHas(built.bloom, built.bits, hash), false);
  }
});

test('正文索引：上下文片段保留前后各一段、换行折成空格、标明是否截断', () => {
  const text = '第一行。\n他撑着一把青柠色的雨伞，站在旧车站的月台上。\n风很轻。';
  const at = text.indexOf('青柠色');
  const snip = search.snippetAround(text, at, 3, 6);
  assert.equal(snip.match, '青柠色');
  assert.equal(snip.before.includes('\n'), false);
  assert.equal(snip.after.includes('\n'), false);
  assert.equal(snip.cutBefore, true);
  assert.equal(snip.cutAfter, true);

  const head = search.snippetAround('青柠色雨伞', 0, 3, 16);
  assert.equal(head.before, '');
  assert.equal(head.match, '青柠色');
  assert.equal(head.after, '雨伞');
  assert.equal(head.cutBefore, false);
  assert.equal(head.cutAfter, false);

  const tail = search.snippetAround('一把青柠色', 2, 3, 16);
  assert.equal(tail.after, '');
  assert.equal(tail.cutAfter, false);
});

test('正文索引：索引文件解析只认当前版本，坏 JSON / 坏条目一律清洗掉', () => {
  assert.equal(search.parseIndex('不是 json'), null);
  assert.equal(search.parseIndex('{}'), null);
  const wrong = search.serializeIndex({ version: 999, root: 'x', books: [] });
  assert.equal(search.parseIndex(wrong), null);

  const dirty = {
    version: search.INDEX_VERSION,
    root: 'C:\\Books',
    builtAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    books: [
      null,
      { path: '', chapters: [] },
      {
        path: 'C:\\Books\\A',
        folder: 'A',
        title: '测试书',
        metaMtimeMs: 123,
        lastModified: 100,
        bloom: 'AAAA',
        bloomBits: 24,
        itemCount: 2,
        chapters: [
          { file: '001-x.txt', name: '起风', index: 0, mtimeMs: 10, size: 20, chars: 3 },
          { file: '', name: '坏章' },
          null
        ]
      }
    ]
  };
  const parsed = search.parseIndex(JSON.stringify(dirty));
  assert.ok(parsed);
  assert.equal(parsed.books.length, 1);
  assert.equal(parsed.books[0].chapters.length, 1); // 空 file 的坏章被丢掉
  assert.equal(parsed.books[0].chapters[0].name, '起风');
  assert.equal(parsed.books[0].title, '测试书');
  assert.equal(search.totalChapters(parsed), 1);
});

test('正文索引：建索引落在 userData（不进书库），只存指纹与位图、不存正文', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const marker = '这是一整段绝对不该被写进索引文件里面的正文';
  await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text: `雨还在下。${marker}。他撑着一把青柠色的雨伞。` },
    { name: '夜雨', text: '风从海面吹来，带着咸味。' }
  ]);
  await makeBook(booksRoot, '另一本', '另一本', [{ name: '起风', text: '清晨的街道很安静。' }]);

  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 2);
  assert.equal(status.chapters, 3);
  assert.equal(status.problem, null);
  assert.ok(status.bytes > 0);
  assert.ok(status.builtAt);

  // 索引只写 userData，书库 / 书文件夹里没有多出文件
  assert.equal(await exists(path.join(userData, search.INDEX_FILE_NAME)), true);
  assert.equal(await exists(path.join(booksRoot, search.INDEX_FILE_NAME)), false);
  assert.deepEqual((await fs.readdir(booksRoot)).sort(), ['另一本', '测试书'].sort());
  assert.deepEqual((await fs.readdir(path.join(booksRoot, '测试书'))).sort(), ['001-旧车站.txt', '002-夜雨.txt', '书目.json']);

  const raw = await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8');
  assert.equal(raw.includes(marker), false, '索引里不能有正文');
  assert.equal(raw.includes('青柠色的雨伞'), false);
  assert.ok(JSON.parse(raw).books.length === 2);
  const first = JSON.parse(raw).books.find((book) => book.folder === '测试书');
  assert.ok(first.bloom.length > 0);
  assert.equal(first.chapters.length, 2);
  assert.ok(first.chapters[0].mtimeMs > 0 && first.chapters[0].size > 0);
});

test('正文索引：搜正文返回章名 / 上下文 / 命中位置，大小写不敏感，搜不到的返回空', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const text = '雨还在下。他撑着一把青柠色的雨伞，站在旧车站的月台上。\n风很轻。';
  await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text },
    { name: '夜雨', text: 'Nothing about that here.' }
  ]);
  const store = makeStore(userData);

  const hit = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(hit.tooShort, false);
  assert.equal(hit.results.length, 1);
  const row = hit.results[0];
  assert.equal(row.bookTitle, '测试书');
  assert.equal(row.chapterIndex, 0);
  assert.equal(row.chapterName, '旧车站');
  assert.equal(row.matchIndex, text.indexOf('青柠色'));
  assert.equal(text.slice(row.matchIndex, row.matchIndex + row.matchLength), '青柠色');
  assert.equal(row.snippet.match, '青柠色');
  assert.ok(row.snippet.before.length > 0);
  assert.ok(row.snippet.after.length > 0);
  assert.equal(hit.index.books, 1);
  assert.equal(hit.index.chapters, 2);
  assert.equal(hit.scannedBooks, 1);

  const latin = await store.search({ booksRoot, query: 'NOTHING' });
  assert.equal(latin.results.length, 1);
  assert.equal(latin.results[0].chapterName, '夜雨');

  const miss = await store.search({ booksRoot, query: '绝对不存在的词xyz' });
  assert.equal(miss.results.length, 0);
  assert.equal(miss.truncated, false);

  const short = await store.search({ booksRoot, query: '雨' });
  assert.equal(short.tooShort, true);
  assert.equal(short.results.length, 0);
});

test('正文索引：结果按 limit 截断并标记 truncated（分页 / 限量）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const chapters = [];
  for (let i = 0; i < 5; i += 1) {
    chapters.push({ name: `第${i + 1}节`, text: `青柠色的雨伞每天都出现（第${i + 1}章）。` });
  }
  await makeBook(booksRoot, '多章书', '多章书', chapters);
  const store = makeStore(userData);
  const limited = await store.search({ booksRoot, query: '青柠色', limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.limit, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.matchedChapters, 2);
  const all = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(all.results.length, 5);
  assert.equal(all.truncated, false);
});

test('正文索引：改章名只更新元数据（不重读正文、不重建位图）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧名字', text: '青柠色的雨伞。' }
  ]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  const before = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(before.results[0].chapterName, '旧名字');
  const bloomBefore = JSON.parse(await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8')).books[0].bloom;

  // 只改章名（模拟应用内重命名：只写 书目.json，不动 txt）
  const meta = await readMeta(bookPath);
  meta.chapters[0].name = '新名字';
  await writeMeta(bookPath, meta);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 0);
  assert.equal(status.lastRun.reusedBooks, 1);
  const after = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(after.results[0].chapterName, '新名字');
  const bloomAfter = JSON.parse(await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8')).books[0].bloom;
  assert.equal(bloomAfter, bloomBefore, '正文没变时位图不应该重建');
});

test('正文索引：外部改 txt（mtime / size 变了）会被发现并更新索引', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath, meta } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text: '旧车站的雨伞是灰色的。' }
  ]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  assert.equal((await store.search({ booksRoot, query: '灰色' })).results.length, 1);

  // 直接改磁盘上的章节 txt（模拟在别的编辑器里改过）
  const chapterPath = path.join(bookPath, meta.chapters[0].file);
  await fs.writeFile(chapterPath, '旧车站的雨伞换成了青柠色的。', 'utf8');
  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 1);
  const oldTerm = await store.search({ booksRoot, query: '灰色' });
  assert.equal(oldTerm.results.length, 0);
  const newTerm = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(newTerm.results.length, 1);
});

test('正文索引：章节文件被删 / 章被删，索引跟着剔除，不会崩也不会再命中', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath, meta } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text: '青柠色的雨伞。' },
    { name: '夜雨', text: '灰蓝色的雨伞。' }
  ]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });

  // 只在书目里删掉第二章（文件还在）：索引「章节数」要跟着书目走
  const nextMeta = await readMeta(bookPath);
  nextMeta.chapters = nextMeta.chapters.slice(0, 1);
  await writeMeta(bookPath, nextMeta);
  const afterMeta = await store.ensure({ booksRoot });
  assert.equal(afterMeta.chapters, 1);
  assert.equal((await store.search({ booksRoot, query: '灰蓝色' })).results.length, 0);

  // 章节文件被删（书目里还在）：跳过该章，不抛错
  await fs.unlink(path.join(bookPath, meta.chapters[0].file));
  const afterMissing = await store.ensure({ booksRoot });
  assert.equal(afterMissing.chapters, 0);
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 0);
});

test('正文索引：整本书被删掉后从索引消失', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  await makeBook(booksRoot, '要删掉的书', '要删掉的书', [{ name: '章', text: '青柠色的雨伞。' }]);
  await makeBook(booksRoot, '留下的书', '留下的书', [{ name: '章', text: '普通的一段。' }]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 1);
  await fs.rm(path.join(booksRoot, '要删掉的书'), { recursive: true, force: true });
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.equal(status.lastRun.removedBooks, 1);
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 0);
});

test('正文索引：索引文件坏了 / 版本不对 → 自动重建，不抛错', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  await makeBook(booksRoot, '测试书', '测试书', [{ name: '章', text: '青柠色的雨伞。' }]);
  await fs.writeFile(path.join(userData, search.INDEX_FILE_NAME), '{"version":999,"books":[]}', 'utf8');
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.equal(status.chapters, 1);
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 1);
  const reloaded = makeStore(userData);
  const status2 = await reloaded.ensure({ booksRoot });
  assert.equal(status2.books, 1);
});

test('正文索引：书架目录换了 → 旧索引作废、按新目录重建（不会串书）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksA = path.join(base, 'booksA');
  const booksB = path.join(base, 'booksB');
  await fs.mkdir(userData);
  await fs.mkdir(booksA);
  await fs.mkdir(booksB);
  await makeBook(booksA, 'A书', 'A书', [{ name: '章', text: '青柠色的雨伞。' }]);
  await makeBook(booksB, 'B书', 'B书', [{ name: '章', text: '灰蓝色的雨伞。' }]);
  const store = makeStore(userData);
  assert.equal((await store.ensure({ booksRoot: booksA })).books, 1);
  assert.equal((await store.search({ booksRoot: booksA, query: '青柠色' })).results.length, 1);
  assert.equal((await store.ensure({ booksRoot: booksB })).books, 1);
  assert.equal((await store.search({ booksRoot: booksB, query: '青柠色' })).results.length, 0);
  assert.equal((await store.search({ booksRoot: booksB, query: '灰蓝色' })).results.length, 1);
});

test('正文索引：markDirty 让最近保存过的书立即重建（不必等外部校验）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath } = await makeBook(booksRoot, '测试书', '测试书', [{ name: '章', text: '青柠色的雨伞。' }]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  store.markDirty(bookPath);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 1);
  assert.equal(store.dirtyList().length, 0, '重建后脏标记要清掉');
});

test('正文索引：索引写盘失败（位置被目录占住）时搜索照常，恢复后 flush 成功', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  await makeBook(booksRoot, '测试书', '测试书', [{ name: '章', text: '青柠色的雨伞。' }]);
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  await fs.mkdir(indexPath); // 用同名目录占住索引文件的位置
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.ok(status.saveError);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1, '索引写不进去也不能挡搜索');
  await fs.rm(indexPath, { recursive: true, force: true });
  await store.flush();
  assert.equal(search.parseIndex(await fs.readFile(indexPath, 'utf8')) !== null, true);
});

test('正文索引：旧书目（v0.4.1 形状，没有 schemaVersion）照常建索引与搜索', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath } = await makeBook(
    booksRoot,
    '旧书',
    '旧书',
    [{ name: '', text: '旧车站的雨伞是青柠色的。' }],
    { oldShape: true }
  );
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].chapterName, '');
  // 建索引 / 搜索全程不改书目、不写书库
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  const meta = await readMeta(bookPath);
  assert.equal('schemaVersion' in meta, false);
});

test('正文索引：空书架 / 不存在的书架目录不崩', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 0);
  assert.equal(status.chapters, 0);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 0);
  const missing = makeStore(userData);
  const missingStatus = await missing.ensure({ booksRoot: path.join(base, '不存在') });
  assert.equal(missingStatus.error, 'ENOENT');
  assert.equal((await missing.search({ booksRoot: path.join(base, '不存在'), query: '青柠色' })).results.length, 0);
});

test('正文索引：一本书里多个命中按章返回，最多每章 3 条（列表不会炸）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const repeated = Array.from({ length: 6 }, (_, i) => `青柠色第${i + 1}次。`).join('');
  await makeBook(booksRoot, '重复书', '重复书', [{ name: '多命中', text: repeated }]);
  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '青柠色', limit: 40 });
  assert.equal(found.results.length, search.MAX_SNIPPETS_PER_CHAPTER);
  assert.equal(found.matchedChapters, 1);
  assert.equal(found.totalMatches, search.MAX_SNIPPETS_PER_CHAPTER);
  assert.equal(found.truncated, false);
});

test('正文索引：200 章规模的书建索引 / 搜索可用（不要求速度，只要求不出错）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const chapters = [];
  for (let i = 0; i < 200; i += 1) {
    const filler = '风从海面吹来，带着咸味。'.repeat(20);
    chapters.push({ name: `第${i + 1}章`, text: `${filler}${i === 137 ? '青柠色的雨伞。' : ''}` });
  }
  await makeBook(booksRoot, '大部头', '大部头', chapters);
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.equal(status.chapters, 200);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].chapterIndex, 137);
});

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
