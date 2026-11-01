// 全书查找 / 替换的纯文本逻辑（不依赖 Electron，可单测）。
// 只做「字面量」查找，不搞正则：作者写小说，正则一不小心就会误伤全稿。
// 替换前由 storage 负责把原章节备份到书内 _trash，替换写盘仍是显式的「全部替换」动作。

// 单章命中数上限：极端情况（搜一个「的」）兜底，别把内存 / IPC 打爆。
// 到了上限还能多找出第 MAX_MATCHES + 1 处时，findMatchesAll 会明确回 truncated: true。
const MAX_MATCHES = 5000;

function scanMatches(text, query, options = {}, limit = MAX_MATCHES) {
  const source = String(text == null ? '' : text);
  const needleRaw = String(query == null ? '' : query);
  if (!needleRaw) return { matches: [], truncated: false };
  const cap = Math.max(1, Math.floor(Number(limit) || MAX_MATCHES));
  const caseSensitive = Boolean(options.caseSensitive);
  let haystack = source;
  let needle = needleRaw;
  if (!caseSensitive) {
    const lower = source.toLowerCase();
    const lowerNeedle = needleRaw.toLowerCase();
    if (lower.length === source.length && lowerNeedle.length === needleRaw.length) {
      haystack = lower;
      needle = lowerNeedle;
    }
  }
  const matches = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    if (matches.length >= cap) return { matches, truncated: true };
    matches.push({ index, length: needleRaw.length });
    from = index + Math.max(1, needle.length);
  }
  return { matches, truncated: false };
}

function findMatches(text, query, options = {}) {
  return scanMatches(text, query, options).matches;
}

// 需要知道「是不是被上限截断了」的时候用这个（例如渲染层的上一处 / 下一处）。
function findMatchesAll(text, query, options = {}) {
  return scanMatches(text, query, options);
}

function countMatches(text, query, options) {
  return findMatches(text, query, options).length;
}

// 纯字面量替换；返回替换后的文本和次数（位置由 findMatches 提供，保证大小写策略一致）
function replaceAllLiteral(text, query, replacement, options = {}) {
  const source = String(text == null ? '' : text);
  const matches = findMatches(source, query, options);
  if (!matches.length) return { text: source, count: 0 };
  const insert = String(replacement == null ? '' : replacement);
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += source.slice(cursor, match.index) + insert;
    cursor = match.index + match.length;
  }
  out += source.slice(cursor);
  return { text: out, count: matches.length };
}

// 结果列表里显示的一小段上下文（去掉换行，避免列表被撑开）
function makeSnippet(text, index, length, radius = 18) {
  const source = String(text == null ? '' : text);
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + length + radius);
  const clean = (part) => part.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
  return {
    before: clean(source.slice(start, index)),
    match: clean(source.slice(index, index + length)),
    after: clean(source.slice(index + length, end)),
    ellipsisStart: start > 0,
    ellipsisEnd: end < source.length
  };
}

// 「只替换这一处」用：从 fromIndex 往后找第一处命中。
// fromIndex 落在某一处命中内部时返回那一处（作者可能在编辑区里点了一下那个词）；
// 否则返回 fromIndex 及之后的下一处；找不到返回 null。
function findNextMatch(text, query, fromIndex = 0, options = {}) {
  const source = String(text == null ? '' : text);
  const matches = findMatches(source, query, options);
  if (!matches.length) return null;
  const rawFrom = Number(fromIndex);
  const from = Math.max(0, Math.min(Number.isFinite(rawFrom) ? Math.floor(rawFrom) : 0, source.length));
  let index = matches.findIndex((match) => match.index <= from && from < match.index + match.length);
  if (index < 0) index = matches.findIndex((match) => match.index >= from);
  if (index < 0) return null;
  return { index, total: matches.length, match: matches[index] };
}

module.exports = {
  MAX_MATCHES,
  findMatches,
  findMatchesAll,
  countMatches,
  replaceAllLiteral,
  makeSnippet,
  findNextMatch
};
