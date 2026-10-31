/* 专注模式（提案 3.5）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 专注模式本身（隐藏左栏 / 顶栏、F11 进出、Esc 退出）是纯显示层的事，没什么可单测的；
 * 真正容易算错的是「打字机模式」：光标所在行要保持屏幕上方约 1/3 处，得把
 * 「光标在正文里的像素位置 + 正文区高度 + 当前滚动位置」换算成新的 textarea.scrollTop。
 * 这些换算放在这里（浏览器挂 window.CWFocusLogic、Node 里可 require 单测），
 * 渲染层只负责量出光标位置、把算出来的 scrollTop 套上去。
 *
 * 原则：只调滚动位置，不改正文、不写盘、不写配置（开关只记在内存里）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFocusLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 光标行目标位置：屏幕上方 1/3（提案原话「屏幕约 1/3 处」）
  const TYPEWRITER_RATIO_DEFAULT = 1 / 3;
  // 允许的范围：太靠上像没滚动、太靠下就看不到下文了
  const TYPEWRITER_RATIO_RANGE = [0.2, 0.5];
  // 死区：光标行与目标位置差得很少时不动（避免每打一个字都抖一下）
  const TYPEWRITER_DEADBAND = 4;
  // 和编辑器小件的标记层同一个口径：正文太大就别每次按键都去量（超长单章会卡）
  // 超过这个字数时打字机模式暂停对齐，正文编辑照常。
  const MAX_TYPEWRITER_CHARS = 300000;

  function toFinite(value) {
    // 注意：Number(null) = 0、Number('') = 0，但「没传」应该是「不知道」而不是 0，
    // 否则 sanitizeRatio(null) 会被当成 0 再夹成 0.2，和默认 1/3 对不上。
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clampNumber(value, fallback, range) {
    const n = toFinite(value);
    if (n == null) return fallback;
    return Math.min(Math.max(n, range[0]), range[1]);
  }

  // 目标比例：默认 1/3，夹在 0.2–0.5（传坏值也回到默认）
  function sanitizeRatio(value) {
    const n = toFinite(value);
    if (n == null) return TYPEWRITER_RATIO_DEFAULT;
    return Math.min(Math.max(n, TYPEWRITER_RATIO_RANGE[0]), TYPEWRITER_RATIO_RANGE[1]);
  }

  // 滚动位置必须落在 [0, 可滚动高度]；坏值当 0，结果取整（scrollTop 设小数没意义）
  function clampScrollTop(value, maxScrollTop) {
    const max = Math.max(0, toFinite(maxScrollTop) || 0);
    const n = toFinite(value);
    if (n == null) return 0;
    return Math.round(Math.min(Math.max(n, 0), max));
  }

  // 打字机滚动计划：
  //   caretTop     光标所在行的顶端（相对正文内容顶部，含 padding，单位 px）
  //   viewportHeight 正文区可视高度（textarea.clientHeight）
  //   maxScrollTop 可滚动到的最大值（scrollHeight - clientHeight）
  //   currentScrollTop 当前滚动位置
  // 理想位置 = 光标行顶端 - 视口高度 × 比例；夹进 [0, max] 后和当前位置比，
  // 差得超过死区才动（adjust = true，scrollTop = 新位置）；否则保持不动。
  function planTypewriterScroll(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const ratio = sanitizeRatio(opts.ratio);
    const deadband = clampNumber(opts.deadband, TYPEWRITER_DEADBAND, [0, 500]);
    const caretTop = toFinite(opts.caretTop);
    const viewportHeight = toFinite(opts.viewportHeight);
    const maxScrollTop = Math.max(0, toFinite(opts.maxScrollTop) || 0);
    const currentRaw = toFinite(opts.currentScrollTop);
    const current = currentRaw == null ? 0 : Math.max(0, currentRaw);
    const result = {
      ratio,
      deadband,
      target: 0,
      scrollTop: current,
      delta: 0,
      adjust: false
    };
    // 量不到光标位置 / 正文区不可见（高度为 0）时什么都不做，别把正文滚飞
    if (caretTop == null || viewportHeight == null || viewportHeight <= 0) {
      return result;
    }
    const target = clampScrollTop(caretTop - viewportHeight * ratio, maxScrollTop);
    const delta = target - current;
    result.target = target;
    result.delta = Math.round(delta * 100) / 100;
    if (Math.abs(delta) > deadband) {
      result.scrollTop = target;
      result.adjust = true;
    }
    return result;
  }

  return {
    TYPEWRITER_RATIO_DEFAULT,
    TYPEWRITER_RATIO_RANGE,
    TYPEWRITER_DEADBAND,
    MAX_TYPEWRITER_CHARS,
    sanitizeRatio,
    clampScrollTop,
    planTypewriterScroll
  };
});
