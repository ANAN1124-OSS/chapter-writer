const test = require('node:test');
const assert = require('node:assert/strict');
const jump = require('../core/jump');

const CHAPTERS = [
  { id: 'ch_001', name: '起风' },
  { id: 'ch_002', name: '夜雨' },
  { id: 'ch_003', name: '远行' },
  { id: 'ch_004', name: '归途' },
  { id: 'ch_005', name: '' },
  { id: 'ch_006', name: '夜雨续' },
  { id: 'ch_007', name: 'Rain' }
];

test('跳章：章号解析（阿拉伯/全角/第X章/回，非法输入不算）', () => {
  assert.equal(jump.parseChapterNumber('12'), 12);
  assert.equal(jump.parseChapterNumber(' 12 '), 12);
  assert.equal(jump.parseChapterNumber('第12章'), 12);
  assert.equal(jump.parseChapterNumber('第 12 章'), 12);
  assert.equal(jump.parseChapterNumber('12章'), 12);
  assert.equal(jump.parseChapterNumber('第12回'), 12);
  assert.equal(jump.parseChapterNumber('１２'), 12);
  assert.equal(jump.parseChapterNumber('０１２'), 12);
  assert.equal(jump.parseChapterNumber('0'), null);
  assert.equal(jump.parseChapterNumber('12.5'), null);
  assert.equal(jump.parseChapterNumber('-1'), null);
  assert.equal(jump.parseChapterNumber('abc'), null);
  assert.equal(jump.parseChapterNumber(''), null);
  assert.equal(jump.parseChapterNumber(null), null);
  assert.equal(jump.parseChapterNumber('第12章：夜雨'), null);
});

test('跳章：输入章号直接定位到对应章（1 起算，返回原始下标）', () => {
  const result = jump.findMatches(CHAPTERS, '3');
  assert.equal(result.number, 3);
  assert.equal(result.chapterCount, 7);
  assert.equal(result.outOfRange, false);
  assert.equal(result.total, 1);
  assert.deepEqual(result.matches, [
    { index: 2, chapterId: 'ch_003', name: '远行', matchType: 'number' }
  ]);
});

test('跳章：章号超出范围返回 outOfRange，不硬跳最后一章', () => {
  const result = jump.findMatches(CHAPTERS, '99');
  assert.equal(result.number, 99);
  assert.equal(result.outOfRange, true);
  assert.equal(result.total, 0);
  assert.deepEqual(result.matches, []);
});

test('跳章：章名关键词按「完全相同 → 开头相同 → 包含」排序，再按章序', () => {
  const result = jump.findMatches(CHAPTERS, '夜雨');
  assert.equal(result.number, null);
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.matches.map((m) => [m.index, m.name]),
    [
      [1, '夜雨'],
      [5, '夜雨续']
    ]
  );
});

test('跳章：章名包含匹配、不区分大小写', () => {
  const contains = jump.findMatches(CHAPTERS, '雨');
  assert.deepEqual(contains.matches.map((m) => m.index), [1, 5], '包含匹配按章序');
  assert.deepEqual(contains.matches.map((m) => m.matchType), ['name', 'name']);

  const lower = jump.findMatches(CHAPTERS, 'rain');
  assert.deepEqual(lower.matches.map((m) => m.index), [6]);
});

test('跳章：空名章节不参与关键词匹配，但可以按章号找到', () => {
  assert.deepEqual(jump.findMatches(CHAPTERS, '章').matches, []);
  const byNumber = jump.findMatches(CHAPTERS, '5');
  assert.equal(byNumber.matches.length, 1);
  assert.equal(byNumber.matches[0].index, 4);
  assert.equal(byNumber.matches[0].name, '');
});

test('跳章：limit 限制返回条数，total 仍是命中总数', () => {
  const many = Array.from({ length: 20 }, (_v, i) => ({ id: `c${i}`, name: `夜雨-${i}` }));
  const result = jump.findMatches(many, '夜雨', { limit: 3 });
  assert.equal(result.total, 20);
  assert.equal(result.matches.length, 3);
  assert.deepEqual(result.matches.map((m) => m.index), [0, 1, 2]);
  assert.equal(jump.findMatches(many, '夜雨', { limit: 0 }).matches.length, jump.DEFAULT_LIMIT);
});

test('跳章：空查询 / 非数组 / 空章节都不报错', () => {
  assert.deepEqual(jump.findMatches(CHAPTERS, ''), {
    query: '',
    number: null,
    chapterCount: CHAPTERS.length,
    outOfRange: false,
    total: 0,
    matches: []
  });
  assert.equal(jump.findMatches(null, '12').chapterCount, 0);
  assert.equal(jump.findMatches(null, '12').outOfRange, true);
  assert.deepEqual(jump.findMatches([], '夜雨').matches, []);
  assert.deepEqual(jump.findMatches([null, '不是对象', { id: 'x', name: '夜雨' }], '夜雨').matches, [
    { index: 2, chapterId: 'x', name: '夜雨', matchType: 'name' }
  ]);
});

test('跳章：超长查询被截断，不会把整段正文当关键词', () => {
  const long = '夜'.repeat(300);
  const result = jump.findMatches(CHAPTERS, long);
  assert.equal(result.query.length, jump.MAX_QUERY_LENGTH);
  assert.equal(result.total, 0);
});
