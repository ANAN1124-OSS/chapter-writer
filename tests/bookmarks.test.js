const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BOOKMARKS,
  MAX_QUERY_LENGTH,
  keyOf,
  normalizeBookmark,
  sanitizeBookmarks,
  findBookmark,
  upsertBookmark,
  removeBookmark,
  bookmarkPlace,
  countBooks
} = require('../core/bookmarks');

// 构造一条完整的书签（单测里时间固定，避免依赖当前时钟）
function sample(overrides = {}) {
  return {
    bookId: 'b_book1',
    chapterId: 'ch_001',
    bookPath: 'D:\\书库\\测试书',
    bookTitle: '测试书',
    chapterName: '雨夜',
    chapterIndex: 1,
    query: '阿明',
    caseSensitive: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

test('查找书签：键只认「书 + 章」，空 id 不算一条', () => {
  assert.equal(keyOf('b1', 'ch1'), 'b1\u0000ch1');
  assert.equal(keyOf('  b1  ', '  ch1  '), 'b1\u0000ch1');
  assert.equal(keyOf('', 'ch1'), '');
  assert.equal(keyOf('b1', ''), '');
  assert.equal(keyOf(null, null), '');

  const list = [sample(), sample({ chapterId: 'ch_002', query: '雨' })];
  assert.equal(findBookmark(list, 'b_book1', 'ch_002').query, '雨');
  assert.equal(findBookmark(list, 'b_book1', 'ch_003'), null);
  assert.equal(findBookmark(list, 'b_other', 'ch_001'), null);
  assert.equal(findBookmark(null, 'b_book1', 'ch_001'), null);
  assert.equal(findBookmark(list, '', ''), null);
});

test('查找书签：单条清洗成固定形状，字段去空白限长，查询词保留原文', () => {
  const bookmark = normalizeBookmark(
    sample({
      bookId: '  b_book1  ',
      chapterId: '  ch_001  ',
      bookPath: '  D:\\书库\\测试书  ',
      bookTitle: '  测试书  ',
      chapterName: '  雨夜  ',
      chapterIndex: '3',
      query: '  阿明  ',
      caseSensitive: 'true'
    }),
    { now: 5000 }
  );
  assert.deepEqual(bookmark, {
    bookId: 'b_book1',
    chapterId: 'ch_001',
    bookPath: 'D:\\书库\\测试书',
    bookTitle: '测试书',
    chapterName: '雨夜',
    chapterIndex: 3,
    query: '  阿明  ',
    caseSensitive: false,
    createdAt: 1000,
    updatedAt: 1000
  });
  // 只留白名单字段：正文 / 命中位置这类内容绝不进配置
  assert.deepEqual(Object.keys(bookmark), [
    'bookId',
    'chapterId',
    'bookPath',
    'bookTitle',
    'chapterName',
    'chapterIndex',
    'query',
    'caseSensitive',
    'createdAt',
    'updatedAt'
  ]);
});

test('查找书签：缺书 / 缺章 / 空查询词的坏条目直接丢弃（不抛错）', () => {
  assert.equal(normalizeBookmark(null), null);
  assert.equal(normalizeBookmark('x'), null);
  assert.equal(normalizeBookmark([]), null);
  assert.equal(normalizeBookmark(sample({ bookId: '' })), null);
  assert.equal(normalizeBookmark(sample({ chapterId: '   ' })), null);
  assert.equal(normalizeBookmark(sample({ query: '' })), null);
  assert.equal(normalizeBookmark(sample({ query: '   ' })), null);
  assert.equal(normalizeBookmark(sample({ query: 123 })), null);
  // 时间戳坏值 / 越界下标都有确定兜底
  const repaired = normalizeBookmark(
    sample({ chapterIndex: -5, createdAt: 'x', updatedAt: null }),
    { now: 7777 }
  );
  assert.equal(repaired.chapterIndex, 0);
  assert.equal(repaired.createdAt, 7777);
  assert.equal(repaired.updatedAt, 7777);
  const capped = normalizeBookmark(sample({ chapterIndex: 99999999 }), { now: 1 });
  assert.equal(capped.chapterIndex, 1000000);
});

test('查找书签：查询词超长截断、大小写只认真正的 true', () => {
  const long = normalizeBookmark(sample({ query: '长'.repeat(MAX_QUERY_LENGTH + 50) }), { now: 1 });
  assert.equal(long.query.length, MAX_QUERY_LENGTH);
  assert.equal(normalizeBookmark(sample({ caseSensitive: true }), { now: 1 }).caseSensitive, true);
  assert.equal(normalizeBookmark(sample({ caseSensitive: 'true' }), { now: 1 }).caseSensitive, false);
  assert.equal(normalizeBookmark(sample({ caseSensitive: 1 }), { now: 1 }).caseSensitive, false);
});

test('查找书签：列表清洗（非数组、坏条目、重复「书 + 章」、上限 200）', () => {
  assert.deepEqual(sanitizeBookmarks(null), []);
  assert.deepEqual(sanitizeBookmarks({}), []);
  assert.deepEqual(sanitizeBookmarks('x'), []);
  const cleaned = sanitizeBookmarks(
    [sample(), sample({ query: '旧' }), sample({ chapterId: 'ch_002' }), null, sample({ bookId: '' })],
    { now: 1 }
  );
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].query, '阿明', '同一「书 + 章」只留第一条（列表是最近保存在前）');
  assert.equal(cleaned[1].chapterId, 'ch_002');

  const many = [];
  for (let i = 0; i < MAX_BOOKMARKS + 20; i += 1) {
    many.push(sample({ chapterId: `ch_${i}` }));
  }
  const capped = sanitizeBookmarks(many, { now: 1 });
  assert.equal(capped.length, MAX_BOOKMARKS);
  assert.equal(capped[0].chapterId, 'ch_0');
  assert.equal(capped[MAX_BOOKMARKS - 1].chapterId, `ch_${MAX_BOOKMARKS - 1}`);
});

test('查找书签：存 / 更新同一条（保留第一次收藏时间、移到最前、不出重复）', () => {
  const base = [sample({ chapterId: 'ch_002', query: '雨', createdAt: 2000, updatedAt: 2000 }), sample()];
  const added = upsertBookmark(
    base,
    { bookId: 'b_book1', chapterId: 'ch_003', query: '灯' },
    { now: 3000 }
  );
  assert.equal(added.length, 3);
  assert.equal(added[0].chapterId, 'ch_003');
  assert.equal(added[0].createdAt, 3000);
  assert.equal(added[0].updatedAt, 3000);

  const updated = upsertBookmark(
    added,
    { bookId: 'b_book1', chapterId: 'ch_001', query: '阿明阿明', caseSensitive: true },
    { now: 4000 }
  );
  assert.equal(updated.length, 3, '同一「书 + 章」只更新，不新增');
  assert.equal(updated[0].chapterId, 'ch_001');
  assert.equal(updated[0].query, '阿明阿明');
  assert.equal(updated[0].caseSensitive, true);
  assert.equal(updated[0].createdAt, 1000, '保留第一次收藏时间');
  assert.equal(updated[0].updatedAt, 4000);
  assert.equal(base.length, 2, '不改调用方数组');
  assert.equal(base[1].query, '阿明', '调用方原条目没被改');

  // 坏条目不会破坏原来的列表
  assert.deepEqual(
    upsertBookmark(base, { bookId: '', chapterId: '', query: '' }).map((item) => item.chapterId),
    ['ch_002', 'ch_001']
  );
});

test('查找书签：删除只按「书 + 章」精确匹配，不动其它条目', () => {
  const list = [sample(), sample({ chapterId: 'ch_002' }), sample({ bookId: 'b_book2' })];
  const next = removeBookmark(list, 'b_book1', 'ch_002');
  assert.equal(next.length, 2);
  assert.equal(findBookmark(next, 'b_book1', 'ch_002'), null);
  assert.ok(findBookmark(next, 'b_book1', 'ch_001'));
  assert.ok(findBookmark(next, 'b_book2', 'ch_001'));
  assert.equal(list.length, 3, '不改调用方数组');

  assert.equal(removeBookmark(list, 'b_book1', '不存在').length, 3);
  assert.deepEqual(removeBookmark(null, 'b_book1', 'ch_001'), []);
  assert.deepEqual(removeBookmark(list, '', '').length, 3, '空键不清空整张表');
});

test('查找书签：位置文案与「几本书」统计', () => {
  assert.equal(bookmarkPlace(sample()), '《测试书》· 第1章：雨夜');
  assert.equal(bookmarkPlace(sample({ chapterName: '' })), '《测试书》· 第1章');
  assert.equal(bookmarkPlace(sample({ chapterIndex: 0, chapterName: '番外' })), '《测试书》· 番外');
  assert.equal(bookmarkPlace(sample({ bookTitle: '', chapterIndex: 0, chapterName: '' })), '《（未命名书）》· 未命名章节');
  assert.equal(bookmarkPlace(null), '');

  const list = [sample(), sample({ chapterId: 'ch_002' }), sample({ bookId: 'b_book2' })];
  assert.equal(countBooks(list), 2);
  assert.equal(countBooks(null), 0);
});
