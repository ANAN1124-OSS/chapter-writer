'use strict';
// scripts/sweep-unused.js 的单测（v0.9 B-4：死代码 / 未引用 CSS / HTML id 扫描）
//
// 分两部分：
//   ① 解析器的纯逻辑（CSS 选择器与声明、HTML id / class / 关系引用、JS 字符串字面量与 id 引用、
//      顶层定义、模块导出、动态拼名形状、重复选择器）——都用合成的小段输入，快且不受仓库内容影响；
//   ② 对**真仓库**跑一遍 gather()，钉住三件事：「真死」清单为空（= 没漏删的）、
//      「动态拼出的类」不会掉进死代码清单（= 不会误删）、脚本自己是只读的（= 跑测试不会改仓库）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sweep = require('../scripts/sweep-unused.js');

// ---------------------------------------------------------------- ① CSS 解析

test('CSS：注释先剔掉（保留换行，行号不错位）', () => {
  const css = 'a {\n  color: red; /* 注释\n  跨行 */\n}\nb { top: 0; }';
  const stripped = sweep.stripCssComments(css);
  assert.ok(!stripped.includes('注释'));
  assert.strictEqual(stripped.split('\n').length, css.split('\n').length);
  const rules = sweep.parseCssRules(css);
  assert.deepStrictEqual(
    rules.map((r) => r.selector),
    ['a', 'b'],
  );
  assert.strictEqual(rules[0].line, 1);
  assert.strictEqual(rules[1].line, 5, '注释占了 2 行，b 必须在第 5 行');
});

test('CSS：@media 里的规则带上 media，且算进类名 / 行号', () => {
  const css = [
    ':root { --a: 1; }',
    '.top { color: red; }',
    '@media (max-width: 900px) {',
    '  .top { color: blue; }',
    '  .only-narrow { padding: 0; }',
    '}',
  ].join('\n');
  const rules = sweep.parseCssRules(css);
  assert.deepStrictEqual(
    rules.map((r) => [r.selector, r.media]),
    [
      [':root', ''],
      ['.top', ''],
      ['.top', '@media (max-width: 900px)'],
      ['.only-narrow', '@media (max-width: 900px)'],
    ],
  );
  assert.strictEqual(rules[3].line, 5);
});

test('CSS：声明里的属性名被抽出来（含自定义属性），值里的冒号 / 分号不干扰', () => {
  const rules = sweep.parseCssRules(
    '.a {\n  background: url("a;b:c");\n  --reading-font-size: 22px;\n  color: red;\n}',
  );
  assert.deepStrictEqual(rules[0].props, ['background', '--reading-font-size', 'color']);
  assert.deepStrictEqual(sweep.declaredProps('margin: 0; /* 注释 */ ; padding : 2px'), ['margin', 'padding']);
});

test('CSS 选择器：抽出类名与 id，属性选择器里的 # 不算', () => {
  assert.deepStrictEqual(sweep.namesInSelector('.a.b > .c:hover, #x .y'), {
    classes: ['a', 'b', 'c', 'y'],
    ids: ['x'],
  });
  // `[href="#app"]` 里的 #app 不是 id 选择器
  assert.deepStrictEqual(sweep.namesInSelector('[href="#app"] .z'), { classes: ['z'], ids: [] });
  // 十六进制颜色不在选择器里（声明块已被切开）
  const idx = sweep.cssIndex('a { color: #a8a49b; }\n.b { color: #fff; }');
  assert.deepStrictEqual([...idx.classes.keys()], ['b']);
  assert.deepStrictEqual([...idx.ids.keys()], []);
});

test('重复选择器：同条件块 + 属性重叠 = 真重复；只追加属性 / @media 覆盖都不算', () => {
  const realDup = sweep.duplicateSelectors(
    sweep.parseCssRules('.a { color: red; margin: 0; }\n.b { top: 0; }\n.a { color: blue; }'),
  );
  assert.strictEqual(realDup.dupes.length, 1);
  assert.strictEqual(realDup.dupes[0].selector, '.a');
  assert.deepStrictEqual(realDup.dupes[0].lines, [1, 3]);
  assert.deepStrictEqual(realDup.dupes[0].overridden, ['color'], '只有两边都写的 color 被列出来');

  const additive = sweep.duplicateSelectors(sweep.parseCssRules(':root { --a: 1; }\n.x { top: 0; }\n:root { --b: 2; }'));
  assert.deepStrictEqual(additive.dupes, [], '第二个 :root 只补变量，不是重复');

  const responsive = sweep.duplicateSelectors(
    sweep.parseCssRules('.a { color: red; }\n@media (max-width: 900px) { .a { color: blue; } }'),
  );
  assert.deepStrictEqual(responsive.dupes, [], '@media 里的同名规则是响应式覆盖');
  assert.strictEqual(responsive.mediaOverrides.length, 1);
  assert.strictEqual(responsive.mediaOverrides[0].selector, '.a');
});

// ---------------------------------------------------------------- ① HTML 解析

test('HTML：抽 id（单双引号都认，空值跳过）与 class 词表', () => {
  const html = '<div id="app" class="view  shelf-view">\n<span id=\'x\' class="muted small"></span>\n<i id=""></i>';
  assert.deepStrictEqual(
    sweep.htmlIds(html).map((d) => [d.id, d.line]),
    [
      ['app', 1],
      ['x', 2],
    ],
  );
  assert.deepStrictEqual([...sweep.htmlClassTokens(html)].sort(), ['muted', 'shelf-view', 'small', 'view']);
});

test('HTML：id 关系引用（label for / aria-* / href="#id"）都算引用', () => {
  const html = [
    '<label for="q">搜索</label>',
    '<input id="q" aria-controls="list extra" />',
    '<div aria-labelledby="h1"></div>',
    '<a href="#sec1">跳</a>',
    '<ul id="list"></ul>',
  ].join('\n');
  const refs = sweep.htmlIdReferences(html);
  for (const id of ['q', 'list', 'extra', 'h1', 'sec1']) assert.ok(refs.has(id), `缺少引用 ${id}`);
});

// ---------------------------------------------------------------- ① JS 解析

test('JS 字符串字面量：三种引号、转义还原、注释里的引号不算', () => {
  const code = [
    "// 这里有 ' 但不算",
    "const a = 'x-';",
    'const b = "y";',
    'const c = `theme-${t}`;',
    "const d = 'line\\nnext';",
    "const e = 'unterminated",
    "const f = 'ok';",
  ].join('\n');
  const values = sweep.jsStringLiterals(code).map((l) => l.value);
  assert.deepStrictEqual(values, ['x-', 'y', 'theme-${t}', 'line\nnext', 'ok']);
});

test('JS：id 引用只认明确写法（$() / getElementById / querySelector(#) / closest）', () => {
  const code = [
    "$('a');",
    'getElementById("b");',
    "document.querySelector('#c');",
    "document.querySelectorAll('#d .x');",
    "el.closest('#e');",
    "const s = 'f';", // 裸字符串不算 id 引用
  ].join('\n');
  const refs = sweep.jsIdReferences(code);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.ok(refs.has(id), `缺少引用 ${id}`);
  assert.ok(!refs.has('f'), '裸字符串不能被当成 id 引用（否则几乎每个 id 都会被算成「用过」）');
});

test('JS 顶层定义：认缩进 ≤ 2 的函数 / 箭头 / 类（含 IIFE 里的模块级），更深的嵌套与方法不算', () => {
  const code = [
    'function top() {}',
    '  const arrow = (a) => a;', // renderer.js 整份在 IIFE 里，模块级声明就是缩进 2
    '  const viaFunction = function () {};',
    '  const Klass = class {};',
    'function outer() {',
    '  function twoSpace() {}', // 缩进 2 也算进来（判定口径是启发式，见文件头），
    '    function fourSpace() {}', // 缩进 4 的明显是内层，排除
    '      const deep = () => 1;',
    '}',
    'const notFn = 42;',
    "const obj = { method() {}, other: () => 1 };",
  ].join('\n');
  assert.deepStrictEqual(
    sweep.jsTopLevelDefs('t.js', code).map((d) => [d.name, d.line, d.kind]),
    [
      ['top', 1, 'function'],
      ['arrow', 2, 'arrow'],
      ['viaFunction', 3, 'function'],
      ['Klass', 4, 'class'],
      ['outer', 5, 'function'],
      ['twoSpace', 6, 'function'],
    ],
  );
});

test('JS 模块导出：简写 / 改名 / module.exports.x 三种写法都认，嵌套键不算', () => {
  const code = [
    'module.exports = {',
    '  pad2,',
    '  clampInt,',
    '  renamed: internalName,',
    '  nested: {',
    '    inner: 1',
    '  },',
    '};',
    "module.exports.extra = function () {};",
  ].join('\n');
  assert.deepStrictEqual(
    sweep.moduleExports(code).map((e) => [e.exported, e.internal]),
    [
      ['pad2', 'pad2'],
      ['clampInt', 'clampInt'],
      ['renamed', 'internalName'],
      ['extra', 'extra'],
    ],
  );
});

test('countWord：整词匹配（$ 与 - 都算词内字符，避免 pad2 命中 pad22 / $pad2 / pad2-x）', () => {
  // `pad2` 出现 2 次可算：开头一次、末尾一次；`pad2x` / `$pad2` / `pad2-x` 都是别的名字
  assert.strictEqual(sweep.countWord('pad2 pad2x $pad2 pad2 = 1', 'pad2'), 2);
  assert.strictEqual(sweep.countWord('a.pad2(b) pad2', 'pad2'), 2);
  assert.strictEqual(sweep.countWord('pad22 pad2-x $pad2', 'pad2'), 0);
  assert.strictEqual(sweep.countWord('nothing here', 'pad2'), 0);
});

// ---------------------------------------------------------------- ① 动态拼名

test('动态拼名：模板串 / 字符串拼接都能认出前缀后缀', () => {
  const code = [
    'document.body.classList.toggle(`theme-${theme}`, true);',
    'cell.classList.add(`lv${level}`);',
    "rule.className = `proofread-rule rule-${issue.rule}`;",
    'const a = \'card-\' + kind;',
    // 真实仓库里 innerHTML 拼 class 的形态：`'<span class="x-' + cls + '">'`
    `const b = '<span class="x-' + cls + '">';`,
  ].join('\n');
  const patterns = sweep.dynamicClassPatterns(code);
  const has = (prefix, suffix) => patterns.some((p) => p.prefix === prefix && p.suffix === suffix);
  assert.ok(has('theme-', ''), '模板串前缀');
  assert.ok(has('lv', ''), '模板串前缀');
  assert.ok(has('rule-', ''), '取最后一个词当前缀（proofread-rule rule-${x}）');
  assert.ok(has('card-', ''), '字符串拼接前缀');
  assert.ok(has('x-', ''), 'innerHTML 里拼 class：从 class=" 之后取词');
});

test('动态拼名：matchesDynamicPattern 能命中真正拼出来的名字，不会误伤无关类名', () => {
  const patterns = [{ prefix: 'theme-', suffix: '' }, { prefix: 'lv', suffix: '' }];
  assert.ok(sweep.matchesDynamicPattern('theme-grid', patterns));
  assert.ok(sweep.matchesDynamicPattern('lv3', patterns));
  assert.strictEqual(sweep.matchesDynamicPattern('theme-', patterns), null, '正好等于前缀不算（那是别的东西）');
  assert.strictEqual(sweep.matchesDynamicPattern('shelf-view', patterns), null);
  // 后缀型（`x-${a}-on`）：前缀后缀都要对上
  const suffixPatterns = [{ prefix: 'state-', suffix: '-active' }];
  assert.ok(sweep.matchesDynamicPattern('state-row-active', suffixPatterns));
  assert.strictEqual(sweep.matchesDynamicPattern('state-row', suffixPatterns), null);
});

// ---------------------------------------------------------------- ② 真仓库闸门

const result = sweep.gather();

test('扫描器能读仓库：扫描范围与关键计数合理', () => {
  const c = result.counts;
  assert.ok(c.cssFiles >= 1, '至少要扫到 styles.css');
  assert.ok(c.productJs >= 40, `产品侧 JS 太少（${c.productJs}），扫描路径可能错了`);
  assert.strictEqual(c.productHtml, 1, '产品侧 HTML 只有 renderer/index.html');
  assert.ok(c.htmlIds > 200, `HTML id 数量异常（${c.htmlIds}）`);
  assert.ok(c.topLevelDefs > 500, `顶层定义数量异常（${c.topLevelDefs}）`);
  assert.ok(c.exports > 100, `模块导出数量异常（${c.exports}）`);
});

test('真仓库：没有「谁都不引用」的 CSS 类 / HTML id / 顶层函数 / 模块导出', () => {
  const fmt = (list, f) => list.map(f).join('、');
  assert.deepStrictEqual(
    result.unusedClasses.map((e) => `.${e.name}`),
    [],
    `styles.css 里有没人用的类：${fmt(result.unusedClasses, (e) => `.${e.name}@${e.cssFile}:${e.lines[0]}`)}`,
  );
  assert.deepStrictEqual(
    result.unusedHtmlIds.map((e) => `#${e.id}`),
    [],
    `index.html 里有没人引用的 id：${fmt(result.unusedHtmlIds, (e) => `#${e.id}@${e.rel}:${e.line}`)}`,
  );
  assert.deepStrictEqual(
    result.unusedCssIds.map((e) => `#${e.name}`),
    [],
    `CSS 按 id 写样式但 HTML 里没这个 id：${fmt(result.unusedCssIds, (e) => `#${e.name}`)}`,
  );
  assert.deepStrictEqual(
    result.deadDefs.map((d) => `${d.name}()@${d.file}:${d.line}`),
    [],
    '有定义了但一次没被调用的顶层函数（真死代码，删掉）',
  );
  assert.deepStrictEqual(
    result.deadExports.map((e) => `${e.name}@${e.file}`),
    [],
    '有「定义文件外 0 引用、自己也不用」的模块导出（真死代码，删掉）',
  );
});

test('真仓库：CSS 没有真重复声明（@media 响应式覆盖不算）', () => {
  assert.deepStrictEqual(
    result.dupes.map((d) => `${d.selector} 覆盖了 ${d.overridden.join('/')}`),
    [],
    '同一条件块里同一个选择器把同一批属性写了两遍——前面那份永远不生效，删掉',
  );
  // 反向确认扫描器不是「一律不报」：窄窗口适配那几组必须被认成跨条件块同名
  assert.ok(
    result.mediaOverrides.some((d) => d.selector === '.editor-header'),
    '响应式覆盖没有识别出来（说明 @media 解析坏了）',
  );
});

test('真仓库：动态拼出来的类名不会被误判成死代码', () => {
  // `.theme-grid` 由 `theme-${theme}` 拼出、`.lv1` 由 `lv${level}` 拼出、`.rule-*` 由 `rule-${issue.rule}` 拼出
  const dynamic = new Set(result.dynamicClasses.map((e) => e.name));
  for (const name of ['theme-grid', 'theme-night', 'lv1', 'lv4', 'rule-halfwidth-punct', 'rule-custom-word']) {
    assert.ok(dynamic.has(name), `.${name} 应该被认成「动态拼出」而不是「没人用」`);
  }
  assert.ok(
    result.unusedClasses.every((e) => !dynamic.has(e.name)),
    '同一个类不能既算动态拼出、又算没人用',
  );
});

test('静态闸门：扫描脚本只读，不会改仓库', () => {
  const source = fs.readFileSync(path.join(sweep.ROOT, 'scripts', 'sweep-unused.js'), 'utf8');
  // 允许出现名字（例如本文档里的说明），但不允许真的调用写接口
  for (const forbidden of [
    'writeFileSync',
    'writeFile(',
    'appendFile',
    'createWriteStream',
    'rmSync',
    'unlinkSync',
    'renameSync',
    'copyFileSync',
    'mkdirSync',
    'fs.promises',
  ]) {
    assert.ok(!source.includes(forbidden), `scripts/sweep-unused.js 不许出现 ${forbidden}（只读脚本）`);
  }
  assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(source), '扫描脚本不该 require electron');
  // 报告只能打到 stdout：没有把结果写回文件的分支
  assert.ok(source.includes('process.stdout.write'), '结果应打到 stdout');
});
