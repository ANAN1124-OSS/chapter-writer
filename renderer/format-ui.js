/* 「整理」交互改版（v0.8.5 R1）——纯逻辑：把「智能排版」的规则和改动统计讲成人话。
 *
 * 为什么要单独一个文件：点「整理」= 直接用上次记住的 `config.formatOptions` 整理当前章，
 * 成功 / 无改动两种结果都要给一句能看懂的话（规则摘要 + 改动统计），「一字未改」时还要说明
 * 没有塞撤销栈。这些只是拼字符串，不该只埋在 renderer.js 里（那样没法单测），所以抽成
 * 「浏览器挂到 window，Node 里可以 require」的模块：
 *   - 渲染层：index.html 先加载 format-ui.js（window.CWFormatUi），再加载 renderer.js；
 *   - 单测：tests/format-ui.test.js 直接 require('../renderer/format-ui.js')。
 *
 * 口径和 core/format.js（真正改正文的纯逻辑，主进程里跑）保持一致：
 * 这里**只生成文案**，不改正文、不写盘、不产生任何文件。
 *
 * v0.9 A-6b（文案梳理）：三处「没得改 / 没内容」的提示原来各写一句，现在统一从
 * NO_CHANGE_TEXT / EMPTY_TEXT 生成（toast 不带句号、面板带句号），renderer.js 不许再自己拼。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFormatUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 默认规则（和 core/format.js 的 DEFAULT_OPTIONS 一致；单测会断言两边不漂移）
  const DEFAULT_OPTIONS = Object.freeze({
    indent: '2', // 段首缩进：none 不处理 / '0' 去掉缩进 / '2' 两个全角空格
    blankLines: 'single', // 段间空行：keep / single / singleIndent / none
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false,
    curlyQuotes: false,
    ellipsis: false
  });

  const BLANK_LABELS = {
    keep: '段间保持原样',
    single: '段间空一行',
    singleIndent: '段间空一行（含缩进）',
    none: '段间不空行'
  };

  // 统计里的数字：负数 / NaN / 字符串都按 0 处理（统计缺字段时文案也要能看）
  function count(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function mergeOptions(options) {
    return { ...DEFAULT_OPTIONS, ...(options && typeof options === 'object' ? options : {}) };
  }

  // 兼容旧配置里的布尔缩进：true = 缩进两格，false = 不处理
  function indentLabel(indent) {
    const mode = indent === true ? '2' : indent === false ? 'none' : String(indent);
    if (mode === '2') return '段首缩进 2 字符';
    if (mode === '0') return '段首缩进 0 字符';
    return '缩进不处理';
  }

  // 规则摘要：「段首缩进 2 字符 · 段间空一行 · 删行尾空白 · 中文旁标点转全角」
  function describeRules(options) {
    const opts = mergeOptions(options);
    const parts = [indentLabel(opts.indent)];
    parts.push(BLANK_LABELS[opts.blankLines] || BLANK_LABELS.single);
    if (opts.trimTrailing) parts.push('删行尾空白');
    if (opts.normalizePunct) parts.push('中文旁标点转全角');
    if (opts.curlyQuotes) parts.push('直引号转弯引号');
    if (opts.ellipsis) parts.push('省略号转中文');
    if (opts.removeCjkSpaces) parts.push('删中文间空格');
    return parts.join(' · ');
  }

  // 改动统计：「共 12 段 · 缩进调整 3 段 · 行尾空白 2 处 · 空行整理 1 处 · 标点转全角 4 处」
  // 三个可选统计只在真的改动过时才出现（和排版对话框预览同一套文案）。
  function statsText(stats) {
    const s = stats && typeof stats === 'object' ? stats : {};
    const parts = [
      `共 ${count(s.paragraphs)} 段`,
      `缩进调整 ${count(s.indentFixed)} 段`,
      `行尾空白 ${count(s.trailingTrimmed)} 处`,
      `空行整理 ${count(s.blankCollapsed)} 处`,
      `标点转全角 ${count(s.punctFixed)} 处`
    ];
    if (count(s.cjkSpacesRemoved)) parts.push(`中文间空格 ${count(s.cjkSpacesRemoved)} 处`);
    if (count(s.quotesFixed)) parts.push(`直引号转弯引号 ${count(s.quotesFixed)} 处`);
    if (count(s.ellipsisFixed)) parts.push(`省略号转中文 ${count(s.ellipsisFixed)} 处`);
    return parts.join(' · ');
  }

  // 点「整理」成功后的提示：规则摘要 + 改动统计 + 仍未保存（可 Ctrl+Z）
  function successToast(options, stats) {
    return `已整理本章（${describeRules(options)}）：${statsText(stats)} · 仍在编辑区，Ctrl+S 保存 / Ctrl+Z 撤销`;
  }

  // 「没得改 / 没内容」这两句在三个地方出现（快速整理的 toast、对话框的 toast、对话框预览面板），
  // 以前各写一句（「没有需要整理的地方」/「本章已经是整理后的格式，没有改动」/「没有可改的地方」），
  // 同一件事三种说法。v0.9 A-6b 收成这里一份：toast 与面板只差句末标点。
  const NO_CHANGE_TEXT = '本章已经是整理后的格式，没有可改的地方';
  const EMPTY_TEXT = '本章还没有内容，没什么可整理的';

  // 一字未改的提示：说清楚为什么（已经是整理后的格式）+ 用的是哪套规则（不塞撤销栈）
  function noChangeToast(options) {
    return `${NO_CHANGE_TEXT}（规则：${describeRules(options)}）`;
  }

  // 对话框里的实时预览面板：规则就在上面几行控件里，这里只留一句结论（带句号）
  function noChangePanelText() {
    return `${NO_CHANGE_TEXT}。`;
  }

  function emptyToast() {
    return EMPTY_TEXT;
  }

  function emptyPanelText() {
    return `${EMPTY_TEXT}。`;
  }

  // 选择卡里「撤销上次整理」的文案：0 步时不给括号里的数字
  function undoLabel(steps) {
    const n = Math.max(0, Math.floor(Number(steps) || 0));
    return n > 0 ? `撤销上次整理（可撤销 ${n} 步）` : '撤销上次整理';
  }

  return {
    DEFAULT_OPTIONS,
    NO_CHANGE_TEXT,
    EMPTY_TEXT,
    mergeOptions,
    describeRules,
    statsText,
    successToast,
    noChangeToast,
    noChangePanelText,
    emptyToast,
    emptyPanelText,
    undoLabel
  };
});
