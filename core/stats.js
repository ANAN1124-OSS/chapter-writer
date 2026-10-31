// 每日字数统计 + 写作目标：纯逻辑 + 独立存储（userData/stats.json）。
//
// 设计约束（来自提案 3.2 与项目红线）：
// - 只统计「保存」动作带来的正字数增量，不做自动保存、不读正文以外的东西；
// - 统计文件放在应用配置目录，绝不写进书库 / 书目.json / 章节 txt；
// - 旧配置没有 dailyGoal 也照常启动（0 = 不设目标）；
// - 日期一律用本机时区的「YYYY-MM-DD」，近 30 天柱子按本地日期连续补零。
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic, stripBom } = require('./atomic');

const STATS_VERSION = 1;
const DEFAULT_GOAL = 0;
const MAX_GOAL = 1000000;
const DEFAULT_RECENT_DAYS = 30;
const MAX_RECENT_DAYS = 400;
// 文件里最多留 400 天：近 30 天图和「今年」都够用，又不会无限长。
const KEEP_DAYS = 400;
const MAX_DAYS = 500;
const MAX_DAY_CHARS = 100000000;
// 写作时长（v0.8-2）：一天最多记 24 小时，坏数据 / 手改文件都夹住。
// 只记秒数，不记正文、不记按键；单位是秒，按天汇总（不按书分桶）。
const MAX_DAY_SECONDS = 86400;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 码字日历固定周一起始（和国内日历 / 口袋写作习惯一致）。
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 本机时区的日期键。已经是合法 YYYY-MM-DD 的原样返回（避免被当成 UTC 解析而差一天），
// 非法 Date / 坏字符串退回「现在」，保证永远返回可读字符串。
function localDayKey(date = new Date()) {
  if (typeof date === 'string' && isValidDayKey(date)) return date.trim();
  const d = date instanceof Date ? date : new Date(date);
  const safe = d instanceof Date && Number.isFinite(d.getTime()) ? d : new Date();
  return `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}`;
}

// 严格解析：格式必须 YYYY-MM-DD，而且必须是真实存在的本地日期（2026-02-30 不算）。
function parseDayKey(key) {
  if (typeof key !== 'string') return null;
  const match = DAY_RE.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day };
}

function isValidDayKey(key) {
  return Boolean(parseDayKey(key));
}

// 从某一天按本地日历加减天数（用中午 12 点构造，避开夏令时/时区边界）。
function shiftDayKey(key, deltaDays) {
  const parsed = isValidDayKey(key) ? parseDayKey(key) : parseDayKey(localDayKey());
  const date = new Date(parsed.year, parsed.month - 1, parsed.day, 12, 0, 0, 0);
  date.setDate(date.getDate() + Math.round(Number(deltaDays) || 0));
  return localDayKey(date);
}

function normalizeGoal(value, fallback = DEFAULT_GOAL) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_GOAL, Math.max(0, Math.round(n)));
}

function clampRecentDays(value, fallback = DEFAULT_RECENT_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RECENT_DAYS, Math.max(1, Math.round(n)));
}

function sanitizeBookId(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (!id) return '_unknown';
  return id.slice(0, 200);
}

// 写作时长清洗：只认有限数，四舍五入到整秒，负数 / NaN / 坏字符串一律 0，
// 超过 24 小时夹到上限。旧 stats.json 没有这个字段 = 0。
function sanitizeDuration(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DAY_SECONDS, n);
}

function secondsOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  return sanitizeDuration(entry.seconds);
}

function emptyStats() {
  return { version: STATS_VERSION, days: {} };
}

// 读取时清洗：坏日期 / 坏条目 / 负数 / 超大数全部丢弃或夹住；不抛错。
function sanitizeStats(raw) {
  const out = emptyStats();
  const rawDays =
    raw && typeof raw === 'object' && !Array.isArray(raw) && raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)
      ? raw.days
      : {};
  // ISO 日期键按字符串排序就是时间顺序；只留最近的 MAX_DAYS 天，避免超大文件。
  const keys = Object.keys(rawDays).filter(isValidDayKey).sort();
  const keep = keys.slice(-MAX_DAYS);
  for (const key of keep) {
    const entry = rawDays[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rawBooks =
      entry.books && typeof entry.books === 'object' && !Array.isArray(entry.books) ? entry.books : {};
    const books = {};
    for (const [rawId, rawValue] of Object.entries(rawBooks)) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id || id.length > 200) continue;
      const n = Math.round(Number(rawValue));
      if (!Number.isFinite(n) || n <= 0) continue;
      books[id] = Math.min(MAX_DAY_CHARS, n);
    }
    const seconds = sanitizeDuration(entry.seconds);
    // 旧数据只有 books；开着写作时长后，某天可能只有时长没有新字数（只计时 / 只读），
    // 这种「只有 seconds」的日子也要留住，否则月视图会少一天时长。
    if (!Object.keys(books).length && seconds <= 0) continue;
    const clean = {};
    if (Object.keys(books).length) clean.books = books;
    if (seconds > 0) clean.seconds = seconds;
    out.days[key] = clean;
  }
  return out;
}

function dayTotal(rawStats, day) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  const entry = stats.days[key];
  if (!entry) return 0;
  let total = 0;
  for (const value of Object.values(entry.books || {})) total += value;
  return total;
}

// 某一天的写作时长（秒）；没有记录 = 0。旧 stats.json 没有 seconds 字段也算 0。
function daySeconds(rawStats, day) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  return secondsOfEntry(stats.days[key]);
}

// 内部用：已经 sanitize 过的统计，直接取某天合计，避免 monthView 里逐天重复清洗。
function totalOfEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.books) return 0;
  let total = 0;
  for (const value of Object.values(entry.books)) total += value;
  return total;
}

// 年月归一：非法 / 越界一律退回 now 所在的本地年月（渲染层传坏值也不会让日历空掉）。
function normalizeMonth(year, month, now = new Date()) {
  const anchor = parseDayKey(localDayKey(now));
  const y = Number(year);
  const m = Number(month);
  if (Number.isInteger(y) && y >= 1970 && y <= 9999 && Number.isInteger(m) && m >= 1 && m <= 12) {
    return { year: y, month: m };
  }
  return { year: anchor.year, month: anchor.month };
}

function daysInMonth(year, month) {
  const { year: y, month: m } = normalizeMonth(year, month);
  return new Date(y, m, 0, 12, 0, 0, 0).getDate();
}

// 一周从周一开始：0 = 周一 … 6 = 周日。
function mondayWeekday(year, month, dayOfMonth = 1) {
  return (new Date(year, month - 1, dayOfMonth, 12, 0, 0, 0).getDay() + 6) % 7;
}

// 码字日历色阶：0 = 没写；设了目标时「达标」= 4，未达标最高 3；没设目标按当月最高一天分 1–4。
function calendarLevel(chars, { goal = 0, maxChars = 0 } = {}) {
  const value = Math.max(0, Math.round(Number(chars) || 0));
  if (value <= 0) return 0;
  if (goal > 0) {
    if (value >= goal) return 4;
    return Math.max(1, Math.min(3, Math.ceil((value / goal) * 3)));
  }
  const max = Math.max(1, Math.round(Number(maxChars) || 0));
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
}

// 某个月的码字日历视图：每天的字数 / 是否达标 / 色阶 + 月度汇总。
// 只读；日期一律按本机本地日期，未来日期标 future（界面淡显，不参与「今天」）。
function monthView(rawStats, { year, month, now = new Date(), goal = DEFAULT_GOAL } = {}) {
  const stats = sanitizeStats(rawStats);
  const anchor = localDayKey(now);
  const normalized = normalizeMonth(year, month, now);
  const targetYear = normalized.year;
  const targetMonth = normalized.month;
  const dailyGoal = normalizeGoal(goal);
  const anchorParts = parseDayKey(anchor);
  const count = daysInMonth(targetYear, targetMonth);
  const pad = (n) => String(n).padStart(2, '0');
  const days = [];
  let total = 0;
  let totalSeconds = 0;
  let writtenDays = 0;
  let goalDays = 0;
  let maxChars = 0;
  let bestDay = null;

  for (let dayOfMonth = 1; dayOfMonth <= count; dayOfMonth += 1) {
    const day = `${targetYear}-${pad(targetMonth)}-${pad(dayOfMonth)}`;
    const entry = stats.days[day];
    const chars = totalOfEntry(entry);
    const seconds = secondsOfEntry(entry);
    const written = chars > 0;
    totalSeconds += seconds;
    if (written) {
      total += chars;
      writtenDays += 1;
      if (dailyGoal > 0 && chars >= dailyGoal) goalDays += 1;
      if (chars > maxChars) {
        maxChars = chars;
        bestDay = { day, chars };
      }
    }
    days.push({
      day,
      dayOfMonth,
      chars,
      seconds,
      written,
      goalMet: dailyGoal > 0 && chars >= dailyGoal,
      level: 0, // 下面按整月最高值 / 目标统一算，避免逐天口径不一致
      today: day === anchor,
      future: day > anchor
    });
  }
  for (const item of days) {
    item.level = calendarLevel(item.chars, { goal: dailyGoal, maxChars });
  }

  return {
    year: targetYear,
    month: targetMonth,
    label: `${targetYear}年${targetMonth}月`,
    today: anchor,
    isCurrentMonth: targetYear === anchorParts.year && targetMonth === anchorParts.month,
    firstWeekday: mondayWeekday(targetYear, targetMonth, 1),
    weekdayLabels: WEEKDAY_LABELS.slice(),
    goal: dailyGoal,
    total,
    totalSeconds,
    writtenDays,
    goalDays,
    average: writtenDays > 0 ? Math.round(total / writtenDays) : 0,
    bestDay,
    days
  };
}

// 连续写作天数：current = 从今天（今天还没写就从昨天）往前数的连续写字天数，
// best = 有记录以来的最长连续天数。只算「当天有正字数」的日期，未来日期忽略。
function streak(rawStats, { now = new Date() } = {}) {
  const stats = sanitizeStats(rawStats);
  const anchor = localDayKey(now);
  const written = new Set();
  for (const [key, entry] of Object.entries(stats.days)) {
    if (key > anchor) continue;
    if (totalOfEntry(entry) > 0) written.add(key);
  }
  const sorted = Array.from(written).sort();
  let current = 0;
  let cursor = written.has(anchor) ? anchor : shiftDayKey(anchor, -1);
  // 统计文件最多 500 天，这里再夹一个硬上限，坏数据也不会死循环。
  for (let guard = 0; guard <= MAX_DAYS + 1 && written.has(cursor); guard += 1) {
    current += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let previous = null;
  for (const key of sorted) {
    run = previous && shiftDayKey(previous, 1) === key ? run + 1 : 1;
    if (run > best) best = run;
    previous = key;
  }
  return {
    current,
    best,
    todayWritten: written.has(anchor),
    lastWritten: sorted.length ? sorted[sorted.length - 1] : null,
    writtenDays: written.size
  };
}

// 只清理「早于保留窗口」的真实日期；未来日期/坏键（读取时已被清洗）不动。
function pruneDays(stats, key) {
  const cutoff = shiftDayKey(key, -(KEEP_DAYS - 1));
  for (const existing of Object.keys(stats.days)) {
    if (existing < cutoff) delete stats.days[existing];
  }
  const all = Object.keys(stats.days).sort();
  if (all.length > MAX_DAYS) {
    for (const old of all.slice(0, all.length - MAX_DAYS)) delete stats.days[old];
  }
}

// 把一次保存的正字数增量记进某本书的某一天；delta <= 0 不计数（删字/没变都不该扣今天的进度）。
// 返回新 stats 与真正记下的 added（调用方据此决定要不要写盘）。
function recordChars(rawStats, { day, bookId, delta } = {}) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  const amount = Math.round(Number(delta));
  if (!Number.isFinite(amount) || amount <= 0) return { stats, added: 0, day: key };
  const id = sanitizeBookId(bookId);
  // 保留这一天已有的写作时长（v0.8-2）；旧数据没有 seconds 时就是空的。
  const existing = stats.days[key];
  const entry = existing && typeof existing === 'object' ? { ...existing, books: { ...(existing.books || {}) } } : { books: {} };
  const before = entry.books[id] || 0;
  entry.books[id] = Math.min(MAX_DAY_CHARS, before + amount);
  const actualAdded = entry.books[id] - before;
  stats.days[key] = entry;
  pruneDays(stats, key);
  return { stats, added: actualAdded, day: key };
}

// 把一段写作时长（秒）累计到某一天；seconds <= 0 / 坏值不写盘。
// 只加时长、不记任何正文或按键；单日上限 MAX_DAY_SECONDS（24 小时）。
// 时长和字数是同一天的两种记录：这里也保留当天已有的按书字数。
function recordDuration(rawStats, { day, seconds } = {}) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  const amount = Math.round(Number(seconds));
  if (!Number.isFinite(amount) || amount <= 0) return { stats, added: 0, day: key };
  const existing = stats.days[key];
  const entry = existing && typeof existing === 'object' ? { ...existing } : { books: {} };
  const before = secondsOfEntry(entry);
  entry.seconds = Math.min(MAX_DAY_SECONDS, before + amount);
  const added = entry.seconds - before;
  if (added <= 0) return { stats, added: 0, day: key };
  stats.days[key] = entry;
  pruneDays(stats, key);
  return { stats, added, day: key };
}

// 近 N 天：从最早到今天，缺的天补 0，方便渲染层直接画柱子。
function recentDays(rawStats, now = new Date(), count = DEFAULT_RECENT_DAYS) {
  const stats = sanitizeStats(rawStats);
  const days = clampRecentDays(count);
  const anchor = localDayKey(now);
  const out = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = shiftDayKey(anchor, -offset);
    out.push({ day: key, chars: dayTotal(stats, key) });
  }
  return out;
}

// 给渲染层的最小摘要：今天多少字、目标多少、完成百分比、近 N 天（含今天）。
// v0.8-2 追加写作时长：今天 / 近 N 天各多少秒（关掉记录时一直是 0，旧数据读出来也是 0）。
function summary(rawStats, { now = new Date(), goal = DEFAULT_GOAL, days = DEFAULT_RECENT_DAYS } = {}) {
  const stats = sanitizeStats(rawStats);
  const anchor = localDayKey(now);
  const recent = recentDays(stats, anchor, days);
  const todayChars = dayTotal(stats, anchor);
  const todaySeconds = daySeconds(stats, anchor);
  const recentSeconds = recent.reduce((sum, item) => sum + secondsOfEntry(stats.days[item.day]), 0);
  const dailyGoal = normalizeGoal(goal);
  const goalPercent = dailyGoal > 0 ? Math.min(100, Math.floor((todayChars / dailyGoal) * 100)) : 0;
  const recentTotal = recent.reduce((sum, item) => sum + item.chars, 0);
  return {
    day: anchor,
    todayChars,
    todaySeconds,
    goal: dailyGoal,
    goalPercent,
    goalMet: dailyGoal > 0 && todayChars >= dailyGoal,
    recentTotal,
    recentSeconds,
    days: recent
  };
}

function cloneStats(stats) {
  return JSON.parse(JSON.stringify(stats));
}

// 独立存储：写入走 core/atomic，串行化避免并发保存互相覆盖。
function createStatsStore(userDataDir) {
  const file = path.join(userDataDir, 'stats.json');
  let cache = null;
  let loadPromise = null;
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readFromDisk() {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptyStats();
      throw err;
    }
    try {
      return sanitizeStats(JSON.parse(stripBom(raw)));
    } catch {
      // 统计文件坏了：归档坏文件（不直接删），然后从空统计继续，不能影响保存正文。
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      try {
        await fs.rename(file, `${file}.corrupt-${stamp}`);
      } catch {
        /* 归档失败也不阻塞 */
      }
      return emptyStats();
    }
  }

  async function load() {
    if (cache) return cloneStats(cache);
    if (!loadPromise) {
      loadPromise = readFromDisk().then(
        (stats) => {
          cache = stats;
          return stats;
        },
        (err) => {
          loadPromise = null; // 读失败允许下次重试，不把坏状态永久缓存
          throw err;
        }
      );
    }
    const stats = await loadPromise;
    return cloneStats(stats);
  }

  async function get() {
    await queue;
    return load();
  }

  function record({ day, bookId, delta } = {}) {
    return enqueue(async () => {
      const current = await load();
      const result = recordChars(current, { day, bookId, delta });
      // 先把新统计写盘，成功了才更新内存缓存：写盘失败时缓存保持旧值，
      // 下次成功保存会重新带上这次增量，不会出现「内存多算了、文件里没有」。
      if (result.added > 0) await writeJsonAtomic(file, result.stats);
      cache = result.stats;
      return { added: result.added, day: result.day, stats: cloneStats(cache) };
    });
  }

  // 写作时长（v0.8-2）：只有按钮记秒数，不记内容；和字数共用一个串行队列与原子写，
  // 避免「保存正文」与「计时上报」同时写 stats.json 互相覆盖。
  function addDuration({ day, seconds } = {}) {
    return enqueue(async () => {
      const current = await load();
      const result = recordDuration(current, { day, seconds });
      if (result.added > 0) await writeJsonAtomic(file, result.stats);
      cache = result.stats;
      return { added: result.added, day: result.day, stats: cloneStats(cache) };
    });
  }

  async function summaryOf(options) {
    const stats = await get();
    return summary(stats, options);
  }

  return { file, load, get, record, addDuration, summary: summaryOf };
}

module.exports = {
  STATS_VERSION,
  DEFAULT_GOAL,
  MAX_GOAL,
  DEFAULT_RECENT_DAYS,
  KEEP_DAYS,
  MAX_DAY_SECONDS,
  WEEKDAY_LABELS,
  localDayKey,
  parseDayKey,
  isValidDayKey,
  shiftDayKey,
  normalizeGoal,
  normalizeMonth,
  daysInMonth,
  mondayWeekday,
  calendarLevel,
  sanitizeStats,
  sanitizeDuration,
  dayTotal,
  daySeconds,
  recordChars,
  recordDuration,
  recentDays,
  summary,
  monthView,
  streak,
  createStatsStore
};
