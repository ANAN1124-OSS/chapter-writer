// 配置读写：存在 Electron userData 目录，不污染小说文件夹。
// 纯 Node，可在测试里传入临时目录。
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, stripBom } = require('./atomic');
const formatLib = require('./format');
const snapshotLib = require('./snapshot');
const statsLib = require('./stats');

// 默认书架：当前用户的「文档\我的小说」（安装后可在应用里改）
const DEFAULT_BOOKS_ROOT = path.join(os.homedir(), 'Documents', '我的小说');
const FONTS = ['serif', 'sans', 'kai', 'custom'];
// 背景主题：纯色 4 档 + 两种纸张纹理（对应口袋写作「背景设置」里的配色/纸张纹理/夜间）
const PAPER_THEMES = ['paper', 'cream', 'green', 'night', 'kraft', 'grid'];
// 可以「按书单独覆盖」的显示设置项（章节栏宽度也在里面）
const BOOK_DISPLAY_KEYS = [
  'editorFont',
  'editorCustomFontPath',
  'editorCustomFontName',
  'editorFontSize',
  'editorSidebarWidth',
  'editorLineHeight',
  'editorLetterSpacing',
  'editorPageWidth',
  'editorPaddingX',
  'editorPaper'
];

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
  // 每本书的显示设置覆盖：{ [bookId]: { 只放改过的项 } }；没有覆盖的书沿用上面的全局值
  bookDisplay: {},
  // 「整理本章」上一次用过的规则，下次打开对话框沿用（不改正文，只是记住勾选）
  formatOptions: { ...formatLib.DEFAULT_OPTIONS },
  // 上次「导出 TXT」保存到的目录，下次导出默认还开在这里（目录没了会自动退回「文档」）
  lastExportDir: '',
  // 上次写作的书 + 章节（书架顶部「继续上次写作」用）。只是书架级记忆，书库里的
  // lastOpenChapterId 仍是「打开这本书回到哪一章」的唯一事实来源。
  // { path, title, chapterId, chapterIndex, chapterName, at }；没有写过 = null。
  lastBook: null,
  // 可选「每日快照」：默认关（不给作者添意外写盘）。开启后每次 Ctrl+S 成功时，
  // 当天第一次保存会把这一章的上一版复制到书内 _trash/快照-YYYYMMDD/。
  snapshotEnabled: false,
  snapshotKeepDays: snapshotLib.DEFAULT_KEEP_DAYS,
  // 每日写作目标（字数）：0 = 不设目标；只统计保存动作写下的正字数。
  // 统计本身存在 userData/stats.json，不写进书库。
  dailyGoal: statsLib.DEFAULT_GOAL,
  // 敏感词预检用的词表（作者自己的 txt，每行一个词）。应用不内置任何词表；
  // 这里只记绝对路径，词表文件本身只读、不复制、不改写。没设置 = ''。
  sensitiveWordsPath: ''
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

// 单本书的显示设置覆盖：只保留传进来的键（没传的项继续用全局值）
function sanitizeBookDisplayEntry(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  if (has('editorFont')) {
    out.editorFont = FONTS.includes(raw.editorFont) ? raw.editorFont : DEFAULTS.editorFont;
  }
  if (has('editorCustomFontPath')) {
    out.editorCustomFontPath = typeof raw.editorCustomFontPath === 'string' ? raw.editorCustomFontPath.trim() : '';
  }
  if (has('editorCustomFontName')) {
    out.editorCustomFontName = typeof raw.editorCustomFontName === 'string' ? raw.editorCustomFontName.trim() : '';
  }
  if (has('editorFontSize')) out.editorFontSize = clampInt(raw.editorFontSize, 12, 30, DEFAULTS.editorFontSize);
  if (has('editorSidebarWidth')) {
    out.editorSidebarWidth = clampInt(raw.editorSidebarWidth, 180, 800, DEFAULTS.editorSidebarWidth);
  }
  if (has('editorLineHeight')) {
    out.editorLineHeight = clampFloat(raw.editorLineHeight, 1.2, 3, DEFAULTS.editorLineHeight);
  }
  if (has('editorLetterSpacing')) {
    out.editorLetterSpacing = clampFloat(raw.editorLetterSpacing, 0, 0.2, DEFAULTS.editorLetterSpacing);
  }
  if (has('editorPageWidth')) {
    const width = Number(raw.editorPageWidth);
    out.editorPageWidth = Number.isFinite(width) && width > 0
      ? clampInt(width, 600, 1600, DEFAULTS.editorPageWidth)
      : 0;
  }
  if (has('editorPaddingX')) out.editorPaddingX = clampInt(raw.editorPaddingX, 16, 200, DEFAULTS.editorPaddingX);
  if (has('editorPaper')) {
    out.editorPaper = PAPER_THEMES.includes(raw.editorPaper) ? raw.editorPaper : DEFAULTS.editorPaper;
  }
  // 覆盖成「自定义字体」但没带字体路径：这一项不算数，回落到全局字体
  if (out.editorFont === 'custom' && !out.editorCustomFontPath) delete out.editorFont;
  return out;
}

function sanitizeBookDisplay(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [bookId, entry] of Object.entries(raw)) {
    const key = typeof bookId === 'string' ? bookId.trim() : '';
    if (!key || key.length > 200) continue;
    const clean = sanitizeBookDisplayEntry(entry);
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

// 「继续上次写作」：只记书架级的位置，读的时候一律清洗；坏值/空值当作没记过（null），
// 不影响旧配置文件（没有 lastBook 就显示不出入口，其余功能照常）。
function sanitizeLastBook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bookPath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!bookPath || bookPath.length > 1000) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim().slice(0, 100) : '';
  const chapterName = typeof raw.chapterName === 'string' ? raw.chapterName.trim().slice(0, 200) : '';
  const at = Number(raw.at);
  return {
    path: bookPath,
    title,
    chapterId,
    chapterIndex: clampInt(raw.chapterIndex, 0, 1000000, 0),
    chapterName,
    at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0
  };
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
  cfg.bookDisplay = sanitizeBookDisplay(cfg.bookDisplay);
  cfg.formatOptions = formatLib.sanitizeOptions(cfg.formatOptions);
  // 上次导出的目录：只做基本清洗，路径不存在时由主进程退回「文档」目录
  const lastExportDir = typeof cfg.lastExportDir === 'string' ? cfg.lastExportDir.trim() : '';
  cfg.lastExportDir = lastExportDir.length > 1000 ? '' : lastExportDir;
  cfg.lastBook = sanitizeLastBook(cfg.lastBook);
  // 每日快照：只认真正的 true（缺字段 / 写错类型都按「关」，不会因为脏配置自动写盘）；
  // 保留天数夹在 1–90 天，坏值回落 7 天。
  cfg.snapshotEnabled = cfg.snapshotEnabled === true;
  cfg.snapshotKeepDays = snapshotLib.normalizeKeepDays(
    cfg.snapshotKeepDays,
    snapshotLib.DEFAULT_KEEP_DAYS
  );
  // 每日目标：0 = 不设目标；负数 / NaN 回落 0，超大值夹到上限；旧配置没有这个键照常启动。
  cfg.dailyGoal = statsLib.normalizeGoal(cfg.dailyGoal, DEFAULTS.dailyGoal);
  // 敏感词表路径：只做基本清洗（非字符串 / 超长 → 未设置）；文件不存在时由预检面板提示，
  // 不会因为词表被移走就让应用起不来。旧配置没有这个键 = 未设置。
  const sensitiveWordsPath =
    typeof cfg.sensitiveWordsPath === 'string' ? cfg.sensitiveWordsPath.trim() : '';
  cfg.sensitiveWordsPath = sensitiveWordsPath.length > 1000 ? '' : sensitiveWordsPath;

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
  let loadWarning = null; // 配置损坏被归档时，给界面提示一次
  let queue = Promise.resolve();

  // 配置写入串行化：并发 set 时各自拿旧 cache 合并会吞掉对方的 patch（例如拖完分隔条同时点保存设置）
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  function defaults() {
    return { ...DEFAULTS, windowBounds: { ...DEFAULTS.windowBounds }, bookDisplay: {} };
  }

  async function load() {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      // 没有配置文件 = 首次启动，用默认值（这不算损坏，不提示）
      cache = defaults();
      return { ...cache };
    }
    try {
      cache = sanitize(JSON.parse(stripBom(raw)));
    } catch {
      // 配置坏了：先归档损坏文件（不直接删），再回默认值，并让界面提示一次，
      // 否则书架路径会悄悄变回「文档\我的小说」，用户会以为书全没了。
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const archived = `${file}.corrupt-${stamp}`;
      try {
        await fs.rename(file, archived);
      } catch {
        /* 归档失败也不能阻塞启动 */
      }
      cache = defaults();
      loadWarning = {
        code: 'CONFIG_CORRUPT',
        archived,
        message: `配置文件损坏，已归档为 ${path.basename(archived)} 并恢复默认设置；书架目录请在「设置」里重新指定。`
      };
    }
    return { ...cache };
  }

  // 取出「配置损坏」提示（只给一次）
  function takeLoadWarning() {
    const warning = loadWarning;
    loadWarning = null;
    return warning;
  }

  async function get() {
    if (!cache) await load();
    return { ...cache };
  }

  function set(patch) {
    return enqueue(async () => {
      const current = await get();
      cache = sanitize({ ...current, ...(patch || {}) });
      await writeJsonAtomic(file, cache);
      return { ...cache };
    });
  }

  // ---------- 每本书的显示设置覆盖 ----------
  async function getBookDisplay(bookId) {
    const cfg = await get();
    const key = String(bookId == null ? '' : bookId).trim();
    if (!key) return {};
    return { ...(cfg.bookDisplay[key] || {}) };
  }

  async function setBookDisplay(bookId, patch) {
    return enqueue(async () => {
      const cfg = await get();
      const key = String(bookId == null ? '' : bookId).trim();
      if (!key) throw new Error('缺少书籍 id');
      const merged = sanitizeBookDisplayEntry({ ...(cfg.bookDisplay[key] || {}), ...(patch || {}) });
      const bookDisplay = { ...cfg.bookDisplay };
      if (Object.keys(merged).length) bookDisplay[key] = merged;
      else delete bookDisplay[key];
      cache = sanitize({ ...cfg, bookDisplay });
      await writeJsonAtomic(file, cache);
      return { ...(cache.bookDisplay[key] || {}) };
    });
  }

  async function resetBookDisplay(bookId) {
    return enqueue(async () => {
      const cfg = await get();
      const key = String(bookId == null ? '' : bookId).trim();
      if (!key || !cfg.bookDisplay[key]) return false;
      const bookDisplay = { ...cfg.bookDisplay };
      delete bookDisplay[key];
      cache = sanitize({ ...cfg, bookDisplay });
      await writeJsonAtomic(file, cache);
      return true;
    });
  }

  return {
    file,
    load,
    get,
    set,
    takeLoadWarning,
    getBookDisplay,
    setBookDisplay,
    resetBookDisplay,
    defaults: DEFAULTS
  };
}

module.exports = {
  createConfigStore,
  DEFAULTS,
  sanitize,
  sanitizeBookDisplayEntry,
  sanitizeLastBook,
  FONTS,
  PAPER_THEMES,
  BOOK_DISPLAY_KEYS
};
