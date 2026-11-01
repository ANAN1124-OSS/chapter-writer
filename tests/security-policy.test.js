const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const policy = require('../core/security-policy');

// v0.9 C-1：Electron 安全开关的期望值只有一处来源（core/security-policy.js）。
// main.js 直接展开这份常量建窗口，E2E 在真实 Electron 里用 webContents.getLastWebPreferences()
// 复核。这里锁住常量本身（谁把开关改宽了单测立刻红），以及「被拒权限」的日志字段清洗
// （日志是允许作者贴出去的，绝不能带出本机路径）。

const REQUIRED_ON = ['contextIsolation', 'sandbox', 'webSecurity'];
const REQUIRED_OFF = [
  'nodeIntegration',
  'nodeIntegrationInWorker',
  'nodeIntegrationInSubFrames',
  'allowRunningInsecureContent',
  'experimentalFeatures',
  'webviewTag',
  'spellcheck'
];

test('安全开关：窗口 webPreferences 该开的一律开、该关的一律关（不含 preload）', () => {
  for (const key of REQUIRED_ON) assert.equal(policy.WINDOW_WEB_PREFERENCES[key], true, key);
  for (const key of REQUIRED_OFF) assert.equal(policy.WINDOW_WEB_PREFERENCES[key], false, key);
  // preload 由调用方按 __dirname 拼，不写死在常量里
  assert.equal('preload' in policy.WINDOW_WEB_PREFERENCES, false);
  // 常量被冻结：运行期改不动
  assert.equal(Object.isFrozen(policy.WINDOW_WEB_PREFERENCES), true);
});

test('安全开关：windowPreferences 每次返回新对象、带上 preload、逐项等于常量', () => {
  const preload = path.join('D:', 'code', 'chapter-writer', 'preload.js');
  const prefs = policy.windowPreferences(preload);
  assert.equal(prefs.preload, preload);
  assert.notEqual(prefs, policy.WINDOW_WEB_PREFERENCES);
  for (const [key, value] of Object.entries(policy.WINDOW_WEB_PREFERENCES)) {
    assert.equal(prefs[key], value, key);
  }
  // 改返回值不能污染常量，也不影响下一次调用（main.js 每个窗口都调一次）
  prefs.nodeIntegration = true;
  prefs.sandbox = false;
  assert.equal(policy.WINDOW_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(policy.WINDOW_WEB_PREFERENCES.sandbox, true);
  assert.equal(policy.windowPreferences(preload).nodeIntegration, false);
});

test('安全开关：没有 preload 路径时直接抛错（不建没有桥接能力的窗口）', () => {
  for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
    assert.throws(() => policy.windowPreferences(bad), TypeError);
  }
});

test('安全开关：和真实窗口回读值对账（preload / spellcheck 不回读，缺键算不一致）', () => {
  // Electron 45 的真实回读形状：没有 preload / spellcheck，其余与策略一致
  const readBack = {};
  for (const key of Object.keys(policy.WINDOW_WEB_PREFERENCES)) {
    if (policy.PREFERENCES_NOT_READ_BACK.includes(key)) continue;
    readBack[key] = policy.WINDOW_WEB_PREFERENCES[key];
  }
  assert.deepEqual(policy.preferenceDiff(readBack), []);
  assert.equal('preload' in readBack, false);
  assert.equal('spellcheck' in readBack, false);
  // 任何一项被放宽都能查出来
  assert.deepEqual(policy.preferenceDiff({ ...readBack, sandbox: false }), ['sandbox']);
  assert.deepEqual(policy.preferenceDiff({ ...readBack, nodeIntegration: true }), ['nodeIntegration']);
  assert.deepEqual(policy.preferenceDiff({ ...readBack, webSecurity: false }), ['webSecurity']);
  assert.deepEqual(policy.preferenceDiff({ ...readBack, webviewTag: true }), ['webviewTag']);
  // 回读里少键（Electron 哪天不报了）也算不一致，不能悄悄放过
  const missing = { ...readBack };
  delete missing.contextIsolation;
  assert.deepEqual(policy.preferenceDiff(missing), ['contextIsolation']);
  // 坏输入：把需要核对的键全部报出来
  const expected = Object.keys(policy.WINDOW_WEB_PREFERENCES).filter(
    (key) => !policy.PREFERENCES_NOT_READ_BACK.includes(key)
  );
  assert.equal(expected.length > 0, true);
  assert.deepEqual(policy.preferenceDiff(null), expected);
  assert.deepEqual(policy.preferenceDiff(undefined), expected);
  // 不回读的键本身也要锁住（别把 preload 也塞进例外里）
  assert.deepEqual([...policy.PREFERENCES_NOT_READ_BACK], ['preload', 'spellcheck']);
});

test('权限日志：权限名只留可打印短串', () => {
  assert.equal(policy.sanitizePermissionName('geolocation'), 'geolocation');
  assert.equal(policy.sanitizePermissionName('  media  '), 'media');
  assert.equal(policy.sanitizePermissionName('clip\u0000board\r\n-read'), 'clipboard-read');
  assert.equal(policy.sanitizePermissionName('x'.repeat(200)).length, policy.MAX_PERMISSION_CHARS);
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(policy.sanitizePermissionName(bad), '');
  }
});

test('权限日志：来源只留协议 + 主机，本机路径不写进日志', () => {
  assert.equal(policy.safeOrigin('https://example.com/a/b?c=1#d'), 'https://example.com');
  assert.equal(policy.safeOrigin('https://user:pw@example.com:8443/x'), 'https://example.com:8443');
  assert.equal(policy.safeOrigin('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173');
  // file:// 只剩协议：盘符 / 用户名 / 书名 / 文件名都不留
  const fileOrigin = policy.safeOrigin('file:///C:/Users/uid72/Documents/%E4%B9%A6/ch1.txt');
  assert.equal(fileOrigin, 'file://');
  assert.equal(fileOrigin.includes('uid72'), false);
  assert.equal(fileOrigin.includes('C:'), false);
  // 不透明来源（没有可记的主机）
  assert.equal(policy.safeOrigin('about:blank'), 'opaque');
  assert.equal(policy.safeOrigin('data:text/html,<b>x</b>'), 'opaque');
  // blob 的来源就是它内层文档的 origin
  assert.equal(policy.safeOrigin('blob:https://example.com/123'), 'https://example.com');
  // 坏输入
  for (const bad of [undefined, null, '', '   ', 'not a url', 42, {}, '/home/user/x']) {
    assert.equal(policy.safeOrigin(bad), 'unknown');
  }
});

test('权限日志：一条被拒请求的字段形状（权限名 + 来源 + denied）', () => {
  assert.deepEqual(policy.permissionLogRecord('geolocation', 'file:///C:/secret/ch1.txt'), {
    permission: 'geolocation',
    origin: 'file://',
    denied: true
  });
  // 坏输入也安全：不会把 undefined / 本机路径塞进日志
  assert.deepEqual(policy.permissionLogRecord(undefined, undefined), {
    permission: 'unknown',
    origin: 'unknown',
    denied: true
  });
});

test('权限策略：任何权限都拒绝（请求回调与检查都拿 false）', () => {
  assert.equal(policy.deniesPermission(), false);
  assert.equal(policy.deniesPermission('geolocation'), false);
  assert.equal(policy.deniesPermission('media', 'file:///C:/x'), false);
});

test('发版配置：electronFuses / asar / 零运行时依赖都还锁着（改宽了单测立刻红）', () => {
  const pkg = require('../package.json');
  const fuses = pkg.build.electronFuses;
  assert.equal(fuses.runAsNode, false);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.onlyLoadAppFromAsar, true);
  assert.equal(pkg.build.asar, true);
  // 项目只有 devDependencies：不允许出现运行时依赖（红线）
  assert.equal('dependencies' in pkg, false);
  assert.equal('optionalDependencies' in pkg, false);
  assert.equal(typeof pkg.devDependencies.electron, 'string');
  // 新增的 core 模块会被 build.files 里的 core/**/* 带上，不需要额外配置
  assert.equal(pkg.build.files.includes('core/**/*'), true);
});
