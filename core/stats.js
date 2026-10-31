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
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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
    if (Object.keys(books).length) out.days[key] = { books };
  }
  return out;
}

function dayTotal(rawStats, day) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  const entry = stats.days[key];
  if (!entry) return 0;
  let total = 0;
  for (const value of Object.values(entry.books)) total += value;
  return total;
}

// 把一次保存的正字数增量记进某本书的某一天；delta <= 0 不计数（删字/没变都不该扣今天的进度）。
// 返回新 stats 与真正记下的 added（调用方据此决定要不要写盘）。
function recordChars(rawStats, { day, bookId, delta } = {}) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  const amount = Math.round(Number(delta));
  if (!Number.isFinite(amount) || amount <= 0) return { stats, added: 0, day: key };
  const id = sanitizeBookId(bookId);
  const entry = stats.days[key] && stats.days[key].books ? stats.days[key] : { books: {} };
  const before = entry.books[id] || 0;
  entry.books[id] = Math.min(MAX_DAY_CHARS, before + amount);
  const actualAdded = entry.books[id] - before;
  stats.days[key] = entry;

  // 只清理「早于保留窗口」的真实日期；未来日期/坏键（读取时已被清洗）不动。
  const cutoff = shiftDayKey(key, -(KEEP_DAYS - 1));
  for (const existing of Object.keys(stats.days)) {
    if (existing < cutoff) delete stats.days[existing];
  }
  const all = Object.keys(stats.days).sort();
  if (all.length > MAX_DAYS) {
    for (const old of all.slice(0, all.length - MAX_DAYS)) delete stats.days[old];
  }
  return { stats, added: actualAdded, day: key };
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
function summary(rawStats, { now = new Date(), goal = DEFAULT_GOAL, days = DEFAULT_RECENT_DAYS } = {}) {
  const stats = sanitizeStats(rawStats);
  const anchor = localDayKey(now);
  const recent = recentDays(stats, anchor, days);
  const todayChars = dayTotal(stats, anchor);
  const dailyGoal = normalizeGoal(goal);
  const goalPercent = dailyGoal > 0 ? Math.min(100, Math.floor((todayChars / dailyGoal) * 100)) : 0;
  const recentTotal = recent.reduce((sum, item) => sum + item.chars, 0);
  return {
    day: anchor,
    todayChars,
    goal: dailyGoal,
    goalPercent,
    goalMet: dailyGoal > 0 && todayChars >= dailyGoal,
    recentTotal,
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

  async function summaryOf(options) {
    const stats = await get();
    return summary(stats, options);
  }

  return { file, load, get, record, summary: summaryOf };
}

module.exports = {
  STATS_VERSION,
  DEFAULT_GOAL,
  MAX_GOAL,
  DEFAULT_RECENT_DAYS,
  KEEP_DAYS,
  localDayKey,
  parseDayKey,
  isValidDayKey,
  shiftDayKey,
  normalizeGoal,
  sanitizeStats,
  dayTotal,
  recordChars,
  recentDays,
  summary,
  createStatsStore
};
