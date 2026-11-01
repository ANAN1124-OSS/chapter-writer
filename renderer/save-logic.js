/* 保存热路径的纯逻辑（代码审计 F2）——不碰 DOM、不读盘、不依赖 Electron。
 *
 * 改前：每次保存成功后，渲染层都 await 主进程的「全书校验」（readBookMeta + 每章 stat +
 *       bookStats），拿到 chapterCount 才出「已保存」提示。千章书每次 Ctrl+S 都在等这一趟。
 * 改后：保存成功立刻出提示（章数直接用书目里的章节数，保存不会增减章节）；全书校验挪到
 *       后台，只有真的缺章才 warn，失败只记日志、不误报。**两段文案与改动前逐字一致**，
 *       所以放在这里用单测锁住（tests/save-logic.test.js）。
 *
 * 浏览器挂 window.CWSaveLogic（index.html 在 renderer.js 之前加载），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWSaveLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 保存成功的提示：`已保存：N 章 · 本章 X 字` + 可选的「今日快照已留」。
  // N 来自 state.chapters.length（保存前后章节数不变），X 是主进程返回的本章字数。
  function savedToastText(options) {
    const opts = options || {};
    const raw = Number(opts.chapterCount);
    const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    const chars = opts.charsText == null ? '' : String(opts.charsText);
    const snapshotNote = opts.snapshotTaken ? ' · 今日快照已留' : '';
    return `已保存：${count} 章 · 本章 ${chars}${snapshotNote}`;
  }

  // 后台全书校验的结论：只有确实缺章才需要提醒；报告不完整 / 校验失败（调用方 catch 掉）
  // 一律静默，避免以前那句会误报的「全书校验失败」。
  function verifyWarnText(report) {
    const missing = report && Array.isArray(report.missing) ? report.missing.length : 0;
    return missing > 0 ? `已保存当前章，但全书有 ${missing} 个章节文件缺失` : '';
  }

  return { savedToastText, verifyWarnText };
});
