/* 编辑器小件（提案 4.1）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 为什么要单独一个文件：这些计算（选中字数、段落导航、超长段落、不可见字符、章节字数对比）
 * 每次按键 / 选区变化都要跑，走 IPC 去主进程太吵；但逻辑又不能只写在 renderer.js 里
 * （那样没法单测）。所以放成「浏览器挂到 window，Node 里可以 require」的模块：
 *   - 渲染层：index.html 先加载 editor-logic.js（window.CWEditorLogic），再加载 renderer.js；
 *   - 单测：tests/editor-logic.test.js 直接 require('../renderer/editor-logic.js')。
 *
 * 段落定义与「朗读」的 core/tts.js 完全一致（一个非空行 = 一段，首尾空白不算），
 * 单测里有交叉校验，避免「朗读说 4 段、选中说 3 段」这种对不上的情况。
 * 所有位置都是编辑区 value 的字符下标（0 基），可以直接 setSelectionRange。
 * 本模块**只读**：不改正文、不写盘、不产生任何文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWEditorLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 覆盖层最多渲染这么多字符的标记：再长就只给「超长段落」结论、不往 DOM 里塞标记。
  // （正常一章远小于这个数；「整本一章」导入的百万字单章会走到这里。）
  const MAX_MARK_CHARS = 300000;
  // 超长段落扫描上限：纯字符串遍历，很快；病态输入兜底。
  const MAX_LONG_PARAGRAPH_CHARS = 2000000;
  const LONG_PARAGRAPH_DEFAULT = 500; // 提案 4.1：段落 > 500 字提示
  const LONG_PARAGRAPH_LIMITS = [50, 20000];
  const MAX_LONG_PARAGRAPH_ITEMS = 200;
  // 一次最多返回多少个「不可见字符」标记（每个全角空格一个、每段行尾空白一个）
  const MAX_MARK_ITEMS = 4000;
  const MARK_ITEM_LIMITS = [10, 20000];
  // 章节字数对比：上一章少于 500 字不比较（短章之间差多少都正常）；
  // 比上一章短 40% 及以上才给软提示（和提案里的例子一致）。
  const COMPARE_MIN_PREVIOUS = 500;
  const COMPARE_SHORT_PERCENT = 40;
  // 「行尾空白」认这些字符（全角空格也算空白；纯空白行不标，避免整行泛色）
  const SPACE_CHARS = ' \t\u3000';

  function toText(value) {
    return String(value == null ? '' : value);
  }

  function toCount(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function clampInt(value, fallback, range) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, range[0]), range[1]);
  }

  function clampIndex(length, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(Math.floor(n), 0), length);
  }

  // 和「本章字数」同一口径：去掉所有空白后的字符数
  function countChars(text) {
    return toText(text).replace(/\s/g, '').length;
  }

  // 每一行（含空行）的 [start, end)；end 不含换行符。blank = 只有空白（含全角空格）
  function lineRanges(text) {
    const source = toText(text);
    const ranges = [];
    let start = 0;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const end = start + raw.length;
      ranges.push({ start, end, line: i + 1, blank: raw.trim() === '' });
      start = end + 1; // 加回换行符
    }
    return ranges;
  }

  // 和 core/tts.js 的 paragraphRanges 同一规则：每个非空行一段，首尾空白（含全角空格）不算
  function paragraphRanges(text) {
    const source = toText(text);
    const ranges = [];
    let paragraph = 0;
    for (const line of lineRanges(source)) {
      if (line.blank) continue;
      let start = line.start;
      let end = line.end;
      while (start < end && /\s/.test(source[start])) start += 1;
      while (end > start && /\s/.test(source[end - 1])) end -= 1;
      if (end <= start) continue;
      paragraph += 1;
      ranges.push({ start, end, paragraph, line: line.line });
    }
    return ranges;
  }

  // 选中统计：chars = 选中字数（不含空白），paragraphs = 选区触及的非空行数。
  // 只选了段首缩进也算「触及那一段」；只选了空行不算段。
  function selectionStats(text, start, end) {
    const source = toText(text);
    const length = source.length;
    let from = clampIndex(length, start);
    let to = clampIndex(length, end);
    if (from > to) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    if (from === to) {
      return { collapsed: true, chars: 0, paragraphs: 0, start: from, end: to };
    }
    const chars = countChars(source.slice(from, to));
    let paragraphs = 0;
    for (const line of lineRanges(source)) {
      if (line.blank) continue;
      if (from < line.end && to > line.start) paragraphs += 1;
    }
    return { collapsed: false, chars, paragraphs, start: from, end: to };
  }

  // 段落导航（Alt+↑/↓）：返回目标段落开头（已去掉段首缩进）的字符下标，没有就返回 null。
  //   - 光标在段中间：↑ 回到本段开头；↓ 去下一段开头
  //   - 光标正好在段开头：↑ 去上一段；↓ 去下一段
  //   - 光标在第一段之前的空白里：↑ 不动；↓ 去第一段开头
  function paragraphJumpTarget(text, position, direction) {
    const source = toText(text);
    const ranges = paragraphRanges(source);
    if (!ranges.length) return null;
    const pos = clampIndex(source.length, position);
    if (Number(direction) < 0) {
      for (let i = ranges.length - 1; i >= 0; i -= 1) {
        if (ranges[i].start < pos) return ranges[i].start;
      }
      return null;
    }
    for (const range of ranges) {
      if (range.start > pos) return range.start;
    }
    return null;
  }

  // 光标所在自然段（v0.8-10，提案 N10）：本编辑器里一个非空行 = 一段，和 paragraphRanges 同口径。
  // 返回：
  //   index     —— 行下标（0 基，含空行）
  //   line      —— 行号（1 基，和界面上「第 N 行」一致）
  //   blank     —— 光标落在空行（只有空白也算空行）
  //   start/end —— 这段去掉首尾空白后的字符区间（空行时是整行的 [start, end)）
  //   paragraph —— 第几段（1 基；空行 = 0）
  //   text      —— 这一段去掉首尾空白后的文字（只读，给测试 / 提示用）
  // 光标正好在一行末尾（换行符之前）算这一行；在换行符之后就是下一行，不会同时属于两行。
  function caretParagraph(text, position) {
    const source = toText(text);
    const pos = clampIndex(source.length, position);
    const lines = lineRanges(source);
    let index = lines.length - 1;
    for (let i = 0; i < lines.length; i += 1) {
      if (pos <= lines[i].end) {
        index = i;
        break;
      }
    }
    const line = lines[index];
    let start = line.start;
    let end = line.end;
    while (start < end && /\s/.test(source[start])) start += 1;
    while (end > start && /\s/.test(source[end - 1])) end -= 1;
    const blank = line.blank;
    let paragraph = 0;
    if (!blank) {
      for (let i = 0; i <= index; i += 1) {
        if (!lines[i].blank) paragraph += 1;
      }
    }
    return {
      index,
      line: line.line,
      blank,
      paragraph,
      start,
      end,
      text: source.slice(start, end)
    };
  }

  function sanitizeThreshold(value) {
    return clampInt(value, LONG_PARAGRAPH_DEFAULT, LONG_PARAGRAPH_LIMITS);
  }

  // 超长段落：字数（去空白）> threshold 的自然段。items 最多 200 条，count 照实。
  function longParagraphs(text, rawOptions) {
    const options = typeof rawOptions === 'number' ? { threshold: rawOptions } : rawOptions || {};
    const threshold = sanitizeThreshold(options.threshold);
    const source = toText(text);
    if (source.length > MAX_LONG_PARAGRAPH_CHARS) {
      return { threshold, items: [], count: 0, truncated: true, tooLarge: true };
    }
    const items = [];
    let count = 0;
    for (const range of paragraphRanges(source)) {
      const chars = countChars(source.slice(range.start, range.end));
      if (chars <= threshold) continue;
      count += 1;
      if (items.length < MAX_LONG_PARAGRAPH_ITEMS) {
        items.push({
          start: range.start,
          end: range.end,
          line: range.line,
          paragraph: range.paragraph,
          chars
        });
      }
    }
    return {
      threshold,
      items,
      count,
      truncated: count > items.length,
      tooLarge: false
    };
  }

  function sanitizeMaxMarks(value) {
    return clampInt(value, MAX_MARK_ITEMS, MARK_ITEM_LIMITS);
  }

  // 不可见字符标记（只给显示层用，正文一个字节都不动）：
  //   fullwidth = 正文里的全角空格（U+3000），每个字符一条，显示成 ␣；
  //   trailing  = 行尾连续空白（空格 / 制表符 / 全角空格），每段末尾一条，显示成浅红底 + 末端 ·
  // 行尾的全角空格只算 trailing，不重复算 fullwidth。纯空白行不标（它本来就是空行）。
  function invisibleMarks(text, rawOptions) {
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const maxMarks = sanitizeMaxMarks(options.maxMarks);
    const source = toText(text);
    const counts = { fullwidth: 0, trailing: 0 };
    if (source.length > MAX_MARK_CHARS) {
      return { items: [], counts, maxMarks, truncated: false, tooLarge: true };
    }
    const items = [];
    const push = (item) => {
      if (items.length < maxMarks) items.push(item);
    };
    for (const line of lineRanges(source)) {
      if (line.blank) continue;
      let contentEnd = line.end;
      while (contentEnd > line.start && SPACE_CHARS.includes(source[contentEnd - 1])) {
        contentEnd -= 1;
      }
      for (let i = line.start; i < contentEnd; i += 1) {
        if (source[i] !== '\u3000') continue;
        counts.fullwidth += 1;
        push({ start: i, end: i + 1, line: line.line, type: 'fullwidth' });
      }
      if (contentEnd < line.end) {
        counts.trailing += 1;
        push({ start: contentEnd, end: line.end, line: line.line, type: 'trailing' });
      }
    }
    const total = counts.fullwidth + counts.trailing;
    return {
      items,
      counts,
      maxMarks,
      truncated: total > items.length,
      tooLarge: false
    };
  }

  // 章节字数对比（只读提示）：上一章太少不比较；短 40% 及以上给软提示。
  function compareChapterChars(current, previous, rawOptions) {
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const minPrevious = clampInt(options.minPrevious, COMPARE_MIN_PREVIOUS, [0, 100000000]);
    const shortPercent = clampInt(options.shortPercent, COMPARE_SHORT_PERCENT, [1, 99]);
    const currentChars = toCount(current);
    const previousChars = toCount(previous);
    const base = { current: currentChars, previous: previousChars, percent: 0, message: '' };
    // 上一章没有字数（老书没缓存 / 空章）或太短，就不比较，免得刷没意义的提示
    if (previousChars <= 0 || previousChars < minPrevious) {
      return { ...base, compared: false, direction: '' };
    }
    const percent = Math.round(((currentChars - previousChars) / previousChars) * 100);
    if (percent <= -shortPercent) {
      return {
        ...base,
        compared: true,
        percent,
        direction: 'shorter',
        message: `比上章短 ${Math.abs(percent)}%`
      };
    }
    if (percent >= 100) {
      return { ...base, compared: true, percent, direction: 'longer', message: `比上章长 ${percent}%` };
    }
    return { ...base, compared: true, percent, direction: 'similar' };
  }

  // 章节列表里的紧凑字数：12345 → 1.2万（整数省掉 .0）
  function formatCharsShort(value) {
    const n = toCount(value);
    if (n < 10000) return String(n);
    const trim = (text) => text.replace(/\.0$/, '');
    const wan = n / 10000;
    if (wan < 9999.95) return `${trim(wan.toFixed(1))}万`;
    return `${trim((n / 100000000).toFixed(1))}亿`;
  }

  // ---------- 写作时长（v0.8-2） ----------
  // 只用于界面显示，不写盘、不参与统计口径：秒数由主进程 / stats.json 提供。
  // 60 秒以下按秒；1 小时以下按分钟；再往上按「N 小时 M 分钟」；跨天按「N 天 M 小时」。
  function formatDuration(value) {
    const total = Math.max(0, Math.round(Number(value) || 0));
    if (total <= 0) return '0 秒';
    if (total < 60) return `${total} 秒`;
    if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
    if (total < 86400) {
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
    }
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  }

  // 计时按钮上的秒表：0:07 / 12:34 / 1:02:05（不补前导 0 的小时）。
  function formatStopwatch(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${Math.floor(total / 60)}:${pad(seconds)}`;
  }

  // 「超长段落 N 段」那个小标签点一下：从光标往后找下一段，到末尾就绕回第一段
  function nextLongParagraph(items, position) {
    if (!Array.isArray(items) || !items.length) return null;
    const raw = Number(position);
    const pos = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    for (const item of items) {
      if (item && item.start > pos) return item;
    }
    return items[0];
  }

  return {
    MAX_MARK_CHARS,
    MAX_LONG_PARAGRAPH_CHARS,
    LONG_PARAGRAPH_DEFAULT,
    LONG_PARAGRAPH_LIMITS,
    MAX_LONG_PARAGRAPH_ITEMS,
    MAX_MARK_ITEMS,
    COMPARE_MIN_PREVIOUS,
    COMPARE_SHORT_PERCENT,
    countChars,
    lineRanges,
    paragraphRanges,
    selectionStats,
    paragraphJumpTarget,
    caretParagraph,
    sanitizeThreshold,
    longParagraphs,
    invisibleMarks,
    compareChapterChars,
    formatCharsShort,
    formatDuration,
    formatStopwatch,
    nextLongParagraph
  };
});
