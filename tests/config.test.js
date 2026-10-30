const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore, sanitize, DEFAULTS } = require('../core/config');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-config-'));
}

test('配置默认值：书架在 文档\\我的小说，窗口 1200x760', async () => {
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
