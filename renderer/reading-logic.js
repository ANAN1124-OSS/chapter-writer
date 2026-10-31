/* 阅读模式（v0.8-4，提案 N4）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 阅读模式本身（整本只读通读、连续滚动、退出回到写作页）是渲染层的事；这里只放
 * 容易算错的纯函数：
 *   - 字号 / 行距档位（四档 / 三档）与坏值夹紧；
 *   - 阅读进度（第 X / N 章、百分比）；
 *   - 滚动到某个位置时，当前视野里是哪一章（按每章区块的顶端位置算）；
 *   - 是否滚动到接近底部（用来决定要不要自动接下一章）；
 *   - 上一章 / 下一章的目标下标（到章首 / 章尾返回 null，不越界）。
 *
 * 原则：本模块**只读**。阅读模式不写正文、不写 `书目.json`、不写配置、不生成 `_trash`。
 * 浏览器里挂 `window.CWReadingLogic`，Node 里可以 require 单测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWReadingLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 字号四档：小 / 中 / 大（默认）/ 特大。默认 22px 在 1294×766 的窗口里不挤。
  const READING_FONT_LEVELS = [17, 19, 22, 25];
  const READING_FONT_LABELS = ['小', '中', '大', '特大'];
  const READING_FONT_DEFAULT = 2;
  // 行距三档：紧凑 / 标准（默认）/ 宽松
  const READING_LINE_LEVELS = [1.7, 2.0, 2.3];
  const READING_LINE_LABELS = ['紧凑', '标准', '宽松'];
  const READING_LINE_DEFAULT = 1;
  // 滚动到离底部这么近时，自动接下一章（连续滚动阅读）
  const AUTO_APPEND_THRESHOLD = 320;
  // 一次阅读会话最多同时留在 DOM 里的章节数：太多了会拖慢滚动，超出的从最早处移除。
  const MAX_LOADED_BLOCKS = 40;

  function toFinite(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // 档位：坏值回默认，越界夹到 [0, maxIndex]
  function clampLevel(value, maxIndex, fallback) {
    const max = Math.max(0, Math.floor(Number(maxIndex) || 0));
    const n = toFinite(value);
    if (n == null) return Math.min(Math.max(Math.floor(Number(fallback) || 0), 0), max);
    return Math.min(Math.max(Math.floor(n), 0), max);
  }

  function fontLevel(value) {
    return clampLevel(value, READING_FONT_LEVELS.length - 1, READING_FONT_DEFAULT);
  }

  function lineLevel(value) {
    return clampLevel(value, READING_LINE_LEVELS.length - 1, READING_LINE_DEFAULT);
  }

  function fontSize(level) {
    return READING_FONT_LEVELS[fontLevel(level)];
  }

  function lineHeight(level) {
    return READING_LINE_LEVELS[lineLevel(level)];
  }

  // 阅读进度：index 是当前章的 0 基下标，total 是全书章数。
  // 百分比按「看到第几章」算（第 1 / 3 章 = 33.3%），保留一位小数。
  function readingProgress(index, total) {
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!safeTotal) {
      return { index: -1, current: 0, total: 0, percent: 0, text: '全书还没有章节' };
    }
    const raw = toFinite(index);
    const safeIndex = Math.min(Math.max(Math.floor(raw == null ? 0 : raw), 0), safeTotal - 1);
    const percent = Math.round(((safeIndex + 1) / safeTotal) * 1000) / 10;
    return {
      index: safeIndex,
      current: safeIndex + 1,
      total: safeTotal,
      percent,
      text: `第 ${safeIndex + 1} / ${safeTotal} 章 · ${percent}%`
    };
  }

  // 当前看的是哪一章：blocks = [{ index, top }]，top 是这一章区块顶端相对滚动内容顶部的位置。
  // 取「顶端已经越过可见区域上沿（再加 offset 像素）」的所有区块里最靠下的那个。
  // 还没滚到第一章时返回第一个区块；空数组返回 -1。
  function blockAtScroll(blocks, scrollTop, offset) {
    if (!Array.isArray(blocks) || !blocks.length) return -1;
    const scroll = Math.max(0, toFinite(scrollTop) || 0);
    const extra = Math.max(0, toFinite(offset) == null ? 24 : toFinite(offset));
    const line = scroll + extra;
    let picked = null;
    let pickedTop = -Infinity;
    let first = null;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const index = toFinite(block.index);
      const top = toFinite(block.top);
      if (index == null || top == null) continue;
      if (first == null) first = Math.floor(index);
      if (top <= line && top >= pickedTop) {
        pickedTop = top;
        picked = Math.floor(index);
      }
    }
    if (picked != null) return picked;
    return first == null ? -1 : first;
  }

  // 是否接近底部：可滚动距离 - 当前滚动位置 <= threshold。
  // scrollHeight <= clientHeight（内容不足一屏）也算「到底」。
  function nearBottom(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const scrollTop = Math.max(0, toFinite(opts.scrollTop) || 0);
    const scrollHeight = Math.max(0, toFinite(opts.scrollHeight) || 0);
    const clientHeight = Math.max(0, toFinite(opts.clientHeight) || 0);
    const thresholdRaw = toFinite(opts.threshold);
    const threshold = Math.max(0, thresholdRaw == null ? AUTO_APPEND_THRESHOLD : thresholdRaw);
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    return maxScrollTop - scrollTop <= threshold;
  }

  // 上一章 / 下一章：direction < 0 = 上一章，其它 = 下一章。
  // 已经在章首 / 章尾时返回 null（按钮置灰、不会越界）。
  function stepIndex(current, total, direction) {
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!safeTotal) return null;
    const raw = toFinite(current);
    const base = Math.min(Math.max(Math.floor(raw == null ? 0 : raw), 0), safeTotal - 1);
    const delta = Number(direction) < 0 ? -1 : 1;
    const target = base + delta;
    return target >= 0 && target < safeTotal ? target : null;
  }

  // 全书字数（书架 / 页脚展示用）：只认书目缓存里的非负整数，坏值跳过。
  function bookChars(chapters) {
    if (!Array.isArray(chapters)) return 0;
    let total = 0;
    for (const chapter of chapters) {
      const n = toFinite(chapter && chapter.chars);
      if (n == null || n <= 0) continue;
      total += Math.round(n);
    }
    return total;
  }

  return {
    READING_FONT_LEVELS,
    READING_FONT_LABELS,
    READING_FONT_DEFAULT,
    READING_LINE_LEVELS,
    READING_LINE_LABELS,
    READING_LINE_DEFAULT,
    AUTO_APPEND_THRESHOLD,
    MAX_LOADED_BLOCKS,
    clampLevel,
    fontLevel,
    lineLevel,
    fontSize,
    lineHeight,
    readingProgress,
    blockAtScroll,
    nearBottom,
    stepIndex,
    bookChars
  };
});
