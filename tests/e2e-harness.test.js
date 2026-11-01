// E2E 工具与组拆分（v0.9 B-7，测试可维护性）：
// scripts/e2e-scenario.js 原来是「一个函数 1.2 万行」，第 60–62 组先搬出去（086153f），
// 第 52 组日志与错误随后搬（2026-11-02），公共工具（check / waitFor / 删书重试 / 读日志 / 文件存在）
// 收在 scripts/e2e/harness.js。这里锁四件事：
//   1. harness 的每个工具行为与拆分前一致（等待 / 重试 / 读日志 / 抛错文案 / 文件存在）；
//   2. 组索引能单独 require（不依赖 Electron），组号唯一有序、按参数顺序派发；
//   3. 静态闸门：场景里不许再长出第二份 harness 工具、搬走的断言不许留副本、执行顺序不变；
//   4. 组文件只 require node 内建，不 require 产品代码（拆组不许牵出新的耦合）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHarness } = require('../scripts/e2e/harness');

const ROOT = path.join(__dirname, '..');
const SCENARIO_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e-scenario.js'), 'utf8');
const HARNESS_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e', 'harness.js'), 'utf8');
const GROUPS_DIR = path.join(ROOT, 'scripts', 'e2e', 'groups');
const INDEX_SOURCE = fs.readFileSync(path.join(GROUPS_DIR, 'index.js'), 'utf8');

// 最小 ctx：只给 harness 真正用到的三个能力，sleep 立即返回（测试不真的等）。
function makeHarness(overrides = {}) {
  const sleeps = [];
  const harness = createHarness({
    exec: async () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    userData: os.tmpdir(),
    ...overrides
  });
  return { harness, sleeps };
}

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('harness.check：通过时只记一条，失败时抛错并带上现场（名称 / detail）', () => {
  const { harness } = makeHarness();
  harness.check('通过项', true);
  assert.deepEqual(harness.checks, [{ name: '通过项', ok: true }]);

  assert.throws(
    () => harness.check('失败项', 0, { where: 'shelf' }),
    (err) => err instanceof Error && /检查失败：失败项 :: \{"where":"shelf"\}/.test(err.message)
  );
  // 失败也要留档（排查时能看到卡在哪一条），ok 为 false
  assert.deepEqual(harness.checks[1], { name: '失败项', ok: false });

  // detail 不传时不该出现多余的 ` :: ` 尾巴
  assert.throws(() => harness.check('无现场', false), /^Error: 检查失败：无现场$/);
});

test('harness.waitFor：逐次重试直到真值；超时抛错并附 activeElement / hasFocus 现场', async () => {
  const seen = [];
  const { harness } = makeHarness({
    exec: async (expr) => {
      seen.push(expr);
      return expr === 'ready()' ? seen.length >= 3 && 'ok' : null;
    }
  });
  assert.equal(await harness.waitFor('ready()'), 'ok');
  assert.equal(seen.filter((expr) => expr === 'ready()').length, 3);

  const diag = '{"activeId":"btn-format","hasFocus":false}';
  const timeoutHarness = makeHarness({
    exec: async (expr) => (expr.startsWith('JSON.stringify') ? diag : ''),
    sleep: async () => {}
  }).harness;
  await assert.rejects(
    () => timeoutHarness.waitFor('never()', 0),
    (err) => err instanceof Error && err.message.startsWith('等待超时：never()') && err.message.includes(diag)
  );
});

test('harness.readLogs：只认日志文件名，按名字排序拼接；目录不存在时返回空而不报错', async () => {
  const userData = await tempDir('cw-harness-logs-');
  const logDir = path.join(userData, 'logs');
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.writeFile(path.join(logDir, 'chapter-writer-2026-10-31.log'), 'OLD\n', 'utf8');
  await fsp.writeFile(path.join(logDir, 'chapter-writer-2026-11-01.123.log'), 'NEW\n', 'utf8');
  await fsp.writeFile(path.join(logDir, 'chapter-writer-2026-11-01.log.bak'), 'BAK\n', 'utf8');
  await fsp.writeFile(path.join(logDir, 'other.log'), 'OTHER\n', 'utf8');

  const { harness } = makeHarness({ userData });
  assert.equal(harness.logDir, logDir);
  const first = await harness.readLogs();
  assert.deepEqual(first.names.sort(), [
    'chapter-writer-2026-10-31.log',
    'chapter-writer-2026-11-01.123.log',
    'chapter-writer-2026-11-01.log.bak',
    'other.log'
  ]);
  // 只拼接匹配命名的两份，且按名字排序（10-31 在前）
  assert.equal(first.text, 'OLD\nNEW\n');

  const empty = makeHarness({ userData: path.join(userData, 'nope') }).harness;
  assert.deepEqual(await empty.readLogs(), { names: [], text: '' });
});

test('harness.waitForLog：等到日志里出现关键字就返回全文，等不到抛「等待日志超时」', async () => {
  const userData = await tempDir('cw-harness-waitlog-');
  const logDir = path.join(userData, 'logs');
  await fsp.mkdir(logDir, { recursive: true });
  const file = path.join(logDir, 'chapter-writer-2026-11-01.log');
  await fsp.writeFile(file, 'INFO app-start\n', 'utf8');

  // 第一次读还没有 → sleep 期间补上（模拟日志异步落盘）；sleep 是注入的，测试不用真等
  let appended = false;
  const { harness } = makeHarness({
    userData,
    sleep: async () => {
      if (appended) return;
      appended = true;
      await fsp.appendFile(file, 'WARN save-failed\n', 'utf8');
    }
  });
  const text = await harness.waitForLog('save-failed', 1000);
  assert.ok(text.includes('save-failed'));

  await assert.rejects(
    () => makeHarness({ userData }).harness.waitForLog('不存在的行', 0),
    /等待日志超时：不存在的行/
  );
});

test('harness.deleteBookWithRetry：失败按 200ms 重试，成功即返回；一直失败返回最后一次结果', async () => {
  const attempts = [];
  const { harness, sleeps } = makeHarness({
    exec: async (expr) => {
      attempts.push(expr);
      return attempts.length >= 2 ? JSON.stringify({ ok: true, data: { method: 'move' } }) : JSON.stringify({ ok: false });
    }
  });
  const ok = await harness.deleteBookWithRetry('D:/tmp/书A');
  assert.equal(ok.ok, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(sleeps, [200]);
  assert.match(attempts[0], /window\.api\.deleteBook\("D:\/tmp\/书A"\)/);

  const failing = makeHarness({ exec: async () => JSON.stringify({ ok: false, error: 'EPERM' }) });
  const last = await failing.harness.deleteBookWithRetry('D:/tmp/书B', 3);
  assert.deepEqual(last, { ok: false, error: 'EPERM' });
  assert.equal(failing.sleeps.length, 3);
});

test('harness.fileExists：文件 / 目录都算存在，不存在（含父目录不存在）返回 false，不抛错', async () => {
  const dir = await tempDir('cw-harness-exists-');
  const file = path.join(dir, '书目.json');
  await fsp.writeFile(file, '{}', 'utf8');
  const { harness } = makeHarness();
  assert.equal(await harness.fileExists(file), true);
  assert.equal(await harness.fileExists(dir), true);
  assert.equal(await harness.fileExists(path.join(dir, '没有这个.txt')), false);
  assert.equal(await harness.fileExists(path.join(dir, 'nope', 'deep', 'x.txt')), false);
});

test('静态闸门：场景里不许再定义第二份 harness 工具，必须走 createHarness + 组索引', () => {
  for (const name of ['checks', 'check', 'waitFor', 'readLogs', 'waitForLog', 'deleteBookWithRetry', 'fileExists']) {
    const pattern = new RegExp(`^  const ${name} = `, 'm');
    assert.equal(pattern.test(SCENARIO_SOURCE), false, `${name} 不该再定义在 e2e-scenario.js 里`);
  }
  assert.match(SCENARIO_SOURCE, /const harness = createHarness\(ctx\);/);
  assert.match(
    SCENARIO_SOURCE,
    /const \{ checks, check, waitFor, logDir, logNamePattern, readLogs, waitForLog, deleteBookWithRetry, fileExists \} =\s*\n\s*harness;/
  );
  assert.match(SCENARIO_SOURCE, /const e2eGroups = require\('\.\/e2e\/groups'\);/);
  // 组按「在哪一段」两处跑：第 52 组在原位，60 起的那批在原 60–62 的循环位置
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[52\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), e2eGroups\.idsFrom\(60\)\);/);
  // 顺序：52 组原位 → 53 组 → … → 60 起那批 → 多窗口（55）——与拆分前的执行顺序一致
  const groupContext = SCENARIO_SOURCE.indexOf('const groupContext = () => ({');
  const run52 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [52]);');
  const group53 = SCENARIO_SOURCE.indexOf('// 53. 正文全文搜索索引');
  const run60 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), e2eGroups.idsFrom(60));');
  const multiWindow = SCENARIO_SOURCE.indexOf('// 55. 多窗口');
  assert.ok(groupContext > 0 && groupContext < run52, 'groupContext 要先定义再交出去');
  assert.ok(run52 > 0 && group53 > run52, '52 组的调用点必须在 53 组之前（顺序不变）');
  assert.ok(run60 > group53 && multiWindow > run60, '60 起那批要在 55 多窗口之前跑完');
});

test('静态闸门：搬走的组不许在场景里留副本（文案只在 groups 下出现一次）', () => {
  const movedBeyond = ['// 52. 崩溃与错误日志（提案 7.4）', '// 60. 日志与错误脱敏', '// 61. IPC 参数边界与 DoS', '// 62. 公共小工具收编'];
  for (const marker of movedBeyond) {
    assert.equal(SCENARIO_SOURCE.includes(marker), false, `场景里还留着 ${marker}`);
  }
  const groupFiles = fs.readdirSync(GROUPS_DIR).filter((name) => name.endsWith('.js') && name !== 'index.js');
  assert.ok(groupFiles.length >= 4, '至少应有 52 / 60 / 61 / 62 四个组文件');
  const joined = groupFiles.map((name) => fs.readFileSync(path.join(GROUPS_DIR, name), 'utf8')).join('\n');
  for (const marker of movedBeyond) {
    assert.equal(joined.includes(marker), true, `groups 下找不到 ${marker}`);
  }
  // 断言名（check 的字符串）同样只该留在组文件里，场景里出现就说明留了副本
  for (const needle of [
    '诊断日志：日志目录是 userData\\\\logs，文件按天命名（chapter-writer-YYYY-MM-DD.log）',
    '诊断日志：保存失败记一条（错误码 + 章节文件路径 + 频道），绝不含正文',
    '错误脱敏：演练书已移入书架 _trash',
    'IPC 边界：演练书已移入书架 _trash',
    '公共小工具：渲染层真的加载了 core/common.js'
  ]) {
    assert.equal(SCENARIO_SOURCE.includes(needle), false, `场景里还留着断言「${needle}」`);
    assert.equal(joined.includes(needle), true, `组文件里找不到断言「${needle}」`);
  }
});

test('静态闸门：组索引能单独 require（不依赖 Electron），组号唯一有序，runGroups 按参数顺序跑', async () => {
  const registry = require('../scripts/e2e/groups');
  assert.ok(Array.isArray(registry.groups) && registry.groups.length >= 4);
  for (const group of registry.groups) {
    assert.equal(typeof group.id, 'number');
    assert.equal(typeof group.run, 'function');
  }
  const ids = registry.groups.map((group) => group.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), '组号必须升序（数组顺序 = 执行顺序）');
  assert.equal(new Set(ids).size, ids.length, '同一个组不许注册两次');

  const required = [...INDEX_SOURCE.matchAll(/require\('\.\/([\w.-]+)'\)/g)].map((m) => m[1]);
  assert.equal(required.length, ids.length, '索引里的 require 条数必须等于注册的组数');
  assert.equal(new Set(required).size, required.length, '同一个组不许注册两次');
  for (const name of required) {
    assert.ok(fs.existsSync(path.join(GROUPS_DIR, `${name}.js`)), `组文件不存在：${name}.js`);
  }
  // 顺序就是原场景里的执行顺序（52 → 60 → 61 → … → 71），以后加组也按组号往后排
  assert.deepEqual(required, [
    '52-crash-logs',
    '60-log-redaction',
    '61-ipc-limits',
    '62-common-tools',
    '63-chapter-list-perf',
    '64-data-safety',
    '65-marks-lazy-spans',
    '66-destructive-recovery',
    '67-contrast-a11y',
    '68-dialog-focus',
    '69-motion',
    '70-a11y-keyboard',
    '71-menu-keyboard'
  ]);
  assert.deepEqual(ids, [52, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
  // 场景尾部那一批：idsFrom(60) = 60 → 71（52 组在原位单独跑，不在这里重复）
  assert.deepEqual(registry.idsFrom(60), ids.slice(1));
  assert.deepEqual(registry.idsFrom(52), ids);

  // runGroups：空列表直接过；组号写错要当场抛（写错一个号就等于少跑一整组的断言）
  await registry.runGroups({}, []);
  await assert.rejects(() => registry.runGroups({}, [999]), /组索引里没有第 999 组/);
  // 按参数顺序派发（临时塞两个假组，跑完就摘掉，别污染别的用例）
  const ran = [];
  registry.groups.push({ id: 9998, run: async () => ran.push(9998) });
  registry.groups.push({ id: 9999, run: async () => ran.push(9999) });
  try {
    await registry.runGroups({}, [9999, 9998]);
  } finally {
    registry.groups.splice(-2, 2);
  }
  assert.deepEqual(ran, [9999, 9998]);
});

test('静态闸门：harness 与组文件只 require node 内建，不牵出产品代码 / electron', () => {
  const sources = [['scripts/e2e/harness.js', HARNESS_SOURCE]];
  for (const name of fs.readdirSync(GROUPS_DIR).filter((file) => file.endsWith('.js') && file !== 'index.js')) {
    sources.push([`scripts/e2e/groups/${name}`, fs.readFileSync(path.join(GROUPS_DIR, name), 'utf8')]);
  }
  for (const [label, source] of sources) {
    const requests = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    for (const request of requests) {
      assert.match(request, /^node:/, `${label} 不该 require ${request}（只许 node 内建）`);
    }
    assert.equal(/require\('electron'\)|\.\.\/main|\.\.\/core\//.test(source), false, `${label} 牵出了产品代码`);
  }
  // harness 对外只交一个工厂 + 明确的工具名，别长成第二个大杂烩
  assert.match(HARNESS_SOURCE, /module\.exports = \{ createHarness \};/);
});
