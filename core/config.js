// 配置读写：存在 Electron userData 目录，不污染小说文件夹。
// 纯 Node，可在测试里传入临时目录。
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic, stripBom } = require('./atomic');
const formatLib = require('./format');

const DEFAULT_BOOKS_ROOT = '文档\\我的小说';
const FONTS = ['serif', 'sans', 'kai', 'custom'];
// 背景主题：纯色 4 档 + 两种纸张纹理（对应口袋写作「背景设置」里的配色/纸张纹理/夜间）
const PAPER_THEMES = ['paper', 'cream', 'green', 'night', 'kraft', 'grid'];

const DEFAULTS = Object.freeze({
  booksRoot: DEFAULT_BOOKS_ROOT,
  windowBounds: { x: 60, y: 40, width: 1200, height: 760 },
  editorFont: 'serif',
  editorFontSize: 18,
  editorSidebarWidth: 250,
  // 自定义字体（editorFont = 'custom' 时生效；只记路径，不复制字体文件）
  editorCustomFontPath: '',
  editorCustomFontName: '',
  // 显示排版（写作页「排版 ▾」/ 设置里可调）
  editorLineHeight: 1.95,
  editorLetterSpacing: 0.02,
  editorPageWidth: 0, // 0 = 通栏；>0 为正文最大宽度（px）
  editorPaddingX: 56, // 正文左右边距（px）
  editorPaper: 'paper', // paper 原纸白 / cream 米黄 / green 豆绿 / night 夜间 / kraft 牛皮纸 / grid 网格纸
  // 「整理本章」上一次用过的规则，下次打开对话框沿用（不改正文，只是记住勾选）
  formatOptions: { ...formatLib.DEFAULT_OPTIONS }
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

function sanitize(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };

  if (typeof cfg.booksRoot !== 'string' || !cfg.booksRoot.trim()) {
    cfg.booksRoot = DEFAULTS.booksRoot;
  }

  cfg.editorFont = FONTS.includes(cfg.editorFont) ? cfg.editorFont : DEFAULTS.editorFont;
  cfg.editorFontSize = clampInt(cfg.editorFontSize, 12, 30, DEFAULTS.editorFontSize);
  // 章节栏宽度（拖动分隔条调整，双击恢复默认）
  cfg.editorSidebarWidth = clampInt(cfg.editorSidebarWidth, 180, 800, DEFAULTS.editorSidebarWidth);

  // 自定义字体：路径只做基本清洗，选中的字体没了会回落到内置字体
  cfg.editorCustomFontPath = typeof cfg.editorCustomFontPath === 'string' ? cfg.editorCustomFontPath.trim() : '';
  cfg.editorCustomFontName = typeof cfg.editorCustomFontName === 'string' ? cfg.editorCustomFontName.trim() : '';
  if (cfg.editorFont === 'custom' && !cfg.editorCustomFontPath) cfg.editorFont = DEFAULTS.editorFont;

  // 显示排版：行距 / 字距 / 正文宽度 / 左右边距 / 背景主题
  cfg.editorLineHeight = clampFloat(cfg.editorLineHeight, 1.2, 3, DEFAULTS.editorLineHeight);
  cfg.editorLetterSpacing = clampFloat(cfg.editorLetterSpacing, 0, 0.2, DEFAULTS.editorLetterSpacing);
  const pageWidth = Number(cfg.editorPageWidth);
  cfg.editorPageWidth = Number.isFinite(pageWidth) && pageWidth > 0
    ? clampInt(pageWidth, 600, 1600, DEFAULTS.editorPageWidth)
    : 0;
  cfg.editorPaddingX = clampInt(cfg.editorPaddingX, 16, 200, DEFAULTS.editorPaddingX);
  cfg.editorPaper = PAPER_THEMES.includes(cfg.editorPaper) ? cfg.editorPaper : DEFAULTS.editorPaper;
  cfg.formatOptions = formatLib.sanitizeOptions(cfg.formatOptions);

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

module.exports = { createConfigStore, DEFAULTS, sanitize, FONTS, PAPER_THEMES };
