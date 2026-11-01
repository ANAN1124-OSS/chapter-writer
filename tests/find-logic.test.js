const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../renderer/find-logic');

// 和 core/find.js 同形状的命中列表：{ index, length }，下标都是编辑区 value 的字符下标
const matchesOf = (text, needle) => {
  const out = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    out.push({ index, length: needle.length });
    from = index + needle.length;
  }
  return out;
};

test('命中列表清洗：坏数据丢掉、排序稳定、不信任负下标', () => {
  assert.deepEqual(logic.normalizeMatches(null), []);
  assert.deepEqual(logic.normalizeMatches('不是数组'), []);
  assert.deepEqual(
    logic.normalizeMatches([
      { index: 8, length: 2 },
      { index: 2, length: 2 },
      { index: -1, length: 2 },
      { index: 3, length: 0 },
      { index: 3.7, length: 2.9 },
      { index: '5', length: '2' },
      null,
      'x'
    ]),
    [
      { index: 2, length: 2 },
      { index: 3, length: 2 },
      { index: 5, length: 2 },
      { index: 8, length: 2 }
    ]
  );
  assert.deepEqual(logic.normalizeMatches([{ index: 0, length: 1 }, { index: 0, length: 1 }]), [
    { index: 0, length: 1 },
    { index: 0, length: 1 }
  ]);
});

test('上一处 / 下一处：正常前进后退，停在第几处都对得上', () => {
  const matches = matchesOf('阿明和阿明和阿明', '阿明');
  assert.equal(matches.length, 3);
  assert.deepEqual(logic.stepMatch(matches, 0, 1), { index: 1, total: 3, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, 1, 1), { index: 2, total: 3, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, 2, -1), { index: 1, total: 3, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, 1, -1), { index: 0, total: 3, wrapped: false });
  // 只有一个命中：前进后退都停在自己身上
  const single = matchesOf('阿明', '阿明');
  assert.deepEqual(logic.stepMatch(single, 0, 1), { index: 0, total: 1, wrapped: false });
  assert.deepEqual(logic.stepMatch(single, 0, -1), { index: 0, total: 1, wrapped: false });
});

test('上一处 / 下一处：到两端默认绕回，wrap: false 时返回 null', () => {
  const matches = matchesOf('阿明阿明阿明', '阿明');
  assert.deepEqual(logic.stepMatch(matches, 2, 1), { index: 0, total: 3, wrapped: true });
  assert.deepEqual(logic.stepMatch(matches, 0, -1), { index: 2, total: 3, wrapped: true });
  assert.equal(logic.stepMatch(matches, 2, 1, { wrap: false }), null);
  assert.equal(logic.stepMatch(matches, 0, -1, { wrap: false }), null);
  // wrap 只认明确的 false，脏值当默认（绕回）
  assert.deepEqual(logic.stepMatch(matches, 2, 1, { wrap: 'nope' }), {
    index: 0,
    total: 3,
    wrapped: true
  });
});

test('上一处 / 下一处：没有当前命中 / 空列表 / 越界下标都安全', () => {
  const matches = matchesOf('阿明阿明', '阿明');
  assert.deepEqual(logic.stepMatch(matches, -1, 1), { index: 0, total: 2, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, -1, -1), { index: 1, total: 2, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, 99, 1), { index: 0, total: 2, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, 99, -1), { index: 1, total: 2, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, null, 1), { index: 0, total: 2, wrapped: false });
  assert.deepEqual(logic.stepMatch(matches, '不是数字', -1), { index: 1, total: 2, wrapped: false });
  assert.equal(logic.stepMatch([], 0, 1), null);
  assert.equal(logic.stepMatch(null, 0, 1), null);
  // 方向不是 -1 的一律当「下一处」
  assert.deepEqual(logic.stepMatch(matches, 0, 0), { index: 1, total: 2, wrapped: false });
});

test('高亮窗口：命中不多时全部画，带 ordinal', () => {
  const matches = matchesOf('阿明阿明阿明', '阿明');
  const win = logic.highlightWindow(matches, 1);
  assert.equal(win.total, 3);
  assert.equal(win.truncated, false);
  assert.equal(win.windowStart, 0);
  assert.equal(win.windowEnd, 3);
  assert.deepEqual(win.items, [
    { index: 0, length: 2, ordinal: 0 },
    { index: 2, length: 2, ordinal: 1 },
    { index: 4, length: 2, ordinal: 2 }
  ]);
  const empty = logic.highlightWindow([], 0);
  assert.deepEqual(empty, {
    items: [],
    total: 0,
    windowStart: 0,
    windowEnd: 0,
    hiddenBefore: 0,
    hiddenAfter: 0,
    truncated: false,
    maxItems: logic.MAX_HIGHLIGHT_ITEMS
  });
});

test('高亮窗口：命中太多时以当前命中为中心开窗，导航序号仍是全局的', () => {
  const matches = [];
  for (let i = 0; i < 1000; i += 1) matches.push({ index: i * 3, length: 2 });
  const middle = logic.highlightWindow(matches, 500, { max: 100 });
  assert.equal(middle.truncated, true);
  assert.equal(middle.total, 1000);
  assert.equal(middle.items.length, 100);
  assert.equal(middle.windowStart, 450);
  assert.equal(middle.windowEnd, 550);
  assert.equal(middle.hiddenBefore, 450);
  assert.equal(middle.hiddenAfter, 450);
  assert.equal(middle.items[0].ordinal, 450);
  assert.equal(middle.items[99].ordinal, 549);
  assert.ok(middle.items.some((item) => item.ordinal === 500));

  // 当前命中在开头 / 结尾：窗口贴边，不会空出一截
  assert.equal(logic.highlightWindow(matches, 0, { max: 100 }).windowStart, 0);
  const tail = logic.highlightWindow(matches, 999, { max: 100 });
  assert.equal(tail.windowStart, 900);
  assert.equal(tail.items[99].ordinal, 999);
  // 越界 / 坏掉的当前下标：夹回第一处，窗口仍然有效
  assert.equal(logic.highlightWindow(matches, -5, { max: 100 }).items[0].ordinal, 0);
  assert.equal(logic.highlightWindow(matches, 99999, { max: 100 }).items[0].ordinal, 0);
});

test('高亮窗口：max 有上下限，坏值回默认', () => {
  const matches = [];
  for (let i = 0; i < 600; i += 1) matches.push({ index: i, length: 1 });
  assert.equal(logic.highlightWindow(matches, 0, { max: 1 }).maxItems, logic.HIGHLIGHT_ITEM_LIMITS[0]);
  const capped = logic.highlightWindow(matches, 0, { max: 999999 });
  assert.equal(capped.maxItems, logic.HIGHLIGHT_ITEM_LIMITS[1]);
  assert.equal(capped.items.length, 600);
  assert.equal(logic.highlightWindow(matches, 0, { max: '坏' }).items.length, 500);
  assert.equal(logic.highlightWindow(matches, 0).maxItems, logic.MAX_HIGHLIGHT_ITEMS);
});

test('高亮片段：切出来的文字拼回去和正文一字不差', () => {
  const text = '　　阿明推门，雨很大。\n\n　　阿明把伞收起来。';
  const matches = matchesOf(text, '阿明');
  const runs = logic.highlightRuns(text, matches);
  assert.equal(runs.map((run) => run.text).join(''), text);
  assert.deepEqual(
    runs.filter((run) => run.hit).map((run) => run.text),
    ['阿明', '阿明']
  );
  assert.deepEqual(
    runs.filter((run) => run.hit).map((run) => run.ordinal),
    [0, 1]
  );
  // 换行、段首缩进都在普通片段里原样保留（影子层靠这个和编辑区对齐）
  assert.ok(runs.some((run) => !run.hit && run.text.includes('\n\n')));
  assert.equal(runs.filter((run) => run.hit).length, 2);
});

test('高亮片段：空文本 / 空命中 / 越界 / 重叠 / 坏 ordinal 都不崩', () => {
  assert.deepEqual(logic.highlightRuns('', []), []);
  assert.deepEqual(logic.highlightRuns(null, null), []);
  assert.deepEqual(logic.highlightRuns('abc', []), [{ text: 'abc', hit: false, ordinal: -1 }]);
  const text = 'abcdef';
  const runs = logic.highlightRuns(text, [
    { index: 4, length: 99, ordinal: 7 }, // 长度超出文末：裁到文末
    { index: 1, length: 2, ordinal: 3 },
    { index: 2, length: 2, ordinal: 4 }, // 和上一处重叠：跳过
    { index: 9, length: 1 }, // 越界：跳过
    { index: -2, length: 1 }, // 负下标：跳过
    { index: 3, length: 0 }, // 长度 0：跳过
    null,
    'x'
  ]);
  assert.equal(runs.map((run) => run.text).join(''), text);
  assert.deepEqual(
    runs.filter((run) => run.hit).map((run) => ({ text: run.text, ordinal: run.ordinal })),
    [
      { text: 'bc', ordinal: 3 },
      { text: 'ef', ordinal: 7 }
    ]
  );
  // 没带 ordinal 的按排序后的顺序补
  const noOrdinal = logic.highlightRuns('阿明阿明', [
    { index: 2, length: 2 },
    { index: 0, length: 2 }
  ]);
  assert.deepEqual(
    noOrdinal.filter((run) => run.hit).map((run) => run.ordinal),
    [0, 1]
  );
});

test('命中在第几行：1 基、越界夹紧、CRLF 也算换行', () => {
  const text = '第一行\n第二行\n\n第三行';
  assert.equal(logic.lineOfIndex(text, 0), 1);
  assert.equal(logic.lineOfIndex(text, 3), 1);
  assert.equal(logic.lineOfIndex(text, 4), 2);
  assert.equal(logic.lineOfIndex(text, text.length), 4);
  assert.equal(logic.lineOfIndex(text, 9999), 4);
  assert.equal(logic.lineOfIndex(text, -3), 1);
  assert.equal(logic.lineOfIndex('a\r\nb', 3), 2);
  assert.equal(logic.lineOfIndex('', 0), 1);
  assert.equal(logic.lineOfIndex(null, null), 1);
});

test('第 X / 共 N 处：没有命中给短横线，坏值不越界', () => {
  assert.equal(logic.formatCounter(0, 12), '1 / 12');
  assert.equal(logic.formatCounter(11, 12), '12 / 12');
  assert.equal(logic.formatCounter(-1, 12), '—');
  assert.equal(logic.formatCounter(12, 12), '—');
  assert.equal(logic.formatCounter(0, 0), '—');
  assert.equal(logic.formatCounter(null, null), '—');
  assert.equal(logic.formatCounter('坏', '坏'), '—');
});

test('和 core/find.js 的口径一致：命中位置可以直接拿去 setSelectionRange', () => {
  // 这里不复刻 findMatches 的实现，只验证「同一段正文、同样的命中列表」下：
  // 窗口 / 片段 / 行号用的都是同一套下标，不会出现「选中第 2 处、高亮第 3 处」。
  const text = '　　A说：Rain。\n　　B说：rain。\n　　阿明来了。';
  const matches = [
    { index: text.indexOf('Rain'), length: 4 },
    { index: text.lastIndexOf('rain'), length: 4 },
    { index: text.indexOf('阿明'), length: 2 }
  ];
  const win = logic.highlightWindow(matches, 1);
  const runs = logic.highlightRuns(text, win.items);
  const hits = runs.filter((run) => run.hit);
  assert.deepEqual(
    hits.map((run) => ({
      text: run.text,
      ordinal: run.ordinal,
      line: logic.lineOfIndex(text, text.indexOf(run.text))
    })),
    [
      { text: 'Rain', ordinal: 0, line: 1 },
      { text: 'rain', ordinal: 1, line: 2 },
      { text: '阿明', ordinal: 2, line: 3 }
    ]
  );
  assert.equal(logic.formatCounter(1, win.total), '2 / 3');
});
