const test = require('node:test');
const assert = require('node:assert/strict');
const chaptersLib = require('../core/chapters');
const { composeBook } = require('../core/exporter');

function metaWith(volumes, chapters) {
  return { title: '测试书', titleTemplate: '第{num}章：{name}', volumes, chapters };
}

test('分卷：清洗卷列表（去非法项、去重、去首尾空白）', () => {
  const clean = chaptersLib.sanitizeVolumes([
    { id: 'v_001', name: ' 第1卷：单篇 ' },
    { id: 'v_001', name: '重复的' },
    { id: '', name: '没有 id' },
    null,
    '不是对象',
    { id: 'v_002', name: 123 },
    { id: 'v_003' }
  ]);
  assert.deepEqual(clean, [
    { id: 'v_001', name: '第1卷：单篇' },
    { id: 'v_002', name: '' },
    { id: 'v_003', name: '' }
  ]);
  assert.deepEqual(chaptersLib.sanitizeVolumes('not-array'), []);
});

test('分卷：章节顺序归一成「未分卷 → 第1卷 → 第2卷」，组内顺序不变', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }],
    [
      { id: 'c1', name: '卷一甲', volumeId: 'v_001' },
      { id: 'c2', name: '未分卷甲' },
      { id: 'c3', name: '卷二甲', volumeId: 'v_002' },
      { id: 'c4', name: '卷一乙', volumeId: 'v_001' },
      { id: 'c5', name: '未分卷乙' }
    ]
  );
  const normalized = chaptersLib.normalizeChapterOrder(meta);
  assert.deepEqual(
    normalized.chapters.map((c) => c.id),
    ['c2', 'c5', 'c1', 'c4', 'c3']
  );
  assert.deepEqual(normalized.volumes.map((v) => v.id), ['v_001', 'v_002']);
});

test('分卷：指向不存在卷的章节回落到「未分卷」', () => {
  const meta = metaWith([{ id: 'v_001', name: 'A' }], [
    { id: 'c1', name: '甲', volumeId: 'v_404' },
    { id: 'c2', name: '乙', volumeId: 'v_001' }
  ]);
  const normalized = chaptersLib.normalizeChapterOrder(meta);
  assert.equal(normalized.chapters[0].id, 'c1');
  assert.equal(normalized.chapters[0].volumeId, null);
  assert.equal(normalized.chapters[1].id, 'c2');
});

test('分卷：volumeRank / nextVolumeId', () => {
  const meta = metaWith([{ id: 'v_001', name: 'A' }, { id: 'v_003', name: 'B' }], []);
  assert.equal(chaptersLib.volumeRank(meta, null), 0);
  assert.equal(chaptersLib.volumeRank(meta, 'v_001'), 1);
  assert.equal(chaptersLib.volumeRank(meta, 'v_003'), 2);
  assert.equal(chaptersLib.volumeRank(meta, 'v_404'), 0);
  assert.equal(chaptersLib.nextVolumeId(meta), 'v_002');
  assert.equal(chaptersLib.nextVolumeId(metaWith([], [])), 'v_001');
});

test('分卷：insertIndexForVolume 给出「插到该卷末尾」的下标', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }],
    [
      { id: 'c1', volumeId: 'v_001' },
      { id: 'c2', volumeId: 'v_001' },
      { id: 'c3', volumeId: 'v_002' },
      { id: 'c4', volumeId: null }
    ]
  );
  assert.equal(chaptersLib.insertIndexForVolume(meta, 'v_001'), 2);
  assert.equal(chaptersLib.insertIndexForVolume(meta, 'v_002'), 3);
  assert.equal(chaptersLib.insertIndexForVolume(meta, null), 4);
  // 空卷：插到下一个卷的第一章之前
  const empty = metaWith([{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }], [
    { id: 'c1', volumeId: 'v_002' }
  ]);
  assert.equal(chaptersLib.insertIndexForVolume(empty, 'v_001'), 0);
});

test('导出：有分卷时每卷前多输出一行卷名', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: '第1卷：单篇' }, { id: 'v_002', name: '第2卷：合集' }],
    [
      { id: 'c1', file: '1.txt', name: '起风', volumeId: 'v_001' },
      { id: 'c2', file: '2.txt', name: '夜雨', volumeId: 'v_001' },
      { id: 'c3', file: '3.txt', name: '灯塔', volumeId: 'v_002' }
    ]
  );
  assert.equal(
    composeBook(meta, ['甲', '乙', '丙']),
    '第1卷：单篇\r\n\r\n第1章：起风\r\n\r\n甲\r\n\r\n第2章：夜雨\r\n\r\n乙\r\n\r\n' +
      '第2卷：合集\r\n\r\n第3章：灯塔\r\n\r\n丙\r\n'
  );
});

test('导出：未分卷章节在前，没有卷名行；没有分卷的书和以前完全一致', () => {
  const withVolumes = metaWith([{ id: 'v_001', name: '第1卷' }], [
    { id: 'c1', file: '1.txt', name: '序', volumeId: null },
    { id: 'c2', file: '2.txt', name: '正文', volumeId: 'v_001' }
  ]);
  assert.equal(
    composeBook(withVolumes, ['甲', '乙']),
    '第1章：序\r\n\r\n甲\r\n\r\n第1卷\r\n\r\n第2章：正文\r\n\r\n乙\r\n'
  );
  const plain = metaWith([], [
    { id: 'c1', file: '1.txt', name: '起风' },
    { id: 'c2', file: '2.txt', name: '夜雨' }
  ]);
  assert.equal(composeBook(plain, ['甲', '乙']), '第1章：起风\r\n\r\n甲\r\n\r\n第2章：夜雨\r\n\r\n乙\r\n');
});

test('分卷：moveVolume 调整卷序，章节跟着卷走、组内顺序不变', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }],
    [
      { id: 'a1', name: 'A1', volumeId: 'v_001' },
      { id: 'b1', name: 'B1', volumeId: 'v_002' },
      { id: 'a2', name: 'A2', volumeId: 'v_001' },
      { id: 'b2', name: 'B2', volumeId: 'v_002' }
    ]
  );
  const moved = chaptersLib.moveVolume(meta, 'v_002', 0);
  assert.equal(moved.moved, true);
  assert.deepEqual(moved.meta.volumes.map((v) => v.id), ['v_002', 'v_001']);
  assert.deepEqual(moved.meta.chapters.map((c) => c.id), ['b1', 'b2', 'a1', 'a2']);
  // 越界 / 不存在的卷：不动
  assert.equal(chaptersLib.moveVolume(meta, 'v_001', 0).moved, false);
  assert.equal(chaptersLib.moveVolume(meta, 'v_404', 0).moved, false);
});
