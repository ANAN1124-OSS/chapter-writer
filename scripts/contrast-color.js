'use strict';
// 章节写作器 · 颜色与 WCAG 对比度（v0.9 A-4 视觉细节）——纯逻辑、零依赖、不读盘、不联网。
//
// 干什么：把浏览器 `getComputedStyle()` 拿回来的颜色字符串（rgb / rgba / #hex / transparent）
// 解析成 0–255 的通道 + 0–1 的透明度，按「上层盖下层」合成出**实际看到的底色**，再算
// WCAG 2.1 的相对亮度与对比度（4.5:1 普通文字 / 3:1 大字号文字与 UI 图形）。
//
// 为什么单独一个文件：`scripts/contrast.js`（只读审计）与 `tests/contrast.test.js` 必须用
// **同一份公式**——抄两遍的话，脚本说 4.5、测试说 4.4，谁也说不清主题到底改没改好。
// 这里只做颜色与公式，不含任何「哪个元素算合格」的业务规则（规格与阈值在 contrast.js）。
//
// 口径提醒（改之前先读）：
//   * 合成在 sRGB 字节空间做线性插值——这是浏览器合成不透明 / 半透明颜色的实际做法；
//     不要改成「线性光空间」合成，否则 rgba(0,0,0,.5) 盖在白底上会算成 127 以外的值，
//     和界面里看到的颜色对不上。
//   * 相对亮度按 WCAG 2.1：先 sRGB → 线性（<=0.03928 走 /12.92，否则 ((c+0.055)/1.055)^2.4）。
//   * 对比度不区分「谁在上」：(L亮 + .05) / (L暗 + .05)，结果 1–21。
//   * 只认识浏览器计算值会出现的写法（rgb()/rgba()/hex/transparent）；`color(srgb …)`、
//     `oklch()` 这类新语法一律返回 null，由调用方按「采样失败」处理（不要猜一个颜色）。

// 通道夹紧成整数 0–255（四舍五入）：合成 / 解析最后都过这里，避免 254.99999 之类的噪声。
function byte(n) {
  const value = Math.round(Number(n));
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, value));
}

// 透明度夹紧成 0–1；NaN / 缺省按 1（不透明）处理——浏览器给的颜色多数是不带 alpha 的。
function alpha(n) {
  if (n == null || n === '') return 1;
  const value = Number(n);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

// 解析一个 CSS 颜色字符串。返回 { r, g, b, a } 或 null（认不出来 / 空值 / 关键字 none）。
function parseColor(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'none') return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (text === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (text === 'black') return { r: 0, g: 0, b: 0, a: 1 };

  if (text[0] === '#') {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const parts = hex.split('').map((ch) => parseInt(ch + ch, 16));
      return { r: parts[0], g: parts[1], b: parts[2], a: hex.length === 4 ? alpha(parts[3] / 255) : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? alpha(parseInt(hex.slice(6, 8), 16) / 255) : 1;
      return { r, g, b, a };
    }
    return null;
  }

  // rgb() / rgba()：Chromium 的计算值通常是 "rgb(31, 32, 35)" / "rgba(31, 32, 35, 0.4)"，
  // 但新语法 "rgb(31 32 35 / 40%)" 也可能出现，所以逗号 / 空格 / 斜杠都认。
  const fn = /^(rgba?)\(([^)]*)\)$/.exec(text);
  if (fn) {
    let body = fn[2].replace(/\//g, ' ');
    let parts = body.includes(',') ? body.split(',') : body.split(/\s+/);
    parts = parts.map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length < 3) return null;
    const channel = (raw) => {
      if (raw.endsWith('%')) return byte((parseFloat(raw) / 100) * 255);
      return byte(parseFloat(raw));
    };
    let a = 1;
    if (parts.length >= 4) {
      const raw = parts[3];
      a = raw.endsWith('%') ? alpha(parseFloat(raw) / 100) : alpha(parseFloat(raw));
    }
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a };
  }

  // color(srgb …)：`color-mix()` 算出来的计算值就是这种写法（实测 --chapter-active-bg /
  // 混色滚动条都是 `color(srgb 0.55 0.54 0.51)`），通道是 0–1 的小数（或百分比）。
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/.exec(text);
  if (srgb) {
    const parts = srgb[1].replace(/\//g, ' ').split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const unit = (raw) => {
      const value = parseFloat(raw);
      if (!Number.isFinite(value)) return 0;
      return byte((raw.endsWith('%') ? value / 100 : value) * 255);
    };
    const a = parts.length >= 4 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return { r: unit(parts[0]), g: unit(parts[1]), b: unit(parts[2]), a: alpha(a) };
  }

  // 其它新语法（oklab / oklch / lab / lch / color(display-p3 …)）：不做色域换算。
  // 但**完全透明**的混色（实测 `oklab(0 0 0 / 0)` 就是 color-mix 到 transparent 的结果）
  // 必须认出来当「没有这一层」，否则背景栈会被整层丢掉、把实际底色算错。
  const other = /^[a-z-]+\(([^)]*)\)$/.exec(text);
  if (other) {
    const alphaText = other[1].includes('/') ? other[1].split('/').pop() : '';
    const value = parseFloat(alphaText);
    if (Number.isFinite(value) && (alphaText.endsWith('%') ? value / 100 : value) === 0) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
  }
  return null;
}

// 颜色 → "rgb(r, g, b)" / "rgba(r, g, b, a)"（报告里给人看的写法；不参与任何判断）。
function formatColor(color) {
  if (!color) return 'unknown';
  if (color.a >= 0.999) return `rgb(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)})`;
  return `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${Number(color.a.toFixed(3))})`;
}

// 半透明 fg 盖在不透明 bg 上：sRGB 字节空间线性插值（与浏览器合成一致）。
// bg 必须是「已经不透明」的颜色；fg 不透明时原样返回（快路径）。
function composite(fg, bg) {
  if (!fg || !bg) return null;
  if (fg.a >= 0.999) return { r: byte(fg.r), g: byte(fg.g), b: byte(fg.b), a: 1 };
  const a = alpha(fg.a);
  if (a <= 0) return { r: byte(bg.r), g: byte(bg.g), b: byte(bg.b), a: 1 };
  return {
    r: byte(byte(fg.r) * a + byte(bg.r) * (1 - a)),
    g: byte(byte(fg.g) * a + byte(bg.g) * (1 - a)),
    b: byte(byte(fg.b) * a + byte(bg.b) * (1 - a)),
    a: 1
  };
}

// 一叠背景色（**第一个是最上层**，通常来自「元素自身 → 逐级父节点」）合成成实际底色。
// 从最下层（数组末尾）开始往上一层一层盖；遇到不透明层不需要提前退出——它上面的层仍然
// 可见（早期版本在这里 break，把「元素自身半透明色盖在不透明父层上」算成了父层颜色）。
// 全都半透明时落到 fallback（默认白）。
function flatten(stack, fallback) {
  const base = parseColor(fallback == null ? '#ffffff' : fallback) || { r: 255, g: 255, b: 255, a: 1 };
  const list = (Array.isArray(stack) ? stack : [stack])
    .map((item) => (item && typeof item === 'object' ? item : parseColor(item)))
    .filter(Boolean);
  let result = { r: byte(base.r), g: byte(base.g), b: byte(base.b), a: 1 };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    result = composite(list[i], result);
  }
  return result;
}

// WCAG 2.1 相对亮度（0–1）：sRGB → 线性。
function relativeLuminance(color) {
  const c = color && typeof color === 'object' ? color : parseColor(color);
  if (!c) return null;
  const channel = (raw) => {
    const v = byte(raw) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = channel(c.r);
  const g = channel(c.g);
  const b = channel(c.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2.1 对比度（1–21）。任一颜色认不出来返回 null（调用方当采样失败，不要猜）。
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la == null || lb == null) return null;
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

// WCAG 的「大字号」：>= 24px；或 >= 18.66px 且 font-weight >= 700（14pt 粗体）。
// 边界按规范取「大于等于」：24px 整 / 18.66px 粗体都算大字号。
function isLargeText(fontSizePx, fontWeight) {
  const size = Number(fontSizePx);
  if (!Number.isFinite(size) || size <= 0) return false;
  const weight = Number(fontWeight);
  if (size >= 24) return true;
  return size >= 18.66 && Number.isFinite(weight) && weight >= 700;
}

// 达标等级：text = 普通文字（AA 4.5 / AAA 7）；large = 大字号文字（AA 3 / AAA 4.5）；
// ui = 非文字的界面图形（焦点环 / 滚动条这类，AA 3，没有 AAA 档）。
function grade(ratio, options) {
  const opt = options || {};
  if (ratio == null) return 'fail';
  if (opt.ui) return ratio >= 3 ? 'AA' : 'fail';
  if (opt.large) {
    if (ratio >= 4.5) return 'AAA';
    return ratio >= 3 ? 'AA' : 'fail';
  }
  if (ratio >= 7) return 'AAA';
  return ratio >= 4.5 ? 'AA' : 'fail';
}

// 这条采样要求的对比度下限：UI 图形与大字号文字 3:1，其余文字 4.5:1。
function requiredRatio(options) {
  const opt = options || {};
  if (opt.ui) return 3;
  if (opt.large) return 3;
  return 4.5;
}

// 把一条原始采样（浏览器侧只负责收集颜色 / 字号）算成结论。
// 入参：{ label, color, bgStack, fontSize, fontWeight, ui }
//   color   元素的计算文字色（或令牌色）；
//   bgStack 背景色栈，**第一个是最上层**（元素自身开始往上走）；
// 出参：{ label, fg, bg, ratio, required, grade, pass, large }
//   颜色认不出来时 ratio = null、pass = false，并在 error 里写明，不抛异常
//   （一条采样坏了不该让整张对比度表跑不出来）。
function evaluate(sample) {
  const item = sample || {};
  const label = String(item.label == null ? '' : item.label);
  const fg = parseColor(item.color);
  const stack = (Array.isArray(item.bgStack) ? item.bgStack : [item.bgStack])
    .map((value) => parseColor(value))
    .filter(Boolean);
  const bg = flatten(stack);
  const large = item.ui ? false : isLargeText(item.fontSize, item.fontWeight);
  const options = { ui: Boolean(item.ui), large };
  const ratio = fg && bg ? contrastRatio(fg, bg) : null;
  return {
    label,
    fg: fg ? formatColor(fg) : null,
    bg: bg ? formatColor(bg) : null,
    ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
    required: requiredRatio(options),
    grade: grade(ratio, options),
    large,
    ui: Boolean(item.ui),
    pass: ratio != null && ratio >= requiredRatio(options),
    error: ratio == null ? '颜色认不出来（采样失败）' : null
  };
}

module.exports = {
  parseColor,
  formatColor,
  composite,
  flatten,
  relativeLuminance,
  contrastRatio,
  isLargeText,
  grade,
  requiredRatio,
  evaluate
};
