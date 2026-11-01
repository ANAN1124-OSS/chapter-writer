const test = require('node:test');
const assert = require('node:assert/strict');
const saveLogic = require('../renderer/save-logic');

// 审计 F2：保存热路径先出「已保存」提示、全书校验挪到后台。
// 这两段文案必须与改动前逐字一致，所以用单测锁住；真正的异步顺序由 E2E 覆盖。

test('保存提示：章数 / 本章字数 / 今日快照的文案与改动前逐字一致', () => {
  // 改动前：`已保存：${report.chapterCount} 章 · 本章 ${formatChars(data.chars)}${snapshotNote}`
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '1.20 万字' }),
    '已保存：3 章 · 本章 1.20 万字'
  );
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1284, charsText: '26 字' }),
    '已保存：1284 章 · 本章 26 字'
  );
  // 今日快照只多这一句（原来也是这样拼的）
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1, charsText: '5 字', snapshotTaken: true }),
    '已保存：1 章 · 本章 5 字 · 今日快照已留'
  );
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1, charsText: '5 字', snapshotTaken: false }),
    '已保存：1 章 · 本章 5 字'
  );
});

test('保存提示：章数取书目里的章节数，坏值按 0、小数向下取整（不出现 NaN）', () => {
  assert.equal(saveLogic.savedToastText({ chapterCount: 0, charsText: '0 字' }), '已保存：0 章 · 本章 0 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: 4.7, charsText: '' }), '已保存：4 章 · 本章 ');
  assert.equal(saveLogic.savedToastText({ chapterCount: '6', charsText: '12 字' }), '已保存：6 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: -3, charsText: '12 字' }), '已保存：0 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: undefined, charsText: '12 字' }), '已保存：0 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: NaN, charsText: '12 字' }), '已保存：0 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: 2, charsText: null }), '已保存：2 章 · 本章 ');
  assert.equal(saveLogic.savedToastText(), '已保存：0 章 · 本章 ');
  // 章数只来自 state.chapters.length，不受其它字段影响（多传字段也不会串进来）
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '9 字', missing: ['001-x.txt'], ok: false }),
    '已保存：3 章 · 本章 9 字'
  );
});

test('后台校验：只有真的缺章才给 warn，文案与改动前一致', () => {
  assert.equal(
    saveLogic.verifyWarnText({ chapterCount: 3, totalChars: 120, missing: ['002-夜雨.txt'] }),
    '已保存当前章，但全书有 1 个章节文件缺失'
  );
  assert.equal(
    saveLogic.verifyWarnText({ missing: ['001-a.txt', '003-c.txt', '004-d.txt'] }),
    '已保存当前章，但全书有 3 个章节文件缺失'
  );
  // 不缺章 / 报告不完整 / 校验失败（调用方已 catch）都不提示，避免误报
  assert.equal(saveLogic.verifyWarnText({ chapterCount: 3, missing: [] }), '');
  assert.equal(saveLogic.verifyWarnText({ chapterCount: 3 }), '');
  assert.equal(saveLogic.verifyWarnText({ missing: 'oops' }), '');
  assert.equal(saveLogic.verifyWarnText({ missing: null }), '');
  assert.equal(saveLogic.verifyWarnText(null), '');
  assert.equal(saveLogic.verifyWarnText(undefined), '');
});

test('保存提示是纯函数：不依赖 DOM / 全局状态，重复调用结果稳定', () => {
  const first = saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字' });
  const second = saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字' });
  assert.equal(first, second);
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof saveLogic.savedToastText, 'function');
  assert.equal(typeof saveLogic.verifyWarnText, 'function');
});
