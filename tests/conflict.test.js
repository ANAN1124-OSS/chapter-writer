const test = require('node:test');
const assert = require('node:assert/strict');
const conflict = require('../core/conflict');

test('冲突副本：识别 Dropbox / OneDrive 风格的 conflicted 文件名', () => {
  assert.equal(conflict.isConflictCopyName('书目 (conflicted copy 1).json'), true);
  assert.equal(conflict.isConflictCopyName('001-起风 (conflicted copy 2026-10-31).txt'), true);
  assert.equal(conflict.isConflictCopyName('002-夜雨-CONFLICTED.txt'), true);
  assert.equal(conflict.isConflictCopyName(' 书目 (conflicted copy).json '), true);
});

test('冲突副本：识别坚果云 / OneDrive 中文的「冲突副本」文件名', () => {
  assert.equal(conflict.isConflictCopyName('书目-冲突副本.json'), true);
  assert.equal(conflict.isConflictCopyName('001-起风 (冲突副本).txt'), true);
  assert.equal(conflict.isConflictCopyName('003-归途-冲突副本-2.txt'), true);
});

test('冲突副本：普通章节 / 书目 / 备份 / 空名字都不算', () => {
  for (const name of [
    '书目.json',
    '书目.json.bak',
    '001-起风.txt',
    '第12章 冲突.txt', // 正文名字里带「冲突」但不是同步副本
    '_trash',
    '',
    '   ',
    null,
    undefined,
    42,
    {}
  ]) {
    assert.equal(conflict.isConflictCopyName(name), false, String(name));
  }
});

test('冲突副本：findConflictCopies 去空、去重、排序、过滤非冲突文件', () => {
  const names = [
    '003-归途-冲突副本.txt',
    '书目.json',
    '001-起风 (conflicted copy).txt',
    '001-起风 (conflicted copy).txt',
    '   ',
    null,
    '002-夜雨.txt',
    '书目-冲突副本.json'
  ];
  assert.deepEqual(conflict.findConflictCopies(names), [
    '001-起风 (conflicted copy).txt',
    '003-归途-冲突副本.txt',
    '书目-冲突副本.json'
  ]);
});

test('冲突副本：非数组安全兜底成空数组', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.deepEqual(conflict.findConflictCopies(bad), []);
  }
});
