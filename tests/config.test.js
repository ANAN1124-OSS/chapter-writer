const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore, sanitize, DEFAULTS } = require('../core/config');

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
