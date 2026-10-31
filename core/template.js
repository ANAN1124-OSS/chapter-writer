/* 章节模板（v0.8 P0 N5，提案 N5）——新建 / 插入章节时套用作者自己的模板。
 *
 * 参考墨者写作 / 灯果写作的「章节模板」：写手常把「第X章：」、分隔线、常用开场
 * 反复手打，希望新建章节时自动带出来。本模块只放纯逻辑：
 *   - 模板文本清洗（CRLF/CR 统一成 LF、去掉 NUL、长度上限）；
 *   - 占位符展开：{n} 章号（阿拉伯数字）、{title} 章名、{date} 本地日期 YYYY-MM-DD；
 *     不认识的占位符（{x} / {N} 等）原样保留，绝不猜；
 *   - 「要不要套用」：模板为空 / 只有空白、或目标章已经有正文时都不套用。
 *
 * 红线：本模块不读盘、不写盘、不联网；模板只改编辑区（未保存、可 Ctrl+Z），
 * 不会自动保存，也不会碰章节文件名 / 书目.json。
 *
 * 同时被 Node（core/config.js、单测）和渲染层（index.html 里 <script>）使用，
 * 所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWTemplate。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWTemplate = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 模板长度上限：够写「第N章 + 空行 + 分隔线 + 常用开场」，又不至于把整章正文塞进去。
  const MAX_TEMPLATE_LENGTH = 2000;
  const PLACEHOLDERS = ['n', 'title', 'date'];
  const PLACEHOLDER_HELP = '{n} = 章号（数字） · {title} = 章名 · {date} = 今天（YYYY-MM-DD）';

  // 模板文本清洗：换行统一成 \n（编辑区只认 \n）、去掉会截断文件的 NUL、夹到长度上限。
  // 非字符串（旧配置没有这个键 / 脏值）一律当空模板，不抛错。
  function sanitizeTemplate(value) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    return text.length > MAX_TEMPLATE_LENGTH ? text.slice(0, MAX_TEMPLATE_LENGTH) : text;
  }

  // 有没有真正要套用的内容：只有空白（空格 / 换行）的模板等于没设置。
  function hasTemplate(value) {
    return sanitizeTemplate(value).trim() !== '';
  }

  // 目标章是不是「空的」：空串 / 只有空白算空章（新建章节刚建出来就是这种）。
  function isBlankText(text) {
    return typeof text !== 'string' || text.trim() === '';
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  // 本地日期（不是 UTC）：和码字日历 / 每日统计的「今天」口径一致。
  function localDateKey(now) {
    const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  // 把外部传进来的上下文清洗成固定形状：章号只认正整数，章名只认字符串，日期兜底今天。
  function templateContext(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const no = Number(ctx.chapterNumber);
    return {
      chapterNumber: Number.isFinite(no) && no > 0 ? Math.floor(no) : null,
      chapterName: typeof ctx.chapterName === 'string' ? ctx.chapterName : '',
      date: localDateKey(ctx.now)
    };
  }

  // 展开模板。空模板 → 空串（调用方据此不套用）。
  // {n} 没有章号上下文时原样保留（宁可让作者看见，也不悄悄吞掉）。
  function applyTemplate(value, context) {
    const source = sanitizeTemplate(value);
    if (!source) return '';
    const ctx = templateContext(context);
    return source.replace(/\{(n|title|date)\}/g, (match, key) => {
      if (key === 'n') return ctx.chapterNumber == null ? match : String(ctx.chapterNumber);
      if (key === 'title') return ctx.chapterName;
      return ctx.date;
    });
  }

  // 新建 / 插入章节时要不要套用：有模板，且新章还是空的。
  function shouldApply(value, text) {
    return hasTemplate(value) && isBlankText(text);
  }

  return {
    MAX_TEMPLATE_LENGTH,
    PLACEHOLDERS,
    PLACEHOLDER_HELP,
    sanitizeTemplate,
    hasTemplate,
    isBlankText,
    localDateKey,
    templateContext,
    applyTemplate,
    shouldApply
  };
});
