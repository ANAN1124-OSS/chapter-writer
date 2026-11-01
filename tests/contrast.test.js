'use strict';
// v0.9 A-4 视觉细节：对比度审计（scripts/contrast*）与主题色的回归测试。
//
// 分四块：
//   1. 颜色解析 / 合成 / WCAG 公式（纯逻辑，边界值全在这）；
//   2. 采样规格的静态闸门（选择器 / 令牌必须真存在，防止改了类名脚本还在量一个不存在的元素）；
//   3. 审计脚本自身的安全闸门（只在临时目录建书库、不删文件、main.js 懒加载、安装包不含 scripts）；
//   4. styles.css 的对比度相关约束（焦点环 / 滚动条 / 夜间色板 / 固定高亮字），以后改主题色别退回去。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const color = require('../scripts/contrast-color');
const contrast = require('../scripts/contrast');
const driver = require('../scripts/contrast-driver');
const table = require('../scripts/table');
const bench = require('../scripts/bench');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const CSS = read('renderer', 'styles.css');
// 判断「有没有写死某个颜色」时先去掉注释：注释里会提到旧颜色（#fbf3ee 之类），
// 那是给后来者看的考古说明，不是生效的样式。
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = read('renderer', 'index.html');
const RENDERER = read('renderer', 'renderer.js');
const DRIVER_SRC = read('scripts', 'contrast-driver.js');
const SCRIPT_SRC = read('scripts', 'contrast.js');
const MAIN_SRC = read('main.js');
const PKG = JSON.parse(read('package.json'));

// ---------- 1. 颜色解析 ----------

test('颜色解析：hex / rgb / rgba / 空格与斜杠语法 / 百分比 / 关键字', () => {
  assert.deepEqual(color.parseColor('#2b2822'), { r: 43, g: 40, b: 34, a: 1 });
  assert.deepEqual(color.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(color.parseColor('#ff000080'), { r: 255, g: 0, b: 0, a: 128 / 255 });
  assert.deepEqual(color.parseColor('#f008'), { r: 255, g: 0, b: 0, a: 136 / 255 });
  assert.deepEqual(color.parseColor('rgb(31, 32, 35)'), { r: 31, g: 32, b: 35, a: 1 });
  assert.deepEqual(color.parseColor('rgba(31, 32, 35, 0.4)'), { r: 31, g: 32, b: 35, a: 0.4 });
  assert.deepEqual(color.parseColor('rgb(31 32 35 / 40%)'), { r: 31, g: 32, b: 35, a: 0.4 });
  assert.deepEqual(color.parseColor('rgb(50% 50% 50%)'), { r: 128, g: 128, b: 128, a: 1 });
  assert.deepEqual(color.parseColor('  #2B2822  '), { r: 43, g: 40, b: 34, a: 1 });
  assert.deepEqual(color.parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(color.parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(color.parseColor('none'), null);
  assert.equal(color.parseColor(''), null);
  assert.equal(color.parseColor(null), null);
  assert.equal(color.parseColor('#12345'), null, '五位的 hex 不是合法颜色');
  assert.equal(color.parseColor('rgb(1, 2)'), null, '缺通道要报错而不是猜一个颜色');
  assert.equal(color.parseColor('hsl(0 0% 50%)'), null, '计算值不会是 hsl，认不出就返回 null');
});

test('颜色解析：color-mix 的计算值 color(srgb …) 必须能读（实测 --chapter-active-bg 就是它）', () => {
  const parsed = color.parseColor('color(srgb 0.552627 0.540863 0.517333)');
  assert.equal(parsed.r, 141);
  assert.equal(parsed.g, 138);
  assert.equal(parsed.b, 132);
  assert.equal(parsed.a, 1);
  assert.equal(color.parseColor('color(srgb 1 0 0 / 0.5)').a, 0.5);
  // color-mix 混到 transparent 时实测会给出 oklab(0 0 0 / 0)：要当成「没有这一层」
  assert.deepEqual(color.parseColor('oklab(0 0 0 / 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(color.parseColor('oklab(0.5 0 0)'), null, '不透明的新语法不做色域换算，要报采样失败');
});

// ---------- 2. 合成 ----------

test('背景合成：半透明盖在不透明底上、多层叠加、全透明回退', () => {
  // 50% 黑盖在白上 = 128 灰（浏览器 sRGB 字节空间合成，不是线性光）
  const grey = color.composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(grey, { r: 128, g: 128, b: 128, a: 1 });
  // 不透明前景直接顶掉背景（快路径）
  assert.deepEqual(color.composite({ r: 1, g: 2, b: 3, a: 1 }, { r: 9, g: 9, b: 9, a: 1 }), {
    r: 1,
    g: 2,
    b: 3,
    a: 1
  });
  // 栈的顺序是「第一个最上层」：半透明黑在最上，白在最下 → 仍然是 128 灰。
  // （早期版本在遇到不透明层时 break，会把这里算成纯白，已由这条断言钉住。）
  assert.deepEqual(color.flatten(['rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)']), {
    r: 128,
    g: 128,
    b: 128,
    a: 1
  });
  // 三层：25% 黑 → 50% 黑 → 白，等于先 50% 再 25%
  const layered = color.flatten([
    'rgba(0, 0, 0, 0.25)',
    'rgba(0, 0, 0, 0.5)',
    'rgb(255, 255, 255)'
  ]);
  assert.deepEqual(layered, { r: 96, g: 96, b: 96, a: 1 });
  // 全透明 / 空栈落到 fallback（默认白）
  assert.deepEqual(color.flatten([]), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(color.flatten(['rgba(0, 0, 0, 0)'], '#000000'), { r: 0, g: 0, b: 0, a: 1 });
});

test('WCAG 公式：亮度 / 对比度 / 大小字号 / 等级 / 阈值', () => {
  assert.equal(color.relativeLuminance('#000000'), 0);
  assert.equal(color.relativeLuminance('#ffffff'), 1);
  assert.equal(Math.round(color.contrastRatio('#ffffff', '#000000')), 21);
  assert.equal(Math.round(color.contrastRatio('#123456', '#123456')), 1);
  assert.equal(color.contrastRatio('#ffffff', 'not-a-color'), null);

  // 主题色改动的锚点：这几个数字是 v0.9 A-4 调色后实测的比值，允许 ±0.05 的取整误差。
  assert.ok(Math.abs(color.contrastRatio('#85827c', '#f7f4ee') - 3.49) < 0.05, '滚动条滑块 / 标准纸');
  assert.ok(Math.abs(color.contrastRatio('#85827c', '#f0e6d2') - 3.09) < 0.05, '滚动条滑块 / 牛皮纸');
  assert.ok(Math.abs(color.contrastRatio('#817f7d', '#1f2023') - 4.08) < 0.05, '滚动条滑块 / 夜间');
  assert.ok(Math.abs(color.contrastRatio('#6a6657', '#f0e6d2') - 4.64) < 0.05, '次要文字 / 牛皮纸');
  assert.ok(Math.abs(color.contrastRatio('#5e584a', '#e5d8bf') - 5.02) < 0.05, '章节列表文字 / 牛皮纸侧栏');

  assert.equal(color.isLargeText(24, 400), true);
  assert.equal(color.isLargeText(23.9, 400), false);
  assert.equal(color.isLargeText(23.9, 700), true, '粗体 18.66px 以上都算大字号');
  assert.equal(color.isLargeText(18.66, 700), true);
  assert.equal(color.isLargeText(18.6, 700), false);
  assert.equal(color.isLargeText(18.66, 600), false);
  assert.equal(color.isLargeText(14, 400), false);
  assert.equal(color.isLargeText(NaN, 700), false);

  assert.equal(color.grade(7, { large: false }), 'AAA');
  assert.equal(color.grade(4.5, { large: false }), 'AA');
  assert.equal(color.grade(4.49, { large: false }), 'fail');
  assert.equal(color.grade(3, { large: true }), 'AA');
  assert.equal(color.grade(4.5, { large: true }), 'AAA');
  assert.equal(color.grade(3, { ui: true }), 'AA');
  assert.equal(color.grade(2.99, { ui: true }), 'fail');
  assert.equal(color.requiredRatio({}), 4.5);
  assert.equal(color.requiredRatio({ large: true }), 3);
  assert.equal(color.requiredRatio({ ui: true }), 3);
});

test('结论汇总：文字 / 大字号 / UI 图形各有阈值，颜色认不出来时给采样失败而不是抛错', () => {
  const text = color.evaluate({
    label: '正文',
    color: 'rgb(43, 40, 34)',
    bgStack: ['rgb(247, 244, 238)'],
    fontSize: 18,
    fontWeight: 400
  });
  assert.equal(text.required, 4.5);
  assert.equal(text.pass, true);
  assert.equal(text.grade, 'AAA', '正文 13:1 已经是 AAA');
  assert.equal(text.fg, 'rgb(43, 40, 34)');
  assert.equal(text.bg, 'rgb(247, 244, 238)');

  // 半透明底色要先合成：accent 12% 盖在纸白上比纯纸白暗，对比度会掉下来
  const tint = color.evaluate({
    label: '当前章',
    color: 'rgb(138, 90, 59)',
    bgStack: ['color(srgb 0.93 0.92 0.90)', 'rgb(251, 249, 244)'],
    fontSize: 12,
    fontWeight: 400
  });
  assert.ok(tint.ratio > 4 && tint.ratio < 6, `半透明底要参与合成，实际 ${tint.ratio}`);

  const ui = color.evaluate({
    label: '焦点环',
    color: 'rgb(138, 90, 59)',
    bgStack: ['rgb(251, 249, 244)'],
    ui: true
  });
  assert.equal(ui.required, 3, 'UI 图形按 3:1 判');
  assert.equal(ui.large, false);

  const large = color.evaluate({
    label: '大标题',
    color: 'rgb(43, 40, 34)',
    bgStack: ['rgb(247, 244, 238)'],
    fontSize: 26,
    fontWeight: 400
  });
  assert.equal(large.large, true);
  assert.equal(large.required, 3);

  const broken = color.evaluate({ label: '坏采样', color: 'hsl(0 0% 50%)', bgStack: ['rgb(0, 0, 0)'] });
  assert.equal(broken.ratio, null);
  assert.equal(broken.pass, false);
  assert.match(broken.error, /颜色认不出来/);
});

// ---------- 3. 采样规格 / 报告 ----------

test('采样规格：键唯一、令牌都真在 styles.css 里、元素选择器的 id / class 都能在页面里找到', () => {
  const all = [...driver.SPECS.shelf, ...driver.SPECS.editor, ...driver.SPECS.dirty];
  const keys = all.map((spec) => spec.key);
  assert.equal(new Set(keys).size, keys.length, '规格 key 不许重复（报告会按 key 合并）');
  for (const spec of all) {
    assert.ok(spec.key && spec.label, `规格缺少 key / label：${JSON.stringify(spec)}`);
    if (spec.token) {
      assert.match(spec.token, /^--[a-z-]+$/, `令牌名不合法：${spec.token}`);
      assert.ok(
        CSS.includes(spec.token + ':'),
        `styles.css 里没有定义 ${spec.token}（规格会一直采样失败）`
      );
      if (spec.bgToken) assert.ok(CSS.includes(spec.bgToken + ':'), `styles.css 里没有 ${spec.bgToken}`);
      assert.ok(!spec.selector, '令牌规格不要再带选择器（两套解析路径只留一条）');
    } else {
      assert.ok(spec.selector, `元素规格缺少选择器：${spec.key}`);
      const tokens = [...String(spec.selector).matchAll(/[#.]([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      assert.ok(tokens.length > 0, `选择器里没有任何 id / class：${spec.selector}`);
      for (const name of tokens) {
        const used =
          HTML.includes(`id="${name}"`) ||
          HTML.includes(`class="${name}`) ||
          HTML.includes(` ${name}`) ||
          CSS.includes('.' + name) ||
          CSS.includes('#' + name) ||
          RENDERER.includes(`'${name}'`) ||
          RENDERER.includes(`"${name}"`);
        assert.ok(used, `选择器里的 ${name} 在页面 / 样式 / 渲染层里都找不到（类名改过？）`);
      }
    }
  }
  // 6 套主题的顺序固定：报告与 E2E 都按这个顺序打表，换顺序会让「改前 / 改后」对不上
  assert.deepEqual(contrast.THEMES, ['paper', 'cream', 'green', 'kraft', 'grid', 'night']);
});

test('结论汇总：按视图折成「规格 × 主题」的行，缺失的采样单独标出来', () => {
  const rows = contrast.evaluateSamples([
    { view: 'shelf', theme: 'paper', key: 'shelf.bookTitle', label: '书卡书名', found: true, color: 'rgb(43, 40, 34)', bgStack: ['rgb(251, 249, 244)'], fontSize: 17, fontWeight: 600 },
    { view: 'shelf', theme: 'night', key: 'shelf.bookTitle', label: '书卡书名', found: true, color: 'rgb(220, 216, 208)', bgStack: ['rgb(38, 40, 44)'], fontSize: 17, fontWeight: 600 },
    { view: 'shelf', theme: 'paper', key: 'shelf.corruptTitle', label: '损坏卡', found: false, optional: true },
    { view: 'shelf', theme: 'night', key: 'shelf.conflictBadge', label: '冲突徽标', found: false }
  ]);
  assert.equal(rows.length, 4);
  const summary = contrast.summarize(rows);
  assert.equal(summary.total, 2, '只有真采到的才算进总数');
  assert.equal(summary.pass, 2);
  assert.equal(summary.fail, 0);
  assert.equal(summary.skipped, 1, 'optional 的缺失算跳过');
  assert.equal(summary.missing, 1, '非 optional 的缺失要报出来');
  assert.equal(summary.ok, false);

  const built = contrast.buildRows(rows);
  const title = built.find((row) => row.key === 'shelf.bookTitle');
  assert.equal(title.cells.paper.ratio, title.cells.paper.ratio);
  assert.ok(title.cells.paper.pass && title.cells.night.pass);
  assert.equal(built.find((row) => row.key === 'shelf.corruptTitle').cells.paper.missing, true);
});

test('审计脚本：临时目录闸门 / 参数 / 结果解析 / 打表', () => {
  // 书库只许建在系统临时目录里（写错一次就会动真实书架）
  const tempRoot = path.join(os.tmpdir(), 'cw-contrast-test');
  assert.equal(contrast.assertTempRoot(tempRoot), path.resolve(tempRoot));
  assert.throws(() => contrast.assertTempRoot('D:\\我的小说'), /系统临时目录/);
  assert.throws(() => contrast.assertTempRoot(path.join(tempRoot, '..', '..')), /系统临时目录/);

  const defaults = contrast.parseArgs([]);
  assert.deepEqual(defaults.themes, contrast.THEMES);
  assert.equal(defaults.failOnLow, true);
  assert.equal(contrast.parseArgs(['--no-fail']).failOnLow, false);
  // 主题按固定顺序过滤：给 night,paper 也只留这两套，且顺序是 theme 表的顺序
  assert.deepEqual(contrast.parseArgs(['--themes=night,paper']).themes, ['paper', 'night']);
  assert.deepEqual(contrast.parseArgs(['--themes=nope']).themes, contrast.THEMES);
  assert.equal(contrast.parseArgs(['--timeout=5']).timeout, 10000, '超时要夹到最小值');
  assert.equal(contrast.parseArgs(['--out=shots/x.json']).out, 'shots/x.json');
  assert.match(contrast.usageText(), /--themes=列表/);
  assert.match(contrast.usageText(), /临时目录/);

  assert.deepEqual(contrast.pickResult('noise\nCONTRAST_RESULT {"ok":true,"samples":[]}\n'), {
    ok: true,
    samples: []
  });
  assert.equal(contrast.pickResult('nothing'), null);
  assert.equal(contrast.pickResult('CONTRAST_RESULT not-json'), null);

  const report = {
    env: { windowSize: '1187×717', dpr: 2, visibility: 'visible' },
    fixtures: { booksRoot: 'D:\\Temp\\x' },
    themes: ['paper', 'night'],
    rows: [
      { view: 'shelf', key: 'shelf.bookTitle', label: '书架：书卡书名', required: 4.5, ui: false, cells: { paper: { ratio: 13.96, pass: true }, night: { ratio: 10.39, pass: true } } },
      { view: 'editor', key: 'token.focusRing', label: '通用：焦点环', required: 3, ui: true, cells: { paper: { ratio: 5.53, pass: true }, night: { ratio: 5.85, pass: true } } }
    ],
    summary: { total: 4, pass: 4, fail: 0, missing: 0 }
  };
  const lines = contrast.formatLines(report).join('\n');
  assert.match(lines, /对比度审计/);
  assert.match(lines, /6 套|2 套/, '口径行要写清主题数');
  assert.match(lines, /书架：书卡书名/);
  assert.match(lines, /通用：焦点环/);
  assert.match(lines, /4\/4 条达标/);
  assert.match(lines, /【写作页】/);
});

test('注入脚本：语法可编译、参数原样带过去、采样只用同步布局', () => {
  const script = driver.buildContrastScript({
    themes: ['paper', 'night'],
    bookPath: 'D:\\Temp\\x\\books\\书',
    chapterIndex: 1,
    specs: driver.SPECS
  });
  assert.match(script, /^\(function contrastScenario|^\(\(cfg\)/);
  assert.doesNotThrow(() => new Function('return ' + script), '注入脚本必须是可编译的表达式');
  assert.match(script, /"themes":\["paper","night"\]/);
  assert.match(script, /D:\\\\Temp/, 'Windows 路径要能被 JSON.stringify 正确转义');
  // 采样口径：必须用同步布局刷一次样式，不许用 rAF / setTimeout 断渲染结果
  assert.match(DRIVER_SRC, /offsetHeight/, '切主题后要读一次 offsetHeight 强制同步布局');
  assert.equal(/requestAnimationFrame/.test(DRIVER_SRC.replace(/\/\/.*$/gm, '')), false);
  assert.equal(
    /setTimeout\s*\(/.test(DRIVER_SRC.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    false,
    '采样不许用固定 sleep / 定时器'
  );
});

// ---------- 4. 静态闸门 ----------

test('静态闸门：审计脚本只读、只在临时目录建库、main.js 懒加载、安装包不含 scripts', () => {
  for (const [name, source] of [
    ['scripts/contrast.js', SCRIPT_SRC],
    ['scripts/contrast-driver.js', DRIVER_SRC],
    ['scripts/contrast-color.js', read('scripts', 'contrast-color.js')]
  ]) {
    const requests = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    for (const request of requests) {
      assert.ok(
        request.startsWith('node:') || request.startsWith('./') || request.startsWith('../'),
        `${name} 里出现了非内建 / 非相对依赖：${request}`
      );
    }
    assert.equal(/require\('electron'\)/.test(source), false, `${name} 不许 require electron`);
    assert.equal(/(fs\.rm|fsp\.rm|unlink\()/.test(source), false, `${name} 不许删文件`);
    assert.equal(/D:\\\\我的小说|我的小说/.test(source), false, `${name} 不许写真实书架路径`);
  }
  // main.js：--contrast 要并进 automation 家族，驱动必须在 runAutomation() 里懒加载
  assert.match(MAIN_SRC, /const isContrast = process\.argv\.includes\('--contrast'\)/);
  assert.match(MAIN_SRC, /const automation = isE2E \|\| isBench \|\| isContrast \|\| Boolean\(screenshotPath\)/);
  const body = MAIN_SRC.slice(MAIN_SRC.indexOf('async function runAutomation'));
  assert.match(body.slice(0, 400), /require\('\.\/scripts\/contrast-driver\.js'\)/, '对比度驱动必须懒加载');
  assert.match(body.slice(0, 400), /if \(isContrast\)/);
  // 安装包不带 scripts/（自检脚本只在开发版存在）
  assert.equal(PKG.build.files.includes('scripts/**/*'), false);
  assert.equal(PKG.build.files.some((item) => item.startsWith('scripts')), false);
  // 开发脚本不引运行时依赖
  assert.deepEqual(Object.keys(PKG.dependencies || {}), []);
});

test('静态闸门：表格补位与 bench 共用同一份（抽取后行为不变）', () => {
  assert.equal(bench.displayWidth, table.displayWidth);
  assert.equal(bench.padCell, table.padCell);
  assert.equal(table.displayWidth('场景'), 4);
  assert.equal(table.displayWidth('abc'), 3);
  assert.equal(table.padCell('ab', 4), 'ab  ');
  assert.equal(table.padCell('ab', 4, 'right'), '  ab');
  assert.equal(table.padCell('超出宽度的长文本', 2), '超出宽度的长文本', '宁可歪也不截断现场信息');
  const lines = table.tableLines([
    ['项目', '要求', 'paper'],
    ['正文', '4.5:1', '13.38✓']
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^项目\s+要求\s+paper$/);
  assert.match(lines[1], /^正文\s+4\.5:1\s+13\.38✓$/);
  assert.deepEqual(table.tableLines([]), []);
});

test('静态闸门：焦点环 / 滚动条 / 夜间色板 / 固定高亮字这些对比度约束不许退回去', () => {
  // 焦点环：所有 :focus-visible 的 outline 都走 --focus-ring（以前用 --accent-soft，浅色纸只有 2.6–2.9:1）
  const focusRules = [...CSS.matchAll(/[^{}]*:focus-visible[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(focusRules.length >= 5, '应当有多条 :focus-visible 规则');
  for (const rule of focusRules) {
    if (!/outline:/.test(rule)) continue;
    assert.match(rule, /outline: 2px solid var\(--focus-ring\)/, `焦点环没用 --focus-ring：${rule.trim()}`);
    assert.equal(/var\(--accent-soft\)/.test(rule), false, '焦点环不许再用 --accent-soft');
  }

  // --focus-ring / --scroll-thumb 必须是两套主题各写一份具体颜色：
  // 写成 `var(--accent)` 会在 :root 上就替换好，夜间覆盖 --accent 对它们无效（实测夜间焦点环 2.54:1）
  const rootBlock = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('body.theme-cream'));
  const nightBlock = CSS.slice(CSS.indexOf('body.theme-night {'), CSS.indexOf('* { box-sizing'));
  assert.match(rootBlock, /--focus-ring: #[0-9a-f]{6};/, '浅色主题要写具体颜色');
  assert.match(rootBlock, /--scroll-thumb: #[0-9a-f]{6};/, '浅色主题要写具体颜色');
  assert.match(nightBlock, /--focus-ring: #[0-9a-f]{6};/, '夜间要单独写具体颜色');
  assert.match(nightBlock, /--scroll-thumb: #[0-9a-f]{6};/, '夜间要单独写具体颜色');
  assert.equal(/--focus-ring: var\(/.test(CSS), false, '--focus-ring 不许是 var()（会冻结成 :root 的值）');
  assert.equal(/--scroll-thumb: var\(|--scroll-thumb: color-mix/.test(CSS), false);
  // 焦点环 / 滚动条滑块的实际比值（改颜色时同步改这里）
  assert.ok(color.contrastRatio('#8a5a3b', '#fbf9f4') >= 3, '浅色焦点环要过 3:1');
  assert.ok(color.contrastRatio('#c99a6a', '#26282c') >= 3, '夜间焦点环要过 3:1');
  assert.ok(color.contrastRatio('#85827c', '#f0e6d2') >= 3, '牛皮纸滚动条要过 3:1');
  assert.ok(color.contrastRatio('#817f7d', '#1f2023') >= 3, '夜间滚动条要过 3:1');

  // 夜间原生控件配色（书架 / 章节栏 / 设置弹层的默认滚动条）
  assert.match(nightBlock, /color-scheme: dark;/, '夜间主题要给原生控件开深色');
  assert.equal(/color-scheme: dark/.test(rootBlock), false, '浅色主题不要开深色');

  // 正文命中高亮：底色是固定的浅琥珀，文字必须固定深色（以前 inherit，夜间 2.08:1）
  const markRule = /\.shelf-content-snippet mark \{[^}]*\}/.exec(CSS);
  assert.ok(markRule, '找不到 .shelf-content-snippet mark 规则');
  assert.match(markRule[0], /color: #2b2822;/, '高亮文字要固定深色');
  // 注释里提到过旧写法，判断前先把注释去掉
  assert.equal(/color: inherit/.test(markRule[0].replace(/\/\*[\s\S]*?\*\//g, '')), false);

  // 损坏书卡 / 冲突徽标不许写死浅色（夜间会变成深色书架里的白卡）
  assert.equal(/#fbf3ee/.test(CSS_CODE), false, '损坏书卡底色不许写死浅色');
  assert.equal(/#d9b3a6/.test(CSS_CODE), false);
  assert.equal(/rgba\(169, 116, 30/.test(CSS_CODE), false, '冲突徽标 / 警示标签颜色要走 --warn');

  // 主题色本身：次要文字 / 警示 / 成功 / 夜间危险色都要过 AA（数值改了就同步改这里）
  const pairs = [
    ['#6a6657', '#f7f4ee', 4.5, '次要文字 / 标准纸'],
    ['#6a6657', '#f0e6d2', 4.5, '次要文字 / 牛皮纸'],
    ['#5e584a', '#e5d8bf', 4.5, '章节列表文字 / 牛皮纸侧栏'],
    ['#8a5c13', '#fbf9f4', 4.5, '警示色 / 纸白'],
    ['#3f6642', '#f0f5ec', 4.5, '成功色 / 绿纸纸白'],
    ['#dc7c7c', '#26282c', 4.5, '夜间危险色 / 夜间纸白'],
    ['#9a968d', '#2b2e32', 4.5, '夜间次要文字 / 夜间输入框'],
    ['#fff', '#8a5a3b', 4.5, '浅色主按钮（白字 / 主色）'],
    ['#201c16', '#c99a6a', 4.5, '夜间主按钮（深字 / 夜间主色）']
  ];
  for (const [fg, bg, need, label] of pairs) {
    const ratio = color.contrastRatio(fg, bg);
    assert.ok(ratio >= need, `${label} 只有 ${ratio.toFixed(2)}:1，要求 ${need}:1`);
  }

  // 主题类与驱动 / 渲染层的清单一致（新增主题时三处都要改）
  const cssThemes = [...CSS.matchAll(/body\.theme-([a-z]+) \{/g)].map((m) => m[1]);
  assert.deepEqual(cssThemes, ['cream', 'green', 'kraft', 'grid', 'night']);
  assert.match(RENDERER, /for \(const theme of \['cream', 'green', 'night', 'kraft', 'grid'\]\)/);
  assert.match(DRIVER_SRC, /const THEME_CLASSES = \['cream', 'green', 'kraft', 'grid', 'night'\]/);

  // 自检时关过渡：往 styles.css 里临时插一条时长归零的规则（过渡会让切主题后读到中间帧），
  // 不许为此在产品 CSS 里长出一个只给测试用的类（sweep-unused 会把那种类判成死代码）。
  assert.match(DRIVER_SRC, /transition-duration:0s !important/, '采样前要关掉颜色过渡');
  assert.match(DRIVER_SRC, /insertRule\(/, '用 CSSOM 临时插规则，而不是产品 CSS 里的测试类');
  assert.equal(/no-transition/.test(CSS_CODE), false, '产品 CSS 里不要留只给自检用的类');
});
