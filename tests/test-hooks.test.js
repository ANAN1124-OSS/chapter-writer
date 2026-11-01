/* 测试钩子拆分（v0.9 B-2，代码审计 F5）的自检
 *
 * 拆完以后「钩子还在不在、活绑定还是活的、renderer.js 有没有留残渣」靠这里钉住：
 * - 行为：Node 里直接 require + create（不需要 DOM），活绑定（模块级 let）必须读最新值；
 * - 契约：钩子里用到的每个 host.X 都必须由 renderer.js 的 testHooksScope() 提供，
 *   反过来 scope 里的每个名字都必须真的在 renderer.js 有模块级声明（写错一个字只会在
 *   ?test=1 时 ReferenceError，E2E 才会红——这条静态闸门把问题提前到单测）；
 * - 静态闸门：renderer.js 不许再内嵌钩子、index.html 不许静态加载 test-hooks.js
 *   （证明「只有 ?test=1 才加载」这件事没被后来的人改回去）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_HOOKS = path.join(__dirname, '..', 'renderer', 'test-hooks.js');
const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

const testHooksSrc = fs.readFileSync(TEST_HOOKS, 'utf8');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const indexSrc = fs.readFileSync(INDEX, 'utf8');
const hooksModule = require(TEST_HOOKS);

/** 去掉注释（保留字符串里的内容），静态闸门要排除注释里的示例 */
function stripComments(src) {
  let out = '';
  let mode = null; // null | "'" | '"' | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === '//') {
      if (ch === '\n') {
        mode = null;
        out += ch;
      }
      continue;
    }
    if (mode === '/*') {
      if (ch === '*' && next === '/') {
        mode = null;
        i += 1;
      }
      continue;
    }
    if (mode) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] || '';
        i += 1;
        continue;
      }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = '//';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = '/*';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') mode = ch;
    out += ch;
  }
  return out;
}

const testHooksCode = stripComments(testHooksSrc);
const rendererCode = stripComments(rendererSrc);

/** renderer.js 里 testHooksScope() 返回对象的键（shorthand / get / set 三种写法） */
function scopeKeys(src) {
  const start = src.indexOf('function testHooksScope()');
  assert.ok(start > 0, 'renderer.js 里找不到 testHooksScope()');
  const end = src.indexOf('\n    };', start);
  assert.ok(end > start, 'testHooksScope() 的对象字面量没找到收尾');
  const block = src.slice(start, end);
  const keys = new Set();
  for (const line of block.split('\n')) {
    const shorthand = /^\s{6}([A-Za-z_$][\w$]*),\s*$/.exec(line);
    if (shorthand) keys.add(shorthand[1]);
    const accessor = /^\s{6}(?:get|set) ([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (accessor) keys.add(accessor[1]);
  }
  return keys;
}

/** 桩宿主：任何取不到的名字都返回一个空函数，够 create() 建表（create 本身不许碰 DOM） */
function stubHost(extra = {}) {
  return new Proxy(extra, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      return () => {};
    },
    has() {
      return true;
    }
  });
}

test('测试钩子模块：Node 里能 require、导出 create，create() 不碰 DOM', () => {
  assert.strictEqual(typeof hooksModule, 'object');
  assert.strictEqual(typeof hooksModule.create, 'function');
  const host = stubHost({ state: { view: 'shelf' } });
  const hooks = hooksModule.create(host);
  assert.strictEqual(typeof hooks, 'object');
  assert.strictEqual(hooks.ready, false, 'ready 由 renderer.js 装配后才置 true');
  assert.strictEqual(hooks.state, host.state, 'state 必须是渲染层同一个对象（不是拷贝）');
  assert.strictEqual(typeof hooks.save, 'function');
  assert.strictEqual(typeof hooks.handleCloseRequest, 'function');
});

test('测试钩子模块：拆分前后钩子名称与数量不变（460 个）', () => {
  const hooks = hooksModule.create(stubHost());
  const names = Object.keys(hooks).sort();
  assert.strictEqual(names.length, 460, '钩子数量变了：拆文件时漏了 / 多了，核对 E2E 引用');
  // 每个功能域各抽一个，防止「数量对但换了一批」
  for (const name of [
    'ready', 'state', 'newBook', 'openBookPath', 'openBookInNewWindow', 'releaseBook', 'windowInfo',
    'newChapter', 'insertAfter', 'renameChapterAt', 'deleteChapterAt', 'switchTo', 'setText', 'text',
    'save', 'saveVisible', 'toasts', 'clearToasts', 'setTestVerifyBook', 'chapterTitles',
    'openFindPanel', 'closeFindPanel', 'openProofreadPanel', 'proofreadRun', 'openSensitivePanel',
    'sensitiveRun', 'ttsFakeState', 'ttsFakeFinish',
    'formatCurrentChapter', 'runFormatBook', 'exportFormat', 'fontDecodeMode', 'setInput', 'setSelect',
    'handleCloseRequest'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(hooks, name), `钩子丢了: ${name}`);
  }
});

test('活绑定：exportFormat 每次读最新值（不是 create 时的快照）', () => {
  let current = { enabled: false };
  const hooks = hooksModule.create({
    get exportFormat() {
      return current;
    }
  });
  assert.deepStrictEqual(hooks.exportFormat(), { enabled: false });
  current = { enabled: true, to: 'traditional' };
  assert.deepStrictEqual(hooks.exportFormat(), { enabled: true, to: 'traditional' });
});

test('活绑定：fakeSpeechState 读的是当前状态（含展开复制）', () => {
  let fake = { spoken: [], last: null, paused: false, speaking: false, pending: null };
  const hooks = hooksModule.create({
    get fakeSpeechState() {
      return fake;
    }
  });
  assert.deepStrictEqual(hooks.ttsFakeState(), {
    spoken: [], last: null, paused: false, speaking: false, hasPending: false
  });
  fake = {
    spoken: [{ text: '第一句' }],
    last: { text: '第二句' },
    paused: true,
    speaking: true,
    pending: { token: 3 }
  };
  const state1 = hooks.ttsFakeState();
  assert.deepStrictEqual(state1, {
    spoken: [{ text: '第一句' }], last: { text: '第二句' }, paused: true, speaking: true, hasPending: true
  });
  // 返回的是副本：改它不许影响内部状态
  state1.spoken.push({ text: '外部乱加' });
  state1.last.text = '被改了';
  assert.strictEqual(hooks.ttsFakeState().spoken.length, 1);
  assert.strictEqual(hooks.ttsFakeState().last.text, '第二句');
});

test('活绑定：formatBookProgressEl / lastFontDecodeMode 也读最新值', () => {
  let el = null;
  let mode = 'fetch';
  const hooks = hooksModule.create({
    get formatBookProgressEl() {
      return el;
    },
    get lastFontDecodeMode() {
      return mode;
    }
  });
  assert.strictEqual(hooks.formatBookProgressText(), '', '没有进度元素时给空串');
  el = { textContent: '正在整理第 3 / 12 章' };
  assert.strictEqual(hooks.formatBookProgressText(), '正在整理第 3 / 12 章');
  assert.strictEqual(hooks.fontDecodeMode(), 'fetch');
  mode = 'atob';
  assert.strictEqual(hooks.fontDecodeMode(), 'atob');
});

test('活绑定：setTestVerifyBook 写回宿主（函数原样、非函数归 null）', () => {
  const written = [];
  const hooks = hooksModule.create({
    set testVerifyBook(value) {
      written.push(value);
    }
  });
  const fn = async () => ({ ok: true });
  hooks.setTestVerifyBook(fn);
  hooks.setTestVerifyBook('不是函数');
  hooks.setTestVerifyBook(null);
  assert.strictEqual(written[0], fn, '函数必须原样写回去（E2E 靠它替换全书校验）');
  assert.strictEqual(written[1], null);
  assert.strictEqual(written[2], null);
});

test('契约闸门：钩子里用到的 host.X 都由 testHooksScope() 提供', () => {
  const used = new Set();
  for (const m of testHooksCode.matchAll(/\bhost\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  const provided = scopeKeys(rendererCode);
  const missing = [...used].filter((name) => !provided.has(name));
  assert.deepStrictEqual(missing, [], '这些名字钩子在用，但 testHooksScope() 没给：' + missing.join(', '));
  // 活绑定必须是 getter / setter，不能是普通值（否则等于快照）
  const scopeStart = rendererCode.indexOf('function testHooksScope()');
  const scopeBlock = rendererCode.slice(scopeStart, rendererCode.indexOf('\n    };', scopeStart));
  for (const name of used) {
    assert.match(
      scopeBlock,
      new RegExp('(?:get|set) ' + name.replace(/\$/g, '\\$') + '\\s*\\('),
      `活绑定 ${name} 必须是 testHooksScope() 里的 get / set 访问器`
    );
  }
});

test('契约闸门：testHooksScope() 的每个键都是 renderer.js 的模块级声明', () => {
  const keys = scopeKeys(rendererCode);
  assert.ok(keys.size > 150, 'testHooksScope() 的键太少（' + keys.size + '），是不是被误删了');
  const missing = [];
  for (const name of keys) {
    const plain = name.replace(/\$/g, '\\$');
    const declared =
      new RegExp('^  (?:const|let|var) ' + plain + '\\s*=', 'm').test(rendererCode) ||
      new RegExp('^  (?:async )?function ' + plain + '\\s*\\(', 'm').test(rendererCode) ||
      new RegExp('^  (?:const|let|var) \\{[^}]*\\b' + plain + '\\b', 'm').test(rendererCode);
    if (!declared) missing.push(name);
  }
  assert.deepStrictEqual(missing, [], 'testHooksScope() 里有名字在 renderer.js 找不到模块级声明：' + missing.join(', '));
});

test('契约闸门：钩子文件不碰 window / require / 文件系统（纯渲染层内部调用）', () => {
  assert.ok(!/\brequire\s*\(/.test(testHooksCode), '测试钩子文件不许 require');
  assert.ok(!/window\./.test(testHooksCode), '测试钩子文件不许直接摸 window（挂载由 renderer.js 做）');
  assert.ok(!/\bprocess\./.test(testHooksCode), '测试钩子文件不许摸 process');
  assert.ok(!/\b__cwTest\b/.test(testHooksCode), 'window.__cwTest 的装配留在 renderer.js');
});

test('静态闸门：renderer.js 不再内嵌测试钩子', () => {
  assert.ok(!/function createTestHooks\s*\(/.test(rendererCode), 'renderer.js 里不许再有 createTestHooks');
  assert.ok(!/= createTestHooks\(\)/.test(rendererCode), 'renderer.js 里不许再调用 createTestHooks');
  // 抽几个只可能出现在钩子里的名字：出现在 renderer.js 就说明又搬回来了
  for (const name of ['ttsFakeState', 'setTestVerifyBook', 'formatBookProgressText', 'fontDecodeMode', 'setInput']) {
    assert.ok(!rendererCode.includes(name), `renderer.js 里不该再有测试钩子 ${name}`);
  }
  const lines = rendererSrc.split(/\r?\n/).length;
  assert.ok(lines < 9600, `renderer.js 又胖了（${lines} 行），测试钩子应留在 test-hooks.js`);
});

test('静态闸门：test-hooks.js 只在 ?test=1 时动态加载（index.html 没有静态 script）', () => {
  assert.ok(!/<script[^>]+test-hooks\.js/.test(indexSrc), 'index.html 不许静态加载 test-hooks.js');
  assert.match(rendererCode, /function loadTestHooks\s*\(\)/, 'renderer.js 必须有 loadTestHooks()');
  assert.match(rendererCode, /script\.src = 'test-hooks\.js'/, '动态加载必须指向 test-hooks.js');
  // 加载与装配必须在 init 的 testMode 分支里（文件里还有一处 toast 用的 testMode 判断，取最后一处）
  const testModeAt = rendererCode.lastIndexOf('if (state.testMode) {');
  assert.ok(testModeAt > 0, 'init 里的 testMode 分支没了');
  const tail = rendererCode.slice(testModeAt, testModeAt + 800);
  assert.match(tail, /await loadTestHooks\(\)/, '加载钩子必须在 testMode 分支里（正常启动不许加载）');
  assert.match(tail, /window\.CWTestHooks\.create\(testHooksScope\(\)\)/, '装配必须走 CWTestHooks.create(testHooksScope())');
  assert.match(tail, /window\.__cwTest\.ready = true/, 'E2E 靠 ready 标志判断启动完成');
});

test('静态闸门：pnpm test 只扫 tests/（产品目录里的 test-*.js 不该被当成测试执行）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  // renderer/test-hooks.js 这个名字正好命中 node 默认的 test-*.js 测试文件模式（`node --test`
  // 会把它当测试文件跑一遍、多报一个空测试），所以 test 脚本要限定在 tests/ 目录。
  assert.match(pkg.scripts.test, /tests\/\*\*/, 'pnpm test 必须限定在 tests/ 目录');
  assert.notStrictEqual(pkg.scripts.test.trim(), 'node --test');
});
