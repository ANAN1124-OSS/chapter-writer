// 磁盘层：书架扫描、书目读写、章节文件读写。
// 不 require('electron')，可直接在 node:test 里用临时目录测试。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, writeJsonAtomic, stripBom } = require('./atomic');
const chaptersLib = require('./chapters');
const findLib = require('./find');
const formatLib = require('./format');

const BOOK_FILE = '书目.json';
const BOOK_BAK = '书目.json.bak';
const TRASH_DIR = '_trash';
const CORRUPT_PREFIX = '书目.json.corrupt-';
// 整本替换的备份目录（写盘前把原章节复制到这里）与「还原前」的反向备份目录
const REPLACE_BACKUP_PREFIX = '替换备份-';
const RESTORE_BACKUP_PREFIX = '还原前备份-';
// 整本智能排版的备份目录（写盘前把要改动的原章节复制到这里）
const FORMAT_BACKUP_PREFIX = '整理备份-';

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
  meta.chapters = meta.chapters.map((c, i) =>
    chaptersLib.cleanChapterMeta({
      ...c,
      id: typeof c.id === 'string' && c.id ? c.id : `ch_${chaptersLib.pad3(i + 1)}`,
      name: typeof c.name === 'string' ? c.name : '',
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso()
    })
  );
  if (typeof meta.titleTemplate !== 'string' || !meta.titleTemplate.trim()) {
    meta.titleTemplate = chaptersLib.TITLE_TEMPLATE;
  }
  if (!Number.isFinite(Number(meta.fileSeq))) meta.fileSeq = meta.chapters.length;
  if (typeof meta.title !== 'string') meta.title = path.basename(bookPath);
  // 分卷：清掉非法卷、把指向不存在卷的章归为「未分卷」，并把章节顺序归一成「未分卷 → 第1卷 → …」
  return chaptersLib.normalizeChapterOrder({ ...meta, volumes: chaptersLib.sanitizeVolumes(meta.volumes) });
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

// 把「刚读出来的章节字数」合并进「锁里重新读到的 meta」：
// 只补仍然缺 chars 的章，别人在这期间新建/改名/删除的章节原样保留，不会被旧 meta 覆盖。
function mergeCharsCache(freshMeta, cachedChapters) {
  let changed = false;
  const byId = new Map();
  const byFile = new Map();
  for (const chapter of freshMeta.chapters) {
    if (chapter.id) byId.set(chapter.id, chapter);
    if (chapter.file) byFile.set(chapter.file, chapter);
  }
  for (const cached of cachedChapters) {
    if (!Number.isFinite(cached.chars)) continue;
    const target = (cached.id && byId.get(cached.id)) || (cached.file && byFile.get(cached.file));
    if (!target || Number.isFinite(target.chars)) continue;
    target.chars = cached.chars;
    changed = true;
  }
  return { meta: freshMeta, changed };
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
      // 写缓存必须走书锁，而且要锁内重读 meta 再合并：
      // 否则「扫描读到的旧 meta + 补字数」会覆盖掉同时发生的建章/改名/删除（真实丢操作路径）。
      try {
        await withBookLock(bookPath, async () => {
          const fresh = await readBookMeta(bookPath);
          const merged = mergeCharsCache(fresh, needRead);
          if (merged.changed) await writeBookMeta(bookPath, merged.meta);
        });
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
        // 章节名给书架搜索用（只搜书名/章节名，不搜正文）
        chapterNames: meta.chapters.map((chapter) => chapter.name || ''),
        // 书卡上的「完稿 X/Y 章」（只统计 status === 'done' 的章）
        doneChapters: chaptersLib.countChapterStatuses(meta).done,
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
        chapterNames: [],
        doneChapters: 0,
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

async function createChapter(bookPath, insertIndex, name, volumeId = null) {
  const meta = await readBookMeta(bookPath);
  const seq = chaptersLib.nextFileSeq(meta);
  const existing = await listTxtFiles(bookPath);
  const file = chaptersLib.uniqueFileName(seq, name, existing);
  await atomicWriteFile(path.join(bookPath, file), '');
  const wantedVolume = chaptersLib.sanitizeVolumes(meta.volumes).some((v) => v.id === volumeId) ? volumeId : null;
  const chapter = {
    id: `ch_${Date.now().toString(36)}_${seq}`,
    file,
    name: String(name == null ? '' : name).trim(),
    volumeId: wantedVolume,
    createdAt: nowIso()
  };
  try {
    // 指定了卷：插到那一卷的末尾（不按调用方传的下标，避免新章跑到别的卷中间）
    const at = wantedVolume
      ? chaptersLib.insertIndexForVolume(meta, wantedVolume)
      : insertIndex;
    const updated = chaptersLib.insertChapter({ ...meta, fileSeq: seq }, at, chapter);
    const saved = await writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder(updated));
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

// ---------- 分卷操作（同一本书的写操作都要持锁，走 locked()） ----------
async function createVolume(bookPath, name) {
  const meta = await readBookMeta(bookPath);
  const volume = { id: chaptersLib.nextVolumeId(meta), name: String(name == null ? '' : name).trim() };
  const updated = chaptersLib.normalizeChapterOrder({ ...meta, volumes: [...meta.volumes, volume] });
  const saved = await writeBookMeta(bookPath, updated);
  return { meta: saved, volume };
}

async function renameVolume(bookPath, volumeId, name) {
  const meta = await readBookMeta(bookPath);
  const volumes = meta.volumes.map((v) =>
    v.id === volumeId ? { ...v, name: String(name == null ? '' : name).trim() } : v
  );
  if (!volumes.some((v) => v.id === volumeId)) {
    throw new StorageError('VOLUME_NOT_FOUND', '卷不存在（可能已被删除）');
  }
  const saved = await writeBookMeta(bookPath, { ...meta, volumes });
  return { meta: saved };
}

// 删卷不删章：卷里的章节回到「未分卷」，章节文件一个都不动
async function deleteVolume(bookPath, volumeId) {
  const meta = await readBookMeta(bookPath);
  if (!meta.volumes.some((v) => v.id === volumeId)) {
    throw new StorageError('VOLUME_NOT_FOUND', '卷不存在（可能已被删除）');
  }
  const updated = chaptersLib.normalizeChapterOrder({
    ...meta,
    volumes: meta.volumes.filter((v) => v.id !== volumeId)
  });
  const saved = await writeBookMeta(bookPath, updated);
  return { meta: saved, movedChapters: saved.chapters.filter((c) => !c.volumeId).length };
}

// 把一章移到某卷（volumeId 传 null = 移回「未分卷」）；移完按卷重新归一顺序
async function moveChapterToVolume(bookPath, chapterId, volumeId = null) {
  const meta = await readBookMeta(bookPath);
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  const wanted = chaptersLib.sanitizeVolumes(meta.volumes).some((v) => v.id === volumeId) ? volumeId : null;
  const chapters = meta.chapters.map((c) => (c.id === chapterId ? { ...c, volumeId: wanted } : c));
  const saved = await writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder({ ...meta, chapters }));
  return { meta: saved, index: saved.chapters.findIndex((c) => c.id === chapterId) };
}

// 拖拽用：把一章放到「某卷的某个位置」——volumeId 为目标卷（null = 未分卷），
// beforeChapterId 为插到哪一章之前（null = 该卷末尾）。可以跨卷。
async function moveChapterTo(bookPath, chapterId, volumeId = null, beforeChapterId = null) {
  const meta = await readBookMeta(bookPath);
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  const wanted = chaptersLib.sanitizeVolumes(meta.volumes).some((v) => v.id === volumeId) ? volumeId : null;
  const chapter = { ...meta.chapters[index], volumeId: wanted };
  const rest = meta.chapters.filter((c) => c.id !== chapterId);
  const restMeta = { ...meta, chapters: rest };
  let at;
  if (beforeChapterId) {
    const beforeIndex = rest.findIndex((c) => c.id === beforeChapterId);
    at = beforeIndex >= 0 ? beforeIndex : chaptersLib.insertIndexForVolume(restMeta, wanted);
  } else {
    at = chaptersLib.insertIndexForVolume(restMeta, wanted);
  }
  const chapters = rest.slice();
  chapters.splice(Math.max(0, Math.min(at, chapters.length)), 0, chapter);
  const saved = await writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder({ ...meta, chapters }));
  return { meta: saved, index: saved.chapters.findIndex((c) => c.id === chapterId) };
}

// 调整卷的先后顺序（章节跟着卷走，组内顺序不变；章节文件不动）
async function moveVolume(bookPath, volumeId, toIndex) {
  const meta = await readBookMeta(bookPath);
  const result = chaptersLib.moveVolume(meta, volumeId, toIndex);
  if (!result.moved) return { meta, moved: false, from: result.from, to: result.to };
  const saved = await writeBookMeta(bookPath, result.meta);
  return { meta: saved, moved: true, from: result.from, to: result.to };
}

async function renameChapter(bookPath, chapterId, name) {
  const meta = await readBookMeta(bookPath);
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  const updated = chaptersLib.updateChapter(meta, chapterId, { name: String(name == null ? '' : name).trim() });
  const saved = await writeBookMeta(bookPath, updated);
  return { meta: saved, chapter: saved.chapters[index] };
}

// 章节状态 / 备注：只改书目里的可选字段，章节 txt 一个字节都不动。
// patch 只认 status（draft/revising/done）和 note（≤200 字；空字符串 = 删除备注）；
// 返回 changed=false 时不写盘（避免无意义的 .bak 轮换）。
async function updateChapterMeta(bookPath, chapterId, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new StorageError('BAD_PATCH', '章节信息必须是一个对象');
  }
  const meta = await readBookMeta(bookPath);
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  if (Object.prototype.hasOwnProperty.call(patch, 'status') && !chaptersLib.isChapterStatus(patch.status)) {
    throw new StorageError('BAD_STATUS', '章节状态只能是 draft / revising / done');
  }
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) changes.status = patch.status;
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) changes.note = patch.note;
  if (!Object.keys(changes).length) {
    return { meta, chapter: meta.chapters[index], index, changed: false };
  }
  const current = meta.chapters[index];
  const nextChapter = chaptersLib.applyChapterMeta(current, changes);
  const changed = current.status !== nextChapter.status || (current.note || '') !== (nextChapter.note || '');
  if (!changed) {
    return { meta, chapter: current, index, changed: false };
  }
  const chapters = meta.chapters.map((c) => (c.id === chapterId ? nextChapter : c));
  const saved = await writeBookMeta(bookPath, { ...meta, chapters });
  return { meta: saved, chapter: saved.chapters[index], index, changed: true };
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

// ---------- 整本智能排版（「一键整理本书」） ----------
const FORMAT_STATS_KEYS = [
  'paragraphs',
  'indentFixed',
  'trailingTrimmed',
  'blankCollapsed',
  'punctFixed',
  'cjkSpacesRemoved',
  'quotesFixed',
  'ellipsisFixed'
];

function emptyFormatStats() {
  const stats = {};
  for (const key of FORMAT_STATS_KEYS) stats[key] = 0;
  return stats;
}

function addFormatStats(target, stats) {
  for (const key of FORMAT_STATS_KEYS) target[key] += Number(stats && stats[key]) || 0;
  return target;
}

// 预检查：只读不写。返回会改动的章节数、前几章名字和合计统计，供确认框显示。
async function previewFormatBook(bookPath, options = {}) {
  const meta = await readBookMeta(bookPath);
  const stats = emptyFormatStats();
  const changed = [];
  for (let i = 0; i < meta.chapters.length; i += 1) {
    const chapter = meta.chapters[i];
    const loaded = await loadTextOrSkip(bookPath, chapter);
    if (!loaded) continue;
    const res = formatLib.formatText(loaded.text, options);
    if (!res.changed) continue;
    addFormatStats(stats, res.stats);
    changed.push({ index: i, file: chapter.file, name: chapter.name || '' });
  }
  return {
    bookTitle: meta.title,
    chapterCount: meta.chapters.length,
    chaptersChanged: changed.length,
    changed: changed.slice(0, 12),
    changedTruncated: changed.length > 12,
    stats
  };
}

// 整本智能排版：逐章格式化后写盘；写盘前把要改动的原章节备份到书内 _trash/整理备份-时间戳/。
// 作者显式点「一键整理本书…」才会执行，规则沿用「整理本章」记住的那套。
async function formatBook(bookPath, options = {}, onProgress) {
  const meta = await readBookMeta(bookPath);
  const total = meta.chapters.length;
  const stats = emptyFormatStats();
  const changed = [];
  let backupDir = null;
  let backupCreated = false;
  for (let i = 0; i < meta.chapters.length; i += 1) {
    const chapter = meta.chapters[i];
    if (typeof onProgress === 'function') {
      try {
        onProgress({ done: i + 1, total, index: i, name: chapter.name || '' });
      } catch { /* 进度回调出错不影响整理 */ }
    }
    const loaded = await loadTextOrSkip(bookPath, chapter);
    if (!loaded) continue;
    const res = formatLib.formatText(loaded.text, options);
    if (!res.changed) continue;
    if (!backupCreated) {
      backupDir = await uniqueTrashDir(path.join(bookPath, TRASH_DIR), FORMAT_BACKUP_PREFIX);
      await ensureDir(backupDir);
      backupCreated = true;
    }
    // 先备份原文再写盘：整理也是「改正文」的显式动作，必须留退路
    await fs.copyFile(assertInside(bookPath, chapter.file), path.join(backupDir, chapter.file));
    await saveChapterText(bookPath, chapter.file, res.text);
    chapter.chars = chaptersLib.countChars(res.text);
    addFormatStats(stats, res.stats);
    changed.push({ index: i, file: chapter.file, name: chapter.name || '' });
  }
  if (changed.length) await writeBookMeta(bookPath, meta);
  return {
    bookTitle: meta.title,
    chapterCount: total,
    chaptersChanged: changed.length,
    backupDir,
    changed: changed.slice(0, 12),
    stats
  };
}

// 在 _trash 下生成一个不重名的备份目录（同名就加 -2、-3…）
async function uniqueTrashDir(trashDir, prefix) {
  const stamp = timestampForFile();
  let name = `${prefix}${stamp}`;
  let i = 2;
  while (await exists(path.join(trashDir, name))) {
    name = `${prefix}${stamp}-${i}`;
    i += 1;
  }
  return path.join(trashDir, name);
}

// 列出书内 _trash 下的「整本替换」备份（最近的在最前），供「还原到替换前」使用。
async function listReplaceBackups(bookPath) {
  const trashDir = path.join(bookPath, TRASH_DIR);
  let entries;
  try {
    entries = await fs.readdir(trashDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(REPLACE_BACKUP_PREFIX)) continue;
    const dir = path.join(trashDir, entry.name);
    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录刚好被删/被占用，跳过
    }
    const names = [];
    let totalBytes = 0;
    let mtimeMs = 0;
    for (const file of files) {
      if (!file.isFile() || !/\.txt$/i.test(file.name)) continue;
      try {
        const stat = await fs.stat(path.join(dir, file.name));
        totalBytes += stat.size;
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
        names.push(file.name);
      } catch { /* 单个文件读不到就跳过 */ }
    }
    if (!names.length) continue;
    backups.push({
      name: entry.name,
      fileCount: names.length,
      totalBytes,
      mtimeMs: Math.round(mtimeMs),
      files: names
    });
  }
  // 目录名里带时间戳，倒序 = 最近一次替换在最前
  backups.sort((a, b) => b.name.localeCompare(a.name, 'zh-Hans-CN'));
  return backups;
}

// 还原一次「整本替换」：把备份目录里的章节文件覆盖回书内。
// 安全措施：只还原书目里当前存在的章节文件（已删章节不偷偷复活）；
// 还原前先把书里「现在的内容」备份到 _trash/还原前备份-时间戳/，还原本身点错了也还有退路。
async function restoreReplaceBackup(bookPath, backupName) {
  const meta = await readBookMeta(bookPath);
  const rawName = String(backupName == null ? '' : backupName).trim();
  const name = path.basename(rawName);
  if (!name || name !== rawName || !name.startsWith(REPLACE_BACKUP_PREFIX)) {
    throw new StorageError('BAD_BACKUP', '替换备份目录名不合法');
  }
  const trashDir = path.join(bookPath, TRASH_DIR);
  const backupDir = path.join(trashDir, name);
  if (!(await exists(backupDir))) {
    throw new StorageError('BACKUP_MISSING', '这个替换备份已经不存在了');
  }

  let entries;
  try {
    entries = await fs.readdir(backupDir, { withFileTypes: true });
  } catch (err) {
    throw new StorageError('BACKUP_UNREADABLE', `替换备份读不出来：${err.message}`);
  }
  const currentFiles = new Set(meta.chapters.map((chapter) => chapter.file));
  const fileEntries = entries.filter((entry) => entry.isFile());
  if (!fileEntries.length) throw new StorageError('BACKUP_EMPTY', '这个替换备份里没有文件');
  const restorable = fileEntries.filter((entry) => currentFiles.has(entry.name));
  if (!restorable.length) {
    throw new StorageError('BACKUP_NO_TARGET', '备份里的章节都不在书里了，没有可还原的内容');
  }

  const restoreDir = await uniqueTrashDir(trashDir, RESTORE_BACKUP_PREFIX);
  let restored = 0;
  let skipped = 0;
  for (const entry of fileEntries) {
    if (!currentFiles.has(entry.name)) {
      skipped += 1; // 章节可能已经删掉了，别偷偷复活
      continue;
    }
    const target = assertInside(bookPath, entry.name);
    if (await exists(target)) {
      await ensureDir(restoreDir);
      await fs.copyFile(target, path.join(restoreDir, entry.name));
    }
    const buffer = await fs.readFile(path.join(backupDir, entry.name));
    await atomicWriteFile(target, buffer);
    restored += 1;
  }

  // 正文被覆盖了，字数缓存要重算；书目改动走 writeBookMeta（写前留 .bak）
  if (restored) {
    for (const chapter of meta.chapters) {
      try {
        const text = await fs.readFile(assertInside(bookPath, chapter.file), 'utf8');
        chapter.chars = chaptersLib.countChars(stripBom(text));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    await writeBookMeta(bookPath, meta);
  }

  return {
    restored,
    skipped,
    total: fileEntries.length,
    restoreBackupDir: restored ? restoreDir : null
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

// 记住「上次打开的是哪一章」（书目里的唯一事实来源）。
// 返回 { ok, title, chapterId, chapterIndex, chapterName, changed } 给主进程同步书架级
// 「继续上次写作」；不存在的 chapterId 不写盘（防止书目被写成永远指不到章节的 id）。
async function setLastOpenChapter(bookPath, chapterId) {
  try {
    const meta = await readBookMeta(bookPath);
    const list = Array.isArray(meta.chapters) ? meta.chapters : [];
    const index = list.findIndex((chapter) => chapter && chapter.id === chapterId);
    if (index < 0) return { ok: false, code: 'CHAPTER_NOT_FOUND', chapterCount: list.length };
    const changed = meta.lastOpenChapterId !== chapterId;
    if (changed) await writeBookMeta(bookPath, { ...meta, lastOpenChapterId: chapterId });
    const chapter = list[index];
    return {
      ok: true,
      changed,
      title: String(meta.title == null ? '' : meta.title),
      chapterId: chapter.id,
      chapterIndex: index,
      chapterName: String(chapter.name == null ? '' : chapter.name)
    };
  } catch {
    return { ok: false };
  }
}

// ---------- 同一本书的「读-改-写」串行化 ----------
// 背景：渲染层会发 fire-and-forget 的 setLastOpenChapter，如果它和改名/插入等操作并发，
// 各自「读 meta → 改 → 写回」就会互相覆盖。主进程内用 promise 链把同一本书的写操作排队。
const bookLocks = new Map();

function withBookLock(bookPath, task) {
  // Windows 路径不分大小写，key 统一小写，免得 C:\Books\A 与 c:\books\a 变成两把锁
  const key = path.resolve(String(bookPath)).toLowerCase();
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
  mergeCharsCache,
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
  createVolume: locked(createVolume),
  renameVolume: locked(renameVolume),
  deleteVolume: locked(deleteVolume),
  moveChapterToVolume: locked(moveChapterToVolume),
  moveChapterTo: locked(moveChapterTo),
  moveVolume: locked(moveVolume),
  renameChapter: locked(renameChapter),
  updateChapterMeta: locked(updateChapterMeta),
  deleteChapter: locked(deleteChapter),
  moveChapter: locked(moveChapter),
  searchBook,
  replaceInBook: locked(replaceInBook),
  previewFormatBook,
  formatBook: locked(formatBook),
  listReplaceBackups,
  restoreReplaceBackup: locked(restoreReplaceBackup),
  renameBook: locked(renameBook),
  trashBook,
  setLastOpenChapter: locked(setLastOpenChapter),
  moveToTrash,
  timestampForFile,
  withBookLock
};
