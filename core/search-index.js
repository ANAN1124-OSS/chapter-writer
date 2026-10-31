// 正文全文搜索索引（提案 7.3）
//
// 目标：书架搜索能搜到正文，同时 280 本 / 3256 章的架子也不能卡。
//
// 做法：每本书一份「正文双字（bigram）哈希 Bloom 位图」+ 每章的文件指纹（mtime / size），
// 索引单独存在 %APPDATA%\chapter-writer\search-index.json —— **绝不进书库、绝不改正文**。
//
// 为什么不是倒排索引：中文没有空格，按字建倒排会被「一章两万字、常用字几乎每章都有」
// 淹掉（筛不掉任何一本）；按词建倒排又得依赖词典。一本 25 万字的书，其不重复双字约
// 8 万个，Bloom 位图 8 bit/项 ≈ 80KB，280 本 ≈ 22MB。查询时先用位图筛掉 97% 以上的书，
// 再只读命中那几本的真实 txt 核对并截上下文 —— 位图只会误报（多读一两本），**不会漏报**
// （建图和查询用同一套归一化：小写 + CRLF 归一）。
//
// 一致性：每章存 mtime + size，搜索 / 回书架时校验。只有正文变过的书才重建位图，
// 改章名 / 调顺序只更新元数据；删书 / 删章 / 外部改 txt 都会被校验发现。
// 索引坏了 / 版本不对 / 书架目录换了 → 当作没有索引自动重建，作者不用手动操作。
// 写盘走 core/atomic；索引读写失败只让本次搜索降级，绝不影响正文保存与界面。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic');
const storage = require('./storage');
const chaptersLib = require('./chapters');

const INDEX_FILE_NAME = 'search-index.json';
const INDEX_VERSION = 1;

// Bloom 参数：每项 8 bit、3 个哈希。一本书 8 万个双字 ≈ 80KB，单项误报率约 3%。
const BITS_PER_ITEM = 8;
const HASH_COUNT = 3;
const MIN_BLOOM_BITS = 1024;
const MAX_BLOOM_BITS = 64 * 1024 * 1024; // 单本 8MB 位图上限（异常输入兜底）

const MIN_QUERY_CHARS = 2; // 正文搜索至少两个字（单字几乎没有筛选意义）
const DEFAULT_RESULT_LIMIT = 40;
const MAX_RESULT_LIMIT = 60;
const MAX_SNIPPETS_PER_CHAPTER = 3;
const SNIPPET_RADIUS = 16;
const MAX_CANDIDATE_BOOKS = 60; // 两字常用词可能命中一大半书：最多读这么多本
const SEARCH_TIME_BUDGET_MS = 1800; // 超过就带着已有结果返回（结果标 truncated）
const FULL_VALIDATE_INTERVAL_MS = 10000; // 后台深度校验的节流（外部改 txt 最迟这么久后发现）
// 搜索自身不做逐章 stat（太慢），但距上次深度校验超过 1 分钟时会顺带做一次兜底校验，
// 保证「一直在书架搜、不回书架」也能发现外部改过的 txt。
const SEARCH_DEEP_INTERVAL_MS = 60000;
const SAVE_DEBOUNCE_MS = 2500;
const PROGRESS_INTERVAL_MS = 150;

function nowIso(clock) {
  const date = typeof clock === 'function' ? clock() : new Date();
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  return d.toISOString();
}

// Windows 路径不分大小写：比较书架目录 / 书目录统一用小写
function normalizeRoot(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return path.resolve(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function normalizeQuery(value) {
  return normalizeText(value).trim();
}

// 双字（UTF-16 码元）32 位哈希：中文正文几乎都在 BMP，代理对按两个码元算也一致。
function bigramHash(c1, c2) {
  let h = Math.imul((c1 + 1) | 0, 0x9e3779b1) ^ Math.imul((c2 + 1) | 0, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

function addBigramsToSet(text, set) {
  const source = String(text == null ? '' : text);
  for (let i = 0; i < source.length - 1; i += 1) {
    set.add(bigramHash(source.charCodeAt(i), source.charCodeAt(i + 1)));
  }
  return set;
}

// 查询串 → 不重复的双字哈希（查询本身也先归一化成小写）
function queryBigrams(query) {
  const set = new Set();
  addBigramsToSet(normalizeQuery(query), set);
  return Array.from(set);
}

function bloomParams(itemCount) {
  const n = Math.max(0, Math.floor(Number(itemCount) || 0));
  const wanted = n * BITS_PER_ITEM;
  const bits = Math.min(MAX_BLOOM_BITS, Math.max(MIN_BLOOM_BITS, wanted));
  return { bits, hashes: HASH_COUNT };
}

function bloomIndexes(hash, bits, hashes = HASH_COUNT) {
  const size = Math.max(1, Math.floor(Number(bits) || 1));
  const out = new Array(Math.max(1, Math.floor(Number(hashes) || 1)));
  let x = hash >>> 0;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = x % size;
    x = (x + 0x9e3779b9) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
  }
  return out;
}

function bloomAdd(bloom, bits, hash) {
  for (const index of bloomIndexes(hash, bits)) {
    bloom[index >> 3] |= 1 << (index & 7);
  }
  return bloom;
}

function bloomHas(bloom, bits, hash) {
  if (!Buffer.isBuffer(bloom)) return true; // 没有位图 = 当作候选（不能漏报）
  for (const index of bloomIndexes(hash, bits)) {
    if ((bloom[index >> 3] & (1 << (index & 7))) === 0) return false;
  }
  return true;
}

// 一本书的所有章节文本 → Bloom 位图。位图只回答「有没有」，不保存任何正文。
function makeBookBloom(texts) {
  const set = new Set();
  for (const text of texts) addBigramsToSet(normalizeText(text), set);
  const params = bloomParams(set.size);
  const bloom = Buffer.alloc(Math.ceil(params.bits / 8));
  for (const hash of set) bloomAdd(bloom, params.bits, hash);
  return { bloom, bits: params.bits, items: set.size };
}

function encodeBloom(bloom) {
  return Buffer.isBuffer(bloom) ? bloom.toString('base64') : '';
}

function decodeBloom(text, bits) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const buffer = Buffer.from(text, 'base64');
    if (!buffer.length) return null;
    const wanted = Math.ceil(Math.max(1, Number(bits) || 0) / 8);
    if (buffer.length !== wanted) return null;
    return buffer;
  } catch {
    return null;
  }
}

// 命中位置前后的上下文片段：换行 / 制表压成空格，两端裁掉多余空白。
// 返回 before / match / after 三段，渲染层用 <mark> 包住 match（不拼 HTML，防注入）。
function snippetAround(text, index, length, radius = SNIPPET_RADIUS) {
  const source = String(text == null ? '' : text);
  const at = Math.max(0, Math.min(Math.floor(Number(index) || 0), source.length));
  const len = Math.max(1, Math.min(Math.floor(Number(length) || 1), source.length - at));
  const beforeStart = Math.max(0, at - radius);
  const afterEnd = Math.min(source.length, at + len + radius);
  const clean = (value) =>
    String(value)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\u0000/g, '')
      .replace(/\s+/g, ' ');
  let before = clean(source.slice(beforeStart, at));
  let match = clean(source.slice(at, at + len));
  let after = clean(source.slice(at + len, afterEnd));
  before = before.replace(/^\s+/, '').replace(/\s+$/, '');
  match = match.replace(/^\s+/, '').replace(/\s+$/, '');
  after = after.replace(/^\s+/, '').replace(/\s+$/, '');
  return {
    before,
    match,
    after,
    cutBefore: beforeStart > 0,
    cutAfter: afterEnd < source.length
  };
}

function emptyIndex(root = '') {
  return {
    version: INDEX_VERSION,
    root: normalizeRoot(root),
    builtAt: '',
    updatedAt: '',
    books: []
  };
}

function sanitizeChapter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = typeof raw.file === 'string' ? raw.file : '';
  if (!file || file.includes('\u0000')) return null;
  const mtimeMs = Number(raw.mtimeMs);
  const size = Number(raw.size);
  const index = Number(raw.index);
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : '',
    name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '',
    file: file.slice(0, 260),
    index: Number.isFinite(index) ? Math.max(0, Math.round(index)) : 0,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
    size: Number.isFinite(size) ? Math.max(0, size) : 0,
    chars: Number.isFinite(Number(raw.chars)) ? Math.max(0, Math.round(Number(raw.chars))) : null
  };
}

function sanitizeBook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bookPath = typeof raw.path === 'string' ? raw.path : '';
  if (!bookPath || bookPath.includes('\u0000')) return null;
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.map(sanitizeChapter).filter(Boolean)
    : [];
  const bloom = typeof raw.bloom === 'string' ? raw.bloom : '';
  const bloomBits = Number(raw.bloomBits);
  const bits = Number.isFinite(bloomBits) ? Math.max(0, Math.round(bloomBits)) : 0;
  const metaMtimeMs = Number(raw.metaMtimeMs);
  const lastModified = Number(raw.lastModified);
  return {
    path: bookPath,
    folder: typeof raw.folder === 'string' ? raw.folder.slice(0, 260) : '',
    id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : '',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    metaMtimeMs: Number.isFinite(metaMtimeMs) ? metaMtimeMs : 0,
    lastModified: Number.isFinite(lastModified) ? lastModified : 0,
    bloom: bloom.slice(0, MAX_BLOOM_BITS), // base64 字符数上限（异常输入兜底）
    bloomBits: bits,
    itemCount: Number.isFinite(Number(raw.itemCount)) ? Math.max(0, Math.round(Number(raw.itemCount))) : 0,
    chapters
  };
}

// 索引文件解析 + 清洗：坏 JSON / 版本不对 / 字段缺失一律当作没有索引（自动重建）。
function sanitizeIndex(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version) !== INDEX_VERSION) return null;
  const books = Array.isArray(raw.books) ? raw.books.map(sanitizeBook).filter(Boolean) : [];
  return {
    version: INDEX_VERSION,
    root: typeof raw.root === 'string' ? normalizeRoot(raw.root) : '',
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt.slice(0, 40) : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : '',
    books
  };
}

function parseIndex(text) {
  try {
    return sanitizeIndex(JSON.parse(String(text == null ? '' : text)));
  } catch {
    return null;
  }
}

function serializeIndex(index) {
  return JSON.stringify(index);
}

function totalChapters(index) {
  return (index && Array.isArray(index.books) ? index.books : []).reduce(
    (sum, book) => sum + (Array.isArray(book.chapters) ? book.chapters.length : 0),
    0
  );
}

function sameChapter(a, b) {
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.file === b.file &&
    a.index === b.index &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.chars === b.chars
  );
}

function sameBook(a, b) {
  if (!a || !b) return false;
  if (
    a.path !== b.path ||
    a.folder !== b.folder ||
    a.id !== b.id ||
    a.title !== b.title ||
    a.metaMtimeMs !== b.metaMtimeMs ||
    a.lastModified !== b.lastModified ||
    a.bloom !== b.bloom ||
    a.bloomBits !== b.bloomBits ||
    a.itemCount !== b.itemCount
  ) {
    return false;
  }
  const left = Array.isArray(a.chapters) ? a.chapters : [];
  const right = Array.isArray(b.chapters) ? b.chapters : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sameChapter(left[i], right[i])) return false;
  }
  return true;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listBookFolders(booksRoot) {
  const entries = await fs.readdir(booksRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => ({ folder: entry.name, bookPath: path.join(booksRoot, entry.name) }))
    .sort((a, b) => a.folder.localeCompare(b.folder, 'zh-Hans-CN'));
}

function countChars(text) {
  return String(text == null ? '' : text).replace(/\s/g, '').length;
}

// 一本书的索引：读书目 + 逐章文件指纹；正文变过（或强制 / 脏标记）才重算位图。
// 返回 null 表示「没有可用书目」（损坏 / 没有 书目.json），这本书不参与搜索。
async function buildBookEntry(bookPath, folder, old, options, onProgress) {
  const force = Boolean(options.force);
  const dirty = Boolean(options.dirty);
  let meta;
  try {
    meta = await storage.readBookMeta(bookPath);
  } catch {
    return null;
  }
  let metaMtimeMs = 0;
  try {
    metaMtimeMs = (await fs.stat(path.join(bookPath, storage.BOOK_FILE))).mtimeMs;
  } catch {
    metaMtimeMs = 0;
  }
  const rawChapters = Array.isArray(meta.chapters) ? meta.chapters : [];
  // 章节文件指纹：并发 stat（大书架一次要 3000+ 次，串行会明显拖慢校验）
  const stats = await mapLimit(rawChapters, 24, async (chapter) => {
    try {
      const stat = await fs.stat(storage.assertInside(bookPath, chapter.file));
      if (!stat.isFile()) return null;
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null; // 缺文件的章节不参与搜索（书目里还在，历史面板能找回）
    }
  });

  const oldChapters = new Map(
    (old && Array.isArray(old.chapters) ? old.chapters : []).map((chapter) => [chapter.file, chapter])
  );
  const chapters = [];
  let textChanged = force || dirty;
  for (let i = 0; i < rawChapters.length; i += 1) {
    const chapter = rawChapters[i];
    const stat = stats[i];
    if (!stat) {
      textChanged = true; // 上一版里有的章现在没了：要剔除，也算内容变化
      continue;
    }
    const previous = oldChapters.get(chapter.file);
    if (
      !previous ||
      previous.mtimeMs !== stat.mtimeMs ||
      previous.size !== stat.size ||
      previous.index !== i
    ) {
      if (!previous || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size) {
        textChanged = true;
      }
    }    chapters.push({
      id: typeof chapter.id === 'string' ? chapter.id : '',
      name: typeof chapter.name === 'string' ? chapter.name : '',
      file: chapter.file,
      index: i,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      chars: Number.isFinite(Number(chapter.chars))
        ? Math.max(0, Math.round(Number(chapter.chars)))
        : previous && Number.isFinite(previous.chars)
          ? previous.chars
          : null
    });
  }
  // 上一版里有、这一版没有的章（被删 / 被跳过）也算变化
  if (!textChanged) {
    const files = new Set(chapters.map((chapter) => chapter.file));
    for (const file of oldChapters.keys()) {
      if (!files.has(file)) {
        textChanged = true;
        break;
      }
    }
  }

  const lastModified = Math.max(metaMtimeMs || 0, ...chapters.map((chapter) => chapter.mtimeMs), 0);
  const base = {
    path: bookPath,
    folder,
    id: typeof meta.id === 'string' ? meta.id : '',
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : folder,
    metaMtimeMs,
    lastModified,
    bloom: '',
    bloomBits: 0,
    itemCount: 0,
    chapters
  };

  if (old && !textChanged && old.bloom) {
    // 只改了章名 / 顺序 / 状态：复用位图，不重读正文
    return {
      entry: {
        ...base,
        bloom: old.bloom,
        bloomBits: old.bloomBits,
        itemCount: old.itemCount,
        chapters: base.chapters.map((chapter) => {
          const previous = oldChapters.get(chapter.file);
          return previous && chapter.chars == null ? { ...chapter, chars: previous.chars } : chapter;
        })
      },
      rebuilt: false
    };
  }

  if (onProgress) onProgress({ phase: 'book', book: base.title, chapters: chapters.length });
  const texts = await mapLimit(chapters, 6, async (chapter) => {
    try {
      return (await storage.loadChapterText(bookPath, chapter.file)).text;
    } catch {
      return null; // 读不到正文：整本位图作废（宁可每次都当候选，也不能漏报）
    }
  });
  if (texts.some((text) => text == null)) {
    // 有章节读不了：不给位图，搜索时这本书永远进候选、逐章核对
    return { entry: { ...base, bloom: '', bloomBits: 0, itemCount: 0 }, rebuilt: true };
  }
  const built = makeBookBloom(texts);
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].chars == null) chapters[i].chars = countChars(texts[i]);
  }
  return {
    entry: {
      ...base,
      bloom: encodeBloom(built.bloom),
      bloomBits: built.bits,
      itemCount: built.items
    },
    rebuilt: true
  };
}

function createSearchStore(options = {}) {
  const userDataDir = path.resolve(String(options.userDataDir == null ? '' : options.userDataDir));
  const filePath = path.join(userDataDir, INDEX_FILE_NAME);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const validateIntervalMs = Number.isFinite(options.validateIntervalMs)
    ? Math.max(0, options.validateIntervalMs)
    : FULL_VALIDATE_INTERVAL_MS;
  const saveDebounceMs = Number.isFinite(options.saveDebounceMs)
    ? Math.max(0, options.saveDebounceMs)
    : SAVE_DEBOUNCE_MS;

  let index = emptyIndex('');
  let loaded = false;
  let loadProblem = null;
  let indexBytes = 0;
  let ensurePromise = null;
  let lastFullValidateAt = 0;
  let lastProgress = null;
  let lastRun = null;
  let saveTimer = null;
  let savePromise = Promise.resolve();
  let lastSaveError = null;
  const dirtyBooks = new Set();
  const bloomCache = new Map(); // path -> { bloom(base64), bits, buffer }

  function bloomFor(book) {
    if (!book.bloom) return null;
    const cached = bloomCache.get(book.path);
    if (cached && cached.bloom === book.bloom && cached.bits === book.bloomBits) return cached.buffer;
    const buffer = decodeBloom(book.bloom, book.bloomBits);
    if (!buffer) return null;
    bloomCache.set(book.path, { bloom: book.bloom, bits: book.bloomBits, buffer });
    return buffer;
  }

  async function load() {
    if (loaded) return index;
    loaded = true;
    try {
      const text = await fs.readFile(filePath, 'utf8');
      indexBytes = Buffer.byteLength(text);
      const parsed = parseIndex(text);
      if (parsed) {
        index = parsed;
      } else {
        loadProblem = 'CORRUPT';
        index = emptyIndex('');
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') loadProblem = err.code || 'ERROR';
      index = emptyIndex('');
    }
    return index;
  }

  function status() {
    return {
      file: filePath,
      ready: Boolean(index.builtAt) && index.books.length > 0,
      books: index.books.length,
      chapters: totalChapters(index),
      bytes: indexBytes,
      builtAt: index.builtAt || '',
      updatedAt: index.updatedAt || '',
      root: index.root,
      building: Boolean(ensurePromise),
      progress: lastProgress,
      problem: loadProblem,
      saveError: lastSaveError,
      lastRun
    };
  }

  async function saveNow() {
    try {
      const text = serializeIndex(index);
      await atomicWriteFile(filePath, text);
      indexBytes = Buffer.byteLength(text);
      lastSaveError = null;
      loadProblem = null;
      return true;
    } catch (err) {
      lastSaveError = (err && err.code) || 'ERROR';
      return false;
    }
  }

  function scheduleSave(delay = saveDebounceMs) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      savePromise = savePromise.then(saveNow, saveNow).catch(() => false);
    }, Math.max(0, delay));
    if (saveTimer.unref) saveTimer.unref();
  }

  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    savePromise = savePromise.then(saveNow, saveNow).catch(() => false);
    await savePromise;
    return status();
  }

  async function doEnsure(options2 = {}) {
    const booksRoot = String(options2.booksRoot == null ? '' : options2.booksRoot);
    const force = Boolean(options2.force);
    // deep=false 时只校验 书目.json 的 mtime（搜索走这条路：不为 3000 次章节 stat 等一秒）；
    // 回书架 / 启动时的后台校验（deep=true）才逐章 stat，用来发现「外部改过的 txt」。
    const deep = options2.deep !== false;
    const onProgress = typeof options2.onProgress === 'function' ? options2.onProgress : null;
    await load();

    const root = normalizeRoot(booksRoot);
    const rootChanged = index.root !== root;
    if (rootChanged) {
      index = emptyIndex(root);
      bloomCache.clear();
      lastFullValidateAt = 0;
    }

    let folders;
    try {
      folders = await listBookFolders(booksRoot);
    } catch (err) {
      const result = status();
      result.error = (err && err.code) || 'ROOT_UNREADABLE';
      return result;
    }

    const fullValidate =
      force || rootChanged || (deep && Date.now() - lastFullValidateAt >= validateIntervalMs);
    const previous = new Map(index.books.map((book) => [normalizeRoot(book.path), book]));
    const nextBooks = [];
    const run = {
      force,
      fullValidate,
      addedBooks: 0,
      rebuiltBooks: 0,
      reusedBooks: 0,
      removedBooks: 0,
      changed: rootChanged,
      books: folders.length,
      chapters: 0
    };
    let progressAt = 0;
    const report = (info, forceReport) => {
      const now = Date.now();
      if (!onProgress) return;
      if (!forceReport && now - progressAt < PROGRESS_INTERVAL_MS) return;
      progressAt = now;
      lastProgress = { ...info, at: now };
      try {
        onProgress(lastProgress);
      } catch {
        /* 进度回调不能影响建索引 */
      }
    };

    let doneBooks = 0;
    for (const { folder, bookPath } of folders) {
      const key = normalizeRoot(bookPath);
      const old = previous.get(key) || null;
      const dirty = dirtyBooks.has(key);
      let reuse = false;
      if (old && !force && !dirty) {
        // 先看 书目.json 的 mtime（每本一次 stat，很便宜；改名 / 排序都靠它发现）。
        // 全量校验窗口外，mtime 没变就整本跳过（省掉 3000 多次章节 stat）；
        // 全量校验时即使 mtime 没变也走 buildBookEntry —— 它会逐章 stat 找「外部改过的 txt」，
        // 章节指纹都没变时复用旧位图，不重读正文。
        let metaMtimeMs = 0;
        try {
          metaMtimeMs = (await fs.stat(path.join(bookPath, storage.BOOK_FILE))).mtimeMs;
        } catch {
          metaMtimeMs = 0;
        }
        if (metaMtimeMs && metaMtimeMs === old.metaMtimeMs && !fullValidate) reuse = true;
      }
      if (reuse) {
        nextBooks.push(old);
        previous.delete(key);
        run.reusedBooks += 1;
        run.chapters += old.chapters.length;
        doneBooks += 1;
        report({ phase: 'validate', done: doneBooks, total: folders.length, books: doneBooks, chapters: run.chapters });
        continue;
      }

      report({
        phase: 'book',
        done: doneBooks,
        total: folders.length,
        book: folder,
        books: doneBooks,
        chapters: run.chapters
      });
      let built = null;
      try {
        built = await buildBookEntry(
          bookPath,
          folder,
          old,
          { force, dirty },
          (info) => report({ ...info, done: doneBooks, total: folders.length })
        );
      } catch {
        built = null; // 单本书异常不能拖垮整个索引
      }
      doneBooks += 1;
      previous.delete(key);
      dirtyBooks.delete(key);
      if (!built) {
        // 没有书目 / 读不出来：不索引这本书（书卡在书架上仍会显示损坏提示）
        continue;
      }
      const entry = built.entry;
      if (!old) run.addedBooks += 1;
      else if (built.rebuilt) run.rebuiltBooks += 1;
      else run.reusedBooks += 1;
      if (!sameBook(old, entry)) run.changed = true;
      nextBooks.push(entry);
      run.chapters += entry.chapters.length;
      report({ phase: 'book', done: doneBooks, total: folders.length, book: entry.title, books: doneBooks, chapters: run.chapters });
    }
    run.removedBooks = previous.size;
    if (previous.size) run.changed = true;
    run.books = nextBooks.length;
    run.chapters = totalChapters({ books: nextBooks });
    for (const key of Array.from(dirtyBooks)) {
      if (!folders.some((folder) => normalizeRoot(folder.bookPath) === key)) dirtyBooks.delete(key);
    }
    index = {
      version: INDEX_VERSION,
      root,
      builtAt: index.builtAt || nowIso(clock),
      updatedAt: nowIso(clock),
      books: nextBooks
    };
    lastFullValidateAt = fullValidate ? Date.now() : lastFullValidateAt;
    if (run.changed || rootChanged) await saveNow();
    lastRun = run;
    const result = status();
    if (run.changed || rootChanged) {
      report(
        {
          phase: 'done',
          done: folders.length,
          total: folders.length,
          books: run.books,
          chapters: run.chapters,
          rebuilt: run.rebuiltBooks,
          bytes: indexBytes
        },
        true
      );
    }
    return result;
  }

  // 同一时间只跑一次校验 / 建索引；后来的调用排在后面（force 仍会执行）。
  function ensure(opts = {}) {
    const previous = ensurePromise || Promise.resolve();
    const run = previous.catch(() => {}).then(() => doEnsure(opts));
    ensurePromise = run;
    run.then(
      () => {
        if (ensurePromise === run) ensurePromise = null;
      },
      () => {
        if (ensurePromise === run) ensurePromise = null;
      }
    );
    return run;
  }

  async function search(opts = {}) {
    const booksRoot = String(opts.booksRoot == null ? '' : opts.booksRoot);
    const normalized = normalizeQuery(opts.query);
    const requestedLimit = Number(opts.limit);
    const limit = Math.max(
      1,
      Math.min(MAX_RESULT_LIMIT, Number.isFinite(requestedLimit) ? Math.round(requestedLimit) : DEFAULT_RESULT_LIMIT)
    );
    const maxBooks = Math.max(
      1,
      Math.min(MAX_CANDIDATE_BOOKS, Math.round(Number(opts.maxBooks) || MAX_CANDIDATE_BOOKS))
    );
    const timeBudgetMs = Math.max(1, Number(opts.timeBudgetMs) || SEARCH_TIME_BUDGET_MS);
    const qBigrams = queryBigrams(normalized);

    const makeBase = (indexInfo) => ({
      query: normalized,
      results: [],
      limit,
      candidateBooks: 0,
      scannedBooks: 0,
      scannedChapters: 0,
      skippedChapters: 0,
      matchedChapters: 0,
      totalMatches: 0,
      truncated: false,
      tooShort: false,
      elapsedMs: 0,
      index: indexInfo
    });

    if (normalized.length < MIN_QUERY_CHARS || !qBigrams.length) {
      const state = await statusResult();
      return {
        ...makeBase({ books: state.books, chapters: state.chapters, building: state.building }),
        tooShort: true
      };
    }

    const ensured = await ensure({
      booksRoot,
      deep: Date.now() - lastFullValidateAt >= SEARCH_DEEP_INTERVAL_MS,
      ...(opts.ensureOptions || {})
    });
    const indexInfo = {
      books: ensured.books,
      chapters: ensured.chapters,
      building: false,
      problem: ensured.problem || '',
      bytes: ensured.bytes
    };
    if (normalizeRoot(booksRoot) !== index.root) {
      return { ...makeBase(indexInfo), truncated: true, index: { ...indexInfo, books: 0, chapters: 0 } };
    }

    const startedAt = Date.now();
    const candidates = [];
    for (const book of index.books) {
      const bloom = bloomFor(book);
      if (!bloom) {
        candidates.push(book); // 没有位图（有章节读不了）→ 永远核查，不能漏
        continue;
      }
      let ok = true;
      for (const hash of qBigrams) {
        if (!bloomHas(bloom, book.bloomBits, hash)) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push(book);
    }
    candidates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    const scanTarget = candidates.slice(0, maxBooks);
    const results = [];
    let matchedChapters = 0;
    let totalMatches = 0;
    let scannedBooks = 0;
    let scannedChapters = 0;
    let skippedChapters = 0;
    let stoppedByTime = false;

    for (const book of scanTarget) {
      if (results.length >= limit) break;
      if (Date.now() - startedAt > timeBudgetMs) {
        stoppedByTime = true;
        break;
      }
      scannedBooks += 1;
      for (const chapter of book.chapters) {
        if (results.length >= limit) break;
        if (Date.now() - startedAt > timeBudgetMs) {
          stoppedByTime = true;
          break;
        }
        let text;
        try {
          text = (await storage.loadChapterText(book.path, chapter.file)).text;
        } catch {
          skippedChapters += 1; // 索引之后文件被删 / 被占用：跳过，不让整次搜索失败
          continue;
        }
        scannedChapters += 1;
        const haystack = normalizeText(text);
        let from = 0;
        let hits = 0;
        while (hits < MAX_SNIPPETS_PER_CHAPTER && results.length < limit) {
          const at = haystack.indexOf(normalized, from);
          if (at < 0) break;
          hits += 1;
          totalMatches += 1;
          results.push({
            bookPath: book.path,
            bookTitle: book.title,
            folder: book.folder,
            chapterId: chapter.id,
            chapterIndex: chapter.index,
            chapterName: chapter.name,
            matchIndex: at,
            matchLength: normalized.length,
            snippet: snippetAround(text, at, normalized.length)
          });
          from = at + Math.max(1, normalized.length);
        }
        if (hits > 0) matchedChapters += 1;
      }
    }

    const truncated =
      results.length >= limit || stoppedByTime || candidates.length > scanTarget.length;
    return {
      ...makeBase({
        books: index.books.length,
        chapters: totalChapters(index),
        building: false,
        bytes: ensured.bytes,
        builtAt: index.builtAt
      }),
      results,
      candidateBooks: candidates.length,
      scannedBooks,
      scannedChapters,
      skippedChapters,
      matchedChapters,
      totalMatches,
      truncated,
      elapsedMs: Date.now() - startedAt
    };
  }

  async function statusResult() {
    await load();
    return status();
  }

  function markDirty(bookPath) {
    const key = normalizeRoot(bookPath);
    if (key) dirtyBooks.add(key);
    return key;
  }

  function dirtyList() {
    return Array.from(dirtyBooks);
  }

  return {
    filePath,
    ensure,
    search,
    status: statusResult,
    flush,
    markDirty,
    dirtyList,
    load,
    // 供单测 / 自检直接用的内部信息（不参与界面逻辑）
    getIndex: () => index,
    getBytes: () => indexBytes,
    getProblem: () => loadProblem
  };
}

module.exports = {
  INDEX_FILE_NAME,
  INDEX_VERSION,
  BITS_PER_ITEM,
  HASH_COUNT,
  MIN_BLOOM_BITS,
  MIN_QUERY_CHARS,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_SNIPPETS_PER_CHAPTER,
  MAX_CANDIDATE_BOOKS,
  SEARCH_TIME_BUDGET_MS,
  FULL_VALIDATE_INTERVAL_MS,
  normalizeRoot,
  normalizeText,
  normalizeQuery,
  bigramHash,
  addBigramsToSet,
  queryBigrams,
  bloomParams,
  bloomIndexes,
  bloomAdd,
  bloomHas,
  makeBookBloom,
  encodeBloom,
  decodeBloom,
  snippetAround,
  emptyIndex,
  sanitizeChapter,
  sanitizeBook,
  sanitizeIndex,
  parseIndex,
  serializeIndex,
  totalChapters,
  sameBook,
  listBookFolders,
  buildBookEntry,
  createSearchStore
};
