const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ch = require('../core/chapters');

test('formatTitle：章号按数组下标现算，不在数据里存 N', () => {
  assert.equal(ch.formatTitle({}, 0, '起风'), '第1章：起风');
  assert.equal(ch.formatTitle({}, 11, '夜雨'), '第12章：夜雨');
  // 没有名字的章节显示「第N章」，不再显示「未命名」
  assert.equal(ch.formatTitle({}, 0, ''), '第1章');
  assert.equal(ch.formatTitle({}, 0, '   '), '第1章');
  assert.equal(ch.formatTitle({}, 0, null), '第1章');
});

test('formatTitle：原文自带章节标题原样显示，不叠加「第N章：」', () => {
  assert.equal(ch.formatTitle({}, 0, '第1章 关于本作品'), '第1章 关于本作品');
  assert.equal(ch.formatTitle({}, 3, '第一章：雪夜'), '第一章：雪夜');
  assert.equal(ch.formatTitle({}, 0, '楔子'), '楔子');
  assert.equal(ch.formatTitle({}, 5, 'Chapter 6 The End'), 'Chapter 6 The End');
});

test('formatTitle：支持自定义模板', () => {
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  assert.equal(ch.formatTitle(meta, 2, '起风'), 'Chapter 3 - 起风');
});

test('formatTitle：自定义模板下原文标题 / 空名仍按 core 口径，坏模板回落默认', () => {
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  // 原文自带标题永远原样显示（哪怕书目写了自定义模板），避免「Chapter 3 - 第3章 …」重复
  assert.equal(ch.formatTitle(meta, 0, '第1章 关于本作品'), '第1章 关于本作品');
  assert.equal(ch.formatTitle(meta, 3, '楔子'), '楔子');
  // 空名无论模板怎么写都只显示「第N章」（渲染层章节列表也走这条，不再补「未命名」）
  assert.equal(ch.formatTitle(meta, 4, '  '), '第5章');
  assert.equal(ch.formatTitle(meta, 4, null), '第5章');
  // 模板只有空白 / 不是字符串 = 用默认模板
  assert.equal(ch.formatTitle({ titleTemplate: '   ' }, 1, '夜雨'), '第2章：夜雨');
  assert.equal(ch.formatTitle({ titleTemplate: 123 }, 1, '夜雨'), '第2章：夜雨');
  // 模板里没有 {name}：界面与导出都只出章号，不偷偷补名字
  assert.equal(ch.formatTitle({ titleTemplate: '第{num}节' }, 2, '起风'), '第3节');
  // 重复占位符全部展开；不认识的占位符原样保留
  assert.equal(
    ch.formatTitle({ titleTemplate: '{num}-{num} {name}{unknown}' }, 0, '起风'),
    '1-1 起风{unknown}'
  );
});

test('UMD：Node require 行为不变，浏览器加载挂到 window.CWChapters', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'chapters.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'core/chapters.js' });
  const browserCh = sandbox.CWChapters;
  assert.equal(typeof browserCh, 'object');
  assert.equal(typeof browserCh.formatTitle, 'function');
  // 浏览器里的实现与 Node require 的是同一套 API（导出名一个不少、顺序无关）
  assert.deepEqual(Object.keys(browserCh).sort(), Object.keys(ch).sort());
  assert.equal(browserCh.TITLE_TEMPLATE, '第{num}章：{name}');
  // 渲染层真正用到的标题规则逐项与 Node 侧一致（自定义模板 / 原文标题 / 空名）
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  for (const [index, name] of [
    [0, '起风'],
    [1, '第2章 旧标题'],
    [2, ''],
    [3, null],
    [4, '  ']
  ]) {
    assert.equal(browserCh.formatTitle(meta, index, name), ch.formatTitle(meta, index, name));
    assert.equal(browserCh.formatTitle(null, index, name), ch.formatTitle(null, index, name));
  }
  // 浏览器分支不污染 Node 模块（同一个文件被两边加载，各拿各的实例）
  assert.equal(typeof ch.formatTitle, 'function');
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

test('章节状态：非法值回落到草稿，合法值统一小写', () => {
  assert.equal(ch.sanitizeChapterStatus('done'), 'done');
  assert.equal(ch.sanitizeChapterStatus(' DONE '), 'done');
  assert.equal(ch.sanitizeChapterStatus('revising'), 'revising');
  assert.equal(ch.sanitizeChapterStatus('finished'), 'draft');
  assert.equal(ch.sanitizeChapterStatus(null), 'draft');
  assert.equal(ch.chapterStatus({ status: 'done' }), 'done');
  assert.equal(ch.chapterStatus({ status: 'weird' }), 'draft');
  assert.equal(ch.chapterStatus({}), 'draft');
  assert.deepEqual(ch.CHAPTER_STATUSES, ['draft', 'revising', 'done']);
});

test('章节备注：一句话、最多 200 字、空值清空', () => {
  assert.equal(ch.sanitizeChapterNote('  这章要改结尾  '), '这章要改结尾');
  assert.equal(ch.sanitizeChapterNote('第一行\n第二行'), '第一行 第二行');
  assert.equal(ch.sanitizeChapterNote('字'.repeat(250)).length, 200);
  assert.equal(ch.sanitizeChapterNote(123), '');
  assert.equal(ch.chapterNote({ note: '  补结尾 ' }), '补结尾');
  assert.equal(ch.chapterNote({}), '');
});

test('章节清洗：旧数据没有 status/note 不乱加字段，非法值不写回', () => {
  const old = ch.cleanChapterMeta({ id: 'ch_001', file: '001-未命名.txt', name: '起风' });
  assert.deepEqual(Object.keys(old).sort(), ['file', 'id', 'name']);
  assert.equal(old.status, undefined);
  assert.equal(old.note, undefined);
  const dirty = ch.cleanChapterMeta({ id: 'x', status: 'NOPE', note: '   ' });
  assert.equal(dirty.status, undefined);
  assert.equal(dirty.note, undefined);
  const good = ch.cleanChapterMeta({ id: 'x', status: ' DONE ', note: '要改\n结尾' });
  assert.equal(good.status, 'done');
  assert.equal(good.note, '要改 结尾');
});

test('章节元数据补丁：只认 status/note，空备注删除字段，统计各状态章数', () => {
  const base = { id: 'x', file: 'x.txt', name: '甲' };
  const done = ch.applyChapterMeta(base, { status: 'done', note: '补结尾', name: '不该生效' });
  assert.equal(done.status, 'done');
  assert.equal(done.note, '补结尾');
  assert.equal(done.name, '甲');
  const cleared = ch.applyChapterMeta(done, { note: '   ' });
  assert.equal(cleared.note, undefined);
  const meta = { chapters: [{ status: 'done' }, {}, { status: 'revising' }, { status: 'bogus' }] };
  assert.deepEqual(ch.countChapterStatuses(meta), { total: 4, draft: 2, revising: 1, done: 1 });
  assert.deepEqual(ch.countChapterStatuses({}), { total: 0, draft: 0, revising: 0, done: 0 });
});

test('换行归一：读入统一 \\n，落盘统一 \\r\\n', () => {
  assert.equal(ch.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(ch.toDiskNewlines('a\nb'), 'a\r\nb');
  assert.equal(ch.toDiskNewlines('a\r\nb'), 'a\r\nb');
});
