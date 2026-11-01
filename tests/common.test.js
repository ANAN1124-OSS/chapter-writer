// 公共小工具（v0.9 B-3，代码精简 B3）：pad2 / clampInt / sleep 的唯一实现。
//
// 这一轮把三个小工具从 15 个文件里的 19 份副本收进 core/common.js（pad2 原本 6 个 core 模块各一份、
// 另有 4 处内联 lambda；clampInt 3 个 core 模块 + 2 个渲染层纯逻辑模块；sleep 原子写与截图驱动各一份）。
// 「行为零变化」是硬要求，所以测试分两层：
//   1. 行为：补零 / 夹紧 / 等一会儿的边界值逐个钉住（含旧实现也会给出的怪值，例如负数补零仍是 '-1'）；
//   2. 回归闸门：仓库里不许再长出第二份实现、用到就必须从 core/common.js 拿、core/common.js 必须保持
//      纯逻辑（不 require 任何东西、不碰 process / window / document）；index.html 里 core/common.js
//      必须排在依赖它的三个文件之前；并用 node:vm 在没有 module 的沙箱里把浏览器那条加载链真跑一遍。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const common = require('../core/common');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const COMMON_SOURCE = read('core/common.js');
// 纯逻辑闸门只看代码：注释里提到 window / electron 是在解释边界，不算越界
const COMMON_CODE = COMMON_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const INDEX_SOURCE = read('renderer/index.html');
const MAIN_SOURCE = read('main.js');

const CORE_FILES = fs
  .readdirSync(path.join(ROOT, 'core'))
  .filter((name) => name.endsWith('.js') && name !== 'common.js')
  .map((name) => `core/${name}`);
const RENDERER_FILES = fs
  .readdirSync(path.join(ROOT, 'renderer'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `renderer/${name}`);
const SCRIPT_FILES = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `scripts/${name}`);

// 浏览器那条路（index.html 的 <script>）：没有 module / require 的沙箱里按顺序加载脚本，
// 模块会把对外接口挂到沙箱的 globalThis 上（window.CWXxx）。返回 context 是为了让用例能用
// 沙箱自己的 Date（跨 realm 的 Date 过不了 instanceof，会误判成「没传日期」）。
function loadInBrowserSandbox(files) {
  const win = {};
  const context = vm.createContext(win);
  for (const rel of files) vm.runInContext(read(rel), context, { filename: rel });
  return { win, context };
}

test('pad2：补零到两位，超过两位原样返回（和 String#padStart 同语义）', () => {
  assert.equal(common.pad2(0), '00');
  assert.equal(common.pad2(7), '07');
  assert.equal(common.pad2(12), '12');
  assert.equal(common.pad2(99), '99');
  assert.equal(common.pad2(100), '100');
  // 负数 / 小数 / 字符串都不是两位数字，旧实现（各模块自己那份）同样原样拼字符串
  assert.equal(common.pad2(-1), '-1');
  assert.equal(common.pad2(1.5), '1.5');
  assert.equal(common.pad2('07'), '07');
  assert.equal(common.pad2(''), '00', 'padStart 会把空串补成 "00"，旧实现同样如此');
  assert.equal(common.pad2(null), 'null');
});

test('clampInt：先向下取整，非有限数退回 fallback，其余夹到 range 两端（含端点）', () => {
  assert.equal(common.clampInt(3.9, 0, [0, 100]), 3);
  assert.equal(common.clampInt(-3.9, 0, [0, 100]), 0);
  assert.equal(common.clampInt(999, 0, [0, 100]), 100);
  assert.equal(common.clampInt(0, 42, [0, 100]), 0);
  assert.equal(common.clampInt(50, 0, [50, 20000]), 50, '下限端点照常放过');
  assert.equal(common.clampInt(20000, 0, [50, 20000]), 20000, '上限端点照常放过');
  // 数字字符串 / 布尔照旧按 Number() 走；'' 会被 Number 当成 0（JS 老规矩，旧实现一样）
  assert.equal(common.clampInt('7', 0, [0, 100]), 7);
  assert.equal(common.clampInt(true, 0, [0, 100]), 1);
  assert.equal(common.clampInt('', 42, [0, 100]), 0);
  // 真正「不是数」的一律退回 fallback
  assert.equal(common.clampInt(NaN, 42, [0, 100]), 42);
  assert.equal(common.clampInt(undefined, 42, [0, 100]), 42);
  assert.equal(common.clampInt(null, 42, [0, 100]), 0, 'Number(null) === 0，旧实现同样给 0');
  assert.equal(common.clampInt(Infinity, 42, [0, 100]), 42);
  assert.equal(common.clampInt(-Infinity, 42, [0, 100]), 42);
  assert.equal(common.clampInt('abc', 42, [0, 100]), 42);
});

test('sleep：返回 Promise，真的等够时间才 resolve，且永远是 undefined', async () => {
  const started = Date.now();
  const pending = common.sleep(30);
  assert.ok(pending instanceof Promise, 'sleep 必须返回 Promise');
  const value = await pending;
  const elapsed = Date.now() - started;
  assert.equal(value, undefined);
  assert.ok(elapsed >= 25, `实际等了 ${elapsed}ms，至少应该 ≥25ms`);
  // 并行等也照常
  const both = await Promise.all([common.sleep(10), common.sleep(10)]);
  assert.deepEqual(both, [undefined, undefined]);
});

test('core/common.js 是纯逻辑：不 require 任何模块，也不碰 process / window / document', () => {
  assert.equal(/require\s*\(/.test(COMMON_CODE), false, '不许 require（fs / path / electron 都不行）');
  assert.equal(/\bprocess\s*\./.test(COMMON_CODE), false, '不许碰 process');
  assert.equal(/\bwindow\s*\./.test(COMMON_CODE), false, '不许碰 window');
  assert.equal(/\bdocument\s*\./.test(COMMON_CODE), false, '不许碰 document');
  assert.equal(/electron/.test(COMMON_CODE), false, '不许出现 electron');
  // 对外形状固定：三个函数，多一个少一个都要在评审里看到
  assert.deepEqual(Object.keys(common).sort(), ['clampInt', 'pad2', 'sleep']);
});

test('静态闸门：仓库里不许再长出第二份 pad2 / clampInt / sleep / 内联补零', () => {
  // scripts/e2e-scenario.js 是测试脚本，里面有几处就地写的 `String(x).padStart(2, '0')` 拼期望值
  // （不是产品逻辑、没有第二个调用方），有意不扫；产品代码与驱动一律不许再抄一份。
  const files = [...CORE_FILES, ...RENDERER_FILES, 'main.js', ...SCRIPT_FILES.filter((f) => f !== 'scripts/e2e-scenario.js')];
  const patterns = [
    { re: /function pad2\s*\(/, what: '第二份 pad2 实现' },
    { re: /function clampInt\s*\(/, what: '第二份 clampInt 实现' },
    { re: /function sleep\s*\(/, what: '第二份 sleep 实现' },
    { re: /padStart\(2, ['"]0['"]\)/, what: '内联补零 String(x).padStart(2, \'0\')' }
  ];
  for (const rel of files) {
    const source = read(rel);
    for (const { re, what } of patterns) {
      assert.equal(re.test(source), false, `${rel} 里不该再有${what}（用 core/common.js）`);
    }
  }
});

test('静态闸门：用到 pad2 / clampInt / sleep 的文件必须从 core/common.js 拿', () => {
  // core/*：普通模块解构 require('./common')；core/template.js 是 UMD，解构工厂参数 common
  const wiredFromCommon = (source, name) =>
    new RegExp(
      `const \\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*(require\\('\\.\\/common'\\)|require\\('\\.\\.\\/core\\/common'\\)|common);`
    ).test(source);
  for (const rel of CORE_FILES) {
    const source = read(rel);
    for (const name of ['pad2', 'clampInt', 'sleep']) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
      assert.ok(wiredFromCommon(source, name), `${rel} 用了 ${name}，但没从 core/common.js 拿`);
    }
  }
  // 渲染层纯逻辑模块：从 '../core/common' 拿；renderer.js 走 window.CWCommon
  for (const rel of RENDERER_FILES) {
    const source = read(rel);
    const uses = ['pad2', 'clampInt'].filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
    if (!uses.length) continue;
    assert.ok(
      /require\('\.\.\/core\/common'\)/.test(source) || /window\.CWCommon/.test(source) || /commonLib\.\w+/.test(source),
      `${rel} 用了 pad2 / clampInt，但没接上 core/common.js`
    );
  }
  // 原子写与截图驱动：sleep 也是同一份
  for (const rel of ['core/atomic.js', 'scripts/screenshot-driver.js']) {
    assert.ok(/require\('\.\/common'\)|require\('\.\.\/core\/common'\)/.test(read(rel)), `${rel} 的 sleep 应该来自 core/common.js`);
  }
  assert.equal(/window\.CWCommon/.test(read('renderer/renderer.js')), true, 'renderer.js 应该用 window.CWCommon 的 pad2');
});

test('静态闸门：index.html 先加载 core/common.js，再加载依赖它的三个文件', () => {
  const commonAt = INDEX_SOURCE.indexOf('src="../core/common.js"');
  assert.ok(commonAt > 0, 'index.html 必须加载 core/common.js');
  assert.equal(INDEX_SOURCE.split('src="../core/common.js"').length - 1, 1, 'core/common.js 只该加载一次，别重复引');
  const dependents = ['src="../core/template.js"', 'src="editor-logic.js"', 'src="find-logic.js"', 'src="renderer.js"'];
  for (const needle of dependents) {
    const at = INDEX_SOURCE.indexOf(needle);
    assert.ok(at > 0, `index.html 里找不到 ${needle}`);
    assert.ok(commonAt < at, `${needle} 必须排在 core/common.js 之后（否则拿不到 window.CWCommon，启动即报错）`);
  }
});

test('浏览器加载链：按 index.html 的顺序真跑一遍，模板 / 编辑器 / 查找都拿到共享实现', () => {
  const { win, context } = loadInBrowserSandbox([
    'core/common.js',
    'core/template.js',
    'renderer/editor-logic.js',
    'renderer/find-logic.js'
  ]);
  assert.equal(typeof win.CWCommon.pad2, 'function');
  // core/template.js 的本地日期走共享的 pad2（用沙箱自己的 Date，模拟被调用方传进来的日期）
  const sandboxDate = vm.runInContext('new Date(2026, 0, 5)', context);
  assert.equal(win.CWTemplate.localDateKey(sandboxDate), '2026-01-05');
  // renderer/editor-logic.js：sanitizeThreshold 走 clampInt，formatStopwatch 走 pad2
  assert.equal(win.CWEditorLogic.sanitizeThreshold('abc'), 500, '坏值退回默认 500 字');
  assert.equal(win.CWEditorLogic.sanitizeThreshold(1), 50, '夹到下限 50 字');
  assert.equal(win.CWEditorLogic.sanitizeThreshold(999999), 20000, '夹到上限 20000 字');
  assert.equal(win.CWEditorLogic.formatStopwatch(65), '1:05');
  assert.equal(win.CWEditorLogic.formatStopwatch(3725), '1:02:05');
  // renderer/find-logic.js：高亮窗口上限走 clampInt（999999 夹到 2000、'abc' 退回 500）
  const matches = Array.from({ length: 10 }, (_, i) => ({ index: i, length: 1 }));
  assert.equal(win.CWFindLogic.highlightWindow(matches, 0, { max: 999999 }).maxItems, 2000);
  assert.equal(win.CWFindLogic.highlightWindow(matches, 0, { max: 'abc' }).maxItems, 500);
});

test('缺少 core/common.js 时三个模块直接报错（不悄悄退回旧副本）', () => {
  for (const [rel, name] of [
    ['core/template.js', 'CWTemplate'],
    ['renderer/editor-logic.js', 'CWEditorLogic'],
    ['renderer/find-logic.js', 'CWFindLogic']
  ]) {
    assert.throws(
      () => loadInBrowserSandbox([rel]),
      new RegExp(`${name}：core/common.js 没有先加载`),
      `${rel} 单独加载时必须明确报错，而不是带着 undefined 继续跑`
    );
  }
});

test('静态闸门：三个 UMD 模块在 Node 分支也把 core/common.js 传给工厂', () => {
  assert.ok(/module\.exports = factory\(require\('\.\/common'\)\);/.test(read('core/template.js')));
  for (const rel of ['renderer/editor-logic.js', 'renderer/find-logic.js']) {
    assert.ok(
      /module\.exports = factory\(require\('\.\.\/core\/common'\)\);/.test(read(rel)),
      `${rel} 的 Node 分支要从 ../core/common 取依赖`
    );
    assert.ok(/root\.CW\w+ = factory\(root\.CWCommon\);/.test(read(rel)), `${rel} 的浏览器分支要取 window.CWCommon`);
  }
});

test('静态闸门：main.js 不再留着已搬走的死代码（sleep 已随 B-1 / B-3 清掉）', () => {
  assert.equal(/\bfunction sleep\s*\(/.test(MAIN_SOURCE), false, 'main.js 里那份 sleep 没人用了');
  assert.equal(/\bsleep\s*\(/.test(MAIN_SOURCE), false, 'main.js 不该再调用 sleep（自动化代码已搬进驱动）');
});
