const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../renderer/editor-logic');
const tts = require('../core/tts');

const FW = '　'; // 全角空格
const longText = (n) => '字'.repeat(n);

test('选中统计：折叠 / 反向 / 越界 / 空文本都安全', () => {
  const text = `${FW}${FW}第一段。\n\n${FW}${FW}第二段，长一点。\n  \n第三段！`;
  const folded = logic.selectionStats(text, 5, 5);
  assert.deepEqual(folded, { collapsed: true, chars: 0, paragraphs: 0, start: 5, end: 5 });
  assert.deepEqual(logic.selectionStats(text, 0, 0), {
    collapsed: true,
    chars: 0,
    paragraphs: 0,
    start: 0,
    end: 0
  });
  assert.deepEqual(logic.selectionStats(null, 0, 10), {
    collapsed: true,
    chars: 0,
    paragraphs: 0,
    start: 0,
    end: 0
  });
  const reverse = logic.selectionStats(text, 12, 4);
  const forward = logic.selectionStats(text, 4, 12);
  assert.deepEqual(reverse, forward);
  const clamped = logic.selectionStats(text, -100, 99999);
  assert.equal(clamped.collapsed, false);
  assert.equal(clamped.start, 0);
  assert.equal(clamped.end, text.length);
  assert.equal(clamped.paragraphs, 3);
});

test('选中统计：字数不含空白，段数按「触及的非空行」算', () => {
  const text = `${FW}${FW}第一段。\n\n${FW}${FW}第二段，长一点。\n  \n第三段！`;
  const p1 = text.indexOf('第一段');
  const p2 = text.indexOf('第二段');
  const p3 = text.indexOf('第三段');
  // 只选了第一段四个字
  const one = logic.selectionStats(text, p1, p1 + 4);
  assert.equal(one.chars, 4);
  assert.equal(one.paragraphs, 1);
  // 选到第一段末尾（中间的换行不额外算字）：还是 1 段
  const acrossBlank = logic.selectionStats(text, p1, p1 + 4);
  assert.equal(acrossBlank.chars, 4);
  assert.equal(acrossBlank.paragraphs, 1);
  // 选进第二段的段首缩进（还没选到正文）：已经触及第二段这一行 → 2 段
  const intoIndent = logic.selectionStats(text, p1, p2 - 1);
  assert.equal(intoIndent.chars, 4);
  assert.equal(intoIndent.paragraphs, 2);
  // 选到第二段里面：2 段
  const two = logic.selectionStats(text, p1, p2 + 3);
  assert.equal(two.chars, 7);
  assert.equal(two.paragraphs, 2);
  // 选到第三段：3 段；换行和空格都不算字
  const three = logic.selectionStats(text, p1, p3 + 3);
  assert.equal(three.chars, 15); // 4 + 8 + 3：中间整段第二段也在选区里

  assert.equal(three.paragraphs, 3);
  // 只选段首两个全角缩进：0 字，但确实触及了这一段
  const indentOnly = logic.selectionStats(text, p1 - 2, p1);
  assert.equal(indentOnly.chars, 0);
  assert.equal(indentOnly.paragraphs, 1);
  // 只选空行：0 字 0 段
  const blankOnly = logic.selectionStats(text, text.indexOf('\n\n') + 1, text.indexOf('\n\n') + 2);
  assert.equal(blankOnly.chars, 0);
  assert.equal(blankOnly.paragraphs, 0);
});

test('段落导航：上/下都落在段落开头（段首缩进之后），到边界返回 null', () => {
  const text = `${FW}${FW}第一段。\n\n第二段。\n${FW}${FW}第三段。`;
  const p1 = text.indexOf('第一段');
  const p2 = text.indexOf('第二段');
  const p3 = text.indexOf('第三段');
  // 段中间往上：回到本段开头
  assert.equal(logic.paragraphJumpTarget(text, p1 + 2, -1), p1);
  // 段开头往上：上一段；第一段开头往上：没有
  assert.equal(logic.paragraphJumpTarget(text, p2, -1), p1);
  assert.equal(logic.paragraphJumpTarget(text, p1, -1), null);
  // 第一段之前的缩进里往上：不动
  assert.equal(logic.paragraphJumpTarget(text, 0, -1), null);
  // 往下：从 0 进第一段；段中间去下一段；段开头去下一段
  assert.equal(logic.paragraphJumpTarget(text, 0, 1), p1);
  assert.equal(logic.paragraphJumpTarget(text, p1 + 1, 1), p2);
  assert.equal(logic.paragraphJumpTarget(text, p2, 1), p3);
  assert.equal(logic.paragraphJumpTarget(text, p3, 1), null);
  // 空行里往上：上一段开头；往下：下一段开头
  const blank = p1 + 4; // 第一段末尾换行处附近
  assert.equal(logic.paragraphJumpTarget(text, blank, -1), p1);
  assert.equal(logic.paragraphJumpTarget(text, blank, 1), p2);
  // 越界光标
  assert.equal(logic.paragraphJumpTarget(text, 99999, 1), null);
  assert.equal(logic.paragraphJumpTarget(text, 99999, -1), p3);
  // 没有正文：null
  assert.equal(logic.paragraphJumpTarget('', 0, 1), null);
  assert.equal(logic.paragraphJumpTarget(`${FW}\n  \n`, 1, 1), null);
});

test('段落定义与朗读（core/tts.js）一致，不会一个说 4 段一个说 3 段', () => {
  const samples = [
    '',
    `${FW}${FW}第一段。　　\n\n第二段！\n   \n\t第三段？`,
    '没有缩进的正文\r\n第二行\r\n\r\n\r\n第三行',
    `${FW}\n${FW}${FW}\n`,
    'a'.repeat(1200)
  ];
  for (const text of samples) {
    const mine = logic.paragraphRanges(text).map((item) => [item.start, item.end, item.line]);
    const theirs = tts.paragraphRanges(text).map((item) => [item.start, item.end, item.line]);
    assert.deepEqual(mine, theirs, JSON.stringify(text.slice(0, 20)));
  }
});

test('超长段落：> 500 字才算，正好 500 字不算；去空白后计数', () => {
  assert.equal(logic.longParagraphs(longText(500)).count, 0);
  const long501 = logic.longParagraphs(longText(501));
  assert.equal(long501.count, 1);
  assert.equal(long501.items[0].chars, 501);
  assert.equal(long501.items[0].start, 0);
  assert.equal(long501.items[0].end, 501);
  assert.equal(long501.items[0].line, 1);
  assert.equal(long501.items[0].paragraph, 1);
  assert.equal(long501.threshold, 500);
  // 大量空白不算字数
  const padded = `${FW}${FW}${longText(400)}${' '.repeat(300)}`;
  assert.equal(logic.longParagraphs(padded).count, 0);
  const paddedLong = `${FW}${FW}${longText(501)}${FW}${FW}`;
  assert.equal(logic.longParagraphs(paddedLong).count, 1);
  assert.equal(logic.longParagraphs(paddedLong).items[0].chars, 501);
});

test('超长段落：空行不算段，行号 / 段号都是 1 基，多段按位置排序', () => {
  const text = `第一段。\n\n${longText(600)}\n\n第三段。\n${longText(520)}`;
  const result = logic.longParagraphs(text);
  assert.equal(result.count, 2);
  assert.deepEqual(
    result.items.map((item) => [item.line, item.paragraph, item.chars]),
    [
      [3, 2, 600],
      [6, 4, 520]
    ]
  );
  assert.ok(result.items[0].start < result.items[1].start);
  for (const item of result.items) {
    assert.equal(logic.countChars(text.slice(item.start, item.end)), item.chars);
  }
});

test('超长段落：阈值夹紧、count 照实、items 上限 200、病态长文兜底', () => {
  assert.equal(logic.longParagraphs('字', 10).threshold, 50);
  assert.equal(logic.longParagraphs('字', 999999).threshold, 20000);
  assert.equal(logic.longParagraphs('字', 'bad').threshold, 500);
  assert.equal(logic.longParagraphs('字', 0).threshold, 50);
  const many = Array.from({ length: 250 }, () => longText(510)).join('\n\n');
  const result = logic.longParagraphs(many);
  assert.equal(result.count, 250);
  assert.equal(result.items.length, logic.MAX_LONG_PARAGRAPH_ITEMS);
  assert.equal(result.truncated, true);
  const huge = '字'.repeat(logic.MAX_LONG_PARAGRAPH_CHARS + 1);
  const tooLarge = logic.longParagraphs(huge);
  assert.equal(tooLarge.tooLarge, true);
  assert.equal(tooLarge.items.length, 0);
  assert.equal(logic.longParagraphs(null).count, 0);
});

test('不可见字符：全角空格逐个标，行尾空白按「一段一条」标，两者不重复', () => {
  const text = `${FW}${FW}A${FW}B${FW}${FW}\nplain  \n\t\n${FW}${FW}C${FW}\n第三行`;
  const result = logic.invisibleMarks(text);
  assert.equal(result.tooLarge, false);
  assert.equal(result.counts.fullwidth, 5);
  assert.equal(result.counts.trailing, 3);
  assert.equal(result.items.length, 8);
  for (const item of result.items) {
    const slice = text.slice(item.start, item.end);
    if (item.type === 'fullwidth') assert.equal(slice, FW);
    else assert.match(slice, /^[ \t　]+$/);
  }
  // 位置按出现顺序排好，且都在原文里
  const starts = result.items.map((item) => item.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  for (const item of result.items) assert.ok(item.start >= 0 && item.end <= text.length);
  // 行尾的全角空格只算 trailing，不会又被算成 fullwidth
  const lineOne = result.items.filter((item) => item.line === 1);
  assert.deepEqual(
    lineOne.map((item) => [item.type, text.slice(item.start, item.end)]),
    [
      ['fullwidth', FW],
      ['fullwidth', FW],
      ['fullwidth', FW],
      ['trailing', `${FW}${FW}`]
    ]
  );
  assert.deepEqual(
    result.items.filter((item) => item.line === 2).map((item) => [item.type, text.slice(item.start, item.end)]),
    [['trailing', '  ']]
  );
  assert.equal(result.items.some((item) => item.line === 3), false); // 纯空白行不标
  assert.deepEqual(
    result.items.filter((item) => item.line === 4).map((item) => [item.type, text.slice(item.start, item.end)]),
    [
      ['fullwidth', FW],
      ['fullwidth', FW],
      ['trailing', FW]
    ]
  );
});

test('不可见字符：制表符 / 行尾全角空格算行尾空白；纯空白行不标；坏输入不炸', () => {
  assert.equal(logic.invisibleMarks(`${FW}${FW}\n\n${FW}\n`).items.length, 0);
  const tabs = logic.invisibleMarks('a\t\t\nb　');
  assert.deepEqual(
    tabs.items.map((item) => [item.type, item.start, item.end]),
    [
      ['trailing', 1, 3],
      ['trailing', 5, 6]
    ]
  );
  assert.equal(logic.invisibleMarks(null).items.length, 0);
  assert.equal(logic.invisibleMarks('').items.length, 0);
  assert.equal(logic.invisibleMarks('普通正文，没有任何标记').items.length, 0);
});

test('不可见字符：超过 maxMarks 截断但计数照实；超长正文不往 DOM 里塞标记', () => {
  const many = `${FW.repeat(5000)}正文`;
  const capped = logic.invisibleMarks(many, { maxMarks: 100 });
  assert.equal(capped.counts.fullwidth, 5000);
  assert.equal(capped.items.length, 100);
  assert.equal(capped.truncated, true);
  const defaultCap = logic.invisibleMarks(many);
  assert.equal(defaultCap.items.length, logic.MAX_MARK_ITEMS);
  assert.equal(defaultCap.truncated, true);
  const huge = 'a'.repeat(logic.MAX_MARK_CHARS + 1);
  const tooLarge = logic.invisibleMarks(huge);
  assert.equal(tooLarge.tooLarge, true);
  assert.equal(tooLarge.items.length, 0);
  assert.equal(tooLarge.counts.fullwidth, 0);
});

test('章节字数对比：短 40% 及以上才提示；上一章太短 / 没字数就不比较', () => {
  assert.deepEqual(logic.compareChapterChars(600, 1000), {
    current: 600,
    previous: 1000,
    compared: true,
    percent: -40,
    direction: 'shorter',
    message: '比上章短 40%'
  });
  assert.equal(logic.compareChapterChars(610, 1000).direction, 'similar');
  assert.equal(logic.compareChapterChars(610, 1000).message, '');
  assert.equal(logic.compareChapterChars(0, 1000).message, '比上章短 100%');
  assert.equal(logic.compareChapterChars(1500, 1000).direction, 'similar');
  assert.equal(logic.compareChapterChars(2100, 1000).message, '比上章长 110%');
  // 上一章少于 500 字：不比较
  const shortPrevious = logic.compareChapterChars(10, 400);
  assert.equal(shortPrevious.compared, false);
  assert.equal(shortPrevious.direction, '');
  assert.equal(shortPrevious.message, '');
  // 上一章没有字数 / 0 / 坏值：不比较
  for (const previous of [0, null, undefined, '', 'bad', -5]) {
    assert.equal(logic.compareChapterChars(100, previous).compared, false);
  }
  // 当前章坏值按 0 算，但不影响上一章比较
  assert.equal(logic.compareChapterChars('bad', 1000).current, 0);
  assert.equal(logic.compareChapterChars('bad', 1000).direction, 'shorter');
  // 阈值可传：上一章 100 字、这一章 50 字 → 短 50%
  const custom = logic.compareChapterChars(50, 100, { minPrevious: 0 });
  assert.equal(custom.direction, 'shorter');
  assert.equal(logic.compareChapterChars(50, 100, { minPrevious: 0, shortPercent: 80 }).direction, 'similar');
});

test('章节列表紧凑字数：万 / 亿，整数省掉 .0', () => {
  assert.equal(logic.formatCharsShort(0), '0');
  assert.equal(logic.formatCharsShort(null), '0');
  assert.equal(logic.formatCharsShort(999), '999');
  assert.equal(logic.formatCharsShort(9999), '9999');
  assert.equal(logic.formatCharsShort(10000), '1万');
  assert.equal(logic.formatCharsShort(12345), '1.2万');
  assert.equal(logic.formatCharsShort(99999999), '1亿');
  assert.equal(logic.formatCharsShort(100000000), '1亿');
  assert.equal(logic.formatCharsShort(123456789), '1.2亿');
  assert.equal(logic.formatCharsShort('bad'), '0');
});

test('超长段落标签点击：从当前光标找下一段，到末尾绕回第一段', () => {
  const items = [{ start: 5 }, { start: 20 }];
  assert.equal(logic.nextLongParagraph(items, 0), items[0]);
  assert.equal(logic.nextLongParagraph(items, 5), items[1]);
  assert.equal(logic.nextLongParagraph(items, 20), items[0]);
  assert.equal(logic.nextLongParagraph(items, 999), items[0]);
  assert.equal(logic.nextLongParagraph([], 0), null);
  assert.equal(logic.nextLongParagraph(null, 0), null);
});

test('空白与下标工具：lineRanges / countChars 边界', () => {
  const lines = logic.lineRanges('ab\n\ncd\n');
  assert.deepEqual(
    lines.map((line) => [line.start, line.end, line.line, line.blank]),
    [
      [0, 2, 1, false],
      [3, 3, 2, true],
      [4, 6, 3, false],
      [7, 7, 4, true]
    ]
  );
  assert.equal(logic.countChars(' a　b\t\n'), 2);
  assert.equal(logic.countChars(null), 0);
  assert.equal(logic.countChars(123), 3);
});


test('写作时长格式：秒 / 分钟 / 小时 / 天，坏值按 0', () => {
  assert.equal(logic.formatDuration(0), '0 秒');
  assert.equal(logic.formatDuration(null), '0 秒');
  assert.equal(logic.formatDuration(1), '1 秒');
  assert.equal(logic.formatDuration(59), '59 秒');
  assert.equal(logic.formatDuration(60), '1 分钟');
  assert.equal(logic.formatDuration(125), '2 分钟');
  assert.equal(logic.formatDuration(3599), '59 分钟');
  assert.equal(logic.formatDuration(3600), '1 小时');
  assert.equal(logic.formatDuration(3660), '1 小时 1 分钟');
  assert.equal(logic.formatDuration(86399), '23 小时 59 分钟');
  assert.equal(logic.formatDuration(86400), '1 天');
  assert.equal(logic.formatDuration(90000), '1 天 1 小时');
  assert.equal(logic.formatDuration(-10), '0 秒');
  assert.equal(logic.formatDuration('abc'), '0 秒');
});

test('写作时长秒表：m:ss / h:mm:ss，小时不补前导 0', () => {
  assert.equal(logic.formatStopwatch(0), '0:00');
  assert.equal(logic.formatStopwatch(7), '0:07');
  assert.equal(logic.formatStopwatch(65), '1:05');
  assert.equal(logic.formatStopwatch(3599), '59:59');
  assert.equal(logic.formatStopwatch(3600), '1:00:00');
  assert.equal(logic.formatStopwatch(3725), '1:02:05');
  assert.equal(logic.formatStopwatch(36000), '10:00:00');
  assert.equal(logic.formatStopwatch(-5), '0:00');
  assert.equal(logic.formatStopwatch('bad'), '0:00');
});

// ---------- 当前段落高亮（v0.8-10，提案 N10） ----------
// 光标所在自然段：一个非空行 = 一段（和 paragraphRanges / 朗读同一口径），
// 只给显示层用：返回行号 / 段落号 / 去首尾空白的区间，不改正文、不写盘。
test('当前段落：光标在段中间 / 段首缩进 / 行尾都算同一段', () => {
  const text = `${FW}${FW}第一段。\n\n${FW}${FW}第二段长一点。\n  \n第三段！`;
  const p1 = text.indexOf('第一段');
  const p2 = text.indexOf('第二段');
  const p3 = text.indexOf('第三段');
  const mid = logic.caretParagraph(text, p1 + 1);
  assert.deepEqual(
    { line: mid.line, paragraph: mid.paragraph, blank: mid.blank, start: mid.start, end: mid.end, text: mid.text },
    { line: 1, paragraph: 1, blank: false, start: p1, end: p1 + 4, text: '第一段。' }
  );
  // 光标在段首两个全角缩进里：还是第一段（高亮整段，不是只高亮缩进）
  const indent = logic.caretParagraph(text, p1 - 2);
  assert.equal(indent.line, 1);
  assert.equal(indent.paragraph, 1);
  assert.equal(indent.start, p1);
  // 光标正好在第一行末尾（换行符之前）算第一行
  const lineEnd = logic.caretParagraph(text, p1 + 4);
  assert.equal(lineEnd.line, 1);
  assert.equal(lineEnd.paragraph, 1);
  // 第二段中间
  const second = logic.caretParagraph(text, p2 + 3);
  assert.equal(second.line, 3);
  assert.equal(second.paragraph, 2);
  assert.equal(second.start, p2);
  assert.equal(second.end, p2 + 7);
  assert.equal(second.text, '第二段长一点。');
  // 最后一段末尾（没有换行）
  const last = logic.caretParagraph(text, text.length);
  assert.equal(last.line, 5);
  assert.equal(last.paragraph, 3);
  assert.equal(last.text, '第三段！');
  assert.ok(p3 > 0);
});

test('当前段落：空行 / 空文本 / 越界位置都给「没有段落」，不会报错', () => {
  const text = `${FW}${FW}第一段。\n\n${FW}${FW}第二段。`;
  const blankPos = text.indexOf('\n\n') + 1;
  const blank = logic.caretParagraph(text, blankPos);
  assert.equal(blank.blank, true);
  assert.equal(blank.paragraph, 0);
  assert.equal(blank.line, 2);
  assert.equal(blank.text, '');
  // 只有空白（两个半角空格）的行也是空行
  const spaced = logic.caretParagraph(`第一段。\n  \n第三段。`, 5);
  assert.equal(spaced.blank, true);
  assert.equal(spaced.paragraph, 0);
  assert.equal(spaced.line, 2);
  // 空文本 = 第 1 行空行
  const empty = logic.caretParagraph('', 0);
  assert.deepEqual(
    { line: empty.line, index: empty.index, blank: empty.blank, paragraph: empty.paragraph },
    { line: 1, index: 0, blank: true, paragraph: 0 }
  );
  // 越界 / 坏位置夹回正文范围
  const negative = logic.caretParagraph(text, -99);
  assert.equal(negative.line, 1);
  assert.equal(negative.paragraph, 1);
  const huge = logic.caretParagraph(text, 999999);
  assert.equal(huge.line, 3);
  assert.equal(huge.paragraph, 2);
  assert.equal(logic.caretParagraph(null, 0).blank, true);
  assert.equal(logic.caretParagraph(text, 'abc').line, 1);
});

test('当前段落：和 paragraphRanges 完全对齐（段号 / 区间 / 行号）', () => {
  const text = `${FW}${FW}第一段。\n\n${FW}${FW}第二段，长一点。\n  \n${FW}${FW}第三段！\n`;
  const paragraphs = logic.paragraphRanges(text);
  assert.equal(paragraphs.length, 3);
  for (const range of paragraphs) {
    const hit = logic.caretParagraph(text, range.start);
    assert.equal(hit.line, range.line);
    assert.equal(hit.paragraph, range.paragraph);
    assert.equal(hit.start, range.start);
    assert.equal(hit.end, range.end);
    assert.equal(hit.blank, false);
    assert.equal(hit.text, text.slice(range.start, range.end));
  }
  // 结尾换行之后（文本末尾）是最后一行的空行，不属于任何段落
  const tail = logic.caretParagraph(text, text.length);
  assert.equal(tail.blank, true);
  assert.equal(tail.paragraph, 0);
  assert.equal(tail.line, 6);
});
