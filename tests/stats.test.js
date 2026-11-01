const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const statsLib = require('../core/stats');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-stats-'));
}

function statsWith(days) {
  return { version: 1, days };
}

test('每日统计：localDayKey 用本机日期补零，合法日期字符串原样保留', () => {
  assert.equal(statsLib.localDayKey(new Date(2026, 0, 5, 9, 30)), '2026-01-05');
  assert.equal(statsLib.localDayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  // 已经是日期键就不要再被 Date 当 UTC 解析（差一天）
  assert.equal(statsLib.localDayKey('2026-10-31'), '2026-10-31');
  // 坏输入退回「现在」，但必须是可读的日期键
  assert.match(statsLib.localDayKey('not-a-date'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(statsLib.localDayKey(new Date('x')), /^\d{4}-\d{2}-\d{2}$/);
});

test('每日统计：parseDayKey 只认严格且真实存在的日期', () => {
  assert.deepEqual(statsLib.parseDayKey('2026-10-31'), { year: 2026, month: 10, day: 31 });
  assert.equal(statsLib.parseDayKey('2026-2-1'), null);
  assert.equal(statsLib.parseDayKey('2026-02-30'), null, '2 月 30 日不是真实日期');
  assert.equal(statsLib.parseDayKey('2025-13-01'), null);
  assert.equal(statsLib.parseDayKey('1969-12-31'), null);
  assert.equal(statsLib.parseDayKey('2026-10-31T00:00:00'), null);
  assert.equal(statsLib.parseDayKey(null), null);
});

test('每日统计：shiftDayKey 跨月 / 闰年按本地日历走', () => {
  assert.equal(statsLib.shiftDayKey('2026-03-01', -1), '2026-02-28');
  assert.equal(statsLib.shiftDayKey('2024-03-01', -1), '2024-02-29');
  assert.equal(statsLib.shiftDayKey('2026-01-01', -1), '2025-12-31');
  assert.equal(statsLib.shiftDayKey('2026-12-31', 1), '2027-01-01');
  assert.equal(statsLib.shiftDayKey('坏日期', 0), statsLib.localDayKey());
});

test('每日统计：normalizeGoal 清洗（0 = 关，负数/NaN 回落，超大夹住）', () => {
  assert.equal(statsLib.normalizeGoal(undefined), 0);
  assert.equal(statsLib.normalizeGoal(null), 0);
  assert.equal(statsLib.normalizeGoal('2000'), 2000);
  assert.equal(statsLib.normalizeGoal(2000.4), 2000);
  assert.equal(statsLib.normalizeGoal(-5), 0);
  assert.equal(statsLib.normalizeGoal(Number.NaN), 0);
  assert.equal(statsLib.normalizeGoal(99999999), statsLib.MAX_GOAL);
  assert.equal(statsLib.normalizeGoal('abc', 1500), 1500);
});

test('每日统计：sanitizeStats 丢弃坏日期 / 坏条目 / 非正数，并按 500 天上限截断', () => {
  const cleaned = statsLib.sanitizeStats({
    version: 99,
    days: {
      '2026-10-31': { books: { bookA: 100, bookB: '50', bad: -3, zero: 0, huge: 1e12 } },
      '2026-02-30': { books: { ghost: 1 } },
      '不是日期': { books: { ghost: 1 } },
      '2026-10-30': { books: {} },
      '2026-10-29': { books: null },
      '2026-10-28': '坏'
    }
  });
  assert.equal(cleaned.version, 1);
  assert.deepEqual(Object.keys(cleaned.days).sort(), ['2026-10-31']);
  assert.equal(cleaned.days['2026-10-31'].books.bookA, 100);
  assert.equal(cleaned.days['2026-10-31'].books.bookB, 50);
  assert.equal(cleaned.days['2026-10-31'].books.bad, undefined);
  assert.equal(cleaned.days['2026-10-31'].books.zero, undefined);
  assert.equal(cleaned.days['2026-10-31'].books.huge, 100000000, '超大值夹到单日上限');

  const many = {};
  for (let i = 0; i < 520; i += 1) {
    const d = new Date(2025, 0, 1, 12);
    d.setDate(d.getDate() + i);
    many[statsLib.localDayKey(d)] = { books: { b: 1 } };
  }
  const capped = statsLib.sanitizeStats({ days: many });
  assert.equal(Object.keys(capped.days).length, 500);
  assert.equal(capped.days[statsLib.localDayKey(new Date(2025, 0, 1, 12))], undefined, '最早的日期被截掉');
});

test('每日统计：recordChars 只累计正增量，删字/没变都不倒扣', () => {
  const base = statsWith({
    '2026-10-30': { books: { bookA: 80 } }
  });
  const added = statsLib.recordChars(base, { day: '2026-10-30', bookId: 'bookA', delta: 20 });
  assert.equal(added.added, 20);
  assert.equal(statsLib.dayTotal(added.stats, '2026-10-30'), 100);

  const noChange = statsLib.recordChars(added.stats, { day: '2026-10-30', bookId: 'bookA', delta: 0 });
  assert.equal(noChange.added, 0);
  assert.equal(statsLib.dayTotal(noChange.stats, '2026-10-30'), 100);

  const shrunk = statsLib.recordChars(added.stats, { day: '2026-10-30', bookId: 'bookA', delta: -50 });
  assert.equal(shrunk.added, 0);
  assert.equal(statsLib.dayTotal(shrunk.stats, '2026-10-30'), 100);

  const bad = statsLib.recordChars(added.stats, { day: '2026-10-30', bookId: 'bookA', delta: 'abc' });
  assert.equal(bad.added, 0);
});

test('每日统计：recordChars 按书分桶、同日累加、空 id 进 _unknown、非法日期落到今天', () => {
  const today = statsLib.localDayKey();
  const first = statsLib.recordChars(statsWith({}), { day: '2026-10-31', bookId: 'bookA', delta: 30 });
  const second = statsLib.recordChars(first.stats, { day: '2026-10-31', bookId: 'bookB', delta: 12 });
  const third = statsLib.recordChars(second.stats, { day: '2026-10-31', bookId: '', delta: 8 });
  assert.equal(third.stats.days['2026-10-31'].books.bookA, 30);
  assert.equal(third.stats.days['2026-10-31'].books.bookB, 12);
  assert.equal(third.stats.days['2026-10-31'].books._unknown, 8);
  assert.equal(statsLib.dayTotal(third.stats, '2026-10-31'), 50);

  const fallback = statsLib.recordChars(statsWith({}), { day: '2026-02-30', bookId: 'bookA', delta: 9 });
  assert.equal(fallback.day, today);
  assert.equal(statsLib.dayTotal(fallback.stats, today), 9);
});

test('每日统计：recordChars 清理早于 400 天窗口的日期，保留边界内的', () => {
  const base = statsWith({
    '2025-01-01': { books: { bookA: 1 } },
    '2025-12-01': { books: { bookA: 2 } },
    '2026-10-30': { books: { bookA: 3 } }
  });
  const res = statsLib.recordChars(base, { day: '2026-10-31', bookId: 'bookA', delta: 10 });
  assert.equal(res.stats.days['2025-01-01'], undefined, '早于保留窗口的日期被清理');
  assert.equal(res.stats.days['2025-12-01'].books.bookA, 2, '窗口内的旧日期保留');
  assert.equal(res.stats.days['2026-10-30'].books.bookA, 3);
  assert.equal(statsLib.dayTotal(res.stats, '2026-10-31'), 10);
});

test('每日统计：recentDays 从最早到今天连续补 0，日期错误也能安全兜底', () => {
  const stats = statsWith({
    '2026-10-31': { books: { bookA: 120 } },
    '2026-10-29': { books: { bookA: 30 } }
  });
  const days = statsLib.recentDays(stats, new Date(2026, 9, 31, 12), 4);
  assert.deepEqual(days, [
    { day: '2026-10-28', chars: 0 },
    { day: '2026-10-29', chars: 30 },
    { day: '2026-10-30', chars: 0 },
    { day: '2026-10-31', chars: 120 }
  ]);
  assert.equal(statsLib.recentDays(stats, '2026-10-31', 2).length, 2);
  assert.equal(statsLib.recentDays(stats, new Date(2026, 9, 31, 12), 0).length, 1, '天数至少 1');
});

test('每日统计：summary 给出今天/目标/完成度/近 30 天', () => {
  const stats = statsWith({
    '2026-10-31': { books: { bookA: 500, bookB: 500 } },
    '2026-10-30': { books: { bookA: 200 } },
    '2026-09-01': { books: { bookA: 7 } }
  });
  const plain = statsLib.summary(stats, { now: new Date(2026, 9, 31, 12), goal: 0 });
  assert.equal(plain.day, '2026-10-31');
  assert.equal(plain.todayChars, 1000);
  assert.equal(plain.goal, 0);
  assert.equal(plain.goalPercent, 0);
  assert.equal(plain.goalMet, false);
  assert.equal(plain.days.length, 30);
  assert.equal(plain.days[29].day, '2026-10-31');
  assert.equal(plain.days[29].chars, 1000);
  assert.equal(plain.recentTotal, 1200, '近 30 天不含 9 月 1 日');

  const half = statsLib.summary(stats, { now: new Date(2026, 9, 31, 12), goal: 2000 });
  assert.equal(half.goalPercent, 50);
  assert.equal(half.goalMet, false);

  const met = statsLib.summary(stats, { now: new Date(2026, 9, 31, 12), goal: 800 });
  assert.equal(met.goalPercent, 100);
  assert.equal(met.goalMet, true);
});

// 旧实现（审计 F4 之前）：recentDays 逐天调 dayTotal，dayTotal 每次都 sanitize 整份统计。
// 这里按旧口径独立算一遍，用来证明新实现结果完全一致。
function legacyRecentDays(rawStats, now, count) {
  const anchor = statsLib.localDayKey(now);
  const out = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const key = statsLib.shiftDayKey(anchor, -offset);
    out.push({ day: key, chars: statsLib.dayTotal(rawStats, key) });
  }
  return out;
}

test('每日统计：recentDays 与旧实现逐项一致（缺日补 0 / 坏数据清洗 / 多书求和）', () => {
  const raw = statsWith({
    '2026-10-31': { books: { bookA: 120, bookB: 80 }, seconds: 90 },
    '2026-10-30': '坏条目',
    '2026-10-29': { books: { bookA: 30, bad: -5, zero: 0 } },
    '2026-10-25': { seconds: 300 }, // 只有时长、没有字数
    '2026-10-24': { books: { bookA: 7 } },
    '2026-02-30': { books: { ghost: 1 } }, // 不存在的日期
    不是日期: { books: { ghost: 1 } }
  });
  const now = new Date(2026, 9, 31, 12);
  for (const count of [1, 7, 30]) {
    assert.deepEqual(
      statsLib.recentDays(raw, now, count),
      legacyRecentDays(raw, now, count),
      `近 ${count} 天应与旧实现逐项一致`
    );
  }
  const week = statsLib.recentDays(raw, now, 7);
  assert.deepEqual(
    week.find((item) => item.day === '2026-10-29'),
    { day: '2026-10-29', chars: 30 }
  );
  assert.equal(week.find((item) => item.day === '2026-10-28').chars, 0);
  assert.equal(week.find((item) => item.day === '2026-10-25').chars, 0, '只有时长的日子字数仍是 0');
});

test('每日统计：summary 与旧实现逐字段一致（含今日 / 目标 / 近 N 天 / 时长）', () => {
  const raw = statsWith({
    '2026-10-31': { books: { bookA: 500, bookB: 500 }, seconds: 90 },
    '2026-10-30': { books: { bookA: 200 }, seconds: 600 },
    '2026-10-29': { seconds: 30 },
    '2026-09-01': { books: { bookA: 7 }, seconds: 9999 }
  });
  const now = new Date(2026, 9, 31, 12);
  const recent = legacyRecentDays(raw, now, 7);
  const todayChars = statsLib.dayTotal(raw, '2026-10-31');
  const todaySeconds = statsLib.daySeconds(raw, '2026-10-31');
  const recentTotal = recent.reduce((sum, item) => sum + item.chars, 0);
  const recentSeconds = recent.reduce((sum, item) => sum + statsLib.daySeconds(raw, item.day), 0);
  assert.deepEqual(statsLib.summary(raw, { now, goal: 2000, days: 7 }), {
    day: '2026-10-31',
    todayChars,
    todaySeconds,
    goal: 2000,
    goalPercent: 50,
    goalMet: false,
    recentTotal,
    recentSeconds,
    days: recent
  });

  // days 参数同样走 clamp：0 → 1 天，和旧实现一致
  assert.deepEqual(statsLib.summary(raw, { now, days: 0 }).days, legacyRecentDays(raw, now, 1));
});

test('每日统计：recentDays / summary 只清洗一次统计（不再逐天 dayTotal）', () => {
  const days = {};
  for (let offset = 0; offset < 30; offset += 1) {
    days[statsLib.shiftDayKey('2026-10-31', -offset)] = { books: { a: offset + 1 }, seconds: 5 };
  }
  let reads = 0;
  const raw = {
    version: 1,
    get days() {
      reads += 1;
      return days;
    }
  };
  reads = 0;
  const recent = statsLib.recentDays(raw, new Date(2026, 9, 31, 12), 30);
  assert.equal(recent.length, 30);
  assert.equal(recent[29].chars, 1);
  assert.ok(reads <= 10, `recentDays 应只读一次 days（实际 ${reads} 次；旧实现约 120 次）`);

  reads = 0;
  const result = statsLib.summary(raw, { now: new Date(2026, 9, 31, 12), days: 30 });
  assert.equal(result.todayChars, 1);
  assert.equal(result.recentTotal, 465); // 1 + 2 + … + 30
  assert.ok(reads <= 10, `summary 应只读一次 days（实际 ${reads} 次；旧实现约 120 次）`);
});

test('每日统计：存储缺文件 = 空统计，记录后原子落盘并可跨实例读回', async () => {
  const dir = await mkTmp();
  const store = statsLib.createStatsStore(dir);
  assert.equal(store.file, path.join(dir, 'stats.json'));
  const empty = await store.summary({ now: new Date(2026, 9, 31, 12), goal: 0 });
  assert.equal(empty.todayChars, 0);
  assert.equal(empty.days.length, 30);

  const rec = await store.record({ day: '2026-10-31', bookId: 'bookA', delta: 123 });
  assert.equal(rec.added, 123);
  const disk = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(disk.days['2026-10-31'].books.bookA, 123);
  assert.equal(disk.version, 1);

  const store2 = statsLib.createStatsStore(dir);
  const summary = await store2.summary({ now: new Date(2026, 9, 31, 12), goal: 500 });
  assert.equal(summary.todayChars, 123);
  assert.equal(summary.goalPercent, 24);
  await assert.rejects(fs.stat(path.join(dir, 'config.json')), /ENOENT/);
});

test('每日统计：并发保存串行合并，不丢增量', async () => {
  const dir = await mkTmp();
  const store = statsLib.createStatsStore(dir);
  await Promise.all(
    Array.from({ length: 20 }, () => store.record({ day: '2026-10-31', bookId: 'bookA', delta: 10 }))
  );
  const summary = await store.summary({ now: new Date(2026, 9, 31, 12) });
  assert.equal(summary.todayChars, 200);
  const disk = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(disk.days['2026-10-31'].books.bookA, 200);
});

test('每日统计：坏文件归档后从空统计继续，不影响后续记录', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'stats.json'), '{ 坏掉的统计', 'utf8');
  const store = statsLib.createStatsStore(dir);
  const summary = await store.summary({ now: new Date(2026, 9, 31, 12) });
  assert.equal(summary.todayChars, 0);
  const files = await fs.readdir(dir);
  assert.ok(files.some((name) => name.startsWith('stats.json.corrupt-')), '坏文件被归档而不是直接删掉');

  await store.record({ day: '2026-10-31', bookId: 'bookA', delta: 5 });
  const after = await store.summary({ now: new Date(2026, 9, 31, 12) });
  assert.equal(after.todayChars, 5);
});

test('每日统计：统计写盘失败时抛错且内存不前进（主进程捕获后不阻塞保存）', async () => {
  const dir = await mkTmp();
  const store = statsLib.createStatsStore(dir);
  await store.record({ day: '2026-10-31', bookId: 'bookA', delta: 5 });
  // 用一个同名目录占住 stats.json，让原子写的 rename 必然失败
  await fs.rm(store.file, { recursive: true, force: true });
  await fs.mkdir(store.file, { recursive: true });
  await assert.rejects(store.record({ day: '2026-10-31', bookId: 'bookA', delta: 10 }));
  const kept = await store.get();
  assert.equal(statsLib.dayTotal(kept, '2026-10-31'), 5, '写盘失败时内存统计不前进，下次成功保存会重新带上增量');
  await fs.rm(store.file, { recursive: true, force: true });
  const recovered = await store.record({ day: '2026-10-31', bookId: 'bookA', delta: 10 });
  assert.equal(recovered.added, 10);
  assert.equal(statsLib.dayTotal(await store.get(), '2026-10-31'), 15);
});

test('每日统计：文件里已有的脏数据读取时清洗，不抛错', async () => {
  const dir = await mkTmp();
  await fs.writeFile(
    path.join(dir, 'stats.json'),
    JSON.stringify({
      version: 1,
      days: {
        '2026-10-31': { books: { ok: 12, bad: -1, zero: 0 } },
        '2026-99-99': { books: { x: 10 } }
      }
    }),
    'utf8'
  );
  const store = statsLib.createStatsStore(dir);
  const summary = await store.summary({ now: new Date(2026, 9, 31, 12) });
  assert.equal(summary.todayChars, 12);
  const clean = await store.get();
  assert.deepEqual(clean.days, { '2026-10-31': { books: { ok: 12 } } }, '读取时清洗掉坏日期与坏数值');
  // 下次有真正的新增量时才写盘，写下去的是清洗后的形状
  await store.record({ day: '2026-10-31', bookId: 'ok', delta: 1 });
  const disk = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(disk.days['2026-99-99'], undefined);
  assert.equal(disk.days['2026-10-31'].books.ok, 13);
});

// ---------- 码字日历 / 连续写作天数 / 月度汇总（v0.8-1，提案 N1） ----------

test('码字日历：月视图按周一起始，汇总每日字数 / 达标 / 最高一天', () => {
  const stats = statsWith({
    '2026-11-01': { books: { a: 60, b: 40 } },
    '2026-11-02': { books: { a: 50 } },
    '2026-11-05': { books: { a: 200 } },
    '2026-10-31': { books: { a: 999 } },
    '2026-12-01': { books: { a: 888 } }
  });
  const before = JSON.stringify(stats);
  const view = statsLib.monthView(stats, {
    year: 2026,
    month: 11,
    now: new Date(2026, 10, 3, 9, 0),
    goal: 100
  });
  assert.equal(view.label, '2026年11月');
  assert.equal(view.year, 2026);
  assert.equal(view.month, 11);
  assert.equal(view.days.length, 30);
  assert.equal(view.firstWeekday, 6, '2026-11-01 是周日，周一起始偏移 6');
  assert.deepEqual(view.weekdayLabels, ['一', '二', '三', '四', '五', '六', '日']);
  assert.equal(view.today, '2026-11-03');
  assert.equal(view.isCurrentMonth, true);
  assert.equal(view.total, 350);
  assert.equal(view.writtenDays, 3);
  assert.equal(view.goalDays, 2);
  assert.equal(view.average, 117);
  assert.deepEqual(view.bestDay, { day: '2026-11-05', chars: 200 });

  const day1 = view.days[0];
  assert.deepEqual(
    { day: day1.day, chars: day1.chars, written: day1.written, goalMet: day1.goalMet, level: day1.level, today: day1.today, future: day1.future },
    { day: '2026-11-01', chars: 100, written: true, goalMet: true, level: 4, today: false, future: false }
  );
  const day2 = view.days[1];
  assert.equal(day2.goalMet, false);
  assert.equal(day2.level, 2, '50 / 目标 100 落在色阶 2');
  assert.equal(view.days[2].level, 0);
  assert.equal(view.days[2].today, true);
  assert.equal(view.days[3].future, true, '今天之后的日期标 future');
  assert.equal(view.days[4].level, 4, '超过目标也是满格');
  assert.equal(JSON.stringify(stats), before, '月视图只读，不改原统计');
});

test('码字日历：非法年月回落当前月；闰年 / 平年天数与未来月标记正确', () => {
  const now = new Date(2026, 10, 3, 9, 0);
  const fallback = statsLib.monthView(statsWith({}), { year: 'x', month: 0, now });
  assert.equal(fallback.year, 2026);
  assert.equal(fallback.month, 11);
  assert.equal(fallback.isCurrentMonth, true);

  const feb2024 = statsLib.monthView(statsWith({}), { year: 2024, month: 2, now });
  assert.equal(feb2024.days.length, 29, '2024 年 2 月有 29 天');
  assert.equal(feb2024.firstWeekday, 3, '2024-02-01 是周四，周一起始偏移 3');
  const feb2026 = statsLib.monthView(statsWith({}), { year: 2026, month: 2, now });
  assert.equal(feb2026.days.length, 28);
  assert.equal(feb2026.firstWeekday, 6, '2026-02-01 是周日');
  assert.equal(feb2026.isCurrentMonth, false);

  const future = statsLib.monthView(statsWith({}), { year: 2026, month: 12, now });
  assert.ok(future.days.every((day) => day.future === true), '未来月的每一天都标 future');
  const past = statsLib.monthView(statsWith({ '2026-10-01': { books: { a: 7 } } }), { year: 2026, month: 10, now });
  assert.equal(past.days[0].future, false, '过去月不标 future');
  assert.equal(past.total, 7);
});

test('码字日历：没设目标时色阶按当月最高一天分 1–4 级', () => {
  assert.equal(statsLib.calendarLevel(0, { goal: 0, maxChars: 100 }), 0);
  assert.equal(statsLib.calendarLevel(1, { goal: 0, maxChars: 200 }), 1);
  assert.equal(statsLib.calendarLevel(100, { goal: 0, maxChars: 200 }), 2);
  assert.equal(statsLib.calendarLevel(150, { goal: 0, maxChars: 200 }), 3);
  assert.equal(statsLib.calendarLevel(200, { goal: 0, maxChars: 200 }), 4);
  assert.equal(statsLib.calendarLevel(80, { goal: 100 }), 3);
  assert.equal(statsLib.calendarLevel(100, { goal: 100 }), 4);
});

test('连续写作天数：今天写了从今天往前数；今天没写从昨天往前数（当天结束前不算断）', () => {
  const stats = statsWith({
    '2026-10-28': { books: { a: 10 } },
    '2026-10-29': { books: { a: 20 } },
    '2026-10-30': { books: { a: 30 } },
    '2026-10-31': { books: { a: 40 } },
    '2026-11-01': { books: { a: 50 } }
  });
  const onLastDay = statsLib.streak(stats, { now: new Date(2026, 10, 1, 23, 0) });
  assert.deepEqual(onLastDay, {
    current: 5,
    best: 5,
    todayWritten: true,
    lastWritten: '2026-11-01',
    writtenDays: 5
  });

  const nextDay = statsLib.streak(stats, { now: new Date(2026, 10, 2, 9, 0) });
  assert.equal(nextDay.current, 5, '新的一天还没写时连续天数保留到当天结束');
  assert.equal(nextDay.todayWritten, false);
  assert.equal(nextDay.lastWritten, '2026-11-01');

  const missedDay = statsLib.streak(stats, { now: new Date(2026, 10, 3, 9, 0) });
  assert.equal(missedDay.current, 0, '昨天没写，连续中断');
});

test('连续写作天数：最长连续按历史算，断档 / 未来日期 / 空统计都安全', () => {
  const stats = statsWith({
    '2026-10-01': { books: { a: 1 } },
    '2026-10-03': { books: { a: 1 } },
    '2026-10-04': { books: { a: 1 } },
    '2026-10-05': { books: { a: 1 } },
    '2026-10-20': { books: { a: 1 } },
    '2026-11-06': { books: { a: 1 } }
  });
  const now = new Date(2026, 9, 5, 12, 0);
  const result = statsLib.streak(stats, { now });
  assert.equal(result.current, 3, '10-03 ~ 10-05 连续三天，今天 10-05 已写');
  assert.equal(result.best, 3);
  assert.equal(result.writtenDays, 4, '未来的 10-20 / 11-06 不计入');
  assert.equal(result.lastWritten, '2026-10-05', '最后写作日不取未来日期');

  const empty = statsLib.streak(statsWith({}), { now });
  assert.deepEqual(empty, {
    current: 0,
    best: 0,
    todayWritten: false,
    lastWritten: null,
    writtenDays: 0
  });
});

// ---------- 写作时长统计（v0.8-2，提案 N2） ----------

test('写作时长：清洗只认正整秒，坏值丢弃，单日夹到 24 小时，旧数据没有 seconds 照常读', () => {
  const cleaned = statsLib.sanitizeStats({
    version: 1,
    days: {
      '2026-11-01': { books: { a: 100 }, seconds: 125 },
      '2026-11-02': { seconds: 90 }, // 只有时长、没有新字数
      '2026-11-03': { books: { a: 10 }, seconds: -5 },
      '2026-11-04': { books: { a: 10 }, seconds: 'abc' },
      '2026-11-05': { books: { a: 10 }, seconds: 1e9 },
      '2026-11-06': { books: {}, seconds: 30.6 },
      '2026-11-07': { books: {}, seconds: 0 },
      '2026-11-08': { books: { a: 1 } }
    }
  });
  assert.deepEqual(Object.keys(cleaned.days).sort(), [
    '2026-11-01',
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-08'
  ]);
  assert.deepEqual(cleaned.days['2026-11-01'], { books: { a: 100 }, seconds: 125 });
  assert.deepEqual(cleaned.days['2026-11-02'], { seconds: 90 }, '只有时长的日子也要留住');
  assert.equal(cleaned.days['2026-11-03'].seconds, undefined, '负数不记');
  assert.equal(cleaned.days['2026-11-04'].seconds, undefined, '坏字符串不记');
  assert.equal(cleaned.days['2026-11-05'].seconds, statsLib.MAX_DAY_SECONDS, '超大夹到单日上限');
  assert.equal(cleaned.days['2026-11-06'].seconds, 31, '四舍五入到整秒');
  assert.equal(cleaned.days['2026-11-07'], undefined);
  assert.deepEqual(cleaned.days['2026-11-08'], { books: { a: 1 } }, '旧数据没有 seconds = 时长 0，不影响字数');

  assert.equal(statsLib.sanitizeDuration(-1), 0);
  assert.equal(statsLib.sanitizeDuration(59.6), 60);
  assert.equal(statsLib.sanitizeDuration(statsLib.MAX_DAY_SECONDS + 100), statsLib.MAX_DAY_SECONDS);
  assert.equal(statsLib.sanitizeDuration('90'), 90);
  assert.equal(statsLib.sanitizeDuration(Number.NaN), 0);
  assert.equal(statsLib.daySeconds(cleaned, '2026-11-02'), 90);
  assert.equal(statsLib.daySeconds(cleaned, '2026-11-03'), 0);
  assert.equal(statsLib.daySeconds(null, '2026-11-02'), 0);
});

test('写作时长：recordDuration 按天累计、不碰字数，字数和时长互不覆盖', () => {
  const base = statsWith({ '2026-11-01': { books: { a: 100 } } });
  const d1 = statsLib.recordDuration(base, { day: '2026-11-01', seconds: 65 });
  assert.equal(d1.added, 65);
  assert.deepEqual(d1.stats.days['2026-11-01'], { books: { a: 100 }, seconds: 65 });
  assert.equal(statsLib.daySeconds(d1.stats, '2026-11-01'), 65);
  assert.equal(statsLib.dayTotal(d1.stats, '2026-11-01'), 100, '时长不影响字数');

  const d2 = statsLib.recordDuration(d1.stats, { day: '2026-11-01', seconds: 30 });
  assert.equal(d2.added, 30);
  assert.equal(statsLib.daySeconds(d2.stats, '2026-11-01'), 95);

  // 只有时长的那天：再加字数也不丢时长
  const onlyTime = statsLib.recordDuration(statsWith({}), { day: '2026-11-02', seconds: 45 });
  assert.equal(onlyTime.stats.days['2026-11-02'].seconds, 45);
  const withChars = statsLib.recordChars(onlyTime.stats, { day: '2026-11-02', bookId: 'b', delta: 12 });
  assert.deepEqual(withChars.stats.days['2026-11-02'], { seconds: 45, books: { b: 12 } });
  assert.equal(statsLib.daySeconds(withChars.stats, '2026-11-02'), 45);

  // 坏值 / 0 / 负数都不计数
  assert.equal(statsLib.recordDuration(withChars.stats, { day: '2026-11-02', seconds: 0 }).added, 0);
  assert.equal(statsLib.recordDuration(withChars.stats, { day: '2026-11-02', seconds: 'abc' }).added, 0);
  assert.equal(statsLib.recordDuration(withChars.stats, { day: '2026-11-02', seconds: -10 }).added, 0);
  assert.equal(statsLib.daySeconds(withChars.stats, '2026-11-02'), 45, '坏值不会改已有记录');

  // 非法日期落到今天
  const today = statsLib.localDayKey();
  const fallback = statsLib.recordDuration(statsWith({}), { day: '2026-02-30', seconds: 7 });
  assert.equal(fallback.day, today);
  assert.equal(statsLib.daySeconds(fallback.stats, today), 7);
});

test('写作时长：单日超过 24 小时夹住，added 只算真正记下的部分', () => {
  const full = statsWith({ '2026-11-01': { books: { a: 1 }, seconds: statsLib.MAX_DAY_SECONDS } });
  const res = statsLib.recordDuration(full, { day: '2026-11-01', seconds: 100 });
  assert.equal(res.added, 0);
  assert.equal(res.stats.days['2026-11-01'].seconds, statsLib.MAX_DAY_SECONDS);

  const near = statsWith({ '2026-11-01': { books: { a: 1 }, seconds: statsLib.MAX_DAY_SECONDS - 10 } });
  const add = statsLib.recordDuration(near, { day: '2026-11-01', seconds: 100 });
  assert.equal(add.added, 10, '只记下剩余容量');
});

test('写作时长：summary 给出今天 / 近 30 天秒数，monthView 给出每天秒数与月度合计', () => {
  const stats = statsWith({
    '2026-10-30': { books: { a: 100 }, seconds: 600 },
    '2026-10-31': { books: { a: 50 }, seconds: 90 },
    '2026-11-01': { books: { a: 20 } },
    '2026-09-01': { books: { a: 1 }, seconds: 9999 }
  });
  const summary = statsLib.summary(stats, { now: new Date(2026, 9, 31, 12) });
  assert.equal(summary.todayChars, 50);
  assert.equal(summary.todaySeconds, 90);
  assert.equal(summary.recentSeconds, 690, '9 月 1 日在 30 天窗口外');
  assert.equal(summary.days.length, 30);

  const view = statsLib.monthView(stats, { year: 2026, month: 10, now: new Date(2026, 9, 31, 12) });
  assert.equal(view.totalSeconds, 690);
  assert.equal(view.total, 150);
  assert.equal(view.days.find((day) => day.day === '2026-10-30').seconds, 600);
  assert.equal(view.days.find((day) => day.day === '2026-10-25').seconds, 0);

  // 只有时长、没有字数的日子：不计写字天数，但计入月度时长
  const durationOnly = statsLib.monthView(statsWith({ '2026-10-05': { seconds: 300 } }), {
    year: 2026,
    month: 10,
    now: new Date(2026, 9, 31, 12)
  });
  assert.equal(durationOnly.writtenDays, 0);
  assert.equal(durationOnly.totalSeconds, 300);
  assert.equal(durationOnly.days.find((day) => day.day === '2026-10-05').seconds, 300);
});

test('写作时长：存储 addDuration 原子落盘、与字数共用文件、并发合并且不丢秒', async () => {
  const dir = await mkTmp();
  const store = statsLib.createStatsStore(dir);
  const rec = await store.addDuration({ day: '2026-10-31', seconds: 61 });
  assert.equal(rec.added, 61);
  assert.equal(rec.day, '2026-10-31');
  const disk = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(disk.days['2026-10-31'].seconds, 61);
  assert.equal(disk.version, 1);

  await store.record({ day: '2026-10-31', bookId: 'bookA', delta: 5 });
  const both = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(both.days['2026-10-31'].seconds, 61, '保存字数不会冲掉时长');
  assert.equal(both.days['2026-10-31'].books.bookA, 5, '记录时长也不冲掉字数');

  await Promise.all(Array.from({ length: 10 }, () => store.addDuration({ day: '2026-10-31', seconds: 6 })));
  const finalDisk = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(finalDisk.days['2026-10-31'].seconds, 121, '并发上报串行合并，不丢秒数');
  const summary = await store.summary({ now: new Date(2026, 9, 31, 12) });
  assert.equal(summary.todaySeconds, 121);
  assert.equal(summary.todayChars, 5);
  await assert.rejects(fs.stat(path.join(dir, 'config.json')), /ENOENT/, '时长只写 stats.json，不写配置');

  // 坏文件归档后从空统计继续（和字数一样，不影响正文）
  const dir2 = await mkTmp();
  await fs.writeFile(path.join(dir2, 'stats.json'), '{ 坏掉的统计', 'utf8');
  const store2 = statsLib.createStatsStore(dir2);
  assert.equal((await store2.summary({ now: new Date(2026, 9, 31, 12) })).todaySeconds, 0);
  assert.equal((await store2.addDuration({ day: '2026-10-31', seconds: 8 })).added, 8);
});
