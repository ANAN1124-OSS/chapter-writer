const test = require('node:test');
const assert = require('node:assert/strict');
const reading = require('../renderer/reading-logic');

test('阅读模式：字号四档默认「大」22px，坏值回默认、越界夹紧', () => {
  assert.deepEqual(reading.READING_FONT_LEVELS, [17, 19, 22, 25]);
  assert.deepEqual(reading.READING_FONT_LABELS, ['小', '中', '大', '特大']);
  assert.equal(reading.fontSize(undefined), 22);
  assert.equal(reading.fontSize(null), 22);
  assert.equal(reading.fontSize('abc'), 22);
  assert.equal(reading.fontSize(0), 17);
  assert.equal(reading.fontSize(1), 19);
  assert.equal(reading.fontSize('2'), 22);
  assert.equal(reading.fontSize(3), 25);
  // 超出 0–3 的夹到两端
  assert.equal(reading.fontSize(-1), 17);
  assert.equal(reading.fontSize(9), 25);
  assert.equal(reading.fontSize(1.9), 19); // 向下取整
  assert.equal(reading.fontLevel(Infinity), reading.READING_FONT_DEFAULT);
});

test('阅读模式：行距三档默认「标准」2.0，坏值回默认、越界夹紧', () => {
  assert.deepEqual(reading.READING_LINE_LEVELS, [1.7, 2.0, 2.3]);
  assert.deepEqual(reading.READING_LINE_LABELS, ['紧凑', '标准', '宽松']);
  assert.equal(reading.lineHeight(undefined), 2.0);
  assert.equal(reading.lineHeight('x'), 2.0);
  assert.equal(reading.lineHeight(0), 1.7);
  assert.equal(reading.lineHeight(1), 2.0);
  assert.equal(reading.lineHeight(2), 2.3);
  assert.equal(reading.lineHeight(-3), 1.7);
  assert.equal(reading.lineHeight(10), 2.3);
  assert.equal(reading.lineLevel(NaN), reading.READING_LINE_DEFAULT);
});

test('阅读模式：进度文字按「看到第几章」算，首章 / 末章 / 夹紧都正确', () => {
  assert.deepEqual(reading.readingProgress(0, 3), {
    index: 0,
    current: 1,
    total: 3,
    percent: 33.3,
    text: '第 1 / 3 章 · 33.3%'
  });
  assert.equal(reading.readingProgress(1, 3).percent, 66.7);
  assert.equal(reading.readingProgress(2, 3).percent, 100);
  assert.equal(reading.readingProgress(2, 3).text, '第 3 / 3 章 · 100%');
  // 下标越界夹到首 / 末；坏值当第一页
  assert.equal(reading.readingProgress(-5, 10).index, 0);
  assert.equal(reading.readingProgress(99, 10).index, 9);
  assert.equal(reading.readingProgress('abc', 10).index, 0);
  assert.equal(reading.readingProgress(3.9, 10).index, 3);
  // 没有章节时不显示「第 1 / 0 章」
  assert.deepEqual(reading.readingProgress(0, 0), {
    index: -1,
    current: 0,
    total: 0,
    percent: 0,
    text: '全书还没有章节'
  });
  assert.equal(reading.readingProgress(null, -3).total, 0);
});

test('阅读模式：按区块顶端算当前章，含 offset 与未滚到首章的情况', () => {
  const blocks = [
    { index: 0, top: 0 },
    { index: 1, top: 900 },
    { index: 2, top: 1800 }
  ];
  assert.equal(reading.blockAtScroll(blocks, 0), 0);
  assert.equal(reading.blockAtScroll(blocks, 400), 0);
  // offset 24：刚好到 900 时还差 24px，算上一章；超过 24 才算下一章
  assert.equal(reading.blockAtScroll(blocks, 875), 0);
  assert.equal(reading.blockAtScroll(blocks, 880), 1);
  assert.equal(reading.blockAtScroll(blocks, 1200), 1);
  assert.equal(reading.blockAtScroll(blocks, 2000), 2);
  // 滚到比最后一章还下面：仍是最后一章
  assert.equal(reading.blockAtScroll(blocks, 99999), 2);
  // 滚到负值按 0 算
  assert.equal(reading.blockAtScroll(blocks, -50), 0);
  // 空数组 / 坏输入返回 -1
  assert.equal(reading.blockAtScroll([], 10), -1);
  assert.equal(reading.blockAtScroll(null, 10), -1);
  // 乱序也取「top 最大且不超过可见线」的那个
  assert.equal(
    reading.blockAtScroll(
      [
        { index: 2, top: 1800 },
        { index: 0, top: 0 },
        { index: 1, top: 900 }
      ],
      1000
    ),
    1
  );
  // 坏条目跳过；全坏时返回 -1
  assert.equal(reading.blockAtScroll([{ index: 'x', top: 0 }, null, { index: 1, top: 100 }], 50), 1);
  assert.equal(reading.blockAtScroll([{ index: 0, top: 'x' }, null], 50), -1);
  // offset 传坏值按默认 24；显式 0 时不加偏移
  assert.equal(reading.blockAtScroll(blocks, 900), 1);
  assert.equal(reading.blockAtScroll(blocks, 899, 0), 0);
  assert.equal(reading.blockAtScroll(blocks, 900, 0), 1);
});

test('阅读模式：接近底部判定（自动接下一章用）', () => {
  // 可滚动 1000，滚动到 700：还差 300，默认阈值 320 → 算接近底部
  assert.equal(
    reading.nearBottom({ scrollTop: 700, scrollHeight: 1600, clientHeight: 600 }),
    true
  );
  // 还差 321 → 不算
  assert.equal(
    reading.nearBottom({ scrollTop: 679, scrollHeight: 1600, clientHeight: 600 }),
    false
  );
  // 内容不足一屏：直接算到底
  assert.equal(reading.nearBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 }), true);
  // 已经超过最大滚动（浏览器会夹住）：仍然算到底
  assert.equal(reading.nearBottom({ scrollTop: 2000, scrollHeight: 1600, clientHeight: 600 }), true);
  // 阈值可调；坏值 / 负数按 0 / 默认处理
  assert.equal(
    reading.nearBottom({ scrollTop: 600, scrollHeight: 1600, clientHeight: 600, threshold: 500 }),
    true
  );
  assert.equal(
    reading.nearBottom({ scrollTop: 100, scrollHeight: 1600, clientHeight: 600, threshold: -10 }),
    false
  );
  // 坏输入不炸
  assert.equal(reading.nearBottom(null), true);
  assert.equal(reading.nearBottom({ scrollTop: 'x', scrollHeight: 'y', clientHeight: 'z' }), true);
});

test('阅读模式：上一章 / 下一章不越界，章首章尾返回 null', () => {
  assert.equal(reading.stepIndex(1, 3, 1), 2);
  assert.equal(reading.stepIndex(1, 3, -1), 0);
  assert.equal(reading.stepIndex(0, 3, -1), null);
  assert.equal(reading.stepIndex(2, 3, 1), null);
  assert.equal(reading.stepIndex(0, 1, 1), null);
  assert.equal(reading.stepIndex(0, 0, 1), null);
  // 坏下标先夹紧再走一步
  assert.equal(reading.stepIndex(-2, 3, 1), 1);
  assert.equal(reading.stepIndex(99, 3, -1), 1);
  assert.equal(reading.stepIndex('1', 3, 1), 2);
  assert.equal(reading.stepIndex('x', 3, 1), 1);
  // direction 非负都当「下一章」；负数（含 -0.1）当上一章
  assert.equal(reading.stepIndex(0, 3, 0), 1);
  assert.equal(reading.stepIndex(0, 3, -0.1), null);
  assert.equal(reading.stepIndex(1, 3, -0.1), 0);
});

test('阅读模式：全书字数只累加书目的非负字数缓存', () => {
  assert.equal(reading.bookChars([{ chars: 100 }, { chars: '50' }, { chars: 0 }]), 150);
  assert.equal(reading.bookChars([{ chars: -5 }, { chars: 'abc' }, null, {}]), 0);
  assert.equal(reading.bookChars([]), 0);
  assert.equal(reading.bookChars(null), 0);
  assert.equal(reading.bookChars([{ chars: 1.6 }, { chars: 2.4 }]), 4);
});
