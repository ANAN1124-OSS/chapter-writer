/* 查找增强（v0.8-11，提案 N11）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 为什么要单独一个文件：当前章的「上一处 / 下一处」和「结果持续高亮」每次按 F3 / 回车都要算，
 * 但这些计算只是数组下标和文字切分，不该走 IPC，也不能只写在 renderer.js 里（那样没法单测）。
 * 所以放成「浏览器挂到 window，Node 里可以 require」的模块：
 *   - 渲染层：index.html 先加载 core/common.js，再加载 find-logic.js（window.CWFindLogic），最后 renderer.js；
 *   - 单测：tests/find-logic.test.js 直接 require('../renderer/find-logic.js')。
 *
 * 命中位置由主进程 core/find.js 的 findMatches 提供（字面量查找、不区分大小写可配），
 * 这里只做三件事：① 上一处 / 下一处（含绕回）；② 只画一屏能画的高亮（长章兜底）；
 * ③ 把正文按命中切成「普通 / 命中」片段给影子层用。
 * 本模块**只读**：不改正文、不写盘、不产生任何文件；所有下标都是编辑区 value 的字符下标（0 基）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/common'));
  } else if (root) {
    root.CWFindLogic = factory(root.CWCommon);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (common) {
  'use strict';

  // core/common.js 必须先加载（index.html 里排在最前面）；缺了直接报错，不要悄悄退回旧副本。
  if (!common || typeof common.clampInt !== 'function') {
    throw new Error('CWFindLogic：core/common.js 没有先加载');
  }
  const { clampInt } = common;

  // 影子层一次最多画多少处命中：正常一章远小于这个数；病态输入（几百个「的」）也不至于
  // 往 DOM 里塞上万个 span。超过时以当前命中为中心开一个窗口，导航仍然对全部命中有效。
  const MAX_HIGHLIGHT_ITEMS = 500;
  const HIGHLIGHT_ITEM_LIMITS = [20, 2000];

  function toText(value) {
    return String(value == null ? '' : value);
  }

  function toCount(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  // 主进程 findMatches 的返回是 [{ index, length }]；这里只信任「非负整数下标 + 至少 1 个字」的项，
  // 排序后交给下面几个函数用。坏数据一律丢掉，不让它把高亮层画歪。
  function normalizeMatches(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const index = toCount(item.index);
      const length = toCount(item.length);
      if (index == null || length == null || length < 1) continue;
      out.push({ index, length });
    }
    out.sort((a, b) => a.index - b.index || a.length - b.length);
    return out;
  }

  // 上一处 / 下一处：currentIndex 是当前第几处（0 基）。
  //   - 还没有当前命中（-1 / 越界）：下一处给第 1 处，上一处给最后一处，不算绕回；
  //   - 到两端：默认绕回（和浏览器 / 编辑器一致），wrap: false 时返回 null（由界面自己提示）。
  function stepMatch(rawMatches, currentIndex, direction, rawOptions) {
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const wrap = options.wrap !== false;
    const matches = normalizeMatches(rawMatches);
    const total = matches.length;
    if (!total) return null;
    const step = Number(direction) < 0 ? -1 : 1;
    // null / '' 不要被 Number() 悄悄当成 0：它们表示「还没有当前命中」
    const raw =
      currentIndex == null || currentIndex === '' ? NaN : Math.floor(Number(currentIndex));
    const hasCurrent = Number.isFinite(raw) && raw >= 0 && raw < total;
    if (!hasCurrent) {
      return { index: step < 0 ? total - 1 : 0, total, wrapped: false };
    }
    // 只有一处命中：上一处 / 下一处都停在它自己身上，也不算「绕回」
    if (total === 1) return { index: 0, total, wrapped: false };
    const next = raw + step;
    if (next >= 0 && next < total) return { index: next, total, wrapped: false };
    if (!wrap) return null;
    return { index: step < 0 ? total - 1 : 0, total, wrapped: true };
  }

  // 高亮窗口：返回要画进影子层的命中（带 ordinal = 在全部命中里的序号，用来标「当前这处」）。
  // total <= max 时全画；超过时以当前命中为中心开窗，窗口尽量包含当前命中。
  function highlightWindow(rawMatches, currentIndex, rawOptions) {
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
    const maxItems = clampInt(options.max, MAX_HIGHLIGHT_ITEMS, HIGHLIGHT_ITEM_LIMITS);
    const matches = normalizeMatches(rawMatches);
    const total = matches.length;
    if (!total) {
      return {
        items: [],
        total: 0,
        windowStart: 0,
        windowEnd: 0,
        hiddenBefore: 0,
        hiddenAfter: 0,
        truncated: false,
        maxItems
      };
    }
    const raw = Math.floor(Number(currentIndex));
    const current = Number.isFinite(raw) && raw >= 0 && raw < total ? raw : 0;
    if (total <= maxItems) {
      return {
        items: matches.map((match, i) => ({ index: match.index, length: match.length, ordinal: i })),
        total,
        windowStart: 0,
        windowEnd: total,
        hiddenBefore: 0,
        hiddenAfter: 0,
        truncated: false,
        maxItems
      };
    }
    const start = Math.min(Math.max(current - Math.floor(maxItems / 2), 0), total - maxItems);
    const items = matches
      .slice(start, start + maxItems)
      .map((match, i) => ({ index: match.index, length: match.length, ordinal: start + i }));
    return {
      items,
      total,
      windowStart: start,
      windowEnd: start + items.length,
      hiddenBefore: start,
      hiddenAfter: total - start - items.length,
      truncated: true,
      maxItems
    };
  }

  // 影子层要「整段文字一个字不少」才能和编辑区逐字对齐：把正文按命中切成普通 / 命中片段。
  // items 可以带 ordinal（来自 highlightWindow）；没有就按排序后的顺序补，方便标当前命中。
  // 越界、重叠、长度不合法的项直接跳过（宁可少画一处，也不把对齐弄歪）。
  function highlightRuns(rawText, rawItems) {
    const text = toText(rawText);
    const items = Array.isArray(rawItems) ? rawItems : [];
    const ranges = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const index = toCount(item.index);
      const length = toCount(item.length);
      if (index == null || length == null || length < 1) continue;
      if (index >= text.length) continue;
      const ordinal = toCount(item.ordinal);
      ranges.push({
        index,
        length: Math.min(length, text.length - index),
        ordinal: ordinal == null ? null : ordinal
      });
    }
    ranges.sort((a, b) => a.index - b.index || a.length - b.length);
    // 没带 ordinal 的按「排好序之后的顺序」补，和 stepMatch / highlightWindow 的序号口径一致
    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges[i].ordinal == null) ranges[i].ordinal = i;
    }
    const runs = [];
    let cursor = 0;
    for (const range of ranges) {
      if (range.index < cursor) continue; // 和上一处重叠：跳过，避免同一段文字画两遍
      if (range.index > cursor) runs.push({ text: text.slice(cursor, range.index), hit: false, ordinal: -1 });
      runs.push({
        text: text.slice(range.index, range.index + range.length),
        hit: true,
        ordinal: range.ordinal
      });
      cursor = range.index + range.length;
    }
    if (cursor < text.length) runs.push({ text: text.slice(cursor), hit: false, ordinal: -1 });
    return runs;
  }

  // 命中位置在第几行（1 基，和界面上的「第 N 行」一致）；越界夹到文首 / 文末。
  function lineOfIndex(rawText, rawIndex) {
    const text = toText(rawText);
    const n = Math.floor(Number(rawIndex));
    const pos = Number.isFinite(n) ? Math.min(Math.max(n, 0), text.length) : 0;
    let line = 1;
    for (let i = 0; i < pos; i += 1) {
      if (text[i] === '\n') line += 1;
    }
    return line;
  }

  // 界面上的「第 X / 共 N 处」小标签；没有命中时给一个短横线。
  function formatCounter(index, total) {
    const count = toCount(total) || 0;
    const at = Number.isFinite(Number(index)) ? Math.floor(Number(index)) : -1;
    if (!count || at < 0 || at >= count) return '—';
    return `${at + 1} / ${count}`;
  }

  return {
    MAX_HIGHLIGHT_ITEMS,
    HIGHLIGHT_ITEM_LIMITS,
    normalizeMatches,
    stepMatch,
    highlightWindow,
    highlightRuns,
    lineOfIndex,
    formatCounter
  };
});
