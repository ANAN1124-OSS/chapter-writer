// 磁盘层：书架扫描、书目读写、章节文件读写。
// 不 require('electron')，可直接在 node:test 里用临时目录测试。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, writeJsonAtomic, stripBom } = require('./atomic');
const chaptersLib = require('./chapters');
const findLib = require('./find');

const BOOK_FILE = '书目.json';
const BOOK_BAK = '书目.json.bak';
const TRASH_DIR = '_trash';
const CORRUPT_PREFIX = '书目.json.corrupt-';

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function assertInside(bookPath, file) {
  const root = path.resolve(bookPath);
  const target = path.resolve(bookPath, file);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new StorageError('BAD_PATH', `非法的章节文件路径：${file}`);
  }
  return target;
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new StorageError('INVALID_META', '书目.json 的内容不是一个对象');
  }
  if (!Array.isArray(meta.chapters)) {
    throw new StorageError('INVALID_META', '书目.json 缺少 chapters 数组');
  }
  meta.chapters.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new StorageError('INVALID_META', `第 ${i + 1} 条章节记录不是对象`);
    }
    if (typeof c.file !== 'string' || !c.file.trim()) {
      throw new StorageError('INVALID_META', `第 ${i + 1} 条章节记录缺少 file 字段`);
    }
  });
  return true;
}

async function readBookMeta(bookPath) {
  const metaPath = path.join(bookPath, BOOK_FILE);
  let raw;
  try {
    raw = await fs.readFile(metaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('NO_BOOK', `没有找到 ${BOOK_FILE}`);
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(stripBom(raw));
  } catch {
    throw new StorageError('PARSE_ERROR', `${BOOK_FILE} 解析失败（内容不是合法 JSON）`);
  }
  validateMeta(meta);
  meta.chapters = meta.chapters.map((c, i) => ({
    ...c,
    id: typeof c.id === 'string' && c.id ? c.id : `ch_${chaptersLib.pad3(i + 1)}`,
    name: typeof c.name === 'string' ? c.name : '',
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso()
  }));
  if (typeof meta.titleTemplate !== 'string' || !meta.titleTemplate.trim()) {
    meta.titleTemplate = chaptersLib.TITLE_TEMPLATE;
  }
  if (!Number.isFinite(Number(meta.fileSeq))) meta.fileSeq = meta.chapters.length;
  if (typeof meta.title !== 'string') meta.title = path.basename(bookPath);
  return meta;
}

async function writeBookMeta(bookPath, meta) {
  await ensureDir(bookPath);
  const metaPath = path.join(bookPath, BOOK_FILE);
  const bakPath = path.join(bookPath, BOOK_BAK);
  // 先备份上一版（只在存在时）
  try {
    const old = await fs.readFile(metaPath);
    await atomicWriteFile(bakPath, old);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const next = { ...meta, updatedAt: nowIso() };
  await writeJsonAtomic(metaPath, next);
  return next;
}

async function listTxtFiles(bookPath) {
  let entries;
  try {
    entries = await fs.readdir(bookPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && /\.txt$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

// 并发上限工具：书架扫描时并行读多本书的 书目.json（机械盘/杀软环境下串行会明显慢）
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// 书架扫描用的统计：字数走 书目.json 缓存，不再每次重读整本书；
// 缓存缺失时只读缺的那几章并把缓存写回（老书首次扫描慢一点，之后秒开）。
async function bookStats(bookPath, meta) {
  let totalChars = 0;
  const needRead = [];
  for (const chapter of meta.chapters) {
    if (Number.isFinite(chapter.chars)) totalChars += chapter.chars;
    else needRead.push(chapter);
  }
  if (needRead.length) {
    let changed = false;
    for (const chapter of needRead) {
      try {
        const text = await fs.readFile(assertInside(bookPath, chapter.file), 'utf8');
        chapter.chars = chaptersLib.countChars(stripBom(text));
        totalChars += chapter.chars;
        changed = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (changed) {
      try {
        await writeBookMeta(bookPath, meta);
      } catch { /* 缓存写不进去不影响书架显示 */ }
    }
  }
  const updatedAt = Date.parse(meta.updatedAt || meta.createdAt || '');
  return { totalChars, latestMtime: Number.isFinite(updatedAt) ? updatedAt : Date.now() };
}

// 打开书/保存后校验用：并行 stat 每章文件，找出缺失的章节文件
async function findMissingChapters(bookPath, meta, concurrency = 16) {
  const flags = await mapLimit(meta.chapters, concurrency, async (chapter) => {
    try {
      await fs.stat(assertInside(bookPath, chapter.file));
      return null;
    } catch (err) {
      if (err.code === 'ENOENT') return chapter.file;
      throw err;
    }
  });
  return flags.filter(Boolean);
}

async function listBooks(booksRoot) {
  await ensureDir(booksRoot);
  let entries;
  try {
    entries = await fs.readdir(booksRoot, { withFileTypes: true });
  } catch (err) {
    throw new StorageError('ROOT_UNREADABLE', `书架目录无法读取：${err.message}`);
  }

  const candidates = entries
    .filter((ent) => ent.isDirectory() && !ent.name.startsWith('_') && !ent.name.startsWith('.'))
    .map((ent) => ({ folder: ent.name, bookPath: path.join(booksRoot, ent.name) }));

  const scanned = await mapLimit(candidates, 12, async ({ folder, bookPath }) => {
    try {
      const meta = await readBookMeta(bookPath);
      const stats = await bookStats(bookPath, meta);
      return {
        path: bookPath,
        folder,
        status: 'ok',
        title: meta.title || folder,
        chapterCount: meta.chapters.length,
        totalChars: stats.totalChars,
        lastModified: stats.latestMtime,
        missing: []
      };
    } catch (err) {
      if (err && err.code === 'NO_BOOK') return null; // 没有书目的普通文件夹，跳过
      return {
        path: bookPath,
        folder,
        status: 'corrupt',
        title: folder,
        chapterCount: 0,
        totalChars: 0,
        lastModified: 0,
        reason: err.message,
        missing: []
      };
    }
  });

  const books = scanned.filter(Boolean);
  books.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  return books;
}

async function createBook(booksRoot, title) {
  const displayTitle = String(title == null ? '' : title).trim() || '我的新书';
  await ensureDir(booksRoot);
  const base = chaptersLib.safeName(displayTitle);
  let folder = base;
  let i = 2;
  for (;;) {
    try {
      await fs.mkdir(path.join(booksRoot, folder));
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        folder = `${base}-${i}`;
        i += 1;
        continue;
      }
      throw err;
    }
  }
  const bookPath = path.join(booksRoot, folder);
  const seq = 1;
  const file = chaptersLib.buildFileName(seq, '');
  await atomicWriteFile(path.join(bookPath, file), '');
  const meta = {
    version: 1,
    id: `b_${Date.now().toString(36)}`,
    title: displayTitle,
    titleTemplate: chaptersLib.TITLE_TEMPLATE,
    fileSeq: seq,
    chapters: [{ id: 'ch_001', file, name: '', createdAt: nowIso() }],
    lastOpenChapterId: 'ch_001',
    createdAt: nowIso()
  };
  const saved = await writeBookMeta(bookPath, meta);
  return { path: bookPath, meta: saved };
}

async function openBook(bookPath) {
  const meta = await readBookMeta(bookPath);
  const [stats, missing] = await Promise.all([
    bookStats(bookPath, meta),
    findMissingChapters(bookPath, meta)
  ]);
  return { meta, missing, totalChars: stats.totalChars };
}

async function verifyBook(bookPath) {
  const meta = await readBookMeta(bookPath);
  const [missing, stats] = await Promise.all([
    findMissingChapters(bookPath, meta),
    bookStats(bookPath, meta)
  ]);
  return { chapterCount: meta.chapters.length, totalChars: stats.totalChars, missing };
}

async function loadChapterText(bookPath, file) {
  const p = assertInside(bookPath, file);
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('CHAPTER_MISSING', `章节文件不存在：${file}`);
    throw err;
  }
  const stat = await fs.stat(p);
  return {
    text: chaptersLib.normalizeNewlines(stripBom(raw)),
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

async function statChapter(bookPath, file) {
  const p = assertInside(bookPath, file);
  const stat = await fs.stat(p);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

async function saveChapterText(bookPath, file, text) {
  const p = assertInside(bookPath, file);
  await atomicWriteFile(p, chaptersLib.toDiskNewlines(text));
  const stat = await fs.stat(p);
  return { mtimeMs: stat.mtimeMs, chars: chaptersLib.countChars(text) };
}

async function createChapter(bookPath, insertIndex, name) {
  const meta = await readBookMeta(bookPath);
  const seq = chaptersLib.nextFileSeq(meta);
  const existing = await listTxtFiles(bookPath);
  const file = chaptersLib.uniqueFileName(seq, name, existing);
  await atomicWriteFile(path.join(bookPath, file), '');
  const chapter = {
    id: `ch_${Date.now().toString(36)}_${seq}`,
    file,
    name: String(name == null ? '' : name).trim(),
    createdAt: nowIso()
  };
  try {
    const updated = chaptersLib.insertChapter({ ...meta, fileSeq: seq }, insertIndex, chapter);
    const saved = await writeBookMeta(bookPath, updated);
    return {
      meta: saved,
      chapter,
      index: saved.chapters.findIndex((c) => c.id === chapter.id)
    };
  } catch (err) {
    try { await fs.unlink(path.join(bookPath, file)); } catch { /* 忽略 */ }
    throw err;
  }
}

async function renameChapter(bookPath, chapterId, name) {
  const meta = await readBookMeta(bookPath);
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  const updated = chaptersLib.updateChapter(meta, chapterId, { name: String(name == null ? '' : name).trim() });
  const saved = await writeBookMeta(bookPath, updated);
  return { meta: saved, chapter: saved.chapters[index] };
}

function timestampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function moveToTrash(bookPath, file) {
  const trashDir = path.join(bookPath, TRASH_DIR);
  await ensureDir(trashDir);
  const stamp = timestampForFile();
  let destName = `${stamp}-${file}`;
  let i = 2;
  while (await exists(path.join(trashDir, destName))) {
    destName = `${stamp}-${i}-${file}`;
    i += 1;
  }
  const dest = path.join(trashDir, destName);
  await fs.rename(path.join(bookPath, file), dest);
  return dest;
}

async function deleteChapter(bookPath, chapterId) {
  const meta = await readBookMeta(bookPath);
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  const target = meta.chapters[index];
  let trashPath = null;
  try {
    trashPath = await moveToTrash(bookPath, target.file);
  } catch (err) {
    throw new StorageError('TRASH_FAILED', `无法把章节移到回收目录：${err.message}`);
  }
  let updated = chaptersLib.removeChapter(meta, chapterId);
  let newChapter = null;
  if (updated.chapters.length === 0) {
    const seq = chaptersLib.nextFileSeq(updated);
    const file = chaptersLib.uniqueFileName(seq, '', await listTxtFiles(bookPath));
    await atomicWriteFile(path.join(bookPath, file), '');
    newChapter = {
      id: `ch_${Date.now().toString(36)}_${seq}`,
      file,
      name: '',
      createdAt: nowIso()
    };
    updated = { ...updated, fileSeq: seq, chapters: [newChapter] };
  }
  const saved = await writeBookMeta(bookPath, updated);
  return {
    meta: saved,
    trashPath,
    newChapter,
    index: Math.min(index, saved.chapters.length - 1)
  };
}

// 拖拽排序：只改 书目.json 里的数组顺序，章节文件永不重命名（显示章号按数组顺序现算）
async function moveChapter(bookPath, chapterId, toIndex) {
  const meta = await readBookMeta(bookPath);
  const from = chaptersLib.findChapterIndex(meta, chapterId);
  if (from < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  const total = meta.chapters.length;
  const to = Math.max(0, Math.min(Math.round(Number(toIndex) || 0), total - 1));
  if (from === to) return { meta, moved: false, from, to };
  const list = meta.chapters.slice();
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  const saved = await writeBookMeta(bookPath, { ...meta, chapters: list });
  return { meta: saved, moved: true, from, to };
}

async function loadTextOrSkip(bookPath, chapter) {
  try {
    return await loadChapterText(bookPath, chapter.file);
  } catch (err) {
    if (err.code === 'CHAPTER_MISSING') return null; // 缺文件的章节直接跳过，别让查找整个失败
    throw err;
  }
}

// 全书查找：逐章读正文，返回命中章节 + 前几处上下文（只读，不写盘）
async function searchBook(bookPath, options = {}) {
  const query = String(options.query == null ? '' : options.query);
  if (!query.trim()) throw new StorageError('EMPTY_QUERY', '查找内容不能为空');
  const caseSensitive = Boolean(options.caseSensitive);
  const meta = await readBookMeta(bookPath);
  const results = [];
  let totalMatches = 0;
  for (const chapter of meta.chapters) {
    const loaded = await loadTextOrSkip(bookPath, chapter);
    if (!loaded) continue;
    const matches = findLib.findMatches(loaded.text, query, { caseSensitive });
    if (!matches.length) continue;
    totalMatches += matches.length;
    results.push({
      chapterId: chapter.id,
      file: chapter.file,
      name: chapter.name,
      count: matches.length,
      matches: matches.slice(0, 12).map((match) => ({
        index: match.index,
        length: match.length,
        ...findLib.makeSnippet(loaded.text, match.index, match.length)
      }))
    });
  }
  return { query, caseSensitive, totalMatches, chapterCount: results.length, results };
}

// 全书替换：逐章字面量替换并写盘；写之前把原文件备份到书内 _trash/替换备份-时间戳/。
// 这是作者显式点「全部替换」才发生的动作，和「打字不自动保存」不冲突。
async function replaceInBook(bookPath, options = {}) {
  const query = String(options.query == null ? '' : options.query);
  const replacement = String(options.replacement == null ? '' : options.replacement);
  const caseSensitive = Boolean(options.caseSensitive);
  if (!query.trim()) throw new StorageError('EMPTY_QUERY', '查找内容不能为空');
  const meta = await readBookMeta(bookPath);
  const backupDir = path.join(bookPath, TRASH_DIR, `替换备份-${timestampForFile()}`);
  let chaptersChanged = 0;
  let occurrences = 0;
  let backupCreated = false;
  for (const chapter of meta.chapters) {
    const loaded = await loadTextOrSkip(bookPath, chapter);
    if (!loaded) continue;
    const res = findLib.replaceAllLiteral(loaded.text, query, replacement, { caseSensitive });
    if (!res.count) continue;
    if (!backupCreated) {
      await ensureDir(backupDir);
      backupCreated = true;
    }
    await fs.copyFile(assertInside(bookPath, chapter.file), path.join(backupDir, chapter.file));
    await saveChapterText(bookPath, chapter.file, res.text);
    chapter.chars = chaptersLib.countChars(res.text);
    chaptersChanged += 1;
    occurrences += res.count;
  }
  if (chaptersChanged) await writeBookMeta(bookPath, meta);
  return {
    chaptersChanged,
    occurrences,
    backupDir: backupCreated ? backupDir : null
  };
}

async function renameBook(bookPath, title) {
  const meta = await readBookMeta(bookPath);
  const nextTitle = String(title == null ? '' : title).trim() || meta.title;
  const saved = await writeBookMeta(bookPath, { ...meta, title: nextTitle });
  return saved;
}

// 整本书的兜底删除：移动到书架根目录下的 _trash（回收站不可用时使用）
async function trashBook(booksRoot, bookPath) {
  const trashDir = path.join(booksRoot, TRASH_DIR);
  await ensureDir(trashDir);
  const folder = path.basename(bookPath);
  const dest = path.join(trashDir, `${timestampForFile()}-${folder}`);
  await fs.rename(bookPath, dest);
  return dest;
}

async function setLastOpenChapter(bookPath, chapterId) {
  try {
    const meta = await readBookMeta(bookPath);
    if (meta.lastOpenChapterId === chapterId) return true;
    await writeBookMeta(bookPath, { ...meta, lastOpenChapterId: chapterId });
    return true;
  } catch {
    return false;
  }
}

// ---------- 同一本书的「读-改-写」串行化 ----------
// 背景：渲染层会发 fire-and-forget 的 setLastOpenChapter，如果它和改名/插入等操作并发，
// 各自「读 meta → 改 → 写回」就会互相覆盖。主进程内用 promise 链把同一本书的写操作排队。
const bookLocks = new Map();

function withBookLock(bookPath, task) {
  const key = path.resolve(String(bookPath));
  const previous = bookLocks.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  bookLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function locked(fn) {
  return (...args) => withBookLock(args[0], () => fn(...args));
}

const safeCreateBook = (booksRoot, title) => withBookLock(booksRoot, () => createBook(booksRoot, title));

module.exports = {
  BOOK_FILE,
  BOOK_BAK,
  TRASH_DIR,
  CORRUPT_PREFIX,
  StorageError,
  nowIso,
  exists,
  assertInside,
  listTxtFiles,
  readBookMeta,
  writeBookMeta,
  listBooks,
  createBook: safeCreateBook,
  openBook,
  verifyBook,
  loadChapterText,
  statChapter,
  saveChapterText,
  createChapter: locked(createChapter),
  renameChapter: locked(renameChapter),
  deleteChapter: locked(deleteChapter),
  moveChapter: locked(moveChapter),
  searchBook,
  replaceInBook: locked(replaceInBook),
  renameBook: locked(renameBook),
  trashBook,
  setLastOpenChapter: locked(setLastOpenChapter),
  moveToTrash,
  timestampForFile,
  withBookLock
};
