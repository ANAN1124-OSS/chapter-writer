// 单测：动效克制与统一（v0.9 A-6）。
//
// 这一项改的是「观感的一致性」，没有业务逻辑可测，所以钉的是**结构与规矩**：
//   · 全界面只有两档动效时长（--motion-quick / --motion-overlay），别的秒数一律不许写；
//   · 每一处 transition / animation 都从这两个令牌取值（写死秒数就红）；
//   · 引用了不存在的令牌（拼错）也能红——`var(--motion-qick)` 会让整条过渡失效，但页面
//     只是「突然不丝滑了」，肉眼很难发现；
//   · 位移类过渡（transform / translate / top / left）一条都不许有：那是唯一会连带
//     移动命中区域、还会额外提升合成层的动效；
//   · toast 的内联淡出（renderer.js 里写 inline style）也必须走令牌。
//
// 真实浏览器里的计算值由 E2E 第 69 组断言（读 getComputedStyle），这里只管静态文本。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STYLES = read('renderer/styles.css');
const INDEX = read('renderer/index.html');

const REDUCED_AT = STYLES.indexOf('@media (prefers-reduced-motion: reduce)');
const REDUCED_BLOCK = REDUCED_AT >= 0 ? STYLES.slice(REDUCED_AT) : '';
// 减少动效块以外的 CSS（那块里允许出现 .01ms，它是兜底覆盖，不是新动效）
const STYLES_MAIN = REDUCED_AT >= 0 ? STYLES.slice(0, REDUCED_AT) : STYLES;

// 渲染层的 JS 模块（内联过渡只允许出现在这些文件里，且必须用令牌）
const JS_FILES = fs
  .readdirSync(path.join(ROOT, 'renderer'))
  .filter((name) => name.endsWith('.js'));

const MOTION_TOKENS = ['--motion-quick', '--motion-overlay'];
const motionCssFiles = ['renderer/styles.css', 'renderer/index.html'];

function declaredTokens(css) {
  // :root 里声明的 --motion-* 令牌（只认 :root 那一块，主题里覆盖纸质变量不算）
  const rootAt = css.indexOf(':root {');
  const rootEnd = css.indexOf('\n}', rootAt);
  const rootBlock = css.slice(rootAt, rootEnd);
  const out = [];
  for (const m of rootBlock.matchAll(/(--motion-[\w-]+)\s*:\s*([^;]+);/g)) {
    out.push([m[1], m[2].trim()]);
  }
  return out;
}

test('动效令牌：全界面只有两档时长，且值就是 .12s / .16s', () => {
  const tokens = declaredTokens(STYLES);
  assert.deepEqual(
    tokens.map(([name]) => name),
    MOTION_TOKENS,
    '只许有 --motion-quick 与 --motion-overlay 两档；新增档位请先改这条测试与 README'
  );
  const values = Object.fromEntries(tokens);
  assert.equal(values['--motion-quick'], '.12s', '指针反馈那一档是 .12s');
  assert.equal(values['--motion-overlay'], '.16s', '面状进出那一档是 .16s');
});

test('动效令牌：每处 transition / animation 都从令牌取值，不写死秒数', () => {
  const offenders = [];
  const re = /(^|[;{]\s*)(transition|animation)(-[a-z]+)?\s*:([^;]+);/g;
  for (const m of STYLES_MAIN.matchAll(re)) {
    const value = m[4];
    if (/\d+(?:\.\d+)?m?s\b/.test(value)) {
      offenders.push(`${m[2]}${m[3] || ''}:${value.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], '这些动效还写死了秒数，要改成 var(--motion-quick / --motion-overlay)');
  // 也得真有过渡在用令牌（否则上面那条会因为「一条都没有」而假通过）
  const uses = [...STYLES_MAIN.matchAll(/var\((--motion-(?:quick|overlay))\)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 10, `令牌该被所有动效引用（现在只有 ${uses.length} 处）`);
});

test('动效令牌：引用的令牌都真的声明了（拼错会让整条过渡悄悄失效）', () => {
  const declared = new Set(declaredTokens(STYLES).map(([name]) => name));
  const sources = [
    ['renderer/styles.css', STYLES],
    ...JS_FILES.map((name) => [`renderer/${name}`, read(`renderer/${name}`)])
  ];
  for (const [label, source] of sources) {
    for (const m of source.matchAll(/var\((--motion-[\w-]+)\)/g)) {
      assert.ok(declared.has(m[1]), `${label} 引用了没声明的动效令牌 ${m[1]}`);
    }
  }
});

test('动效克制：不写位移类过渡（会连带移动命中区域、额外提升合成层）', () => {
  const re = /transition(?:-property)?\s*:([^;]+);/g;
  const offenders = [];
  for (const m of STYLES.matchAll(re)) {
    for (const prop of m[1].split(',')) {
      const name = prop.trim().split(/\s+/)[0];
      if (['transform', 'translate', 'top', 'left', 'all'].includes(name)) offenders.push(m[0].trim());
    }
  }
  assert.deepEqual(offenders, [], '不许再出现位移 / all 过渡');
  // 卡片悬停的 1px 上浮已经去掉：留下的悬停反馈是边框色 + 阴影
  assert.equal(/translateY\(-1px\)/.test(STYLES), false, '书卡 / 继续写作卡的悬停上浮已经删除，别加回来');
  const cardBlock = STYLES.slice(STYLES.indexOf('.book-card {'), STYLES.indexOf('.book-card:hover'));
  assert.equal(/transform\s*:/.test(cardBlock), false, '.book-card 自身不该有 transform');
});

test('动效克制：只有 toast 一条入场动画（新增动画要先改这条测试）', () => {
  const names = [...STYLES.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
  assert.deepEqual(names, ['toast-in'], '界面里只允许 toast 的入场动画；别的动画要写清理由再加');
  assert.match(STYLES, /\.toast\s*\{[^}]*animation:\s*toast-in var\(--motion-overlay\)/, 'toast 入场时长要走 overlay 那一档');
});

test('动效克制：焦点 / 悬停反馈还在（不是把动效删光换来的「统一」）', () => {
  // 悬停 / 焦点 / 当前章这几个反馈必须仍然存在（A-4 / A-5 已经量过对比度，别在 A-6 弄丢）
  for (const needle of [
    '.btn:hover:not(:disabled)',
    '.chapter-item:hover',
    '.book-card:hover',
    '.book-card-more:hover',
    '.dropdown-menu button:hover:not(:disabled)',
    '.context-menu button:hover'
  ]) {
    assert.ok(STYLES.includes(needle), `悬停反馈 ${needle} 不见了`);
  }
  assert.match(STYLES, /\.btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/, '按钮的焦点环还在');
  assert.match(STYLES, /\.chapter-item\.active\s*\{/, '当前章高亮还在');
});

test('动效：toast 淡出由 CSS 类承载，走令牌（以前写死 .25s，比全界面慢一拍）', () => {
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /el\.classList\.add\('leaving'\)/, 'toast 淡出要加 .leaving class');
  assert.match(
    STYLES,
    /\.toast\.leaving\s*\{[^}]*opacity:\s*0;[^}]*transition:\s*opacity var\(--motion-overlay\) ease;/,
    '.toast.leaving 里要写透明度与过渡，且时长走 overlay 那一档'
  );
  // 内联 transition / animation 里不许出现 var()：Chromium 的 CSSOM 会整条丢掉（实测 all / 0s）
  for (const name of JS_FILES) {
    const source = read(`renderer/${name}`);
    assert.equal(
      /\.style\.(?:transition|animation)\s*=\s*'[^']*var\(/.test(source),
      false,
      `${name}：内联 transition / animation 里不许写 var()（CSSOM 会丢整条声明）`
    );
  }
  // 渲染层里不许再有第二处写死秒数的内联过渡 / 动画
  const offenders = [];
  for (const name of JS_FILES) {
    const source = read(`renderer/${name}`);
    for (const m of source.matchAll(/\.style\.(transition|animation)\s*=\s*'([^']*)'/g)) {
      if (/\d+(?:\.\d+)?m?s\b/.test(m[2])) offenders.push(`${name}: ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, [], '渲染层的内联过渡 / 动画也要用令牌');
});

test('动效：样式表与页面里没有第二套动效来源', () => {
  // 只有 styles.css 承载动效：index.html 不许再写内联 <style> / style="…transition…"
  assert.equal(/<style[\s>]/i.test(INDEX), false, 'index.html 不该有内联样式表');
  assert.equal(/style="[^"]*(?:transition|animation)/i.test(INDEX), false, 'index.html 不该有内联动效');
  for (const file of motionCssFiles) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} 不存在`);
  }
  // 减少动效兜底还在，而且仍然盖住所有元素（A-5 加的，A-6 不许弄丢）
  assert.ok(REDUCED_AT > 0, 'styles.css 缺 prefers-reduced-motion 块');
  assert.match(REDUCED_BLOCK, /\*\s*,\s*\n\s*\*::before/, '减少动效要用通配选择器盖住所有元素');
  assert.match(REDUCED_BLOCK, /transition-duration:\s*\.01ms !important/, '减少动效要把过渡压到 .01ms');
  assert.match(REDUCED_BLOCK, /animation-duration:\s*\.01ms !important/, '减少动效要把动画压到 .01ms');
});
