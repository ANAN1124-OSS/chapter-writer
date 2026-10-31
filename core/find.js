// 全书查找 / 替换的纯文本逻辑（不依赖 Electron，可单测）。
// 只做「字面量」查找，不搞正则：作者写小说，正则一不小心就会误伤全稿。
// 替换前由 storage 负责把原章节备份到书内 _trash，替换写盘仍是显式的「全部替换」动作。

function findMatches(text, query, options = {}) {
  const source = String(text == null ? '' : text);
  const needleRaw = String(query == null ? '' : query);
  if (!needleRaw) return [];
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
    matches.push({ index, length: needleRaw.length });
    from = index + Math.max(1, needle.length);
    if (matches.length >= 5000) break; // 单章极端情况兜底，别把内存打爆
  }
  return matches;
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

module.exports = { findMatches, countMatches, replaceAllLiteral, makeSnippet };
