const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ipcPaths = require('../core/ipc-paths');

// v0.9 C-2：IPC 路径入口审计。
// 这里锁两件事：
//   1. 校验函数本身的行为（书架路径只能是书架目录的直接子目录；导入目录只能来自对话框）；
//   2. 一份「IPC 入口清单」静态闸门：main.js 里带路径参数的频道必须走 handleBook（统一过
//      assertBookPath）或在这份测试里显式登记理由 —— 以后新增 IPC 绕不过去。
// 真实 Electron 侧的回归在 E2E 第 57 组（伪造路径一律 BAD_*）。

const ROOT = path.join(os.tmpdir(), 'cw-ipc-paths-书架');
const book = (name) => path.join(ROOT, name);

test('书架路径：书架目录的直接子目录才合法，返回 resolve 后的绝对路径', () => {
  assert.equal(ipcPaths.assertBookPath(book('某本书'), ROOT), book('某本书'));
  // 末尾分隔符 / 内部 `..` 绕回原处，都算同一个书文件夹
  assert.equal(ipcPaths.assertBookPath(book('某本书') + path.sep, ROOT), book('某本书'));
  assert.equal(ipcPaths.assertBookPath(book('某本书') + path.sep + '..' + path.sep + '另一本', ROOT), book('另一本'));
  // 前后空白：配置里读出来的路径可能带空格（Windows 允许目录名带空格），trim 掉更安全
  assert.equal(ipcPaths.assertBookPath(`  ${book('带 空格')}  `, `  ${ROOT}  `), book('带 空格'));
  // Windows 大小写不敏感：大小写不同也是同一个书架
  assert.equal(
    ipcPaths.assertBookPath(book('某本书').toUpperCase(), ROOT),
    book('某本书').toUpperCase()
  );
});

test('书架路径：书架目录空着时直接报错（不把进程 cwd 当成书架）', () => {
  for (const root of ['', '   ', null, undefined]) {
    assert.throws(
      () => ipcPaths.assertBookPath(book('某本书'), root),
      (err) => err instanceof ipcPaths.IpcPathError && err.code === 'BAD_PATH' && err.message === '书架目录还没有设置'
    );
  }
});

test('书架路径：越界（父目录 / 孙目录 / 绝对路径 / 空值）一律 BAD_PATH', () => {
  const bad = [
    path.join(ROOT, '..', '逃出去'), // 父目录
    path.join(ROOT, '..', '..', 'Windows'), // 多级往上
    path.join(ROOT, '某本书', '子目录'), // 孙目录：书里不能有「书」
    ROOT, // 书架自己不是书
    '', // 空串
    null,
    undefined,
    123
  ];
  for (const value of bad) {
    assert.throws(
      () => ipcPaths.assertBookPath(value, ROOT),
      (err) => err instanceof ipcPaths.IpcPathError && err.code === 'BAD_PATH',
      `应当拒绝：${String(value)}`
    );
  }
  // 错误信息只说规则，不把本机路径 / 输入原样带出去
  assert.throws(
    () => ipcPaths.assertBookPath(path.join(ROOT, '..', '逃出去'), ROOT),
    (err) => err.message === '只能操作书架目录下的书' && !err.message.includes(ROOT)
  );
});

test('导入目录：没有显式路径时返回空数组（调用方退回系统对话框）', () => {
  assert.deepEqual(ipcPaths.importSourceDirs(undefined), []);
  assert.deepEqual(ipcPaths.importSourceDirs(null), []);
  assert.deepEqual(ipcPaths.importSourceDirs([]), []);
  assert.deepEqual(ipcPaths.importSourceDirs(['', '   ', 123, null]), []);
  assert.deepEqual(ipcPaths.importSourceDirs('D:\\不是数组'), []);
});

test('导入目录：生产环境不认渲染层传的路径（BAD_IMPORT_PATH，不泄漏输入）', () => {
  assert.throws(
    () => ipcPaths.importSourceDirs(['D:\\我的小说'], { allowExplicit: false }),
    (err) => err instanceof ipcPaths.IpcPathError && err.code === 'BAD_IMPORT_PATH'
  );
  assert.throws(
    () => ipcPaths.importSourceDirs(['D:\\我的小说']),
    (err) => err.code === 'BAD_IMPORT_PATH' && err.message === '导入目录只能通过系统对话框选择'
  );
  assert.throws(
    () => ipcPaths.importSourceDirs(['D:\\我的小说']),
    (err) => !err.message.includes('我的小说')
  );
});

test('导入目录：自检 / 截图模式才认显式路径，且统一 resolve + trim', () => {
  assert.deepEqual(ipcPaths.importSourceDirs(['D:\\源目录'], { allowExplicit: true }), ['D:\\源目录']);
  assert.deepEqual(
    ipcPaths.importSourceDirs(['  D:\\源目录  ', '', 42, 'D:\\另一个'], { allowExplicit: true }),
    ['D:\\源目录', 'D:\\另一个']
  );
  // 相对路径按主进程 cwd 解析（自检脚本传绝对路径，这里只锁行为）
  assert.deepEqual(ipcPaths.importSourceDirs(['rel-dir'], { allowExplicit: true }), [path.resolve('rel-dir')]);
});

// ---------- IPC 入口清单（静态闸门） ----------
// 解析 main.js 的注册点：`handle('频道', …)` / `handleBook('频道', …)`。
// 只要第一个参数是路径类名字（…Path / …Paths / …Dir / …File / name / ref），就必须
// 走 handleBook，或者出现在下面的 PATH_CHANNEL_ALLOWLIST 里（每条都得写清靠什么校验）。
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function registrations(source) {
  const re = /^[ \t]+(handleBook|handle)\('([^']+)'/gm;
  const hits = [];
  let match;
  while ((match = re.exec(source))) {
    hits.push({ kind: match[1], channel: match[2], at: match.index });
  }
  return hits.map((hit, index) => ({
    ...hit,
    body: source.slice(hit.at, index + 1 < hits.length ? hits[index + 1].at : source.length)
  }));
}

function firstParam(body) {
  // 形如 `, async (bookPath) =>` / `, async () =>` / `, async (explicitPaths, options) =>`
  const match = /,\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)?/.exec(body);
  return (match && match[1]) || '';
}

const REGISTRATIONS = registrations(MAIN_SOURCE);
const PATHISH = /(path|paths|dir|dirs|file|files|folder|name|ref)$/i;

// 直接过 handleBook 的频道（第一参数必然是 bookPath → 统一过 assertBookPath）。
// 这份清单是审计结论本身：新增「书相关」频道必须同时加到这里。
const BOOK_CHANNELS = [
  'book:open', 'book:verify', 'book:rename', 'book:update-info', 'book:set-last',
  'chapter:load', 'chapter:stat', 'chapter:save', 'chapter:create', 'chapter:rename',
  'chapter:update-meta', 'chapter:delete', 'chapter:move', 'volume:create', 'volume:rename',
  'volume:delete', 'chapter:move-to-volume', 'volume:move', 'chapter:move-to',
  'book:search', 'book:replace', 'book:proofread', 'book:sensitive-check',
  'book:list-replace-backups', 'book:restore-replace-backup', 'book:list-history',
  'book:preview-history-file', 'book:restore-history-file', 'book:restore-history-dir',
  'book:format-preview', 'book:format', 'book:export-plan', 'book:export', 'book:export-epub',
  'book:export-docx', 'book:copy', 'chapter:copy-platform', 'book:repair', 'book:delete',
  'shell:open-book-folder'
];

// 不走 handleBook、但第一参数仍是渲染层传的「名字 / 路径」的频道：每条都要有校验出处。
const PATH_CHANNEL_ALLOWLIST = {
  'window:open-book': 'main.js 里就地调 assertBookPath（同一本书只开一个窗口）',
  'fragments:read': 'core/fragments.js assertFragmentName（只认 _碎片 里的 .txt 基名，禁止分隔符 / 控制字符）',
  'book:import': 'core/ipc-paths.js importSourceDirs（显式目录只在 automation 模式认）',
  'font:test-pick': '只在 automation 下注册；记下的路径还要过 font-policy（扩展名 / 24MB），font:read 不接受渲染层路径'
};

test('IPC 清单：所有注册点都经 handle / handleBook，没有裸 ipcMain', () => {
  // 两个 handle 包装函数内部各一次；多出来的就是有人绕过包装直接注册
  assert.equal((MAIN_SOURCE.match(/ipcMain\.handle\(/g) || []).length, 2);
  // app:close-ready / app:dirty 两个单向上报（不读盘、不带路径）
  assert.equal((MAIN_SOURCE.match(/ipcMain\.on\(/g) || []).length, 2);
  assert.ok(REGISTRATIONS.length >= 80, `注册点应有 80+，实际 ${REGISTRATIONS.length}`);
});

test('IPC 清单：书相关频道一律走 handleBook，第一参数是 bookPath', () => {
  const bookChannels = REGISTRATIONS.filter((item) => item.kind === 'handleBook');
  assert.deepEqual(bookChannels.map((item) => item.channel).sort(), BOOK_CHANNELS.slice().sort());
  for (const item of bookChannels) {
    assert.equal(firstParam(item.body), 'bookPath', `${item.channel} 必须把书路径放在第一个参数`);
  }
});

test('IPC 清单：其它带路径 / 名字参数的频道都在允许清单里（新增入口必须过审）', () => {
  const plainPathChannels = REGISTRATIONS.filter(
    (item) => item.kind === 'handle' && PATHISH.test(firstParam(item.body))
  ).map((item) => item.channel);
  // 允许清单里不留死条目：频道改名 / 删掉后这里会红
  for (const channel of Object.keys(PATH_CHANNEL_ALLOWLIST)) {
    assert.ok(
      plainPathChannels.includes(channel),
      `${channel} 已不在带路径的频道里，请从 PATH_CHANNEL_ALLOWLIST 删掉`
    );
  }
  const unlisted = plainPathChannels.filter((channel) => !PATH_CHANNEL_ALLOWLIST[channel]);
  assert.deepEqual(unlisted, [], `这些频道带路径参数但没有校验出处：${unlisted.join(', ')}`);
});
