// v0.9 C-10：安全约束的「防回退清单」——把 C-1–C-8 已经修好的安全约束与它们各自的
// 钉住点（单测 / 真实 Electron 的 E2E 组）收成一份可执行的索引，并补上三处以前完全
// 没有测试的边界：CSP、preload 桥接暴露面、主进程安全加固的接线。
//
// 这张表就是审计结论本身（每一条都要对得上真实存在的测试，删了 / 改名了这里会红）：
//
//   约束                                 单测（node:test）                      真实 Electron（E2E）
//   路径穿越 / 伪造书路径                tests/ipc-paths.test.js                第 57 组
//   伪造配置路径（booksRoot / 词表）     tests/config-gate.test.js              第 58 组
//   IPC 参数上限 / 替换放大 / DoS        tests/ipc-limits.test.js               第 61 组
//   导入导出边界（zip 条目名 / 导入大小）tests/zip.test.js + importer.test.js   第 59 组
//   日志 / 错误脱敏（本机路径不外泄）    tests/error-text.test.js + logs.test   第 60 组
//   原子写 / 书目损坏 / 冲突副本         tests/atomic.test.js + data-safety     第 64 组
//   破坏性操作可恢复（删 / 整理 / 还原） tests/destructive-recovery.test.js     第 66 组
//   跨窗口写锁（同一本书只开一个窗口）   tests/open-books.test.js               第 55 组
//   外部篡改（外部改 / 删 txt / 冲突副本）tests/conflict.test.js + storage      第 55 / 64 组
//   Electron 安全开关 / 权限一律拒绝     tests/security-policy.test.js          第 56 组
//   CSP（指令集 / 内联 / eval / base） **本文件**                             第 56 组（运行时复核）
//   preload 暴露面（不泄漏 Node / IPC）   **本文件**                             第 56 组（window.api 实测）
//   主进程加固接线（新窗口 / 新 session） **本文件**                             第 56 组（行为实测）
//
// C-10 那一轮只补测试；v0.9 C-4 收尾把 CSP 再收紧到 object-src / base-uri / frame-src
// 一律 'none'（产品只改了 index.html 那一行 meta），本文件同步锁死并补「页面不用这些元素」
// 的闸门；版本号仍 0.8.6。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

// 取 main.js 里一个顶层函数的函数体。顶层函数的开头与结尾都在第 0 列，所以用
// `^function 名字(...) { ... ^}` 的非贪婪匹配就够；断言里再核对拿到的东西确实像函数体。
function functionBody(source, name) {
  const match = source.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `main.js 里找不到顶层函数 ${name}()`);
  return match[0];
}

// 加载 preload.js：在 vm 沙箱里把 `electron` 换成假的，记录桥接暴露了什么、
// 每个 API 实际用了哪些频道。preload 只 require('electron')，不需要别的注入。
function loadPreload({ rejectInvoke = false } = {}) {
  const calls = { invoked: [], subscribed: [], sent: [] };
  let exposed = null;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(key, api) {
        assert.equal(exposed, null, 'preload 只能 exposeInMainWorld 一次');
        exposed = { key, api };
      }
    },
    ipcRenderer: {
      async invoke(channel) {
        calls.invoked.push(channel);
        if (rejectInvoke) throw new Error('拒绝：C:\\Users\\某人\\私密\\章节.txt');
        return { ok: true, channel };
      },
      on(channel) {
        calls.subscribed.push(channel);
      },
      send(channel) {
        calls.sent.push(channel);
      }
    }
  };
  const requireShim = (id) => {
    assert.equal(id, 'electron', `preload 只该 require('electron')，实际 require('${id}')`);
    return fakeElectron;
  };
  new vm.Script(PRELOAD, { filename: 'preload.js' }).runInNewContext({ require: requireShim, console });
  assert.ok(exposed, 'preload.js 没有调用 contextBridge.exposeInMainWorld');
  return { exposed, calls };
}

// main.js 的主进程侧频道：注册（handle / handleBook）、单向通知（sendToSession /
// sendToFlow / webContents.send / broadcast）、以及两个单向接收（ipcMain.on）。
function mainChannels() {
  const handlers = [...MAIN.matchAll(/^[ \t]+(?:handleBook|handle)\('([^']+)'/gm)].map((item) => item[1]);
  const sent = new Set();
  for (const re of [
    /sendToSession\([^,\n]+,\s*'([^']+)'/g,
    /sendToFlow\('([^']+)'/g,
    /webContents\.send\('([^']+)'/g,
    /broadcast\('([^']+)'/g
  ]) {
    for (const match of MAIN.matchAll(re)) sent.add(match[1]);
  }
  const received = [...MAIN.matchAll(/ipcMain\.on\('([^']+)'/g)].map((item) => item[1]);
  return { handlers, sent: [...sent], received };
}

// ---------- CSP（C4） ----------

test('CSP：index.html 的指令集锁死（只许 self，connect-src 只为字体多一个 data:，其余一律 none）', () => {
  const meta = INDEX.match(/<meta http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(meta, 'index.html 必须带 Content-Security-Policy meta');

  const directives = {};
  for (const chunk of meta[1].split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    assert.equal(directives[parts[0]], undefined, `CSP 指令重复：${parts[0]}`);
    directives[parts[0]] = parts.slice(1);
  }
  assert.deepEqual(directives, {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'data:'],
    // v0.9 C-4 收尾：default-src 的 'self' 会兜住 object-src / frame-src（同源仍可嵌），
    // 而 base-uri 根本没有 fallback（不写就完全不限）。页面本来就不用这三样，收紧到 none。
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-src': ["'none'"],
    // form-action 也没有 fallback（default-src 不管它）：页面里没有任何 <form>，
    // 收紧到 'none' 是零行为变化的纯兜底。
    'form-action': ["'none'"]
  });
  // 任何放宽都必须先改这里再改 meta：unsafe-* / 远程来源 / 通配符一律不许出现。
  assert.doesNotMatch(meta[1], /unsafe-|http:|https:|ws:|wss:|\*/i);
});

test('CSP：页面不用 base / iframe / object / embed / form（四条 none 指令不会误伤自己）', () => {
  // 收紧到 'none' 的前提是页面真的不用这些元素；以后谁加了 <iframe> / <base>，这条会先红，
  // 逼他回来重新想 CSP，而不是让新元素在运行时被默默拦掉。
  const directiveOf = { base: 'base-uri', iframe: 'frame-src', form: 'form-action' };
  for (const tag of ['base', 'iframe', 'form', 'object', 'embed']) {
    const found = INDEX.match(new RegExp(`<${tag}\\b`, 'gi')) || [];
    assert.deepEqual(found, [], `index.html 里出现了 <${tag}>，请先复核 CSP 的 ${directiveOf[tag] || 'object-src'} 'none'`);
  }
});

test('CSP：index.html 没有内联脚本 / 内联事件处理器 / 远程资源', () => {
  const inlineHandlers = INDEX.match(/\son[a-z]+\s*=/gi) || [];
  assert.deepEqual(inlineHandlers, [], 'HTML 里不许出现 onclick 之类内联事件处理器');

  const scriptTags = INDEX.match(/<script\b/gi) || [];
  const scriptsWithSrc = INDEX.match(/<script\b[^>]*\bsrc=/gi) || [];
  assert.ok(scriptTags.length > 0, 'index.html 应该按顺序加载外部脚本');
  assert.equal(scriptsWithSrc.length, scriptTags.length, '每个 <script> 都必须带 src（不许内联）');

  assert.deepEqual(INDEX.match(/https?:\/\//gi) || [], [], 'index.html 不许引用任何远程资源');
  // 所有 src / href 都是相对路径（同目录或 ../core/…），不能是 //host 或协议相对地址。
  for (const match of INDEX.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    assert.doesNotMatch(match[1], /^[a-z][a-z0-9+.-]*:|^\/\//i, `资源必须是相对路径：${match[1]}`);
  }
});

// ---------- preload 桥接暴露面（C-1 的延伸：渲染层零 Node） ----------

test('preload：只向主世界暴露一个 api，且每个成员都是函数（不泄漏 ipcRenderer / Node）', () => {
  const { exposed } = loadPreload();
  assert.equal(exposed.key, 'api');
  const names = Object.keys(exposed.api);
  assert.ok(names.length > 80, `preload 暴露的 API 数量明显变少（${names.length}）——是不是漏了桥接？`);
  for (const name of names) {
    assert.equal(typeof exposed.api[name], 'function', `preload 暴露了非函数成员：${name}`);
  }
  // 桥接对象里绝不能出现这些名字（出现了说明把整套能力原样递给了渲染层）：
  for (const forbidden of ['ipcRenderer', 'require', 'process', 'module', 'electron', 'fs', 'child_process']) {
    assert.equal(forbidden in exposed.api, false, `preload 暴露面里出现了 ${forbidden}`);
  }
  assert.equal((PRELOAD.match(/contextBridge\.exposeInMainWorld\(/g) || []).length, 1);
});

test('preload：invoke 频道与 main.js 注册的 handle 频道一一对应（不多不少、不重复）', () => {
  const { exposed, calls } = loadPreload();
  for (const fn of Object.values(exposed.api)) fn(() => {});
  const invoked = [...new Set(calls.invoked)];
  const { handlers } = mainChannels();

  assert.equal(invoked.length, calls.invoked.length, `有 API 重复调用同一个频道：${calls.invoked.join(', ')}`);
  assert.deepEqual(
    invoked.filter((channel) => !handlers.includes(channel)),
    [],
    'preload 调用了主进程没注册的频道'
  );
  assert.deepEqual(
    handlers.filter((channel) => !invoked.includes(channel)),
    [],
    'main.js 注册了渲染层到不了的频道（要么 preload 忘暴露，要么频道已死）'
  );
  assert.equal(new Set(handlers).size, handlers.length, 'main.js 里有重复注册的频道');
});

test('preload：单向通知 / 上报频道与 main.js 一一对应（6 条通知 + 2 条上报）', () => {
  const { exposed, calls } = loadPreload();
  for (const fn of Object.values(exposed.api)) fn(() => {});
  const { sent, received } = mainChannels();

  assert.deepEqual([...calls.subscribed].sort(), [...sent].sort(), 'preload 订阅的通知与主进程实际发送的频道不一致');
  assert.deepEqual([...calls.sent].sort(), [...received].sort(), 'preload 上报的频道与主进程 ipcMain.on 的频道不一致');
  assert.equal(calls.subscribed.length, 6);
  assert.equal(calls.sent.length, 2);
});

test('preload：主进程抛错只在渲染层得到 {ok:false, code:IPC_ERROR}，不把异常抛进页面', async () => {
  const { exposed } = loadPreload({ rejectInvoke: true });
  const result = await exposed.api.appVersion();
  // 注意：返回值来自 vm 里的另一个 realm，跨 realm 的对象原型不同，不能 deepEqual，
  // 逐字段比即可（断言的语义不变）。
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IPC_ERROR');
  assert.equal(result.message, '拒绝：C:\\Users\\某人\\私密\\章节.txt');
});

// ---------- 主进程安全加固接线（C-1 / C-3） ----------

test('main.js：窗口安全开关只有 core/security-policy.js 一个来源，且只建一种窗口', () => {
  assert.equal((MAIN.match(/new BrowserWindow\(/g) || []).length, 1, 'main.js 只应有一个建窗口的地方');
  assert.equal((MAIN.match(/webPreferences\s*:/g) || []).length, 1, 'webPreferences 只许写一次');
  assert.match(
    MAIN,
    /webPreferences:\s*securityPolicy\.windowPreferences\(path\.join\(__dirname, 'preload\.js'\)\)/,
    'webPreferences 必须来自 securityPolicy.windowPreferences(preload)'
  );
});

test('main.js：每个新 webContents / session 都挂同一套加固，窗口不再自己写一份', () => {
  const web = functionBody(MAIN, 'hardenWebContents');
  assert.ok(web.includes("contents.setWindowOpenHandler(() => ({ action: 'deny' }));"));
  assert.ok(web.includes("contents.on('will-navigate', (event) => event.preventDefault());"));
  assert.ok(web.includes("contents.on('will-attach-webview'"));
  assert.ok(web.includes('delete webPreferences.preload;'));
  assert.ok(web.includes('webPreferences.nodeIntegration = false;'));
  assert.ok(web.includes('webPreferences.contextIsolation = true;'));
  assert.ok(web.includes('webPreferences.sandbox = true;'));

  const session = functionBody(MAIN, 'hardenSession');
  assert.ok(session.includes('ses.setPermissionRequestHandler(permissionHandlers.request);'));
  assert.ok(session.includes('ses.setPermissionCheckHandler(permissionHandlers.check);'));
  assert.ok(session.includes('ses.setDevicePermissionHandler(() => false);'), '设备权限（串口 / HID / USB）也要拒绝');
  assert.ok(session.includes('callback(false);'), '权限请求必须无条件拒绝');
  assert.ok(session.includes('securityPolicy.deniesPermission()'), '权限检查必须走统一策略');
  assert.ok(
    session.includes('securityPolicy.permissionLogRecord('),
    '被拒权限的日志字段必须走 core/security-policy 的清洗（不带本机路径）'
  );

  // 兜底接线：新的 webContents / session 一创建就加固；默认 session 启动时先加固一次。
  assert.ok(MAIN.includes("app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));"));
  assert.ok(MAIN.includes("app.on('session-created', (ses) => hardenSession(ses));"));
  assert.match(MAIN, /hardenSession\(electronSession\.defaultSession\);/, '默认 session 也要先加固一次');

  // 单实例锁：拿不到锁立刻退出，进程里不会同时跑两个应用实例。
  assert.match(MAIN, /const gotLock = app\.requestSingleInstanceLock\(\);/);
  assert.match(MAIN, /if \(!gotLock\) \{\s*app\.quit\(\);/);
});

// ---------- 防回退清单本身（C-10） ----------

test('防回退清单：C-1–C-8 的单测与 E2E 组都还在、并且真的挂在 E2E 组索引里', () => {
  const pins = [
    ['C-1', 'Electron 安全开关', 'tests/security-policy.test.js', 'scripts/e2e-scenario.js', 'v0.9 C-1', null],
    ['C-2', 'IPC 路径入口', 'tests/ipc-paths.test.js', 'scripts/e2e-scenario.js', 'v0.9 C-2', null],
    ['C-2b', '配置来源校验', 'tests/config-gate.test.js', 'scripts/e2e-scenario.js', 'v0.9 C-2b', null],
    ['C-3', '导入导出边界', 'tests/zip.test.js', 'scripts/e2e-scenario.js', 'v0.9 C-3', null],
    ['C-4', '日志与错误脱敏', 'tests/error-text.test.js', 'scripts/e2e/groups/60-log-redaction.js', 'v0.9 C-4', 60],
    ['C-5', 'IPC 参数上限', 'tests/ipc-limits.test.js', 'scripts/e2e/groups/61-ipc-limits.js', 'v0.9 C-5', 61],
    ['C-7', '数据安全回归', 'tests/data-safety.test.js', 'scripts/e2e/groups/64-data-safety.js', 'v0.9 C-7', 64],
    ['C-8', '破坏性操作可恢复', 'tests/destructive-recovery.test.js', 'scripts/e2e/groups/66-destructive-recovery.js', 'v0.9 C-8', 66],
    // 另外两类没有单独的 C 编号，但在 C-10 的核对范围里，同样钉住：
    // 跨窗口写锁（同一本书只开一个窗口、别的窗口正在写时拒绝）与外部篡改（外部改 / 删 txt、冲突副本）。
    ['跨窗口', '跨窗口写锁 / 同一本书只开一个窗口', 'tests/open-books.test.js', 'scripts/e2e-scenario.js', '55. 多窗口', null],
    ['外部篡改', '外部改 / 删章节文件与同步冲突副本', 'tests/conflict.test.js', 'scripts/e2e-scenario.js', '55. 多窗口', null]
  ];
  const groupIds = require('../scripts/e2e/groups').groups.map((group) => group.id);

  for (const [code, label, unitPath, e2ePath, marker, groupId] of pins) {
    const unitFile = path.join(ROOT, unitPath);
    assert.equal(fs.existsSync(unitFile), true, `${code}（${label}）的单测文件不见了：${unitPath}`);
    const unitSource = fs.readFileSync(unitFile, 'utf8');
    assert.ok(unitSource.includes("require('node:test')"), `${unitPath} 看起来不再是单测`);
    assert.ok((unitSource.match(/^test\(/gm) || []).length >= 3, `${unitPath} 里的用例少于 3 项`);

    const e2eFile = path.join(ROOT, e2ePath);
    assert.equal(fs.existsSync(e2eFile), true, `${code}（${label}）的 E2E 文件不见了：${e2ePath}`);
    assert.ok(
      fs.readFileSync(e2eFile, 'utf8').includes(marker),
      `${e2ePath} 里找不到 ${code} 的段标记「${marker}」`
    );
    if (groupId !== null) {
      assert.ok(groupIds.includes(groupId), `E2E 组索引里没有第 ${groupId} 组（${code} 的回归组）`);
    }
  }

  // C-9 依赖与供应链：这一条不靠人肉核，直接把红线写成断言。
  const pkg = require('../package.json');
  assert.equal('dependencies' in pkg, false, '项目不许有运行时依赖');
  assert.equal('optionalDependencies' in pkg, false, '项目不许有可选运行时依赖');
  assert.equal(pkg.devDependencies && pkg.devDependencies.electron, '45.1.0');
});
