const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bookInfo = require('../core/bookinfo');
const storage = require('../core/storage');

async function mkTmp(prefix = 'cw-bookinfo-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('书籍信息：作者单行化、去首尾空白、限长；非字符串当空', () => {
  assert.equal(bookInfo.sanitizeAuthor('  张三  '), '张三');
  assert.equal(bookInfo.sanitizeAuthor('张\n三\t著'), '张 三 著');
  assert.equal(bookInfo.sanitizeAuthor('张   三'), '张 三');
  assert.equal(bookInfo.sanitizeAuthor(42), '');
  assert.equal(bookInfo.sanitizeAuthor(null), '');
  assert.equal(bookInfo.sanitizeAuthor('名'.repeat(bookInfo.MAX_AUTHOR_LENGTH + 20)).length, bookInfo.MAX_AUTHOR_LENGTH);
});

test('书籍信息：分组是单行短文本，超长截断', () => {
  assert.equal(bookInfo.sanitizeGroup('  玄幻  '), '玄幻');
  assert.equal(bookInfo.sanitizeGroup('短篇\r\n合集'), '短篇 合集');
  assert.equal(bookInfo.sanitizeGroup('组'.repeat(bookInfo.MAX_GROUP_LENGTH + 5)).length, bookInfo.MAX_GROUP_LENGTH);
  assert.equal(bookInfo.sanitizeGroup(undefined), '');
});

test('书籍信息：简介保留换行、去行尾空白、合并多余空行、限长', () => {
  assert.equal(bookInfo.sanitizeBrief('第一行\r\n\r\n\r\n第二行   '), '第一行\n\n第二行');
  assert.equal(bookInfo.sanitizeBrief('\r\n\r\n开头有空行\n\n\n\n结尾也有\r\n\r\n'), '开头有空行\n\n结尾也有');
  assert.equal(bookInfo.sanitizeBrief('   '), '');
  assert.equal(bookInfo.sanitizeBrief(123), '');
  const long = '段'.repeat(bookInfo.MAX_BRIEF_LENGTH + 100);
  assert.equal(bookInfo.sanitizeBrief(long).length, bookInfo.MAX_BRIEF_LENGTH);
  // 代理对不被从中间切开
  const emoji = bookInfo.sanitizeBrief('😀'.repeat(700));
  assert.equal(emoji.length % 2, 0);
  assert.equal(/[\uD800-\uDBFF]$/.test(emoji), false);
});

test('书籍信息：标签支持数组 / 各种分隔符、去空去重、限个数与长度', () => {
  assert.deepEqual(bookInfo.sanitizeTags([' 爽文 ', '', '升级', '爽文']), ['爽文', '升级']);
  assert.deepEqual(bookInfo.sanitizeTags('爽文，升级、悬疑; 短篇、爽文'), ['爽文', '升级', '悬疑', '短篇']);
  assert.deepEqual(bookInfo.sanitizeTags('a\nb'), ['a', 'b']);
  assert.deepEqual(bookInfo.sanitizeTags(12), []);
  const many = Array.from({ length: 15 }, (_, i) => `标签${i + 1}`);
  assert.equal(bookInfo.sanitizeTags(many).length, bookInfo.MAX_TAGS);
  const longTag = '标'.repeat(bookInfo.MAX_TAG_LENGTH + 8);
  assert.equal(bookInfo.sanitizeTags([longTag])[0].length, bookInfo.MAX_TAG_LENGTH);
});

test('书籍信息：旧书没有可选字段时读成空值，不补字段', () => {
  const meta = { title: '旧书', chapters: [{ id: 'ch_001', file: '001.txt' }] };
  assert.deepEqual(bookInfo.readBookInfo(meta), { author: '', brief: '', group: '', tags: [] });
  const cleaned = bookInfo.cleanBookInfo(meta);
  assert.deepEqual(cleaned, meta);
  assert.equal('author' in cleaned, false);
  assert.equal('tags' in cleaned, false);
});

test('书籍信息：脏值读取时清洗，不改原对象；空值不落字段', () => {
  const meta = {
    title: '书',
    chapters: [],
    author: '  张三\n',
    brief: '第一行\r\n\r\n\r\n第二行',
    group: 42,
    tags: [' 爽文 ', '爽文', 7, '']
  };
  const info = bookInfo.readBookInfo(meta);
  assert.deepEqual(info, { author: '张三', brief: '第一行\n\n第二行', group: '', tags: ['爽文'] });
  assert.equal(meta.author, '  张三\n', '不修改传入对象');
  const cleaned = bookInfo.cleanBookInfo(meta);
  assert.equal(cleaned.author, '张三');
  assert.equal(cleaned.brief, '第一行\n\n第二行');
  assert.equal('group' in cleaned, false, '非法分组被清掉');
  assert.deepEqual(cleaned.tags, ['爽文']);
  assert.equal(cleaned.title, '书');
  assert.deepEqual(cleaned.chapters, []);
});

test('书籍信息：patch 只认四个白名单字段，类型不对返回 null', () => {
  assert.equal(bookInfo.bookInfoPatchFields(null), null);
  assert.equal(bookInfo.bookInfoPatchFields([]), null);
  assert.equal(bookInfo.bookInfoPatchFields({}), null);
  assert.equal(bookInfo.bookInfoPatchFields({ title: '改书名' }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ author: 42 }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ brief: null }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ tags: { a: 1 } }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ tags: ['ok', 3] }), null);
  assert.deepEqual(bookInfo.bookInfoPatchFields({ author: ' 张三 ' }), { author: '张三' });
  assert.deepEqual(bookInfo.bookInfoPatchFields({ group: '' }), { group: '' });
  assert.deepEqual(bookInfo.bookInfoPatchFields({ tags: [] }), { tags: [] });
  assert.deepEqual(bookInfo.bookInfoPatchFields({ tags: '爽文，升级' }), { tags: ['爽文', '升级'] });
});

test('书籍信息：sameBookInfo 比较四个字段，标签顺序算不同', () => {
  const base = { author: '张三', brief: '简介', group: '玄幻', tags: ['爽文', '升级'] };
  assert.equal(bookInfo.sameBookInfo(base, { ...base, tags: [...base.tags] }), true);
  assert.equal(bookInfo.sameBookInfo(base, { ...base, author: '李四' }), false);
  assert.equal(bookInfo.sameBookInfo(base, { ...base, tags: ['升级', '爽文'] }), false);
  assert.equal(bookInfo.sameBookInfo({}, { author: '', brief: '', group: '', tags: [] }), true);
});

test('书籍信息：书架搜索补作者 / 分组 / 标签，字面量不区分大小写', () => {
  const info = { author: '张三', group: '玄幻', tags: ['爽文', 'Upgrade'] };
  assert.equal(bookInfo.bookInfoMatches(info, '张三'), true);
  assert.equal(bookInfo.bookInfoMatches(info, '玄幻'), true);
  assert.equal(bookInfo.bookInfoMatches(info, '爽'), true);
  assert.equal(bookInfo.bookInfoMatches(info, 'upgrade'), true);
  assert.equal(bookInfo.bookInfoMatches(info, ' 张三 '), true);
  assert.equal(bookInfo.bookInfoMatches(info, '李四'), false);
  assert.equal(bookInfo.bookInfoMatches(info, ''), false);
  assert.equal(bookInfo.bookInfoMatches(null, '张三'), false);
});

test('书籍信息：摘要只拼非空字段', () => {
  assert.equal(
    bookInfo.bookInfoSummary({ author: '张三', group: '玄幻', tags: ['爽文', '升级'] }),
    '作者：张三 · 分组：玄幻 · #爽文 #升级'
  );
  assert.equal(bookInfo.bookInfoSummary({}), '');
});

test('书籍信息：updateBookInfo 只写书目可选字段，章节 txt / 文件名 / 文件夹不变', async () => {
  const root = await mkTmp();
  const created = await storage.createBook(root, '信息测试书');
  const bookPath = created.path;
  let meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  const filePath = path.join(bookPath, file);
  await storage.saveChapterText(bookPath, file, '第一章正文\n');
  const beforeText = await fs.readFile(filePath);
  const beforeStat = await fs.stat(filePath);
  const beforeEntries = (await fs.readdir(bookPath)).sort();
  const beforeMetaBytes = await fs.readFile(path.join(bookPath, '书目.json'));

  const result = await storage.updateBookInfo(bookPath, {
    author: ' 张三 ',
    brief: '第一行\r\n\r\n\r\n第二行  ',
    group: ' 玄幻 ',
    tags: ['爽文', ' 爽文 ', '升级', '']
  });
  assert.equal(result.changed, true);

  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.author, '张三');
  assert.equal(meta.brief, '第一行\n\n第二行');
  assert.equal(meta.group, '玄幻');
  assert.deepEqual(meta.tags, ['爽文', '升级']);

  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(onDisk.author, '张三');
  assert.equal(onDisk.group, '玄幻');
  assert.deepEqual(onDisk.tags, ['爽文', '升级']);
  // 上一版书目留在 .bak（原样，不是脏值）
  const bak = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8'));
  assert.equal(bak.author, undefined);
  assert.equal(bak.title, created.meta.title);
  assert.deepEqual(beforeMetaBytes, await fs.readFile(path.join(bookPath, '书目.json.bak')));

  // 章节 txt、文件名、文件夹内容都没变（只有书目 / .bak 被原子替换）
  assert.deepEqual(await fs.readFile(filePath), beforeText);
  const afterStat = await fs.stat(filePath);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  const afterEntries = (await fs.readdir(bookPath)).sort();
  const contentFiles = (names) => names.filter((name) => name !== '书目.json' && name !== '书目.json.bak');
  assert.deepEqual(contentFiles(afterEntries), contentFiles(beforeEntries), '章节 txt 等文件一个不多一个不少');

  // 书架列表带上这四个可选字段（旧书则是空值）
  const listed = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.equal(listed.author, '张三');
  assert.equal(listed.brief, '第一行\n\n第二行');
  assert.equal(listed.group, '玄幻');
  assert.deepEqual(listed.tags, ['爽文', '升级']);
});

test('书籍信息：清空可选字段 = 从书目里删掉；没有变化时不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '清空测试');
  await storage.updateBookInfo(bookPath, { author: '张三', brief: '简介', group: '玄幻', tags: ['爽文'] });

  const first = await storage.updateBookInfo(bookPath, { author: '', brief: '', group: '', tags: [] });
  assert.equal(first.changed, true);
  let meta = await storage.readBookMeta(bookPath);
  assert.equal('author' in meta, false);
  assert.equal('brief' in meta, false);
  assert.equal('group' in meta, false);
  assert.equal('tags' in meta, false);

  // 同样的值再存一次：changed=false，书目字节与 mtime 都不动（不无意义轮换 .bak）
  const metaPath = path.join(bookPath, '书目.json');
  const beforeBytes = await fs.readFile(metaPath);
  const beforeStat = await fs.stat(metaPath);
  const again = await storage.updateBookInfo(bookPath, { author: '', group: '', tags: [] });
  assert.equal(again.changed, false);
  assert.deepEqual(await fs.readFile(metaPath), beforeBytes);
  assert.equal((await fs.stat(metaPath)).mtimeMs, beforeStat.mtimeMs);
  meta = await storage.readBookMeta(bookPath);
  assert.equal('author' in meta, false);

  // 非法 patch 直接拒绝，不静默清空
  await assert.rejects(
    () => storage.updateBookInfo(bookPath, { author: 42 }),
    (err) => err.code === 'BAD_BOOK_INFO'
  );
  await assert.rejects(
    () => storage.updateBookInfo(bookPath, {}),
    (err) => err.code === 'BAD_BOOK_INFO'
  );
  await assert.rejects(
    () => storage.updateBookInfo(bookPath, { tags: [1, 2] }),
    (err) => err.code === 'BAD_BOOK_INFO'
  );
});

test('书籍信息：旧书（没有可选字段）照常改名 / 改章信息，不补书籍字段', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '旧书兼容');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal('author' in meta, false);
  assert.equal('brief' in meta, false);
  assert.equal('group' in meta, false);
  assert.equal('tags' in meta, false);

  await storage.renameBook(bookPath, '旧书兼容-改名');
  await storage.updateChapterMeta(bookPath, meta.chapters[0].id, { status: 'done', note: '旧书备注' });
  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(onDisk.title, '旧书兼容-改名');
  assert.equal(onDisk.chapters[0].status, 'done');
  for (const key of ['author', 'brief', 'group', 'tags']) {
    assert.equal(key in onDisk, false, `改名 / 改章信息不应补 ${key}`);
  }
  const listed = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.deepEqual([listed.author, listed.brief, listed.group, listed.tags], ['', '', '', []]);
});

test('书籍信息：书目里的脏值（类型不对 / 超长）读取时清洗，不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '脏值测试');
  const metaPath = path.join(bookPath, '书目.json');
  const raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  raw.author = 42;
  raw.group = '  玄幻\n下篇 ';
  raw.tags = [' 爽文 ', 9, '爽文'];
  raw.brief = '第一行\r\n\r\n\r\n第二行';
  await fs.writeFile(metaPath, JSON.stringify(raw, null, 2), 'utf8');
  const bytes = await fs.readFile(metaPath);

  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.author, undefined);
  assert.equal(meta.group, '玄幻 下篇');
  assert.deepEqual(meta.tags, ['爽文']);
  assert.equal(meta.brief, '第一行\n\n第二行');
  assert.deepEqual(await fs.readFile(metaPath), bytes, '只读不清洗落盘；下次正常写盘才落');

  const listed = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.equal(listed.author, '');
  assert.equal(listed.group, '玄幻 下篇');
  assert.deepEqual(listed.tags, ['爽文']);
});
