// 配置读写：存在 Electron userData 目录，不污染小说文件夹。
// 纯 Node，可在测试里传入临时目录。
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic, stripBom } = require('./atomic');

const DEFAULT_BOOKS_ROOT = '文档\\我的小说';
const FONTS = ['serif', 'sans', 'kai'];

const DEFAULTS = Object.freeze({
  booksRoot: DEFAULT_BOOKS_ROOT,
  windowBounds: { x: 60, y: 40, width: 1200, height: 760 },
  editorFont: 'serif',
  editorFontSize: 18
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitize(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };

  if (typeof cfg.booksRoot !== 'string' || !cfg.booksRoot.trim()) {
    cfg.booksRoot = DEFAULTS.booksRoot;
  }

  cfg.editorFont = FONTS.includes(cfg.editorFont) ? cfg.editorFont : DEFAULTS.editorFont;
  cfg.editorFontSize = clampInt(cfg.editorFontSize, 12, 30, DEFAULTS.editorFontSize);

  const b = cfg.windowBounds;
  if (b && typeof b === 'object' && Number.isFinite(Number(b.width)) && Number.isFinite(Number(b.height))) {
    cfg.windowBounds = {
      x: Number.isFinite(Number(b.x)) ? Math.round(Number(b.x)) : DEFAULTS.windowBounds.x,
      y: Number.isFinite(Number(b.y)) ? Math.round(Number(b.y)) : DEFAULTS.windowBounds.y,
      width: clampInt(b.width, 960, 4000, DEFAULTS.windowBounds.width),
      height: clampInt(b.height, 620, 3000, DEFAULTS.windowBounds.height)
    };
  } else {
    cfg.windowBounds = { ...DEFAULTS.windowBounds };
  }

  return cfg;
}

function createConfigStore(userDataDir) {
  const file = path.join(userDataDir, 'config.json');
  let cache = null;

  async function load() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      cache = sanitize(JSON.parse(stripBom(raw)));
    } catch {
      cache = { ...DEFAULTS, windowBounds: { ...DEFAULTS.windowBounds } };
    }
    return { ...cache };
  }

  async function get() {
    if (!cache) await load();
    return { ...cache };
  }

  async function set(patch) {
    const current = await get();
    cache = sanitize({ ...current, ...(patch || {}) });
    await writeJsonAtomic(file, cache);
    return { ...cache };
  }

  return { file, load, get, set, defaults: DEFAULTS };
}

module.exports = { createConfigStore, DEFAULTS, sanitize, FONTS };
