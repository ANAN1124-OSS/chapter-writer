const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeBuffer, splitChapters, splitChaptersRaw, parseHeading, isChapterHeading } = require('../core/txt');

test('解码：UTF-8 无 BOM / 有 BOM', () => {
  assert.equal(decodeBuffer(Buffer.from('第一章 雪夜', 'utf8')), '第一章 雪夜');
  assert.equal(decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM', 'utf8')])), '带BOM');
});

test('解码：UTF-16LE / UTF-16BE', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]);
  assert.equal(decodeBuffer(le), '中文');
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文', 'utf16le').swap16()]);
  assert.equal(decodeBuffer(be), '中文');
});

test('解码：GBK 中文', () => {
  // “第一章 中文”的 GBK 字节
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBuffer(gbk), '第一章 中文');
});

test('标题识别：各种常见写法', () => {
  assert.equal(parseHeading('第1章：开端').name, '开端');
  assert.equal(parseHeading('第1章--超级标题').name, '超级标题');
  assert.equal(parseHeading('第 12 章 雪夜').name, '雪夜');
  assert.equal(parseHeading('　　第一章 雪夜').name, '雪夜');
  assert.equal(parseHeading('第1章').name, '');
  assert.equal(parseHeading('第3章”TSF变身游戏').name, 'TSF变身游戏');
  assert.equal(parseHeading('楔子').name, '楔子');
  assert.equal(parseHeading('序章 缘起').name, '序章 缘起');
  assert.equal(parseHeading('Chapter 5 The End').name, 'Chapter 5 The End');
});

test('标题识别：正文段落不会被误判', () => {
  assert.equal(isChapterHeading('他把第一章读了三遍。'), false);
  assert.equal(isChapterHeading('　　“第1章？”她问。'), false);
  assert.equal(isChapterHeading('第1章的剧情很精彩'), true, '行首「第1章」这类仍按标题处理');
  assert.equal(isChapterHeading('接着写道：第2章开始'), false);
  assert.equal(isChapterHeading(''), false);
});

test('切章：标准多章结构', () => {
  const text = ['第1章 开端', '', '正文一', '', '第2章 转折', '', '正文二'].join('\n');
  const parts = splitChapters(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '开端');
  assert.equal(parts[0].text, '正文一');
  assert.equal(parts[1].title, '转折');
  assert.equal(parts[1].text, '正文二');
});

test('切章：没有标题行 → 一章「全文」', () => {
  const parts = splitChapters('这是一整篇没有章节标题的短篇小说。\n\n第二段。');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, '全文');
  assert.ok(parts[0].text.includes('第二段'));
});

test('切章：第一个标题之前的内容作为「开篇」保留', () => {
  const text = ['书名：测试', '作者：某人', '', '第1章 开端', '', '正文一'].join('\n');
  const parts = splitChapters(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '开篇');
  assert.ok(parts[0].text.includes('作者：某人'));
  assert.equal(parts[1].title, '开端');
});

test('切章：CRLF 与空章都能处理', () => {
  const text = '第1章\r\n\r\n内容一\r\n\r\n第2章\r\n\r\n第3章\r\n\r\n内容三';
  const parts = splitChapters(text);
  assert.equal(parts.length, 3);
  assert.equal(parts[1].title, '');
  assert.equal(parts[1].text, '');
  assert.equal(parts[2].text, '内容三');
});

test('原样切章：章名照抄原文标题、正文不做 trim', () => {
  const text = '第1章 开端\n\n正文一，带 空格。\n\n第2章 转折\n\n正文二\n';
  const parts = splitChaptersRaw(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '第1章 开端');
  assert.equal(parts[0].body, '\n正文一，带 空格。\n');
  assert.equal(parts[1].title, '第2章 转折');
  assert.equal(parts[1].body, '\n正文二\n');
});

test('原样切章：开头有书名/引子时并入第一章正文，不多出「开篇」章', () => {
  const text = '书名：测试\n作者：某人\n\n　　楔子\n\n引子内容\n\n第1章 开端\n\n正文一';
  const parts = splitChaptersRaw(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '楔子');
  assert.ok(parts[0].body.includes('书名：测试'));
  assert.ok(parts[0].body.includes('引子内容'));
  assert.equal(parts[1].title, '第1章 开端');
});

test('标题识别扩展：第X幕 / 第X话 / 番外（1）/ 前言（无色）/ 尾声】 / 长标题', () => {
  assert.equal(parseHeading('第一幕 穿越为白发金眸小龙娘！').name, '穿越为白发金眸小龙娘！');
  assert.equal(parseHeading('第3话 某个日常').name, '某个日常');
  assert.ok(parseHeading('番外（1）'));
  assert.ok(parseHeading('番外篇：后日谈'));
  assert.ok(parseHeading('前言（无色）'));
  assert.ok(parseHeading('尾声】（纯剧情，无H内容）'));
  assert.ok(parseHeading('后记和设定说明'));
  assert.ok(parseHeading('附录：设定集'));
  // 各种奇怪但真实的标题写法
  assert.ok(parseHeading('附录，兔女郎的酒吧密会'));
  assert.ok(parseHeading('尾声？：'));
  assert.ok(parseHeading('后记。'));
  assert.ok(parseHeading('番外·终:马屌比赛的结局'));
  assert.ok(parseHeading('第四章;转生成铃兰小姐后，为了还债只能被迫在浴馆中打工'));
  assert.ok(parseHeading('番外，目前可以解锁的素世的调教表格：'));
  // 有分隔符的长标题（很多网文标题上百字）也应识别
  const longTitle = `第2章  ${'照顾男友一起按摩的清纯少女'.repeat(4)}`;
  assert.ok(parseHeading(longTitle));
  assert.ok(parseHeading(longTitle).name.length > 30);
});

test('正文长句不会被当成标题', () => {
  assert.equal(isChapterHeading('第三节课结束时，大部分学生已经如同从水里捞出来一般，瘫在各自狼藉的座位上。'), false);
  assert.equal(isChapterHeading('第三节课上，老师讲的内容我一个字也没听进去。'), false);
  assert.equal(isChapterHeading('尾声的序章，便是菈妮丝代表蔷薇骑士团，为岚等三人献上了蔷薇骑士团的信物徽章。'), false);
  assert.equal(isChapterHeading('第二节课后，紫萱又靠了过来，身上那股浓郁的雌性荷尔蒙媚香立刻把我包围了。'), false);
  // 没有分隔符但很短：仍可能是标题
  assert.ok(parseHeading('第一章男朋友（无色）'));
});

test('原样切章：没有标题行时整本一章、正文原样', () => {
  const text = '这是一整篇没有章节标题的短篇小说。\n\n第二段。\n';
  const parts = splitChaptersRaw(text);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, '');
  assert.equal(parts[0].body, text);
});
