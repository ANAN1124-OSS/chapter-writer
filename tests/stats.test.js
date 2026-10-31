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
