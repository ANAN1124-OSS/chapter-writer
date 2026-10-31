// 章节模板（v0.8 P0 N5）：模板文本清洗 / 占位符展开 / 「要不要套用」纯逻辑。
// 不读盘、不写盘、不依赖 Electron；只测 core/template.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const templateLib = require('../core/template');

test('章节模板：清洗换行 / NUL / 长度，脏值当空模板', () => {
  assert.equal(templateLib.sanitizeTemplate(undefined), '');
  assert.equal(templateLib.sanitizeTemplate(null), '');
  assert.equal(templateLib.sanitizeTemplate(123), '');
  assert.equal(templateLib.sanitizeTemplate({}), '');
  assert.equal(templateLib.sanitizeTemplate(''), '');
  // CRLF / CR 统一成 LF：编辑区和章节 txt 用 \n
  assert.equal(templateLib.sanitizeTemplate('第{n}章：\r\n\r\n'), '第{n}章：\n\n');
  assert.equal(templateLib.sanitizeTemplate('第一行\r第二行'), '第一行\n第二行');
  // NUL 会截断文件，直接去掉
  assert.equal(templateLib.sanitizeTemplate('开始\u0000结束'), '开始结束');
  // 长度上限：只截模板本身，不抛错
  const long = '字'.repeat(templateLib.MAX_TEMPLATE_LENGTH + 50);
  assert.equal(templateLib.sanitizeTemplate(long).length, templateLib.MAX_TEMPLATE_LENGTH);
});

test('章节模板：只有空白 = 没设置；有内容才算模板', () => {
  assert.equal(templateLib.hasTemplate(''), false);
  assert.equal(templateLib.hasTemplate('   '), false);
  assert.equal(templateLib.hasTemplate('\n\n\t '), false);
  assert.equal(templateLib.hasTemplate(undefined), false);
  assert.equal(templateLib.hasTemplate('第{n}章：\n\n'), true);
  assert.equal(templateLib.hasTemplate('　'), false, '全角空格也是空白');
});

test('章节模板：空章判定（空串 / 只有空白算空章）', () => {
  assert.equal(templateLib.isBlankText(''), true);
  assert.equal(templateLib.isBlankText(' \n\t '), true);
  assert.equal(templateLib.isBlankText(undefined), true);
  assert.equal(templateLib.isBlankText(null), true);
  assert.equal(templateLib.isBlankText('正文'), false);
  assert.equal(templateLib.isBlankText('　　'), true);
});

test('章节模板：{n} / {title} / {date} 展开，未知占位符原样保留', () => {
  const now = new Date(2026, 10, 1, 9, 30, 0); // 本地时间 2026-11-01
  const expanded = templateLib.applyTemplate('第{n}章：{title}\n\n{date}', {
    chapterNumber: 12,
    chapterName: '夜雨',
    now
  });
  assert.equal(expanded, '第12章：夜雨\n\n2026-11-01');
  // 同一个占位符出现多次都要替换
  assert.equal(
    templateLib.applyTemplate('{n}-{n}-{title}-{title}', { chapterNumber: 3, chapterName: '风', now }),
    '3-3-风-风'
  );
  // 不认识的占位符 / 大小写不同都不动
  assert.equal(
    templateLib.applyTemplate('{x}{N}{chapter}', { chapterNumber: 1, now }),
    '{x}{N}{chapter}'
  );
  // 没有占位符时原样返回（只做换行统一）
  assert.equal(templateLib.applyTemplate('分隔线\r\n', { now }), '分隔线\n');
});

test('章节模板：章号没上下文时 {n} 原样保留，章名空就展开成空串', () => {
  const now = new Date(2026, 10, 1);
  assert.equal(templateLib.applyTemplate('第{n}章：', { chapterNumber: 0, now }), '第{n}章：');
  assert.equal(templateLib.applyTemplate('第{n}章：', { chapterNumber: -3, now }), '第{n}章：');
  assert.equal(templateLib.applyTemplate('第{n}章：', { chapterNumber: 'abc', now }), '第{n}章：');
  assert.equal(templateLib.applyTemplate('第{n}章：', {}, now), '第{n}章：');
  // 章名可能是空（未命名章）
  assert.equal(
    templateLib.applyTemplate('第{n}章：{title}\n', { chapterNumber: 5, chapterName: '', now }),
    '第5章：\n'
  );
  // 章号取整
  assert.equal(templateLib.applyTemplate('{n}', { chapterNumber: 7.9, now }), '7');
});

test('章节模板：context 缺省 / 坏值安全兜底，日期用本地时区', () => {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`;
  assert.equal(templateLib.localDateKey(), todayKey);
  assert.equal(templateLib.localDateKey('bad'), todayKey);
  assert.equal(templateLib.localDateKey(new Date(Number.NaN)), todayKey);
  assert.equal(templateLib.applyTemplate('{date}', {}), todayKey);
  assert.equal(templateLib.applyTemplate('{date}', null), todayKey);
  // 空模板无论上下文是什么都展开成空串
  assert.equal(templateLib.applyTemplate('', { chapterNumber: 1, now: new Date(2026, 0, 1) }), '');
  assert.equal(templateLib.applyTemplate('   ', { chapterNumber: 1 }), '   ');
});

test('章节模板：shouldApply 只在「有模板 + 目标章为空」时套用', () => {
  const now = new Date(2026, 10, 1);
  const ctx = { chapterNumber: 1, chapterName: '开篇', now };
  assert.equal(templateLib.shouldApply('第{n}章：\n\n', ''), true);
  assert.equal(templateLib.shouldApply('第{n}章：\n\n', '  \n '), true);
  assert.equal(templateLib.shouldApply('第{n}章：\n\n', '已经有正文'), false, '已有正文绝不覆盖');
  assert.equal(templateLib.shouldApply('', ''), false, '没模板不套用');
  assert.equal(templateLib.shouldApply('   \n', ''), false, '只有空白的模板不套用');
  assert.equal(templateLib.shouldApply(undefined, ''), false);
  // 纯函数：不改传进来的上下文
  const context = { chapterNumber: 2, chapterName: '第二章', now };
  const before = JSON.stringify(context);
  templateLib.applyTemplate('{n} {title} {date}', context);
  assert.equal(JSON.stringify(context), before, '不修改调用方对象');
});
