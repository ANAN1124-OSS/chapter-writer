// E2E 专用：预置跨天写作统计，用来验证「码字日历 / 连续写作天数 / 月度汇总」。
//
// 只往临时 userData 的 stats.json 里写种子数据（run-e2e.js 在启动应用前写一次），
// 不碰真实配置、不碰书库、不产生任何书内文件。
// 日期全部按运行时本机日期算：种子月 = 两个月前（避开「今天 / 近 30 天」的既有断言），
// 昨天固定 150 字，用来验证「今天还没写时连续天数不中断 / 今天写了变 2 天」。
const statsLib = require('../core/stats');

const SEED_BOOK_ID = 'e2e-stats-seed';
const MONTH_OFFSET = -2;
const SEED_DAYS_OF_MONTH = [5, 6, 7];
const SEED_CHARS = [120, 80, 200];
const YESTERDAY_CHARS = 150;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildSeed(now = new Date()) {
  const todayKey = statsLib.localDayKey(now);
  const today = statsLib.parseDayKey(todayKey);
  // 两个月前的 1 号中午（避免夏令时 / 月末边界）。
  const target = new Date(today.year, today.month - 1 + MONTH_OFFSET, 1, 12, 0, 0, 0);
  const seedYear = target.getFullYear();
  const seedMonth = target.getMonth() + 1;
  const days = {};
  const seedDays = [];

  SEED_DAYS_OF_MONTH.forEach((dayOfMonth, index) => {
    const date = new Date(seedYear, seedMonth - 1, dayOfMonth, 12, 0, 0, 0);
    const day = statsLib.localDayKey(date);
    const chars = SEED_CHARS[index];
    days[day] = { books: { [SEED_BOOK_ID]: chars } };
    seedDays.push({ day, chars });
  });

  const yesterdayKey = statsLib.shiftDayKey(todayKey, -1);
  days[yesterdayKey] = { books: { [SEED_BOOK_ID]: YESTERDAY_CHARS } };

  const monthTotal = seedDays.reduce((sum, item) => sum + item.chars, 0);
  const best = seedDays.reduce((top, item) => (item.chars > top.chars ? item : top), seedDays[0]);

  return {
    stats: { version: 1, days },
    todayKey,
    seedYear,
    seedMonth,
    seedMonthLabel: `${seedYear}年${seedMonth}月`,
    seedPrefix: `${seedYear}-${pad2(seedMonth)}-`,
    seedDays,
    monthTotal,
    monthWrittenDays: seedDays.length,
    monthAverage: Math.round(monthTotal / seedDays.length),
    monthBestDay: best.day,
    monthBestChars: best.chars,
    yesterdayKey,
    yesterdayChars: YESTERDAY_CHARS,
    bestStreak: seedDays.length
  };
}

module.exports = { buildSeed, SEED_BOOK_ID };
