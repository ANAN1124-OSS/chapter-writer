// 「Ctrl+G 快速跳章」的纯逻辑：把输入当成章号或章名关键词，算出要跳的章节。
// 不碰磁盘、不依赖 Electron，渲染层通过主进程的 jump:match 调用同一份规则（可单测）。
//
// 支持两种输入：
//   1. 章号：「12」「第12章」「12章」「第 12 回」，以及全角数字「１２」→ 第 12 章（1 起算）；
//   2. 章名关键词：命中的章节名（不区分大小写），按「完全相同 → 开头相同 → 包含」排序，再按章序。

const DEFAULT_LIMIT = 8;
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 50;
const MAX_CHAPTER_NUMBER = 999999;

const FULL_WIDTH_DIGIT_RE = /[０-９]/g;

function normalizeQuery(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, MAX_QUERY_LENGTH);
}

function toHalfWidthDigits(text) {
  return String(text == null ? '' : text).replace(FULL_WIDTH_DIGIT_RE, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

// 纯章号查询才返回数字；「12.5」「第12章：夜雨」「abc」都不算。
function parseChapterNumber(raw) {
  const query = normalizeQuery(raw);
  if (!query) return null;
  const match = toHalfWidthDigits(query).match(/^第?\s*([0-9]{1,6})\s*[章节回]?$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_CHAPTER_NUMBER) return null;
  return number;
}

function sanitizeLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_RESULTS, Math.floor(n));
}

function chapterNameOf(chapter) {
  return chapter && typeof chapter === 'object' ? String(chapter.name == null ? '' : chapter.name).trim() : '';
}

function chapterIdOf(chapter) {
  return chapter && typeof chapter === 'object' && chapter.id != null ? String(chapter.id) : '';
}

function makeMatch(chapter, index, matchType) {
  return {
    index,
    chapterId: chapterIdOf(chapter),
    name: chapterNameOf(chapter),
    matchType
  };
}

// 主线：返回 { query, number, chapterCount, outOfRange, total, matches }。
//   - number != null：按章号找，只返回 1 条（越界时 matches 为空、outOfRange=true）；
//   - 否则按章名关键词找（空名章节不参与）；
//   - matches[].index 是 chapters 数组里的原始下标（删除/空白项不会让下标错位）。
function findMatches(chapters, rawQuery, options) {
  const query = normalizeQuery(rawQuery);
  const limit = sanitizeLimit(options && options.limit);
  const list = Array.isArray(chapters) ? chapters : [];
  const result = {
    query,
    number: null,
    chapterCount: list.length,
    outOfRange: false,
    total: 0,
    matches: []
  };
  if (!query) return result;

  const number = parseChapterNumber(query);
  if (number != null) {
    result.number = number;
    const index = number - 1;
    const chapter = list[index];
    if (index >= list.length || !chapter || typeof chapter !== 'object') {
      result.outOfRange = true;
      return result;
    }
    result.total = 1;
    result.matches = [makeMatch(chapter, index, 'number')];
    return result;
  }

  const needle = query.toLowerCase();
  const scored = [];
  for (let index = 0; index < list.length; index += 1) {
    const chapter = list[index];
    if (!chapter || typeof chapter !== 'object') continue;
    const name = chapterNameOf(chapter);
    if (!name) continue;
    const lower = name.toLowerCase();
    let score = -1;
    if (lower === needle) score = 0;
    else if (lower.startsWith(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    if (score >= 0) scored.push({ chapter, index, score });
  }
  scored.sort((a, b) => (a.score - b.score) || (a.index - b.index));
  result.total = scored.length;
  result.matches = scored.slice(0, limit).map((item) => makeMatch(item.chapter, item.index, 'name'));
  return result;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_CHAPTER_NUMBER,
  normalizeQuery,
  toHalfWidthDigits,
  parseChapterNumber,
  findMatches
};
