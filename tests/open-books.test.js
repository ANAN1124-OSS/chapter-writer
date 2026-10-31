// 「打开中的书」登记 / 重复打开 / 最近窗口 / 保存前校验 / 跨窗口拦截的纯逻辑单测。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const openBooks = require('../core/open-books');

const BOOK_A = path.join('D:\\Books', '甲书');
const BOOK_B = path.join('D:\\Books', '乙书');

test('打开登记：窗口登记后能查到，换书时旧书释放', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  assert.deepStrictEqual(registry.counts(), { windows: 1, openBooks: 0 });
  const first = registry.setBook(1, BOOK_A);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(registry.findWindow(BOOK_A), '1');
  assert.strictEqual(registry.getBook(1), openBooks.normalizeBookPath(BOOK_A));
  const second = registry.setBook(1, BOOK_B);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(registry.findWindow(BOOK_A), null);
  assert.strictEqual(registry.findWindow(BOOK_B), '1');
  assert.deepStrictEqual(registry.counts(), { windows: 1, openBooks: 1 });
});

test('打开登记：同一个窗口重复打开同一本书是允许的（刷新），不会变成两个登记', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(7);
  assert.strictEqual(registry.setBook(7, BOOK_A).ok, true);
  assert.strictEqual(registry.setBook(7, BOOK_A).ok, true);
  assert.deepStrictEqual(registry.list(), [{ windowId: '7', bookPath: openBooks.normalizeBookPath(BOOK_A) }]);
});

test('打开登记：路径比较不区分大小写、能识别斜杠差异', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow('w1');
  registry.setBook('w1', 'D:\\Books\\甲书');
  const result = registry.setBook('w2', 'd:/books/甲书/');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.BOOK_OPEN_IN_OTHER_WINDOW);
  assert.strictEqual(result.ownerWindowId, 'w1');
  // 被拒绝时不能改动已有登记
  assert.strictEqual(registry.getBook('w2'), null);
  assert.strictEqual(registry.findWindow(BOOK_A), 'w1');
});

test('重复打开拒绝：另一窗口返回拒绝 + 提醒切换', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  registry.registerWindow(2);
  registry.setBook(1, BOOK_A);
  const denied = openBooks.checkOpenBook({ registry, windowId: 2, bookPath: BOOK_A });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, openBooks.CODE.BOOK_OPEN_IN_OTHER_WINDOW);
  assert.strictEqual(denied.ownerWindowId, '1');
  assert.match(denied.message, /另一个窗口/);
  assert.strictEqual(registry.getBook(2), null);
  assert.strictEqual(registry.findWindow(BOOK_A), '1');
});

test('窗口释放：关窗 / 回书架只释放这个窗口，别窗口的书不动', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  registry.registerWindow(2);
  registry.setBook(1, BOOK_A);
  registry.setBook(2, BOOK_B);
  assert.strictEqual(registry.clearBook(1), true);
  assert.strictEqual(registry.getBook(1), null);
  assert.strictEqual(registry.findWindow(BOOK_A), null);
  assert.strictEqual(registry.getBook(2), openBooks.normalizeBookPath(BOOK_B));
  registry.unregisterWindow(2);
  assert.strictEqual(registry.getBook(2), null);
  registry.unregisterWindow(1);
  assert.deepStrictEqual(registry.counts(), { windows: 0, openBooks: 0 });
});

test('clearPath：书被删除时清掉所有窗口对它的登记', () => {
  const registry = openBooks.createRegistry();
  registry.setBook(1, BOOK_A);
  registry.setBook(2, BOOK_B);
  assert.strictEqual(registry.clearPath(BOOK_A), true);
  assert.strictEqual(registry.findWindow(BOOK_A), null);
  assert.strictEqual(registry.getBook(1), null);
  assert.strictEqual(registry.clearPath(BOOK_A), false);
  assert.strictEqual(registry.findWindow(BOOK_B), '2');
});

test('最近窗口：按最近激活时间选择，没开书的窗口也算', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1, { now: 1000 });
  registry.registerWindow(2, { now: 2000 });
  registry.setBook(1, BOOK_A, { now: 3000 });
  assert.strictEqual(registry.mostRecentWindow(), '1');
  registry.touch(2, { now: 4000 });
  assert.strictEqual(registry.mostRecentWindow(), '2');
  registry.unregisterWindow(2);
  assert.strictEqual(registry.mostRecentWindow(), '1');
  registry.unregisterWindow(1);
  assert.strictEqual(registry.mostRecentWindow(), null);
});

test('最近窗口：同一毫秒内后登记 / 后激活的窗口优先', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow('a', { now: 5000 });
  registry.registerWindow('b', { now: 5000 });
  assert.strictEqual(registry.mostRecentWindow(), 'b');
  registry.touch('a', { now: 5000 });
  assert.strictEqual(registry.mostRecentWindow(), 'a');
});

test('跨窗口拦截：别的窗口开着的书拒绝删除 / 改名 / 保存，自己窗口允许', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  registry.registerWindow(2);
  registry.setBook(2, BOOK_A);
  for (const action of ['delete', 'rename', 'format', 'replace', 'save']) {
    const denied = openBooks.checkMutation({ registry, windowId: 1, bookPath: BOOK_A, action });
    assert.strictEqual(denied.ok, false, action);
    assert.strictEqual(denied.code, openBooks.CODE.CROSS_WINDOW_BUSY);
    assert.strictEqual(denied.ownerWindowId, '2');
    assert.match(denied.message, /请先关掉另一个窗口/);
  }
  assert.strictEqual(
    openBooks.checkMutation({ registry, windowId: 2, bookPath: BOOK_A, action: 'save' }).ok,
    true
  );
});

test('跨窗口拦截：没有窗口开着的书 / 未知窗口 ID 不受影响', () => {
  const registry = openBooks.createRegistry();
  assert.strictEqual(
    openBooks.checkMutation({ registry, windowId: 1, bookPath: BOOK_B, action: 'delete' }).ok,
    true
  );
  registry.setBook(2, BOOK_A);
  assert.strictEqual(
    openBooks.checkMutation({ registry, windowId: undefined, bookPath: BOOK_A, action: 'delete' }).ok,
    false
  );
});

test('路径归一：空值 / 相对路径 / 环境差异都安全，空路径不能登记', () => {
  assert.strictEqual(openBooks.normalizeBookPath(null), '');
  assert.strictEqual(openBooks.normalizeBookPath('  '), '');
  assert.strictEqual(
    openBooks.normalizeBookPath('D:\\Books\\甲书\\'),
    path.resolve('D:\\Books\\甲书').toLowerCase()
  );
  const registry = openBooks.createRegistry();
  assert.strictEqual(registry.setBook(1, '').ok, false);
  assert.strictEqual(registry.setBook(1, '').code, 'BAD_PATH');
});

test('保存前校验：书文件夹不在了 → 阻止保存', () => {
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: false,
    chapterId: 'ch_001',
    chapterExists: false
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.BOOK_MISSING);
  assert.match(result.message, /影子文件/);
});

test('保存前校验：书目读不出来 → 阻止保存（解析失败给出修复提示）', () => {
  const missing = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: null,
    chapterId: 'ch_001',
    chapterExists: true
  });
  assert.strictEqual(missing.code, openBooks.CODE.BOOK_MISSING);
  const broken = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: null,
    metaCode: 'PARSE_ERROR',
    chapterId: 'ch_001',
    chapterExists: true
  });
  assert.strictEqual(broken.code, 'PARSE_ERROR');
  assert.match(broken.message, /修复/);
});

test('保存前校验：章节已不在书目里 → 阻止保存', () => {
  const meta = { chapters: [{ id: 'ch_001', file: '001-未命名.txt' }] };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta,
    chapterId: 'ch_999',
    chapterExists: true
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_NOT_FOUND);
  assert.match(result.message, /不在书目里/);
});

test('保存前校验：章节记录指向的文件名变了 → 阻止保存（不写错文件）', () => {
  const meta = { chapters: [{ id: 'ch_001', file: '001-未命名.txt' }] };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta,
    chapterId: 'ch_001',
    file: '002-旧名.txt',
    chapterExists: true
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_NOT_FOUND);
});

test('保存前校验：章节文件不存在 → 阻止保存，不重建 txt', () => {
  const meta = { chapters: [{ id: 'ch_001', file: '001-未命名.txt' }] };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta,
    chapterId: 'ch_001',
    file: '001-未命名.txt',
    chapterExists: false
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_MISSING);
  assert.match(result.message, /影子文件/);
});

test('保存前校验：书 / 章都在书目里 → 允许保存，并返回章节记录', () => {
  const chapter = { id: 'ch_001', file: '001-未命名.txt', name: '起风' };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: { chapters: [chapter] },
    chapterId: 'ch_001',
    file: '001-未命名.txt',
    chapterExists: true
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.chapter, chapter);
  assert.strictEqual(result.index, 0);
});

test('保存前校验：坏 meta（chapters 不是数组）也不会抛错', () => {
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: { chapters: null },
    chapterId: 'ch_001',
    chapterExists: true
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_NOT_FOUND);
});

test('错误提示：不同动作用不同动词，且都提示先关 / 先切另一个窗口', () => {
  const registry = openBooks.createRegistry();
  registry.setBook(9, BOOK_A);
  for (const [action, verb] of [
    ['delete', '删除'],
    ['rename', '改名'],
    ['format', '整理'],
    ['replace', '替换'],
    ['save', '保存']
  ]) {
    const denied = openBooks.checkMutation({ registry, windowId: 1, bookPath: BOOK_A, action });
    assert.ok(denied.message.includes(verb), action);
    assert.ok(denied.message.includes('请先关掉另一个窗口'), action);
  }
});

test('多窗口规模：登记 / 释放与最近窗口在多个窗口下保持一致', () => {
  const registry = openBooks.createRegistry();
  for (let i = 1; i <= 5; i += 1) registry.registerWindow(i, { now: i });
  for (let i = 1; i <= 5; i += 1) registry.setBook(i, path.join('D:\\Books', `书${i}`), { now: 10 + i });
  assert.deepStrictEqual(registry.counts(), { windows: 5, openBooks: 5 });
  assert.strictEqual(registry.mostRecentWindow(), '5');
  registry.clearBook(5);
  assert.strictEqual(registry.mostRecentWindow(), '5'); // 窗口还在，只是没开书
  assert.strictEqual(registry.findWindow(path.join('D:\\Books', '书5')), null);
  assert.strictEqual(registry.findWindow(path.join('D:\\Books', '书4')), '4');
});
