const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const logsLib = require('../core/logs');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-logs-'));
}

async function readAll(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return '';
  }
  let text = '';
  for (const name of names.filter((n) => n.endsWith('.log')).sort()) {
    text += await fs.readFile(path.join(dir, name), 'utf8');
  }
  return text;
}

function stderrFree(fn) {
  try {
    return fn();
  } catch (err) {
    return err;
  }
}

test('崩溃日志：localDayKey 用本机日期补零，isValidDayKey 只认真实日期', () => {
  assert.equal(logsLib.localDayKey(new Date(2026, 0, 5, 9, 30)), '2026-01-05');
  assert.equal(logsLib.localDayKey('坏日期'), logsLib.localDayKey());
  assert.equal(logsLib.isValidDayKey('2026-02-28'), true);
  assert.equal(logsLib.isValidDayKey('2026-02-30'), false);
  assert.equal(logsLib.isValidDayKey('2026-2-1'), false);
  assert.equal(logsLib.isValidDayKey(null), false);
});

test('崩溃日志：formatTime 带本地时间与时区偏移', () => {
  const text = logsLib.formatTime(new Date(2026, 10, 1, 2, 5, 3, 17));
  assert.match(text, /^2026-11-01 02:05:03\.017 [+-]\d{2}:\d{2}$/);
});

test('崩溃日志：文件名按天 + 序号，解析只认本应用的日志文件', () => {
  assert.equal(logsLib.fileNameForDay('2026-11-01'), 'chapter-writer-2026-11-01.log');
  assert.equal(logsLib.fileNameForDay('2026-11-01', 2), 'chapter-writer-2026-11-01.2.log');
  assert.equal(logsLib.fileNameForDay('坏日期'), `chapter-writer-${logsLib.localDayKey()}.log`);
  assert.equal(logsLib.fileNameForDay('2026-11-01', 0), 'chapter-writer-2026-11-01.log');
  assert.equal(logsLib.fileNameForDay('2026-11-01', 5000), 'chapter-writer-2026-11-01.999.log');

  assert.deepEqual(logsLib.parseLogFileName('chapter-writer-2026-11-01.log'), {
    name: 'chapter-writer-2026-11-01.log',
    day: '2026-11-01',
    index: 1
  });
  assert.deepEqual(logsLib.parseLogFileName('chapter-writer-2026-11-01.3.log'), {
    name: 'chapter-writer-2026-11-01.3.log',
    day: '2026-11-01',
    index: 3
  });
  assert.equal(logsLib.parseLogFileName('chapter-writer-2026-11-01.txt'), null);
  assert.equal(logsLib.parseLogFileName('chapter-writer-2026-02-30.log'), null);
  assert.equal(logsLib.parseLogFileName('chapter-writer-2026-11-01.log.bak'), null);
  assert.equal(logsLib.parseLogFileName('notes.log'), null);
  assert.equal(logsLib.parseLogFileName(''), null);
  assert.equal(logsLib.parseLogFileName(null), null);
});

test('崩溃日志：连续 24 个以上汉字按正文隐去，短句 / 数字 / 路径不受影响', () => {
  const long = '他沿着堤岸慢慢往回走风很轻天已经黑了他还在等一个不会回来的人';
  assert.ok(long.length >= 24);
  const masked = logsLib.maskLongCjk(`前缀 ${long} 后缀`);
  assert.equal(masked.includes(long), false);
  assert.match(masked, /\[正文已隐藏 \d+ 字\]/);
  assert.equal(logsLib.maskLongCjk('章节文件不存在：001.txt'), '章节文件不存在：001.txt');
  assert.equal(logsLib.maskLongCjk('D:\\小说\\星海旅人\\001-起风.txt'), 'D:\\小说\\星海旅人\\001-起风.txt');
});

test('崩溃日志：sanitizeMessage 压成单行、去控制字符、隐去正文、超长截断', () => {
  assert.equal(logsLib.sanitizeMessage('第一行\r\n第二行\t带制表符'), '第一行 第二行 带制表符');
  assert.equal(logsLib.sanitizeMessage('a\u0000b\u0007c'), 'abc');
  assert.equal(logsLib.sanitizeMessage(null), '');
  assert.equal(logsLib.sanitizeMessage(undefined), '');
  assert.equal(logsLib.sanitizeMessage(42), '42');
  const long = '这是一段绝不应该出现在日志里的正文'.repeat(30);
  const text = logsLib.sanitizeMessage(long);
  assert.equal(text.includes('绝不应该出现在日志里的正文'), false);
  assert.match(text, /\[正文已隐藏 \d+ 字\]/);
  const many = logsLib.sanitizeMessage('x'.repeat(1000));
  assert.equal(many.length > logsLib.MAX_MESSAGE_CHARS, true);
  assert.match(many, /\[已截断 \d+ 字\]$/);
});

test('崩溃日志：sanitizeMessage 里的本机绝对路径只留最后一节（v0.9 C-4）', () => {
  // 真实形状：Node 的 fs 错误把完整路径写进 message，日志里不能再带本机目录 / 用户名
  const masked = logsLib.sanitizeMessage(
    "EPERM: operation not permitted, open 'C:\\Users\\uid72\\AppData\\Local\\Programs\\chapter-writer\\书\\001-第1章.txt'"
  );
  assert.equal(masked, "EPERM: operation not permitted, open '…\\001-第1章.txt'");
  assert.equal(masked.includes('uid72'), false);
  assert.equal(masked.includes('C:\\'), false);
  // 多条路径Together一条也照收；相对路径与网址不动
  assert.equal(
    logsLib.sanitizeMessage('先开 D:\\书\\a.txt 再开 D:\\书\\b.txt'),
    '先开 …\\a.txt 再开 …\\b.txt'
  );
  assert.equal(
    logsLib.sanitizeMessage('下载页 https://github.com/x/y 打不开（0001-第1章.txt 不受影响）'),
    '下载页 https://github.com/x/y 打不开（0001-第1章.txt 不受影响）'
  );
  // 日志的「书名」信息仍看得出：最后一节保留
  assert.match(logsLib.sanitizeMessage("ENOENT: no such file or directory, scandir 'D:\\我的小说'"), /…\\我的小说'$/);
});

test('崩溃日志：sanitizePath 单行、去控制字符、超长截断', () => {
  assert.equal(logsLib.sanitizePath('D:\\小说\\书\\001-起风.txt'), 'D:\\小说\\书\\001-起风.txt');
  assert.equal(logsLib.sanitizePath('a\nb\tc'), 'a b c');
  assert.equal(logsLib.sanitizePath('x'.repeat(400)).length, logsLib.MAX_PATH_CHARS + 1);
  assert.equal(logsLib.sanitizePath(null), '');
});

test('崩溃日志：sanitizeStack 去空行、限行数、限单行长度、隐去正文', () => {
  const raw = ['Error: boom', '', '    at foo (main.js:1:1)', '    at bar (main.js:2:2)'].join('\r\n');
  assert.deepEqual(logsLib.sanitizeStack(raw), ['Error: boom', 'at foo (main.js:1:1)', 'at bar (main.js:2:2)']);
  const many = Array.from({ length: 40 }, (_v, i) => `    at fn${i} (main.js:${i}:1)`).join('\n');
  assert.equal(logsLib.sanitizeStack(many).length, logsLib.MAX_STACK_LINES);
  const longLine = `    at ${'y'.repeat(500)} (main.js:1:1)`;
  assert.ok(logsLib.sanitizeStack(longLine)[0].length <= logsLib.MAX_STACK_LINE_CHARS + 1);
  const body = '他沿着堤岸慢慢往回走风很轻天已经黑了他还在等一个不会回来的人';
  assert.equal(logsLib.sanitizeStack(`  at x (${body})`)[0].includes(body), false);
  assert.deepEqual(logsLib.sanitizeStack(null), []);
  assert.deepEqual(logsLib.sanitizeStack(['a', 'b']), ['a', 'b']);
  // 栈里的绝对路径：保留最后两节（仍看得出哪个文件哪一行），本机目录 / 用户名收掉
  const appStack = logsLib.sanitizeStack(
    "Error: boom\n    at save (C:\\Users\\uid72\\AppData\\Local\\Programs\\chapter-writer\\resources\\app.asar\\core\\storage.js:395:11)"
  );
  assert.deepEqual(appStack, ['Error: boom', 'at save (…\\core\\storage.js:395:11)']);
  assert.equal(appStack.join('\n').includes('uid72'), false);
  assert.equal(appStack.join('\n').includes('app.asar'), false);
});

test('崩溃日志：sanitizeEntry 只留白名单字段，坏值回落默认', () => {
  const now = new Date(2026, 10, 1, 2, 0, 0);
  const entry = logsLib.sanitizeEntry(
    {
      level: 'WARN',
      kind: 'ipc-error',
      code: 'EPERM',
      channel: 'chapter:save',
      path: 'D:\\书\\001.txt',
      message: '写入失败',
      stack: 'Error: 写入失败\n    at x (main.js:1:1)',
      pid: 1234,
      app: '0.4.1',
      bookPath: 'D:\\我的小说\\真实书架', // 不在白名单：必须丢弃
      text: '正文内容不能进日志',
      time: now
    },
    now
  );
  assert.equal(entry.level, 'warn');
  assert.equal(entry.kind, 'ipc-error');
  assert.equal(entry.code, 'EPERM');
  assert.equal(entry.channel, 'chapter:save');
  assert.equal(entry.day, '2026-11-01');
  assert.equal(entry.pid, 1234);
  assert.equal(entry.app, '0.4.1');
  assert.equal(entry.path, 'D:\\书\\001.txt');
  assert.equal(entry.bookPath, undefined);
  assert.equal(entry.text, undefined);
  assert.equal(entry.time, now);
  assert.deepEqual(entry.stack, ['Error: 写入失败', 'at x (main.js:1:1)']);

  const bad = logsLib.sanitizeEntry(
    { level: 'fatal', kind: '有 空格 和汉字', code: 'bad code', channel: 'bad channel!', pid: -3, app: '版本号', time: 'x' },
    now
  );
  assert.equal(bad.level, 'error');
  assert.equal(bad.kind, 'unknown');
  assert.equal(bad.code, '');
  assert.equal(bad.channel, '');
  assert.equal(bad.pid, 0);
  assert.equal(bad.app, '');
  assert.equal(bad.day, '2026-11-01');

  const empty = logsLib.sanitizeEntry(null, now);
  assert.equal(empty.level, 'error');
  assert.equal(empty.kind, 'unknown');
  assert.equal(empty.message, '');
  assert.deepEqual(empty.stack, []);
  assert.equal(stderrFree(() => logsLib.sanitizeEntry(undefined, 'bad-now')).kind, 'unknown');
});

test('崩溃日志：describeError 从 Error / 字符串 / 任意 rejection 值取元数据', () => {
  const err = Object.assign(new Error('写入失败'), { code: 'EPERM' });
  const described = logsLib.describeError(err);
  assert.equal(described.code, 'EPERM');
  assert.equal(described.message, '写入失败');
  assert.match(described.stack, /写入失败/);
  assert.deepEqual(logsLib.describeError('纯字符串原因'), { code: '', message: '纯字符串原因', stack: '' });
  assert.deepEqual(logsLib.describeError(undefined), { code: '', message: '', stack: '' });
  assert.deepEqual(logsLib.describeError(0), { code: '', message: '0', stack: '' });
  assert.equal(logsLib.describeError({ code: 5, message: '数字码' }).code, '5');
});

test('崩溃日志：格式是一条带时间 / 级别 / 类型 / 码 / 频道 / 路径 / 栈的文本块', () => {
  const now = new Date(2026, 10, 1, 2, 5, 3, 17);
  const text = logsLib.formatEntry(
    {
      level: 'error',
      kind: 'save-failed',
      code: 'EPERM',
      channel: 'chapter:save',
      path: 'D:\\书\\001.txt',
      message: '写入失败',
      stack: 'Error: 写入失败\n    at x (main.js:1:1)',
      pid: 999,
      app: '0.4.1',
      time: now
    },
    now
  );
  assert.match(text, /^2026-11-01 02:05:03\.017 [+-]\d{2}:\d{2} ERROR save-failed code=EPERM channel=chapter:save pid=999 app=0\.4\.1\n/);
  assert.match(text, /\n {2}path: D:\\书\\001\.txt\n/);
  assert.match(text, /\n {2}message: 写入失败\n/);
  assert.match(text, /\n {2}stack:\n {4}Error: 写入失败\n {4}at x \(main\.js:1:1\)\n\n$/);
  // info 级别不带栈也能读
  const info = logsLib.formatEntry({ level: 'info', kind: 'app-start', message: '启动' }, now);
  assert.match(info, / INFO app-start\n {2}message: 启动\n\n$/);
});

test('崩溃日志：chooseLogFile 按大小滚到下一个序号，跨天用当天文件', () => {
  const now = new Date(2026, 10, 1, 12, 0, 0);
  assert.equal(logsLib.chooseLogFile([], { now, maxFileBytes: 1000 }), 'chapter-writer-2026-11-01.log');
  assert.equal(
    logsLib.chooseLogFile([{ name: 'chapter-writer-2026-11-01.log', day: '2026-11-01', index: 1, size: 100 }], {
      now,
      maxFileBytes: 1000
    }),
    'chapter-writer-2026-11-01.log'
  );
  assert.equal(
    logsLib.chooseLogFile(
      [
        { name: 'chapter-writer-2026-11-01.log', day: '2026-11-01', index: 1, size: 1000 },
        { name: 'chapter-writer-2026-11-01.2.log', day: '2026-11-01', index: 2, size: 10 }
      ],
      { now, maxFileBytes: 1000 }
    ),
    'chapter-writer-2026-11-01.2.log'
  );
  assert.equal(
    logsLib.chooseLogFile(
      [
        { name: 'chapter-writer-2026-11-01.log', day: '2026-11-01', index: 1, size: 1000 },
        { name: 'chapter-writer-2026-11-01.2.log', day: '2026-11-01', index: 2, size: 1000 }
      ],
      { now, maxFileBytes: 1000 }
    ),
    'chapter-writer-2026-11-01.3.log'
  );
  // 昨天的文件写满不影响今天（每天一个文件）
  assert.equal(
    logsLib.chooseLogFile([{ name: 'chapter-writer-2026-10-31.log', day: '2026-10-31', index: 1, size: 9999 }], {
      now,
      maxFileBytes: 1000
    }),
    'chapter-writer-2026-11-01.log'
  );
  // 序号到上限就继续写最后一份（宁可变大，不能丢日志）
  const full = Array.from({ length: 3 }, (_v, i) => ({
    name: logsLib.fileNameForDay('2026-11-01', i + 1),
    day: '2026-11-01',
    index: i + 1,
    size: 1000
  }));
  full[2].name = logsLib.fileNameForDay('2026-11-01', logsLib.MAX_INDEX);
  full[2].index = logsLib.MAX_INDEX;
  assert.equal(
    logsLib.chooseLogFile(full, { now, maxFileBytes: 1000 }),
    logsLib.fileNameForDay('2026-11-01', logsLib.MAX_INDEX)
  );
});

test('崩溃日志：planPrune 只删最旧的，超出份数才删、不认识的文件不动', () => {
  const files = [
    { name: 'chapter-writer-2026-10-29.log', day: '2026-10-29', index: 1 },
    { name: 'chapter-writer-2026-10-30.log', day: '2026-10-30', index: 1 },
    { name: 'chapter-writer-2026-10-30.2.log', day: '2026-10-30', index: 2 },
    { name: 'chapter-writer-2026-10-31.log', day: '2026-10-31', index: 1 },
    { name: 'debug.txt', day: '2000-01-01', index: 1 },
    { name: 'chapter-writer-2026-10-28.log', day: '2026-10-28', index: 1 }
  ];
  assert.deepEqual(logsLib.planPrune(files, { maxFiles: 2 }), [
    'chapter-writer-2026-10-28.log',
    'chapter-writer-2026-10-29.log',
    'chapter-writer-2026-10-30.log'
  ]);
  assert.deepEqual(logsLib.planPrune(files, { maxFiles: 5 }), []);
  assert.deepEqual(logsLib.planPrune(files, { maxFiles: 10 }), []);
  assert.deepEqual(logsLib.planPrune([], { maxFiles: 1 }), []);
  assert.deepEqual(logsLib.planPrune(files, { maxFiles: 0 }), [
    'chapter-writer-2026-10-28.log',
    'chapter-writer-2026-10-29.log',
    'chapter-writer-2026-10-30.log',
    'chapter-writer-2026-10-30.2.log'
  ]);
});

test('崩溃日志：写一条 → 建 logs 目录、按天命名、含错误信息但不含正文', async () => {
  const base = await mkTmp();
  try {
    const store = logsLib.createLogStore(base, { now: () => new Date(2026, 10, 1, 2, 0, 0) });
    const body = '这是一段绝不应该出现在日志里的正文句子'.repeat(3);
    const result = await store.write({
      level: 'error',
      kind: 'save-failed',
      code: 'EPERM',
      channel: 'chapter:save',
      path: 'D:\\临时书库\\测试书\\001-起风.txt',
      message: `写入失败：${body}`,
      stack: new Error('写入失败').stack,
      pid: 4242,
      app: '0.4.1'
    });
    assert.equal(result.ok, true);
    assert.equal(result.file, 'chapter-writer-2026-11-01.log');
    const text = await fs.readFile(path.join(store.dir, result.file), 'utf8');
    assert.match(text, /ERROR save-failed code=EPERM channel=chapter:save pid=4242 app=0\.4\.1/);
    assert.match(text, /path: D:\\临时书库\\测试书\\001-起风\.txt/);
    assert.match(text, /message: 写入失败：\[正文已隐藏 \d+ 字\]/);
    assert.equal(text.includes('绝不应该出现在日志里的正文句子'), false);
    assert.match(text, /stack:/);
    // 日志目录就在 userData 下的 logs，不散落到别处
    assert.equal(path.basename(store.dir), 'logs');
    assert.equal(path.dirname(store.dir), base);
    assert.deepEqual((await fs.readdir(base)).sort(), ['logs']);
    const info = await store.info();
    assert.equal(info.dir, store.dir);
    assert.equal(info.files.length, 1);
    assert.equal(info.files[0].name, 'chapter-writer-2026-11-01.log');
    assert.ok(info.files[0].bytes > 0);
    assert.ok(info.totalBytes > 0);
    assert.equal(info.latest, 'chapter-writer-2026-11-01.log');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：串行写入不丢条目（并发写也一条不少）', async () => {
  const base = await mkTmp();
  try {
    const store = logsLib.createLogStore(base, { now: () => new Date(2026, 10, 1, 3, 0, 0) });
    await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        store.write({ level: 'info', kind: 'app-start', message: `并发第 ${i} 条` })
      )
    );
    const text = await readAll(store.dir);
    for (let i = 0; i < 8; i += 1) assert.ok(text.includes(`并发第 ${i} 条`), `第 ${i} 条丢了`);
    assert.equal(store.counters().written, 8);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：超过单份大小上限自动换下一个序号，历史条目还在', async () => {
  const base = await mkTmp();
  try {
    const store = logsLib.createLogStore(base, {
      now: () => new Date(2026, 10, 1, 4, 0, 0),
      maxFileBytes: 400,
      maxFiles: 12
    });
    for (let i = 0; i < 6; i += 1) {
      await store.write({ level: 'error', kind: 'ipc-error', code: 'E_TEST', message: `第 ${i} 条错误`.padEnd(120, 'x') });
    }
    const names = (await fs.readdir(store.dir)).sort();
    assert.ok(names.length >= 2, `应该滚动成多份：${names.join(',')}`);
    assert.ok(names.includes('chapter-writer-2026-11-01.log'));
    assert.ok(names.includes('chapter-writer-2026-11-01.2.log'));
    const text = await readAll(store.dir);
    for (let i = 0; i < 6; i += 1) assert.ok(text.includes(`第 ${i} 条错误`), `第 ${i} 条丢了`);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：份数上限生效，旧的按日期删、不认识的文件保留', async () => {
  const base = await mkTmp();
  const dir = path.join(base, 'logs');
  try {
    await fs.mkdir(dir, { recursive: true });
    for (const day of ['2026-10-25', '2026-10-26', '2026-10-27']) {
      await fs.writeFile(path.join(dir, `chapter-writer-${day}.log`), 'old\n');
    }
    await fs.writeFile(path.join(dir, '作者笔记.txt'), '不能删\n');
    const store = logsLib.createLogStore(base, {
      now: () => new Date(2026, 10, 1, 5, 0, 0),
      maxFiles: 2
    });
    const result = await store.write({ level: 'error', kind: 'ipc-error', message: '今天的新错误' });
    assert.equal(result.ok, true);
    const names = (await fs.readdir(dir)).sort();
    assert.deepEqual(names, ['chapter-writer-2026-10-27.log', 'chapter-writer-2026-11-01.log', '作者笔记.txt']);
    assert.equal(store.counters().pruned, 2);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：同样的错误 5 秒内只记一条，过了窗口再记', async () => {
  const base = await mkTmp();
  let nowMs = new Date(2026, 10, 1, 6, 0, 0).getTime();
  try {
    const store = logsLib.createLogStore(base, { now: () => new Date(nowMs) });
    const first = await store.write({ level: 'error', kind: 'uncaughtException', message: '同一个错误' });
    assert.equal(first.ok, true);
    assert.equal(first.suppressed, false);
    const second = await store.write({ level: 'error', kind: 'uncaughtException', message: '同一个错误' });
    assert.equal(second.ok, true);
    assert.equal(second.suppressed, true);
    nowMs += 6000;
    const third = await store.write({ level: 'error', kind: 'uncaughtException', message: '同一个错误' });
    assert.equal(third.suppressed, false);
    const text = await readAll(store.dir);
    assert.equal((text.match(/同一个错误/g) || []).length, 2);
    assert.equal(store.counters().written, 2);
    assert.equal(store.counters().suppressed, 1);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：写不进去（日志目录被占用）只返回失败，不抛错也不影响后续写入', async () => {
  const base = await mkTmp();
  const dir = path.join(base, 'logs');
  try {
    await fs.writeFile(dir, '日志目录位置被一个文件占了');
    const store = logsLib.createLogStore(base, { now: () => new Date(2026, 10, 1, 7, 0, 0) });
    const failed = await store.write({ level: 'error', kind: 'ipc-error', message: '写不进去的错误' });
    assert.equal(failed.ok, false);
    assert.ok(failed.code);
    assert.equal(store.counters().failed, 1);
    const info = await store.info();
    assert.deepEqual(info.files, []);
    assert.equal(info.dir, dir);
    // 障碍排除后照常写（不会因为一次失败就永久停写）
    await fs.unlink(dir);
    const fixed = await store.write({ level: 'error', kind: 'ipc-error', message: '恢复后的错误' });
    assert.equal(fixed.ok, true);
    assert.match(await readAll(dir), /恢复后的错误/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：坏输入不抛错（undefined / 空对象 / 坏时间 / 坏 limits）', async () => {
  const base = await mkTmp();
  try {
    const store = logsLib.createLogStore(base, { now: () => new Date(2026, 10, 1, 8, 0, 0), maxFileBytes: 0, maxFiles: Infinity });
    const result = await store.write(undefined);
    assert.equal(result.ok, true);
    const text = await readAll(store.dir);
    assert.match(text, /ERROR unknown/);
    assert.equal(store.limits.maxFileBytes, logsLib.DEFAULT_MAX_FILE_BYTES);
    assert.equal(store.limits.maxFiles, logsLib.DEFAULT_MAX_FILES);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('崩溃日志：listLogFiles 只挑本应用的日志文件，坏目录当空', async () => {
  const base = await mkTmp();
  try {
    const dir = path.join(base, 'logs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'chapter-writer-2026-11-01.log'), 'x');
    await fs.writeFile(path.join(dir, 'chapter-writer-2026-11-01.2.log'), 'y');
    await fs.writeFile(path.join(dir, 'chapter-writer-2026-11-01.txt'), 'z');
    await fs.writeFile(path.join(dir, 'other.log'), 'w');
    const files = (await logsLib.listLogFiles(dir)).sort((a, b) => a.index - b.index);
    assert.deepEqual(files.map((file) => file.name), [
      'chapter-writer-2026-11-01.log',
      'chapter-writer-2026-11-01.2.log'
    ]);
    assert.deepEqual(await logsLib.listLogFiles(path.join(base, 'nope')), []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
