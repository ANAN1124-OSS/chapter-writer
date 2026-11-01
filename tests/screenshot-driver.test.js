// 截图 / E2E 驱动（v0.9 B-1，代码审计 F7）：
// 这段代码原来整块长在 main.js 里（约 620 行），只有 --screenshot / --e2e 才会执行。
// 这里锁三件事：
//   1. 驱动能脱离 Electron 单独 require（不 require electron / main.js），纯逻辑部分直接跑；
//   2. 注入脚本（--dialog 截图用的 JS 片段）语法有效、行为可预期；
//   3. 静态闸门：main.js 里不能再长出截图 / 自检代码、驱动必须懒加载、打包配置不含 scripts/。
// 真实 Electron 侧（截图 / 1150 项 E2E）仍由 scripts/e2e-scenario.js 与截图命令覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const driver = require('../scripts/screenshot-driver');

const ROOT = path.join(__dirname, '..');
const DRIVER_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'screenshot-driver.js'), 'utf8');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function fakeWin(exec) {
  return { webContents: { executeJavaScript: exec } };
}

// run(host) 的最小 host：单个用例只覆盖自己关心的字段，其余按「什么都不做」给。
function baseHost(overrides = {}) {
  return {
    fs: fsp,
    path,
    app: { exit: () => {}, getPath: () => os.tmpdir(), hasSingleInstanceLock: () => true },
    storage: {},
    repair: {},
    exporter: {},
    isE2E: false,
    getConfig: async () => ({}),
    argValue: () => null,
    getPermissionHandlers: () => ({ request: null, check: null }),
    clipboard: {},
    screenshot: { path: null, book: null, chapter: null, dialog: null },
    getWin: () => null,
    createWindow: () => {
      throw new Error('单元测试不该建窗口');
    },
    sessionById: () => null,
    focusSession: () => false,
    listSessions: () => [],
    setClipboard: () => {},
    setRealClose: () => false,
    isWindowAllClosed: () => false,
    getCloseReady: () => undefined,
    resetCloseReady: () => {},
    getLastPermissionDenial: () => null,
    getContentTypes: () => [],
    ...overrides
  };
}

test('驱动可脱离 Electron 单独 require：入口齐全，且不 require electron / main.js', () => {
  assert.equal(typeof driver.run, 'function');
  assert.equal(typeof driver.waitForRenderer, 'function');
  assert.equal(typeof driver.createE2EClipboard, 'function');
  assert.equal(typeof driver.screenshotCaretLongLineScript, 'function');
  assert.equal(typeof driver.SCREENSHOT_PICK_CHAR_JS, 'string');
  assert.equal(typeof driver.SCREENSHOT_PICK_VOLUME_JS, 'string');
  assert.equal(/require\(['"]electron['"]\)/.test(DRIVER_SOURCE), false);
  assert.equal(/require\(['"]\.\.?\/main/.test(DRIVER_SOURCE), false);
  assert.equal(/\bautomationWin\b/.test(DRIVER_SOURCE), false, '主进程的窗口变量不该泄漏到驱动里');
  // 宿主能力必须全从 host 来：驱动自己不开窗口、不退出应用
  assert.equal(/new BrowserWindow|app\.quit\(/.test(DRIVER_SOURCE), false);
});

test('waitForRenderer：页面没准备好就一直等，准备好就返回；执行脚本抛错也继续等', async () => {
  const seen = [];
  let calls = 0;
  const win = fakeWin(async (expr, userGesture) => {
    seen.push([expr, userGesture]);
    calls += 1;
    if (calls < 3) throw new Error('页面还没加载完');
    return 'ready';
  });
  assert.equal(await driver.waitForRenderer(win, 'window.__cwTest.ready', 3000), 'ready');
  assert.equal(calls, 3);
  assert.deepEqual(seen[0], ['window.__cwTest.ready', true], '注入脚本要用 userGesture=true 执行');
});

test('waitForRenderer：超过时限抛「等待超时：<表达式>」，不会把主进程卡死', async () => {
  let calls = 0;
  const win = fakeWin(async () => {
    calls += 1;
    return false;
  });
  await assert.rejects(
    () => driver.waitForRenderer(win, 'window.__cwTest.never', 30),
    (err) => err instanceof Error && err.message === '等待超时：window.__cwTest.never'
  );
  assert.ok(calls >= 1);
});

test('createE2EClipboard：系统剪贴板可用时原样使用（synthetic=false）', async () => {
  let text = '';
  const clipboard = {
    writeText: async (value) => {
      text = String(value);
    },
    readText: async () => text
  };
  const result = await driver.createE2EClipboard(clipboard);
  assert.equal(result.synthetic, false);
  assert.equal(result.clipboard, clipboard);
  assert.match(text, /^cw-clip-probe-\d+-[a-z0-9]+$/);
});

test('createE2EClipboard：锁屏 / 无交互桌面（读写抛错或读不回来）时退回进程内剪贴板', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const throwing = {
      writeText: async () => {
        const err = new Error('Access is denied.');
        err.code = 'ACCESS_DENIED';
        throw err;
      },
      readText: async () => ''
    };
    const result = await driver.createE2EClipboard(throwing);
    assert.equal(result.synthetic, true);
    assert.notEqual(result.clipboard, throwing);
    await result.clipboard.writeText('复制整本');
    assert.equal(await result.clipboard.readText(), '复制整本');
    await result.clipboard.writeText(null);
    assert.equal(await result.clipboard.readText(), '');
    await result.clipboard.writeText(42);
    assert.equal(await result.clipboard.readText(), '42');
    // 写成功但读不回来（锁屏时 OpenClipboard 可能返回空串）也要退回
    const emptyRead = { writeText: async () => {}, readText: async () => '' };
    assert.equal((await driver.createE2EClipboard(emptyRead)).synthetic, true);
  } finally {
    console.warn = originalWarn;
  }
});

test('注入脚本：三个 --dialog 片段语法有效，caret 脚本的 extra 接在最后', () => {
  const plain = driver.screenshotCaretLongLineScript();
  assert.match(plain, /window\.__cwTest\.setCaret\(target\)/);
  assert.match(plain, /window\.__cwTest\.setEditorScroll/);
  assert.match(plain, /getElementById\('editor'\)/);
  assert.equal(plain.includes('${'), false, '不能留下没展开的模板占位');
  const withExtra = driver.screenshotCaretLongLineScript('window.__cwTest.openFormatMenu();');
  assert.ok(withExtra.includes('window.__cwTest.openFormatMenu();'));
  assert.ok(withExtra.indexOf('openFormatMenu') > withExtra.indexOf('setEditorScroll'));
  for (const script of [
    plain,
    withExtra,
    driver.SCREENSHOT_PICK_CHAR_JS,
    driver.SCREENSHOT_PICK_VOLUME_JS
  ]) {
    assert.doesNotThrow(() => new Function(script), '注入脚本必须是合法 JS');
  }
});

test('SCREENSHOT_PICK_CHAR_JS：按汉字出现次数挑最多的那个字，空文本回空串', () => {
  const runPick = (text) => {
    const fn = new Function(
      'window',
      `${driver.SCREENSHOT_PICK_CHAR_JS}\nreturn { text: best, count: bestCount };`
    );
    return fn({ __cwTest: { text: () => text } });
  };
  assert.deepEqual(runPick('风雨风，风停了'), { text: '风', count: 3 });
  assert.deepEqual(runPick(''), { text: '', count: 0 });
  assert.deepEqual(runPick('abc 123，。'), { text: '', count: 0 });
});

test('SCREENSHOT_PICK_VOLUME_JS：选中「按卷导出」并挑第一个卷，派发 change', () => {
  const events = [];
  const radio = {
    clicks: 0,
    click() {
      this.clicks += 1;
    }
  };
  const select = {
    selectedIndex: 0,
    options: [{}, {}],
    dispatchEvent(event) {
      events.push(event.type);
    }
  };
  const document = {
    querySelector(selector) {
      assert.equal(selector, 'input[name="export-scope"][value="volume"]');
      return radio;
    },
    getElementById(id) {
      assert.equal(id, 'export-volume');
      return select;
    }
  };
  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }
  new Function('window', 'document', 'Event', driver.SCREENSHOT_PICK_VOLUME_JS)(
    {},
    document,
    FakeEvent
  );
  assert.equal(radio.clicks, 1);
  assert.equal(select.selectedIndex, 1);
  assert.deepEqual(events, ['change']);
});

test('run：--screenshot 流程能截图落盘（等页面 → 截屏 → 写 PNG → exit 0）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shot-unit-'));
  const target = path.join(dir, 'nested', 'shot.png');
  const png = Buffer.from('fake-png-bytes');
  const executed = [];
  const exits = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await driver.run(
      baseHost({
        app: { exit: (code) => exits.push(code), getPath: () => dir, hasSingleInstanceLock: () => true },
        screenshot: { path: target, book: null, chapter: null, dialog: null },
        getWin: () => ({
          webContents: {
            executeJavaScript: async (expr) => {
              executed.push(expr);
              return true;
            },
            capturePage: async () => ({ toPNG: () => png })
          }
        })
      })
    );
    assert.deepEqual(exits, [0]);
    assert.deepEqual(executed, ['Boolean(window.__cwTest && window.__cwTest.ready)']);
    assert.deepEqual(fs.readFileSync(target), png);
    assert.ok(logs.includes(`[screenshot] ${target}`));
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run：驱动出错时打印 E2E_RESULT 并 exit 1，不把异常抛回启动流程', async () => {
  const exits = [];
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => errors.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await driver.run(
      baseHost({
        app: { exit: (code) => exits.push(code), getPath: () => os.tmpdir(), hasSingleInstanceLock: () => true },
        screenshot: { path: 'whatever.png', book: null, chapter: null, dialog: null },
        getWin: () => {
          throw new Error('窗口没建好');
        }
      })
    );
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some((line) => line.includes('[automation] 失败:')));
    const line = logs.find((item) => item.startsWith('E2E_RESULT '));
    assert.ok(line, '必须回一条 E2E_RESULT 给 scripts/run-e2e.js');
    const result = JSON.parse(line.slice('E2E_RESULT '.length));
    assert.equal(result.ok, false);
    assert.match(result.error, /窗口没建好/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test('静态闸门：main.js 不再内嵌截图 / 自检代码，驱动只能懒加载', () => {
  assert.equal(/window\.__cwTest/.test(MAIN_SOURCE), false, '截图注入脚本必须留在驱动里');
  assert.equal(/capturePage/.test(MAIN_SOURCE), false);
  assert.equal(/SCREENSHOT_PICK/.test(MAIN_SOURCE), false);
  assert.equal(/screenshotCaretLongLineScript/.test(MAIN_SOURCE), false);
  assert.equal(/async function waitForRenderer/.test(MAIN_SOURCE), false);
  assert.equal(/async function createE2EClipboard/.test(MAIN_SOURCE), false);
  const requireAt = MAIN_SOURCE.indexOf("require('./scripts/screenshot-driver.js')");
  assert.ok(requireAt > 0, 'main.js 必须懒加载 scripts/screenshot-driver.js');
  const lineStart = MAIN_SOURCE.lastIndexOf('\n', requireAt) + 1;
  const requireLine = MAIN_SOURCE.slice(lineStart, MAIN_SOURCE.indexOf('\n', requireAt)).replace(
    /\r$/,
    ''
  );
  assert.match(
    requireLine,
    /^\s+const driver = require\('\.\/scripts\/screenshot-driver\.js'\);$/,
    'require 必须在函数里（有缩进），不能是顶层'
  );
  const defAt = MAIN_SOURCE.indexOf('async function runAutomation');
  assert.ok(defAt > 0 && requireAt > defAt, '懒加载要发生在 runAutomation() 里');
  assert.equal(
    (MAIN_SOURCE.match(/runAutomation\(\)/g) || []).length,
    2,
    'runAutomation 只应有定义 + createWindow 自动化分支那一处调用'
  );
});

test('静态闸门：打包配置不含 scripts/，所以驱动不会进安装包（顶层 require 会直接崩）', () => {
  assert.deepEqual(PKG.build.files, ['main.js', 'preload.js', 'core/**/*', 'renderer/**/*', 'package.json']);
  assert.equal(PKG.main, 'main.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'screenshot-driver.js')));
  // 驱动里没有任何顶层可执行逻辑：上面已经 require 过它，没有副作用（不会退出应用 / 建窗口）
});
