// 磁盘层：书架扫描、书目读写、章节文件读写。
// 不 require('electron')，可直接在 node:test 里用临时目录测试。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, writeJsonAtomic, stripBom } = require('./atomic');
const chaptersLib = require('./chapters');

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

async function bookStats(bookPath, meta) {
  let totalChars = 0;
  let latestMtime = 0;
  const missing = [];
  for (const c of meta.chapters) {
    const p = assertInside(bookPath, c.file);
    try {
      const stat = await fs.stat(p);
      const text = await fs.readFile(p, 'utf8');
      totalChars += chaptersLib.countChars(stripBom(text));
      if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') missing.push(c.file);
      else throw err;
    }
  }
  if (!latestMtime) {
    try {
      latestMtime = (await fs.stat(path.join(bookPath, BOOK_FILE))).mtimeMs;
    } catch { latestMtime = Date.now(); }
  }
  return { totalChars, missing, latestMtime };
}

async function listBooks(booksRoot) {
  await ensureDir(booksRoot);
  let entries;
  try {
    entries = await fs.readdir(booksRoot, { withFileTypes: true });
  } catch (err) {
    throw new StorageError('ROOT_UNREADABLE', `书架目录无法读取：${err.message}`);
  }
  const books = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
    const bookPath = path.join(booksRoot, ent.name);
    if (!(await exists(path.join(bookPath, BOOK_FILE)))) continue;
    try {
      const meta = await readBookMeta(bookPath);
      const stats = await bookStats(bookPath, meta);
      books.push({
        path: bookPath,
        folder: ent.name,
        status: 'ok',
        title: meta.title || ent.name,
        chapterCount: meta.chapters.length,
        totalChars: stats.totalChars,
        lastModified: stats.latestMtime,
        missing: stats.missing
      });
    } catch (err) {
      books.push({
        path: bookPath,
        folder: ent.name,
        status: 'corrupt',
        title: ent.name,
        chapterCount: 0,
        totalChars: 0,
        lastModified: 0,
        reason: err.message,
        missing: []
      });
    }
  }
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
  const stats = await bookStats(bookPath, meta);
  return { meta, missing: stats.missing, totalChars: stats.totalChars };
}

async function verifyBook(bookPath) {
  const meta = await readBookMeta(bookPath);
  const stats = await bookStats(bookPath, meta);
  return { chapterCount: meta.chapters.length, totalChars: stats.totalChars, missing: stats.missing };
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

async function renameBook(bookPath, title) {
  const meta = await readBookMeta(bookPath);
  const nextTitle = String(title == null ? '' : title).trim() || meta.title;
  const saved = await writeBookMeta(bookPath, { ...meta, title: nextTitle });
  return saved;
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
  renameBook: locked(renameBook),
  setLastOpenChapter: locked(setLastOpenChapter),
  moveToTrash,
  timestampForFile,
  withBookLock
};
