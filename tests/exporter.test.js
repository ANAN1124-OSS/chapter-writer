const test = require('node:test');
const assert = require('node:assert/strict');
const { composeBook, exportBuffer, BOM } = require('../core/exporter');

function metaOf(...names) {
  return {
    title: '测试书',
    titleTemplate: '第{num}章：{name}',
    chapters: names.map((name, i) => ({ id: `ch_${i}`, file: `${i}.txt`, name }))
  };
}

test('整本拼接：标题行 + 空行 + 正文，章间一空行，\\r\\n', () => {
  const meta = metaOf('起风', '夜雨');
  const text = composeBook(meta, ['风从海面吹来。\n', '\n雨下了一夜。\n']);
  assert.equal(
    text,
    '第1章：起风\r\n\r\n风从海面吹来。\r\n\r\n第2章：夜雨\r\n\r\n雨下了一夜。\r\n'
  );
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), '不应出现裸 \\n');
});

test('空章只输出标题行，不留半截格式', () => {
  const meta = metaOf('起风', '', '夜雨');
  const text = composeBook(meta, ['正文', '', '']);
  assert.equal(text, '第1章：起风\r\n\r\n正文\r\n\r\n第2章：未命名\r\n\r\n第3章：夜雨\r\n');
});

test('正文首尾多余空行被去掉，中间空行保留', () => {
  const meta = metaOf('起风');
  const text = composeBook(meta, ['\n\n第一段\n\n第二段\n\n']);
  assert.equal(text, '第1章：起风\r\n\r\n第一段\r\n\r\n第二段\r\n');
});

test('导出文件：UTF-8 带 BOM', () => {
  const meta = metaOf('起风');
  const buf = exportBuffer(meta, ['内容']);
  assert.equal(buf[0], 0xef);
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
  assert.equal(buf.toString('utf8'), BOM + composeBook(meta, ['内容']));
});

test('单章也能正确拼接（不依赖章节数）', () => {
  const meta = metaOf('唯一章');
  assert.equal(composeBook(meta, ['内容']), '第1章：唯一章\r\n\r\n内容\r\n');
});
