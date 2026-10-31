const test = require('node:test');
const assert = require('node:assert/strict');
const tts = require('../core/tts');

const texts = (result) => result.chunks.map((chunk) => chunk.text);
const hasLoneSurrogate = (text) =>
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(text);

test('朗读切分：空文本 / null / 纯空白都安全', () => {
  for (const input of ['', null, undefined, '   \n\n　　\n']) {
    const result = tts.buildChunks(input);
    assert.deepEqual(result.chunks, []);
    assert.equal(result.startIndex, -1);
    assert.equal(result.paragraphs, 0);
    assert.equal(result.totalChars, 0);
    assert.equal(result.truncated, false);
  }
});

test('朗读切分：一个非空行一段，首尾空白（含全角空格）不进朗读文本', () => {
  const text = '　　第一段。　　\n\n第二段！\n   \n\t第三段？';
  const result = tts.buildChunks(text);
  assert.deepEqual(texts(result), ['第一段。', '第二段！', '第三段？']);
  assert.deepEqual(
    result.chunks.map((chunk) => [chunk.start, chunk.end, chunk.paragraph, chunk.line]),
    [
      [2, 6, 1, 1],
      [10, 14, 2, 3],
      [20, 24, 3, 5]
    ]
  );
  for (const chunk of result.chunks) {
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text);
    assert.equal(chunk.text.includes('\n'), false);
  }
  assert.equal(result.paragraphs, 3);
  assert.equal(result.chars, text.length);
  assert.equal(result.totalChars, 12); // 去空白后的字数
});

test('朗读切分：短段落不拆，整段就是一个 chunk', () => {
  const text = '风从海面吹来，他收起了帆。远处有一盏灯。';
  const result = tts.buildChunks(text);
  assert.deepEqual(texts(result), [text]);
  assert.equal(result.chunks[0].paragraph, 1);
});

test('朗读切分：一段超过上限时优先在句末标点处断开', () => {
  const sentences = ['甲'.repeat(24) + '。', '乙'.repeat(24) + '！', '丙'.repeat(24) + '？'];
  const text = sentences.join('');
  const result = tts.buildChunks(text, { maxChunkChars: 40 });
  assert.equal(result.chunks.length, 3);
  assert.deepEqual(texts(result), sentences);
  for (const chunk of result.chunks) assert.ok(chunk.end - chunk.start <= 40);
});

test('朗读切分：句子能装下就合并，装不下才新起一段（不超上限）', () => {
  const sentences = ['甲'.repeat(14) + '。', '乙'.repeat(14) + '。', '丙'.repeat(14) + '。', '丁'.repeat(14) + '。'];
  const text = sentences.join('');
  const result = tts.buildChunks(text, { maxChunkChars: 40 });
  for (const chunk of result.chunks) assert.ok(chunk.end - chunk.start <= 40);
  // 每两句合并成一个 chunk（30 字），不会把句子从中间切开
  assert.deepEqual(texts(result), [sentences[0] + sentences[1], sentences[2] + sentences[3]]);
  for (const chunk of result.chunks) assert.ok(/[。！？…]$/.test(chunk.text), chunk.text);
  assert.equal(texts(result).join(''), text);
});

test('朗读切分：超长无标点段落硬切，覆盖全部文字且每段不超上限', () => {
  const text = '字'.repeat(350);
  const result = tts.buildChunks(text, { maxChunkChars: 60 });
  assert.equal(result.chunks.length, 6);
  for (const chunk of result.chunks) {
    assert.ok(chunk.end - chunk.start <= 60);
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text);
  }
  assert.equal(result.chunks.map((chunk) => chunk.text).join(''), text);
});

test('朗读切分：硬切优先落在空白处，不把英文单词从中间劈开', () => {
  const text = ('word '.repeat(30)).trim();
  const result = tts.buildChunks(text, { maxChunkChars: 40 });
  for (const chunk of result.chunks) {
    assert.ok(chunk.end - chunk.start <= 40);
    // 每个 chunk 都是完整的单词序列（结尾不是半个单词）
    assert.equal(/^[a-z ]+$/.test(chunk.text), true);
    assert.equal(chunk.text.endsWith(' '), false);
  }
  assert.equal(result.chunks.map((chunk) => chunk.text).join(' '), text);
});

test('朗读切分：不会切开代理对（emoji）', () => {
  const text = 'a' + '😀'.repeat(60);
  const result = tts.buildChunks(text, { maxChunkChars: 40 });
  assert.ok(result.chunks.length > 1);
  for (const chunk of result.chunks) {
    assert.equal(hasLoneSurrogate(chunk.text), false);
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text);
  }
  assert.equal(result.chunks.map((chunk) => chunk.text).join(''), text);
});

test('朗读切分：连续标点 / 收尾引号留在同一句，不会被拆开', () => {
  const text = '他喊：“真的吗？！”。然后笑了。';
  const result = tts.buildChunks(text, { maxChunkChars: 40 });
  assert.deepEqual(texts(result), ['他喊：“真的吗？！”。然后笑了。']);
  assert.equal(tts.sentencePieces(text, 0, text.length).length, 2);
  assert.deepEqual(tts.sentencePieces(text, 0, text.length), [
    { start: 0, end: 11 },
    { start: 11, end: 16 }
  ]);
});

test('朗读切分：段落号与行号 1 基，空行不占段落', () => {
  const result = tts.buildChunks('第一行\n\n第二行\n\n\n第三行');
  assert.deepEqual(
    result.chunks.map((chunk) => [chunk.paragraph, chunk.line]),
    [
      [1, 1],
      [2, 3],
      [3, 6]
    ]
  );
  assert.equal(result.paragraphs, 3);
});

test('朗读切分：CRLF / CR 归一后位置与编辑区（LF）一致', () => {
  const raw = '第一段。\r\n\r\n第二段。\r第三段。';
  const result = tts.buildChunks(raw);
  const normalized = '第一段。\n\n第二段。\n第三段。';
  assert.equal(result.chars, normalized.length);
  for (const chunk of result.chunks) {
    assert.equal(normalized.slice(chunk.start, chunk.end), chunk.text);
    assert.equal(chunk.text.includes('\r'), false);
  }
  assert.deepEqual(texts(result), ['第一段。', '第二段。', '第三段。']);
});

test('朗读切分：开头的 BOM 被去掉，位置从正文算起', () => {
  const result = tts.buildChunks('\uFEFF第一段。');
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].start, 0);
  assert.equal(result.chunks[0].text, '第一段。');
});

test('朗读切分：maxChunks 截断时 truncated=true，段落总数照实统计', () => {
  const text = Array.from({ length: 80 }, (_, i) => `第${i + 1}段。`).join('\n');
  const result = tts.buildChunks(text, { maxChunks: 50 });
  assert.equal(result.chunks.length, 50);
  assert.equal(result.paragraphs, 80);
  assert.equal(result.truncated, true);
  assert.equal(result.chunks[49].paragraph, 50);
});

test('朗读切分：参数越界自动夹紧，坏值退回默认', () => {
  assert.equal(tts.buildChunks('あ'.repeat(100), { maxChunkChars: 1 }).options.maxChunkChars, 40);
  assert.equal(tts.buildChunks('あ'.repeat(1300), { maxChunkChars: 99999 }).options.maxChunkChars, 1200);
  assert.equal(tts.buildChunks('あ', { maxChunkChars: 'abc' }).options.maxChunkChars, 160);
  assert.equal(tts.buildChunks('あ', { maxChunks: 1 }).options.maxChunks, 50);
  assert.equal(tts.buildChunks('あ', null).options.maxChunks, 5000);
});

test('朗读切分：超长正文只处理前 MAX_SOURCE_CHARS 个字符并标 truncated', () => {
  const text = 'a'.repeat(tts.MAX_SOURCE_CHARS + 10);
  const result = tts.buildChunks(text, { maxChunks: 20000 });
  assert.equal(result.truncated, true);
  assert.equal(result.chars, text.length);
  assert.ok(result.chunks.length > 0);
  assert.ok(result.chunks[result.chunks.length - 1].end <= tts.MAX_SOURCE_CHARS);
});

test('从光标处朗读：chunkIndexAt 落在段内 / 段间 / 越界都能给出合理起点', () => {
  const chunks = [
    { start: 0, end: 5 },
    { start: 8, end: 12 },
    { start: 15, end: 20 }
  ];
  assert.equal(tts.chunkIndexAt(chunks, 0), 0);
  assert.equal(tts.chunkIndexAt(chunks, 4), 0);
  assert.equal(tts.chunkIndexAt(chunks, 5), 1); // 段间算「下一段」
  assert.equal(tts.chunkIndexAt(chunks, 7), 1);
  assert.equal(tts.chunkIndexAt(chunks, 11), 1);
  assert.equal(tts.chunkIndexAt(chunks, 14), 2);
  assert.equal(tts.chunkIndexAt(chunks, 20), 2); // 末尾之后夹到最后一段
  assert.equal(tts.chunkIndexAt(chunks, 9999), 2);
  assert.equal(tts.chunkIndexAt(chunks, -5), 0);
  assert.equal(tts.chunkIndexAt([], 3), -1);
  assert.equal(tts.chunkIndexAt(null, 3), -1);
});

test('从光标处朗读：buildChunks 的 startIndex 跟着 caret 走', () => {
  const text = '第一段。\n\n第二段。\n\n第三段。';
  const secondStart = text.indexOf('第二段');
  assert.equal(tts.buildChunks(text, { caret: 0 }).startIndex, 0);
  assert.equal(tts.buildChunks(text, { caret: secondStart }).startIndex, 1);
  assert.equal(tts.buildChunks(text, { caret: text.length + 100 }).startIndex, 2);
  assert.equal(tts.buildChunks(text, { caret: -1 }).startIndex, 0);
  assert.equal(tts.buildChunks(text, { caret: 'x' }).startIndex, 0);
});

test('朗读切分：总字数按去空白统计，和状态栏同口径', () => {
  const text = '　甲 乙。\n\n丙　丁！';
  const result = tts.buildChunks(text);
  assert.equal(result.totalChars, 6);
  assert.equal(result.chars, text.length);
});

test('朗读切分：paragraphRanges 只返回非空行且已 trim', () => {
  const text = '  a  \n\n  b\n';
  assert.deepEqual(tts.paragraphRanges(text), [
    { start: 2, end: 3, paragraph: 1, line: 1 },
    { start: 9, end: 10, paragraph: 2, line: 3 }
  ]);
});

test('朗读切分：纯函数——同样输入多次切分结果一致，不依赖外部状态', () => {
  const text = '甲。\n乙！\n丙？';
  const a = tts.buildChunks(text, { caret: 3 });
  const b = tts.buildChunks(text, { caret: 3 });
  assert.deepEqual(a, b);
});
