const test = require('node:test');
const assert = require('node:assert/strict');
const ch = require('../core/chapters');

test('formatTitle：章号按数组下标现算，不在数据里存 N', () => {
  assert.equal(ch.formatTitle({}, 0, '起风'), '第1章：起风');
  assert.equal(ch.formatTitle({}, 11, '夜雨'), '第12章：夜雨');
  assert.equal(ch.formatTitle({}, 0, ''), '第1章：未命名');
  assert.equal(ch.formatTitle({}, 0, '   '), '第1章：未命名');
  assert.equal(ch.formatTitle({}, 0, null), '第1章：未命名');
});

test('formatTitle：支持自定义模板', () => {
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  assert.equal(ch.formatTitle(meta, 2, '起风'), 'Chapter 3 - 起风');
});

test('插入章节后，后面所有章号自动顺延（顺序即编号）', () => {
  const meta = { chapters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const inserted = ch.insertChapter(meta, 1, { id: 'x' });
  assert.deepEqual(inserted.chapters.map((c) => c.id), ['a', 'x', 'b', 'c']);
  assert.equal(ch.formatTitle(inserted, 1, '灯塔'), '第2章：灯塔');
  assert.equal(ch.formatTitle(inserted, 2, '夜雨'), '第3章：夜雨');
  assert.equal(inserted.chapters.length, 4);
  assert.equal(meta.chapters.length, 3, '不修改原对象');
});

test('insertChapter 边界：负数、超长、非数字都落到合法位置', () => {
  const base = { chapters: [{ id: 'a' }] };
  assert.deepEqual(ch.insertChapter(base, -5, { id: 'x' }).chapters.map((c) => c.id), ['x', 'a']);
  assert.deepEqual(ch.insertChapter(base, 99, { id: 'y' }).chapters.map((c) => c.id), ['a', 'y']);
  assert.deepEqual(ch.insertChapter(base, undefined, { id: 'z' }).chapters.map((c) => c.id), ['a', 'z']);
});

test('safeName：过滤 Windows 非法字符、空值回退、超长截断', () => {
  assert.equal(ch.safeName('起风'), '起风');
  assert.equal(ch.safeName('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(ch.safeName('   '), '未命名');
  assert.equal(ch.safeName(''), '未命名');
  assert.equal(ch.safeName('...起风...'), '起风');
  assert.equal(ch.safeName('夜'.repeat(60)).length, 40);
  assert.ok(!/[\\/:*?"<>|]/.test(ch.safeName('a:b*c')));
});

test('文件名生成：补零三位、空白名用未命名、重名加后缀', () => {
  assert.equal(ch.buildFileName(1, '起风'), '001-起风.txt');
  assert.equal(ch.buildFileName(12, ''), '012-未命名.txt');
  assert.equal(ch.buildFileName(100, '夜雨'), '100-夜雨.txt');
  assert.equal(ch.uniqueFileName(5, '起风', []), '005-起风.txt');
  assert.equal(ch.uniqueFileName(5, '起风', ['005-起风.txt']), '005-起风-2.txt');
  assert.equal(
    ch.uniqueFileName(5, '起风', ['005-起风.txt', '005-起风-2.txt']),
    '005-起风-3.txt'
  );
});

test('nextFileSeq：单调递增、删除不回退、缺失时兜底', () => {
  assert.equal(ch.nextFileSeq({ fileSeq: 3 }), 4);
  assert.equal(ch.nextFileSeq({ fileSeq: 0 }), 1);
  assert.equal(ch.nextFileSeq({}), 1);
  assert.equal(ch.nextFileSeq({ fileSeq: '7' }), 8);
});

test('重命名/删除只改记录，不碰 file 字段', () => {
  const meta = {
    chapters: [
      { id: 'a', file: '001-起风.txt', name: '起风' },
      { id: 'b', file: '002-夜雨.txt', name: '夜雨' }
    ]
  };
  const renamed = ch.updateChapter(meta, 'a', { name: '大风' });
  assert.equal(renamed.chapters[0].name, '大风');
  assert.equal(renamed.chapters[0].file, '001-起风.txt');
  const removed = ch.removeChapter(meta, 'b');
  assert.deepEqual(removed.chapters.map((c) => c.file), ['001-起风.txt']);
});

test('字数统计：不算空白字符', () => {
  assert.equal(ch.countChars('雨下了一夜。'), 6);
  assert.equal(ch.countChars('雨 下\n了\t一夜。'), 6);
  assert.equal(ch.countChars(''), 0);
  assert.equal(ch.countChars(null), 0);
});

test('换行归一：读入统一 \\n，落盘统一 \\r\\n', () => {
  assert.equal(ch.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(ch.toDiskNewlines('a\nb'), 'a\r\nb');
  assert.equal(ch.toDiskNewlines('a\r\nb'), 'a\r\nb');
});
