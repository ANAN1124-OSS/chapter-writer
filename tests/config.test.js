const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore, sanitize, sanitizeLastBook, DEFAULTS } = require('../core/config');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-config-'));
}

test('配置默认值：书架在「文档\\我的小说」，窗口 1200x760', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);
  assert.equal(cfg.windowBounds.width, 1200);
  assert.equal(cfg.windowBounds.height, 760);
  assert.equal(cfg.editorFont, 'serif');
  assert.equal(cfg.editorFontSize, 18);
  assert.equal(cfg.editorSidebarWidth, 250);
});

test('配置写入后可再次读取（持久化）', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ booksRoot: 'D:\\小说库', editorFont: 'kai', editorFontSize: 22, editorSidebarWidth: 360 });
  const store2 = createConfigStore(dir);
  const cfg = await store2.get();
  assert.equal(cfg.booksRoot, 'D:\\小说库');
  assert.equal(cfg.editorFont, 'kai');
  assert.equal(cfg.editorFontSize, 22);
  assert.equal(cfg.editorSidebarWidth, 360);
});

test('配置脏数据被兜底，不会让应用起不来', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 坏掉的配置', 'utf8');
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);

  const cleaned = sanitize({
    booksRoot: '',
    editorFont: 'comic-sans',
    editorFontSize: 999,
    editorSidebarWidth: 9999,
    windowBounds: { width: 'x', height: null }
  });
  assert.equal(cleaned.booksRoot, DEFAULTS.booksRoot);
  assert.equal(cleaned.editorFont, 'serif');
  assert.equal(cleaned.editorFontSize, 30);
  assert.equal(cleaned.editorSidebarWidth, 800, '章节栏宽度应被夹到合理范围');
  assert.equal(cleaned.windowBounds.width, 1200);
});

test('显示排版配置：默认值 + 持久化', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.editorLineHeight, 1.95);
  assert.equal(cfg.editorLetterSpacing, 0.02);
  assert.equal(cfg.editorPageWidth, 0, '默认通栏');
  assert.equal(cfg.editorPaddingX, 56, '默认左右边距');
  assert.equal(cfg.editorPaper, 'paper');
  assert.deepEqual(cfg.formatOptions, {
    indent: '2',
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false,
    curlyQuotes: false,
    ellipsis: false
  });

  await store.set({
    editorLineHeight: 2.2,
    editorLetterSpacing: 0.05,
    editorPageWidth: 800,
    editorPaddingX: 24,
    editorPaper: 'cream',
    formatOptions: { indent: true, blankLines: 'none', trimTrailing: true, normalizePunct: false, removeCjkSpaces: true }
  });
  const cfg2 = await createConfigStore(dir).get();
  assert.equal(cfg2.editorLineHeight, 2.2);
  assert.equal(cfg2.editorLetterSpacing, 0.05);
  assert.equal(cfg2.editorPageWidth, 800);
  assert.equal(cfg2.editorPaddingX, 24);
  assert.equal(cfg2.editorPaper, 'cream');
  assert.equal(cfg2.formatOptions.blankLines, 'none');
  assert.equal(cfg2.formatOptions.normalizePunct, false);
  assert.equal(cfg2.formatOptions.removeCjkSpaces, true);
});

test('显示排版配置：脏数据被夹到合理范围', () => {
  const cleaned = sanitize({
    editorLineHeight: 99,
    editorLetterSpacing: -1,
    editorPageWidth: 'x',
    editorPaddingX: 9999,
    editorPaper: 'pink',
    formatOptions: { blankLines: 'weird' }
  });
  assert.equal(cleaned.editorLineHeight, 3);
  assert.equal(cleaned.editorLetterSpacing, 0);
  assert.equal(cleaned.editorPageWidth, 0);
  assert.equal(cleaned.editorPaddingX, 200);
  assert.equal(cleaned.editorPaper, 'paper');
  assert.equal(cleaned.formatOptions.blankLines, 'single');
  assert.equal(cleaned.formatOptions.indent, '2');

  assert.equal(sanitize({ editorPageWidth: 99999 }).editorPageWidth, 1600);
  assert.equal(sanitize({ editorPageWidth: 900 }).editorPageWidth, 900);
  assert.equal(sanitize({ editorPaddingX: 8 }).editorPaddingX, 16);
  assert.equal(sanitize({ editorPaper: 'night' }).editorPaper, 'night');
  assert.equal(sanitize({ editorPaper: 'kraft' }).editorPaper, 'kraft');
});

test('自定义字体：没有字体文件时回落内置字体', () => {
  assert.equal(sanitize({ editorFont: 'custom' }).editorFont, 'serif', '缺路径不能停在 custom');
  const custom = sanitize({
    editorFont: 'custom',
    editorCustomFontPath: 'D:\\fonts\\我的字体.ttf',
    editorCustomFontName: '我的字体.ttf'
  });
  assert.equal(custom.editorFont, 'custom');
  assert.equal(custom.editorCustomFontPath, 'D:\\fonts\\我的字体.ttf');
  assert.equal(custom.editorCustomFontName, '我的字体.ttf');
  assert.equal(sanitize({ editorCustomFontPath: 123 }).editorCustomFontPath, '');
});

test('按书显示设置：只存改过的项，脏数据被清洗', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const bookId = 'b_test-book';

  assert.deepEqual(await store.getBookDisplay(bookId), {});

  const saved = await store.setBookDisplay(bookId, {
    editorPaper: 'night',
    editorSidebarWidth: 420,
    editorLineHeight: 2.2
  });
  assert.equal(saved.editorPaper, 'night');
  assert.equal(saved.editorSidebarWidth, 420);
  assert.equal(saved.editorLineHeight, 2.2);
  // 没改的项不写进覆盖，继续沿用全局
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'editorFont'), false);

  // 再改一项是合并，不会把之前的覆盖冲掉
  await store.setBookDisplay(bookId, { editorFont: 'kai' });
  const merged = await store.getBookDisplay(bookId);
  assert.equal(merged.editorFont, 'kai');
  assert.equal(merged.editorPaper, 'night');
  assert.equal(merged.editorSidebarWidth, 420);

  // 全局设置不受这本书的覆盖影响
  const cfg = await store.get();
  assert.equal(cfg.editorPaper, 'paper');
  assert.equal(cfg.editorFont, 'serif');

  // 重启后仍在
  const display = await createConfigStore(dir).getBookDisplay(bookId);
  assert.equal(display.editorPaper, 'night');

  // 直到点「恢复本书默认」才删掉覆盖
  assert.equal(await store.resetBookDisplay(bookId), true);
  assert.deepEqual(await store.getBookDisplay(bookId), {});
  assert.equal(await store.resetBookDisplay(bookId), false, '没有覆盖时再重置返回 false');
});

test('按书显示设置：非法值按全局规则夹紧，非法 bookId 被忽略', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.setBookDisplay('b_x', {
    editorPaper: 'pink',
    editorFontSize: 999,
    editorPageWidth: 99999,
    editorCustomFontPath: 123
  });
  const display = await store.getBookDisplay('b_x');
  assert.equal(display.editorPaper, 'paper');
  assert.equal(display.editorFontSize, 30);
  assert.equal(display.editorPageWidth, 1600);
  assert.equal(display.editorCustomFontPath, '');
  // 覆盖成 custom 但没路径：该项不算数
  const custom = await store.setBookDisplay('b_y', { editorFont: 'custom' });
  assert.deepEqual(custom, {});

  const cleaned = sanitize({
    bookDisplay: {
      '  ': { editorPaper: 'night' },
      'b_ok': { editorPaper: 'kraft', editorSidebarWidth: 9999 }
    }
  });
  assert.deepEqual(Object.keys(cleaned.bookDisplay), ['b_ok']);
  assert.equal(cleaned.bookDisplay.b_ok.editorPaper, 'kraft');
  assert.equal(cleaned.bookDisplay.b_ok.editorSidebarWidth, 800);
  assert.equal(sanitize({ bookDisplay: 'not-an-object' }).bookDisplay && Object.keys(sanitize({ bookDisplay: 'not-an-object' }).bookDisplay).length, 0);
});

test('导出目录记忆：默认空、去首尾空白、坏值回空', () => {
  assert.equal(sanitize({}).lastExportDir, '');
  assert.equal(sanitize({ lastExportDir: '  D:\\xxs  ' }).lastExportDir, 'D:\\xxs');
  assert.equal(sanitize({ lastExportDir: 123 }).lastExportDir, '');
  assert.equal(sanitize({ lastExportDir: null }).lastExportDir, '');
  assert.equal(sanitize({ lastExportDir: 'x'.repeat(2000) }).lastExportDir, '');
});

test('继续上次写作：lastBook 默认空，旧配置没有字段也能读；合法值清洗后保留', () => {
  // 旧配置文件里没有 lastBook：当作没记过，不影响其它设置
  assert.equal(DEFAULTS.lastBook, null);
  const old = sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai' });
  assert.equal(old.lastBook, null);
  assert.equal(old.booksRoot, 'D:\\旧书架');

  assert.equal(sanitizeLastBook(null), null);
  assert.equal(sanitizeLastBook('not-an-object'), null);
  assert.equal(sanitizeLastBook([]), null);
  assert.equal(sanitizeLastBook({ path: '   ' }), null, '没有路径就不算「上次写作」');
  assert.equal(sanitizeLastBook({ path: 123 }), null, '非字符串路径直接作废');

  const recent = sanitizeLastBook({
    path: '  D:\\书架\\星海旅人  ',
    title: ' 星海旅人 ',
    chapterId: ' ch_012 ',
    chapterIndex: 11,
    chapterName: ' 夜雨 ',
    at: 1760000000123.7
  });
  assert.deepEqual(recent, {
    path: 'D:\\书架\\星海旅人',
    title: '星海旅人',
    chapterId: 'ch_012',
    chapterIndex: 11,
    chapterName: '夜雨',
    at: 1760000000124
  });
});

test('继续上次写作：lastBook 脏值兜底（越界下标/坏时间戳/超长文本）', () => {
  const base = { path: 'D:\\书架\\书' };
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: -5 }).chapterIndex, 0);
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: 1e9 }).chapterIndex, 1000000);
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: 'x' }).chapterIndex, 0);
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: 2.6 }).chapterIndex, 3);
  assert.equal(sanitizeLastBook({ ...base, at: 'abc' }).at, 0);
  assert.equal(sanitizeLastBook({ ...base, at: -1 }).at, 0);
  assert.equal(sanitizeLastBook({ ...base, at: '1760000000000' }).at, 1760000000000);
  assert.equal(sanitizeLastBook({ ...base, title: 123 }).title, '');
  assert.equal(sanitizeLastBook({ ...base, chapterName: 'x'.repeat(300) }).chapterName.length, 200);
  assert.equal(sanitizeLastBook({ ...base, path: 'x'.repeat(2000) }), null);
});

test('继续上次写作：lastBook 写盘 / 读回 / 清空，且不动其它配置', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const recent = {
    path: 'D:\\书架\\星海旅人',
    title: '星海旅人',
    chapterId: 'ch_003',
    chapterIndex: 2,
    chapterName: '夜雨',
    at: 1760000000000
  };
  await store.set({ lastBook: recent });
  const cfg = await store.get();
  assert.deepEqual(cfg.lastBook, recent);
  assert.equal(cfg.editorPaper, 'paper', '写 lastBook 不能把其它配置冲掉');

  // 真的落进了 config.json，重启后能读回
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.lastBook, recent);
  const reopened = await createConfigStore(dir).get();
  assert.deepEqual(reopened.lastBook, recent);

  // 坏值写入会被清成 null（不保留半条脏记录）
  await store.set({ lastBook: { path: '', chapterId: 'x' } });
  assert.equal((await store.get()).lastBook, null);

  // null 可以清掉记录
  await store.set({ lastBook: recent });
  await store.set({ lastBook: null });
  assert.equal((await createConfigStore(dir).get()).lastBook, null);
});

test('配置损坏：归档坏文件、回默认值，并给出一次提示', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 这不是合法 JSON ', 'utf8');
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);
  const warning = store.takeLoadWarning();
  assert.ok(warning && warning.code === 'CONFIG_CORRUPT');
  assert.equal(store.takeLoadWarning(), null, '提示只给一次');
  const files = await fs.readdir(dir);
  assert.ok(files.some((f) => f.startsWith('config.json.corrupt-')), '坏配置要归档，不能直接删');
  assert.ok(!files.includes('config.json'), '坏文件应已改名归档');
});

test('首次启动（没有配置文件）不算损坏，不提示', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.get();
  assert.equal(store.takeLoadWarning(), null);
});

test('配置并发写入：两个 set 的 patch 都不会被吞掉', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await Promise.all([
    store.set({ editorPaper: 'night' }),
    store.set({ editorFontSize: 22 })
  ]);
  const cfg = await store.get();
  assert.equal(cfg.editorPaper, 'night');
  assert.equal(cfg.editorFontSize, 22);
});

test('每日快照配置：默认关闭、保留 7 天，旧配置没有这两个键也照常启动', async () => {
  const dir = await mkTmp();
  // 模拟 v0.4.1 的旧配置：完全没有 snapshot 字段
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', editorFont: 'kai' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.snapshotEnabled, false, '旧配置/缺字段必须按「关」处理');
  assert.equal(cfg.snapshotKeepDays, 7);
  assert.equal(cfg.editorFont, 'kai', '旧配置其它字段不受影响');
});

test('每日快照配置：脏值清洗（只认 true、天数夹到 1–90）', () => {
  assert.equal(sanitize({ snapshotEnabled: 'true' }).snapshotEnabled, false);
  assert.equal(sanitize({ snapshotEnabled: 1 }).snapshotEnabled, false);
  assert.equal(sanitize({ snapshotEnabled: true }).snapshotEnabled, true);
  assert.equal(sanitize({ snapshotKeepDays: 0 }).snapshotKeepDays, 1);
  assert.equal(sanitize({ snapshotKeepDays: 999 }).snapshotKeepDays, 90);
  assert.equal(sanitize({ snapshotKeepDays: 'abc' }).snapshotKeepDays, 7);
  assert.equal(sanitize({ snapshotKeepDays: 14.6 }).snapshotKeepDays, 15);
});

test('每日快照配置：写盘 / 读回，不影响其它配置', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ snapshotEnabled: true, snapshotKeepDays: 3, editorFont: 'sans' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.snapshotEnabled, true);
  assert.equal(reopened.snapshotKeepDays, 3);
  assert.equal(reopened.editorFont, 'sans');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.snapshotEnabled, true);
  assert.equal(raw.snapshotKeepDays, 3);

  // 关掉后能真正清掉（不会残留 true）
  await store.set({ snapshotEnabled: false });
  assert.equal((await createConfigStore(dir).get()).snapshotEnabled, false);
});

test('每日目标配置：默认 0（不设目标），旧配置没有 dailyGoal 也照常启动', async () => {
  const dir = await mkTmp();
  // 模拟 v0.4.1 / v0.6-2 的旧配置：没有 dailyGoal 字段
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', snapshotEnabled: true, snapshotKeepDays: 3 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.dailyGoal, 0, '旧配置缺字段 = 不设目标');
  assert.equal(cfg.snapshotEnabled, true, '旧配置其它字段不受影响');
  assert.equal(cfg.snapshotKeepDays, 3);
});

test('每日目标配置：脏值清洗（负数/NaN 回落 0，超大夹到上限）', () => {
  assert.equal(sanitize({ dailyGoal: -100 }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: 'abc' }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: null }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: 2000 }).dailyGoal, 2000);
  assert.equal(sanitize({ dailyGoal: '2500' }).dailyGoal, 2500);
  assert.equal(sanitize({ dailyGoal: 2000.4 }).dailyGoal, 2000);
  assert.equal(sanitize({ dailyGoal: 99999999 }).dailyGoal, 1000000);
});

test('每日目标配置：写盘 / 读回，只影响 dailyGoal', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ dailyGoal: 2000, editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.dailyGoal, 2000);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.dailyGoal, 2000);

  // 0 = 关掉目标，能落盘
  await store.set({ dailyGoal: 0 });
  assert.equal((await createConfigStore(dir).get()).dailyGoal, 0);
});

test('敏感词表配置：默认未设置，旧配置缺字段照常启动，脏值清洗成空', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).sensitiveWordsPath, '');
  // 模拟旧配置：完全没有 sensitiveWordsPath
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 1200 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.sensitiveWordsPath, '');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');

  assert.equal(sanitize({ sensitiveWordsPath: 123 }).sensitiveWordsPath, '');
  assert.equal(sanitize({ sensitiveWordsPath: null }).sensitiveWordsPath, '');
  assert.equal(sanitize({ sensitiveWordsPath: '   ' }).sensitiveWordsPath, '');
  assert.equal(
    sanitize({ sensitiveWordsPath: '  D:\\词表\\敏感词.txt  ' }).sensitiveWordsPath,
    'D:\\词表\\敏感词.txt'
  );
  assert.equal(sanitize({ sensitiveWordsPath: 'x'.repeat(1001) }).sensitiveWordsPath, '');
});

test('敏感词表配置：写盘 / 读回，清除后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ sensitiveWordsPath: 'D:\\词表\\我的词表.txt' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.sensitiveWordsPath, 'D:\\词表\\我的词表.txt');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.sensitiveWordsPath, 'D:\\词表\\我的词表.txt');

  await store.set({ sensitiveWordsPath: '' });
  assert.equal((await createConfigStore(dir).get()).sensitiveWordsPath, '');
});

test('写作时长配置：默认关、旧配置缺字段照常启动、只认真正的 true', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).writeDurationEnabled, false, '默认关');
  // 模拟旧配置：完全没有 writeDurationEnabled
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.writeDurationEnabled, false, '旧配置缺字段 = 关');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');

  assert.equal(sanitize({ writeDurationEnabled: 'true' }).writeDurationEnabled, false, '字符串 true 不算');
  assert.equal(sanitize({ writeDurationEnabled: 1 }).writeDurationEnabled, false, '数字 1 不算');
  assert.equal(sanitize({ writeDurationEnabled: true }).writeDurationEnabled, true);
});

test('写作时长配置：开关写盘 / 读回，只影响这个字段', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const on = await store.set({ writeDurationEnabled: true, editorFont: 'kai' });
  assert.equal(on.writeDurationEnabled, true);
  assert.equal(on.editorFont, 'kai');
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.writeDurationEnabled, true);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.writeDurationEnabled, true);
  assert.equal(raw.editorFont, 'kai');

  await store.set({ writeDurationEnabled: false });
  assert.equal((await createConfigStore(dir).get()).writeDurationEnabled, false);
});
