const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const statsLogic = require('../renderer/stats-logic');
const editorLogic = require('../renderer/editor-logic');

// v0.9 B-6：码字日历的纯逻辑从 renderer.js 拆到 renderer/stats-logic.js。
// 这里钉住两件事：① 拆出来的算法与拆之前逐个边界一致（跨年翻月 / 不翻到未来 / 月首空格 /
// 色阶 class / 汇总文案）；② 渲染层不许再长出第二份实现（静态闸门）。

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'stats-logic.js'), 'utf8');

// 渲染层的显示口径（formatDuration 用真实现；formatChars 与 renderer.js 里那 4 行等价）。
const fmt = {
  formatChars: (n) => {
    const value = Number(n) || 0;
    if (value < 10000) return `${value} 字`;
    if (value < 100000000) return `${(value / 10000).toFixed(2)} 万字`;
    return `${(value / 100000000).toFixed(2)} 亿字`;
  },
  formatDuration: editorLogic.formatDuration
};

// 2026-11（本月）当作「现在」，翻月 / 按钮状态都相对它算。
const NOW = new Date(2026, 10, 15, 13, 30, 0, 0);

test('月份游标：当前年月按本地日期取（跨 realm 的 Date 也认，不用 instanceof）', () => {
  assert.deepEqual(statsLogic.currentYearMonth(new Date(2026, 10, 1)), { year: 2026, month: 11 });
  assert.deepEqual(statsLogic.currentYearMonth(new Date(2025, 0, 31)), { year: 2025, month: 1 });
  assert.deepEqual(statsLogic.currentYearMonth(new Date(2025, 11, 31)), { year: 2025, month: 12 });
  // node:vm 沙箱里的 Date 过不了外层 realm 的 instanceof（v0.9 B-3 踩过），这里必须是鸭子类型
  const foreign = vm.runInNewContext('new Date(2024, 5, 10, 9, 0, 0)');
  assert.deepEqual(statsLogic.currentYearMonth(foreign), { year: 2024, month: 6 });
  // 不传 / 传坏值 = 现在（只校验形状，不校验具体年月）
  for (const bad of [undefined, null, 0, '2026-11']) {
    const now = statsLogic.currentYearMonth(bad);
    assert.ok(Number.isInteger(now.year) && now.month >= 1 && now.month <= 12);
  }
});

test('月份游标：比较与翻月（含跨年、大跨度、字符串 delta）', () => {
  assert.ok(statsLogic.compareYearMonth({ year: 2026, month: 1 }, { year: 2025, month: 12 }) > 0);
  assert.ok(statsLogic.compareYearMonth({ year: 2025, month: 12 }, { year: 2026, month: 1 }) < 0);
  assert.equal(statsLogic.compareYearMonth({ year: 2026, month: 5 }, { year: 2026, month: 5 }), 0);
  assert.equal(statsLogic.compareYearMonth({ year: 2026, month: 3 }, { year: 2026, month: 11 }), -8);

  assert.deepEqual(statsLogic.shiftYearMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
  assert.deepEqual(statsLogic.shiftYearMonth({ year: 2025, month: 12 }, 1), { year: 2026, month: 1 });
  assert.deepEqual(statsLogic.shiftYearMonth({ year: 2026, month: 3 }, -14), { year: 2025, month: 1 });
  assert.deepEqual(statsLogic.shiftYearMonth({ year: 2026, month: 3 }, 14), { year: 2027, month: 5 });
  // delta 是数字字符串也能翻（E2E 的 calendarShift 传的就是 number，容错而已）
  assert.deepEqual(statsLogic.shiftYearMonth({ year: 2026, month: 3 }, '2'), { year: 2026, month: 5 });
  // 闰年 2 月：翻 12 个月不丢一天
  assert.deepEqual(statsLogic.shiftYearMonth({ year: 2024, month: 2 }, 12), { year: 2025, month: 2 });
});

test('翻月边界：不翻到未来、不低于 1970-01、delta 为 0 / 非数字一律不翻', () => {
  const cursor = statsLogic.calendarCursor(null, NOW);
  assert.deepEqual(cursor, { year: 2026, month: 11 });
  // 往前翻可以
  assert.deepEqual(statsLogic.shiftCalendarCursor({ year: 2026, month: 10 }, -1, NOW), { year: 2026, month: 9 });
  assert.deepEqual(statsLogic.shiftCalendarCursor({ year: 2026, month: 1 }, -1, NOW), { year: 2025, month: 12 });
  // 本月 +1 = 未来，禁止（E2E：calendarShift(1) 在本月返回 false）
  assert.equal(statsLogic.shiftCalendarCursor({ year: 2026, month: 11 }, 1, NOW), null);
  assert.equal(statsLogic.shiftCalendarCursor({ year: 2026, month: 12 }, 1, NOW), null);
  // delta 为 0 / 空 / 非数字 / NaN / Infinity
  for (const delta of [0, '0', '', 'abc', null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(statsLogic.shiftCalendarCursor(cursor, delta, NOW), null, `delta=${String(delta)} 不该翻月`);
  }
  // 下限 1970-01：再往前翻不动，往后翻没事
  assert.equal(statsLogic.shiftCalendarCursor({ year: 1970, month: 1 }, -1, NOW), null);
  assert.deepEqual(statsLogic.shiftCalendarCursor({ year: 1970, month: 2 }, -1, NOW), { year: 1970, month: 1 });
  assert.deepEqual(statsLogic.shiftCalendarCursor({ year: 1969, month: 12 }, 1, NOW), { year: 1970, month: 1 });
});

test('日历游标：主进程回报的整数年月优先，缺失 / 坏值退回本月', () => {
  assert.deepEqual(statsLogic.calendarCursor({ year: 2026, month: 9 }, NOW), { year: 2026, month: 9 });
  assert.deepEqual(statsLogic.calendarCursor(null, NOW), { year: 2026, month: 11 });
  assert.deepEqual(statsLogic.calendarCursor({}, NOW), { year: 2026, month: 11 });
  assert.deepEqual(statsLogic.calendarCursor({ year: '2026', month: 9 }, NOW), { year: 2026, month: 11 });
  assert.deepEqual(statsLogic.calendarCursor({ year: 2026, month: 9.5 }, NOW), { year: 2026, month: 11 });
});

test('按钮状态：本月禁用「下一月 / 本月」，1970-01 禁用「上一月」，没有数据三个都禁用', () => {
  assert.deepEqual(statsLogic.calendarButtons({ year: 2026, month: 11 }, NOW), {
    prevDisabled: false,
    nextDisabled: true,
    todayDisabled: true
  });
  assert.deepEqual(statsLogic.calendarButtons({ year: 2026, month: 9 }, NOW), {
    prevDisabled: false,
    nextDisabled: false,
    todayDisabled: false
  });
  assert.deepEqual(statsLogic.calendarButtons({ year: 1970, month: 1 }, NOW), {
    prevDisabled: true,
    nextDisabled: false,
    todayDisabled: false
  });
  assert.deepEqual(statsLogic.calendarButtons(null, NOW), {
    prevDisabled: true,
    nextDisabled: true,
    todayDisabled: true
  });
});

test('星期表头：主进程给满 7 个才用，否则用内置「一…日」，并且返回副本', () => {
  assert.deepEqual(statsLogic.weekdayLabels(null), ['一', '二', '三', '四', '五', '六', '日']);
  assert.deepEqual(statsLogic.weekdayLabels({}), ['一', '二', '三', '四', '五', '六', '日']);
  assert.deepEqual(statsLogic.weekdayLabels({ weekdayLabels: ['A', 'B'] }), ['一', '二', '三', '四', '五', '六', '日']);
  const custom = ['日', '一', '二', '三', '四', '五', '六'];
  const labels = statsLogic.weekdayLabels({ weekdayLabels: custom });
  assert.deepEqual(labels, custom);
  labels[0] = '改坏';
  assert.equal(statsLogic.weekdayLabels({ weekdayLabels: custom })[0], '日');
  // 内置表也不能被上一次的调用改坏
  const defaults = statsLogic.weekdayLabels(null);
  defaults[0] = '改坏';
  assert.equal(statsLogic.weekdayLabels(null)[0], '一');
  assert.equal(statsLogic.WEEKDAY_LABELS.length, 7);
});

test('连续天数文案：没记录 / 中断 / 正在连续（与 v0.8-1 逐字一致）', () => {
  assert.equal(statsLogic.calendarStreakLabel(null), '还没有写作记录');
  assert.equal(statsLogic.calendarStreakLabel({ current: 0, best: 0 }), '还没有写作记录');
  assert.equal(statsLogic.calendarStreakLabel({ current: 0, best: 3 }), '连续写作中断 · 最长 3 天');
  assert.equal(statsLogic.calendarStreakLabel({ current: 2, best: 3 }), '已连续写作 2 天 · 最长 3 天');
  // 坏值按 0，不出现 NaN
  assert.equal(statsLogic.calendarStreakLabel({ current: '2', best: '3' }), '已连续写作 2 天 · 最长 3 天');
  assert.equal(statsLogic.calendarStreakLabel({ current: 1.6, best: -5 }), '还没有写作记录');
});

test('月度汇总：没有记录 / 只有计时 / 有记录（目标、最高一天、用时）', () => {
  assert.equal(statsLogic.calendarSummaryText(null, fmt), '');
  assert.equal(
    statsLogic.calendarSummaryText({ isCurrentMonth: true, writtenDays: 0, totalSeconds: 0 }, fmt),
    '本月还没有保存记录（保存一次后开始记录）'
  );
  assert.equal(
    statsLogic.calendarSummaryText({ month: 9, isCurrentMonth: false, writtenDays: 0, totalSeconds: 0 }, fmt),
    '这个月没有保存记录'
  );
  assert.equal(
    statsLogic.calendarSummaryText({ month: 9, isCurrentMonth: false, writtenDays: 0, totalSeconds: 90 }, fmt),
    '这个月没有保存记录（计时 1 分钟）'
  );
  // 有记录：本月 / 9 月各一版；目标、最高一天、用时都按顺序拼
  const view = {
    month: 11,
    isCurrentMonth: true,
    total: 12000,
    writtenDays: 5,
    average: 2400,
    goal: 2000,
    goalDays: 4,
    bestDay: { day: '2026-11-15', chars: 3000 },
    totalSeconds: 5400
  };
  assert.equal(
    statsLogic.calendarSummaryText(view, fmt),
    '本月 1.20 万字 · 写了 5 天 · 日均 2400 字 · 达标 4 天 · 最高 11-15（3000 字） · 用时 1 小时 30 分钟'
  );
  const seed = { ...view, month: 9, isCurrentMonth: false, goal: 0, goalDays: 0, bestDay: null, totalSeconds: 0 };
  assert.equal(statsLogic.calendarSummaryText(seed, fmt), '9月 1.20 万字 · 写了 5 天 · 日均 2400 字');
});

test('今天字数：0 说一句、正数带 +、坏值按 0（不显示 +0 / NaN）', () => {
  assert.equal(statsLogic.statsTodayText({ todayChars: 0 }, fmt), '今天还没写字');
  assert.equal(statsLogic.statsTodayText({}, fmt), '今天还没写字');
  assert.equal(statsLogic.statsTodayText(null, fmt), '今天还没写字');
  assert.equal(statsLogic.statsTodayText({ todayChars: -5 }, fmt), '今天还没写字');
  assert.equal(statsLogic.statsTodayText({ todayChars: 1234 }, fmt), '今天 +1234 字');
  assert.equal(statsLogic.statsTodayText({ todayChars: '1234' }, fmt), '今天 +1234 字');
  assert.equal(statsLogic.statsTodayText({ todayChars: 15000 }, fmt), '今天 +1.50 万字');
});

test('日历网格：月首空格 / 每天格子的 class + 标题 + dataset / 月尾补齐整周', () => {
  const view = {
    firstWeekday: 2,
    days: [
      { day: '2026-09-01', dayOfMonth: 1, chars: 0, seconds: 0, level: 0, written: false, goalMet: false, today: false, future: false },
      { day: '2026-09-02', dayOfMonth: 2, chars: 120, seconds: 90, level: 3, written: true, goalMet: true, today: true, future: false },
      { day: '2026-09-03', dayOfMonth: 3, chars: 0, seconds: 0, level: 0, written: false, goalMet: false, today: false, future: true }
    ]
  };
  const plan = statsLogic.calendarCells(view, fmt);
  assert.equal(plan.blanksBefore, 2);
  assert.equal(plan.cells.length, 3);
  // 2 + 3 = 5，补到 7 格
  assert.equal(plan.blanksAfter, 2);
  assert.deepEqual(plan.cells[0], {
    dayOfMonth: '1',
    className: 'cal-day',
    title: '2026-09-01 · 没写',
    dataset: { day: '2026-09-01', chars: '0', seconds: '0', level: '0', goalMet: '0' }
  });
  assert.equal(plan.cells[1].className, 'cal-day written lv3 goal-met today');
  assert.equal(plan.cells[1].dayOfMonth, '2');
  assert.equal(plan.cells[1].title, '2026-09-02 · 120 字 · 用时 1 分钟 · 已达标 · 今天');
  assert.deepEqual(plan.cells[1].dataset, {
    day: '2026-09-02',
    chars: '120',
    seconds: '90',
    level: '3',
    goalMet: '1'
  });
  assert.equal(plan.cells[2].className, 'cal-day future');
  assert.equal(plan.cells[2].title, '2026-09-03 · 没写 · 还没到');
  // E2E 的 calendarDayInfo 读的就是这五个 dataset 键
  assert.deepEqual(Object.keys(plan.cells[0].dataset), statsLogic.CELL_DATASET_KEYS);
});

test('日历网格：正好整周不补空格、坏 firstWeekday 夹紧、days 缺失当空月、缺 fmt 直接报错', () => {
  // 5 天 + 月首 2 空格 = 7，正好一整周
  const week = {
    firstWeekday: 2,
    days: Array.from({ length: 5 }, (_, i) => ({ day: `2026-09-0${i + 1}`, dayOfMonth: i + 1, chars: 0, level: 0 }))
  };
  assert.equal(statsLogic.calendarCells(week, fmt).blanksAfter, 0);
  // 坏 firstWeekday：夹到 0–6，不出现 NaN 把尾部空格吞掉
  assert.equal(statsLogic.calendarCells({ firstWeekday: 99, days: [] }, fmt).blanksBefore, 6);
  assert.equal(statsLogic.calendarCells({ firstWeekday: -3, days: [] }, fmt).blanksBefore, 0);
  assert.equal(statsLogic.calendarCells({ firstWeekday: '2', days: [] }, fmt).blanksBefore, 2);
  assert.equal(statsLogic.calendarCells({ firstWeekday: 'x', days: [] }, fmt).blanksBefore, 0);
  assert.equal(statsLogic.calendarCells({ firstWeekday: 1.9, days: [] }, fmt).blanksBefore, 1);
  // days 缺失 / 坏形状：当成空月，不抛错
  assert.deepEqual(statsLogic.calendarCells({}, fmt), { blanksBefore: 0, cells: [], blanksAfter: 0 });
  assert.deepEqual(statsLogic.calendarCells(null, fmt), { blanksBefore: 0, cells: [], blanksAfter: 0 });
  // 坏 day 条目按空对象处理（不抛错、dataset 也不出现 undefined）
  const bad = statsLogic.calendarCells({ firstWeekday: 0, days: [null] }, fmt);
  assert.equal(bad.cells[0].className, 'cal-day');
  assert.equal(bad.cells[0].dataset.chars, 'undefined');
  // 格式化口径必须由调用方传进来，缺了立刻报错（不悄悄退回另一套数字格式）
  assert.throws(() => statsLogic.calendarCells(week), TypeError);
  assert.throws(() => statsLogic.calendarSummaryText({ writtenDays: 1, total: 1, average: 1 }), TypeError);
  assert.throws(() => statsLogic.statsTodayText({ todayChars: 1 }, { formatChars: 'x' }), TypeError);
});

test('格式化口径由调用方传入：模块自己只调用、不复制一套', () => {
  const used = [];
  const spy = {
    formatChars: (n) => {
      used.push(['chars', n]);
      return `C${n}`;
    },
    formatDuration: (n) => {
      used.push(['duration', n]);
      return `D${n}`;
    }
  };
  const plan = statsLogic.calendarCells(
    { firstWeekday: 0, days: [{ day: '2026-09-01', dayOfMonth: 1, chars: 300, seconds: 600, level: 4, written: true }] },
    spy
  );
  assert.equal(plan.cells[0].title, '2026-09-01 · C300 · 用时 D600');
  const text = statsLogic.calendarSummaryText(
    { isCurrentMonth: true, writtenDays: 2, total: 300, average: 150, goal: 100, goalDays: 1, totalSeconds: 60 },
    spy
  );
  assert.equal(text, '本月 C300 · 写了 2 天 · 日均 C150 · 达标 1 天 · 用时 D60');
  assert.equal(statsLogic.statsTodayText({ todayChars: 7 }, spy), '今天 +C7');
  assert.deepEqual(used.map(([kind]) => kind), ['chars', 'duration', 'duration', 'chars', 'chars', 'chars']);
  // 模块里不许有第二份数字格式化实现（只做转发）
  assert.ok(!/function formatChars\s*\(/.test(moduleSrc), 'stats-logic.js 不许自己实现 formatChars');
  assert.ok(!/function formatDuration\s*\(/.test(moduleSrc), 'stats-logic.js 不许自己实现 formatDuration');
});

test('静态闸门：码字日历只有一份实现，渲染层只建 DOM', () => {
  // 搬走的那几个函数不许再长回 renderer.js —— 这是本轮拆分的核心约束
  for (const name of [
    'currentYearMonth',
    'compareYearMonth',
    'shiftYearMonth',
    'statsCalendarCursor',
    'calendarStreakLabel',
    'statsTodayText'
  ]) {
    assert.ok(
      !new RegExp('function ' + name + '\\s*\\(').test(rendererSrc),
      `renderer.js 里不该再有 ${name}（应在 renderer/stats-logic.js）`
    );
  }
  // 日历的 class 拼接也只能在模块里
  assert.ok(!/written lv/.test(rendererSrc), 'renderer.js 里不该再拼「written lvN」');
  // 渲染层必须真的接上模块
  assert.match(rendererSrc, /const statsLogic = window\.CWStatsLogic;/);
  assert.match(rendererSrc, /statsLogic\.calendarCells\(view, statsFormat\)/);
  assert.match(rendererSrc, /statsLogic\.shiftCalendarCursor\(/);
  assert.match(rendererSrc, /statsLogic\.calendarStreakLabel\(state\.streak\)/);
  // 测试钩子的 host 契约里还有 calendarSummaryText，薄封装必须留着
  assert.match(rendererSrc, /function calendarSummaryText\(view\) \{/);
  // index.html 里模块必须先于 renderer.js 加载
  const moduleAt = indexSrc.indexOf('src="stats-logic.js"');
  const rendererAt = indexSrc.indexOf('src="renderer.js"');
  assert.ok(moduleAt > 0, 'index.html 没有加载 renderer/stats-logic.js');
  assert.ok(rendererAt > moduleAt, 'stats-logic.js 必须排在 renderer.js 之前');
});

test('静态闸门：stats-logic.js 是纯逻辑（不碰 DOM / 文件系统 / Electron / 网络）', () => {
  assert.ok(!/\bdocument\b/.test(moduleSrc), 'stats-logic.js 不许碰 document');
  assert.ok(!/querySelector|createElement|classList/.test(moduleSrc), 'stats-logic.js 不许碰 DOM API');
  assert.ok(!/\brequire\s*\(/.test(moduleSrc), 'stats-logic.js 不许 require（格式化由调用方传）');
  assert.ok(!/\bprocess\./.test(moduleSrc), 'stats-logic.js 不许碰 process');
  assert.ok(!/\bwindow\./.test(moduleSrc), 'stats-logic.js 不许摸 window（挂载在 UMD 包装里）');
  assert.ok(!/\b(?:readFileSync|writeFileSync|fs\.)/.test(moduleSrc), 'stats-logic.js 不许读写文件');
  assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(moduleSrc), 'stats-logic.js 不许联网');
});

test('UMD：浏览器沙箱里挂 window.CWStatsLogic，行为与 Node require 一致', () => {
  // 沙箱里没有 module，走浏览器分支；globalThis 就是沙箱自己的全局对象
  const sandbox = { Date, Number, String, Math, Array, Object, TypeError };
  vm.runInNewContext(moduleSrc, sandbox);
  const browser = sandbox.CWStatsLogic;
  assert.ok(browser && typeof browser.calendarCells === 'function', '浏览器分支没挂上 CWStatsLogic');
  const view = {
    year: 2026,
    month: 9,
    isCurrentMonth: false,
    label: '2026年9月',
    firstWeekday: 1,
    total: 400,
    writtenDays: 2,
    average: 200,
    goal: 100,
    goalDays: 1,
    bestDay: { day: '2026-09-15', chars: 300 },
    totalSeconds: 0,
    written: true,
    days: [
      { day: '2026-09-01', dayOfMonth: 1, chars: 300, seconds: 600, level: 4, written: true, goalMet: true, today: false, future: false },
      { day: '2026-09-02', dayOfMonth: 2, chars: 100, seconds: 0, level: 2, written: true, goalMet: false, today: false, future: false }
    ]
  };
  // 沙箱里造出来的对象原型来自另一个 realm，deepStrictEqual 会因为原型不同报错，
  // 所以先过一遍 JSON（只比结构）。
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(browser.calendarCells(view, fmt)), statsLogic.calendarCells(view, fmt));
  assert.equal(browser.calendarSummaryText(view, fmt), statsLogic.calendarSummaryText(view, fmt));
  assert.equal(browser.calendarStreakLabel({ current: 2, best: 3 }), statsLogic.calendarStreakLabel({ current: 2, best: 3 }));
  assert.deepEqual(plain(browser.shiftYearMonth({ year: 2026, month: 1 }, -1)), { year: 2025, month: 12 });
  assert.deepEqual([...browser.weekdayLabels(view)], statsLogic.weekdayLabels(view));
});
