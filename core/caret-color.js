/* 当前段落高亮的自定义颜色（v0.8-10b，提案 N10b）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 为什么要单独一个文件：开关键盘 / 开关状态要按书记忆（config.bookDisplay），颜色也要能存进
 * config 并在启动时清洗；渲染层还要把颜色换算成「淡色底 + 左侧细线」用的 rgba。这两件事都只是
 * 字符串处理，不该写在 renderer.js 里（那样没法单测），也不该在主进程里另写一份。
 * 所以放成「浏览器挂到 window，Node 里可以 require」的模块：
 *   - 渲染层：index.html 先加载 core/caret-color.js（window.CWCaretColor），再加载 renderer.js；
 *   - 主进程：core/config.js require 它做配置清洗；
 *   - 单测：tests/caret-color.test.js 直接 require。
 *
 * 约定：'' = 跟随当前背景主题（默认），'#rrggbb' = 作者自己选的颜色。
 * 只做显示层的颜色字符串，不改正文、不写盘、不产生任何文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWCaretColor = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 色板：第一个是「跟随主题」（value 为空）。后面几个是在 6 套纸张 / 夜间底色上都能看清、
  // 又不至于抢正文的常用色；作者也可以点色块旁边的取色器自选任意颜色。
  const PRESETS = Object.freeze([
    { value: '', label: '跟随主题', hint: '用当前背景主题配好的高亮色' },
    { value: '#c8873c', label: '琥珀', hint: '暖色，接近默认的木质色调' },
    { value: '#3f7fbf', label: '湖蓝', hint: '冷色，夜间主题下也清楚' },
    { value: '#4f8a5b', label: '豆绿', hint: '护眼绿，和豆绿纸张接近' },
    { value: '#b45f6d', label: '胭脂', hint: '偏红的暖色' },
    { value: '#7a63b0', label: '藤紫', hint: '低饱和紫' },
    { value: '#7d8794', label: '石墨', hint: '中性灰，最不抢眼' }
  ]);

  const PRESET_VALUES = Object.freeze(PRESETS.map((item) => item.value).filter(Boolean));

  // 命中高亮的透明度：底色要淡（不盖住字），左侧细线稍实一点（一眼能看出段落边界）。
  // 数值写死在这里，单测与 E2E 都按这两个值断言，避免渲染层改出不一致的色。
  const TINT_ALPHA = 0.16;
  const EDGE_ALPHA = 0.82;

  function toText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // 只认 #rgb / #rrggbb（大小写都行，前后空白忽略）；解析不了的一律当「跟随主题」。
  // 统一成小写 6 位，方便配置里比较、也避免同一颜色存成两种写法。
  function normalizeColor(raw) {
    const value = toText(raw).toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(value)) {
      return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    }
    if (/^#[0-9a-f]{6}$/.test(value)) return value;
    return '';
  }

  function isCustomColor(raw) {
    return normalizeColor(raw) !== '';
  }

  function hexToRgb(raw) {
    const value = normalizeColor(raw);
    if (!value) return null;
    return {
      r: parseInt(value.slice(1, 3), 16),
      g: parseInt(value.slice(3, 5), 16),
      b: parseInt(value.slice(5, 7), 16)
    };
  }

  function rgbaString(rgb, alpha) {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  // 给 CSS 的两个变量：--caret-para-tint（底色）/ --caret-para-edge（左侧细线）。
  // 没有自定义颜色时返回 null，让样式表按背景主题走。
  function caretStyle(raw) {
    const rgb = hexToRgb(raw);
    if (!rgb) return null;
    return {
      color: normalizeColor(raw),
      tint: rgbaString(rgb, TINT_ALPHA),
      edge: rgbaString(rgb, EDGE_ALPHA)
    };
  }

  // 色板里有没有这个颜色（用于界面打勾 / 高亮；自定义颜色不在色板里返回 -1）
  function presetIndex(raw) {
    const value = normalizeColor(raw);
    return PRESET_VALUES.indexOf(value);
  }

  return {
    PRESETS,
    PRESET_VALUES,
    TINT_ALPHA,
    EDGE_ALPHA,
    normalizeColor,
    isCustomColor,
    hexToRgb,
    caretStyle,
    presetIndex
  };
});
