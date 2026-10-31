const test = require('node:test');
const assert = require('node:assert/strict');
const {
  composeBook,
  exportBuffer,
  exportBufferFromText,
  chapterIndexOf,
  resolveExportDir,
  BOM
} = require('../core/exporter');

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
  assert.equal(text, '第1章：起风\r\n\r\n正文\r\n\r\n第2章\r\n\r\n第3章：夜雨\r\n');
});

test('原文自带章节标题的章节导出时原样保留', () => {
  const meta = metaOf('第1章 关于本作品', '第2章');
  const text = composeBook(meta, ['甲', '乙']);
  assert.equal(text, '第1章 关于本作品\r\n\r\n甲\r\n\r\n第2章\r\n\r\n乙\r\n');
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

test('导出缓冲可以直接用拼好的文本生成（避免重复拼接）', () => {
  const meta = metaOf('起风');
  const text = composeBook(meta, ['内容']);
  assert.deepEqual(exportBufferFromText(text), exportBuffer(meta, ['内容']));
  assert.equal(exportBufferFromText(text).toString('utf8'), BOM + text);
  assert.equal(exportBufferFromText('').toString('utf8'), BOM);
});

test('当前章覆盖：按 id 找到章节下标', () => {
  const meta = metaOf('起风', '夜雨');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_1', text: '未保存内容' }), 1);
});

test('当前章覆盖：id 对不上时按文件名兜底', () => {
  const meta = metaOf('起风', '夜雨');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_x', chapterFile: '0.txt', text: 'x' }), 0);
});

test('当前章覆盖：匹配不到 / 文本不是字符串时返回 -1（按磁盘内容导出）', () => {
  const meta = metaOf('起风');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_nope', text: 'x' }), -1);
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_0', text: null }), -1);
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_0' }), -1);
  assert.equal(chapterIndexOf(meta, null), -1);
  assert.equal(chapterIndexOf(null, { chapterId: 'ch_0', text: 'x' }), -1);
});

test('当前章覆盖：空文本也算覆盖（导出成空章而不是旧内容）', () => {
  const meta = metaOf('起风');
  assert.equal(chapterIndexOf(meta, { chapterId: 'ch_0', text: '' }), 0);
});

test('导出目录：记得上次的目录就用上次的', () => {
  assert.equal(resolveExportDir('D:\\xxs', 'C:\\Users\\x\\Documents'), 'D:\\xxs');
});

test('导出目录：没记过就退回默认目录（文档）', () => {
  assert.equal(resolveExportDir('', 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir(undefined, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir(null, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir('   ', 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
});

test('导出目录：上次的目录已经不存在时退回默认目录', () => {
  const exists = (dir) => dir !== 'D:\\删掉了';
  assert.equal(resolveExportDir('D:\\删掉了', 'C:\\Users\\x\\Documents', exists), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir('D:\\还在', 'C:\\Users\\x\\Documents', exists), 'D:\\还在');
});

test('导出目录：不是字符串（配置被手改坏）时退回默认目录', () => {
  assert.equal(resolveExportDir(123, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
  assert.equal(resolveExportDir({ a: 1 }, 'C:\\Users\\x\\Documents'), 'C:\\Users\\x\\Documents');
});
