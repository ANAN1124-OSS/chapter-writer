// 「打开中的书」登记（多窗口唯一事实来源）与跨窗口操作判定。
//
// 设计约定：
// - 一个窗口同一时间只开一本书；一个书路径同一时间只允许一个窗口打开。
// - 路径比较统一 path.resolve + 小写（Windows 不区分大小写，同一个目录可能被写成不同形式）。
// - 这里只做纯内存逻辑，不碰磁盘、不 require electron，单测直接覆盖。
// - 主进程通过 storage 里的同一个 registry 实例登记 / 释放，写盘前再由这里判定。
const path = require('node:path');

const CODE = {
  BOOK_OPEN_IN_OTHER_WINDOW: 'BOOK_OPEN_IN_OTHER_WINDOW',
  CROSS_WINDOW_BUSY: 'CROSS_WINDOW_BUSY',
  BOOK_MISSING: 'BOOK_MISSING',
  CHAPTER_MISSING: 'CHAPTER_MISSING',
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND'
};

const KIND_LABEL = {
  save: '保存',
  delete: '删除',
  rename: '改名',
  format: '整理',
  replace: '替换',
  write: '修改'
};

function normalizeBookPath(bookPath) {
  const raw = String(bookPath == null ? '' : bookPath).trim();
  if (!raw) return '';
  try {
    return path.resolve(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function bookLabel(bookPath) {
  const raw = String(bookPath == null ? '' : bookPath).trim();
  if (!raw) return '这本书';
  try {
    const base = path.basename(raw);
    return base || raw;
  } catch {
    return raw;
  }
}

function crossWindowMessage(bookPath, action = 'write') {
  const label = bookLabel(bookPath);
  const verb = KIND_LABEL[action] || KIND_LABEL.write;
  return `「${label}」正在另一个窗口打开，已阻止这次${verb}。请先关掉另一个窗口，或先切换到那个窗口后再操作。`;
}

function openInOtherWindowMessage(bookPath) {
  return `「${bookLabel(bookPath)}」已经在另一个窗口打开，已切换到那个窗口。`;
}

// windowId → bookPath 的唯一登记表。窗口本身也登记（没有开书也要能选「最近使用的窗口」）。
class OpenBookRegistry {
  constructor() {
    this.byWindow = new Map(); // windowId(string) -> normalized bookPath
    this.byBook = new Map(); // normalized bookPath -> windowId(string)
    this.windows = new Map(); // windowId(string) -> { lastActiveAt, seq }
    this.seq = 0;
  }

  static id(windowId) {
    return String(windowId);
  }

  registerWindow(windowId, { now = Date.now() } = {}) {
    const id = OpenBookRegistry.id(windowId);
    if (!id || id === 'null' || id === 'undefined') return null;
    if (!this.windows.has(id)) this.windows.set(id, { lastActiveAt: 0, seq: 0 });
    this.touch(windowId, { now });
    return id;
  }

  unregisterWindow(windowId) {
    const id = OpenBookRegistry.id(windowId);
    const book = this.byWindow.get(id);
    const hadWindow = this.windows.has(id);
    if (book) this.byBook.delete(book);
    this.byWindow.delete(id);
    this.windows.delete(id);
    return Boolean(book || hadWindow);
  }

  // 窗口开 / 换书。返回 { ok, code, ownerWindowId, bookPath }；重复打开由调用方决定是否聚焦。
  setBook(windowId, bookPath, { now = Date.now() } = {}) {
    const id = OpenBookRegistry.id(windowId);
    const key = normalizeBookPath(bookPath);
    if (!id || !key) return { ok: false, code: 'BAD_PATH', bookPath: key };
    const owner = this.byBook.get(key);
    if (owner && owner !== id) {
      return {
        ok: false,
        code: CODE.BOOK_OPEN_IN_OTHER_WINDOW,
        ownerWindowId: owner,
        bookPath: key,
        message: openInOtherWindowMessage(bookPath)
      };
    }
    const previous = this.byWindow.get(id);
    if (previous) this.byBook.delete(previous);
    this.byWindow.set(id, key);
    this.byBook.set(key, id);
    if (!this.windows.has(id)) this.windows.set(id, { lastActiveAt: 0, seq: 0 });
    this.touch(windowId, { now });
    return { ok: true, windowId: id, bookPath: key };
  }

  clearBook(windowId) {
    const id = OpenBookRegistry.id(windowId);
    const book = this.byWindow.get(id);
    if (!book) return false;
    this.byWindow.delete(id);
    this.byBook.delete(book);
    return true;
  }

  // 书被删除 / 被移走时，把所有窗口对它的登记清掉（正常只有一个）
  clearPath(bookPath) {
    const key = normalizeBookPath(bookPath);
    const owner = this.byBook.get(key);
    if (!owner) return false;
    this.byBook.delete(key);
    if (this.byWindow.get(owner) === key) this.byWindow.delete(owner);
    return true;
  }

  getBook(windowId) {
    return this.byWindow.get(OpenBookRegistry.id(windowId)) || null;
  }

  findWindow(bookPath) {
    return this.byBook.get(normalizeBookPath(bookPath)) || null;
  }

  isOpenElsewhere(bookPath, windowId) {
    const owner = this.findWindow(bookPath);
    const id = OpenBookRegistry.id(windowId);
    return { open: Boolean(owner && owner !== id), ownerWindowId: owner || null };
  }

  touch(windowId, { now = Date.now() } = {}) {
    const id = OpenBookRegistry.id(windowId);
    if (!id) return;
    this.seq += 1;
    this.windows.set(id, { lastActiveAt: now, seq: this.seq });
  }

  // 「最近使用的窗口」：先比最近一次激活时间，同一毫秒内再比登记顺序（后动者为最近）
  mostRecentWindow() {
    let best = null;
    for (const [id, info] of this.windows) {
      if (!best || info.lastActiveAt > best.lastActiveAt ||
          (info.lastActiveAt === best.lastActiveAt && info.seq > best.seq)) {
        best = { windowId: id, lastActiveAt: info.lastActiveAt, seq: info.seq };
      }
    }
    return best ? best.windowId : null;
  }

  list() {
    return Array.from(this.byWindow, ([windowId, bookPath]) => ({ windowId, bookPath }));
  }

  counts() {
    return { windows: this.windows.size, openBooks: this.byBook.size };
  }

  reset() {
    this.byWindow.clear();
    this.byBook.clear();
    this.windows.clear();
    this.seq = 0;
  }
}

function createRegistry() {
  return new OpenBookRegistry();
}

// 同一本书不允许两个窗口：已经开在别的窗口就拒绝并告诉调用方去聚焦哪个窗口。
function checkOpenBook({ registry, windowId, bookPath }) {
  const result = registry.setBook(windowId, bookPath);
  if (!result.ok && result.code === CODE.BOOK_OPEN_IN_OTHER_WINDOW) {
    return {
      ...result,
      message: openInOtherWindowMessage(bookPath)
    };
  }
  return result;
}

// 跨窗口删改拦截：别窗口正开着的书一律不许写（删除 / 改名 / 整理 / 替换 / 保存…）。
// 自己窗口开着这本书时允许（正常写作）；没有登记也允许（比如自动化直接调 API）。
function checkMutation({ registry, windowId, bookPath, action = 'write' }) {
  const owner = registry.findWindow(bookPath);
  const self = windowId == null || windowId === '' ? null : OpenBookRegistry.id(windowId);
  if (owner && owner !== self) {
    return {
      ok: false,
      code: CODE.CROSS_WINDOW_BUSY,
      ownerWindowId: owner,
      message: crossWindowMessage(bookPath, action)
    };
  }
  return { ok: true, ownerWindowId: owner || null };
}

// 保存前校验（纯函数，探针结果由 storage 提供）：
// 书文件夹在、书目能读、章节还在书目里、章节文件也在 → 才允许写盘。
// 任何一项失效都返回明确错误；调用方由此阻止 atomicWriteFile 的 mkdir 重建影子文件。
function verifySaveTarget({ bookPath, bookExists, meta, metaCode, chapterId, file, chapterExists }) {
  if (!bookExists) {
    return {
      ok: false,
      code: CODE.BOOK_MISSING,
      message: `「${bookLabel(bookPath)}」的书文件夹已经不在了（可能已在另一个窗口或应用外删除）。为避免重新生成影子文件，已阻止这次保存。`
    };
  }
  if (!meta) {
    const code = metaCode === 'PARSE_ERROR' ? 'PARSE_ERROR' : CODE.BOOK_MISSING;
    return {
      ok: false,
      code,
      message:
        code === 'PARSE_ERROR'
          ? '书目.json 解析失败，已阻止保存。请先用「修复这本书」处理书目。'
          : `「${bookLabel(bookPath)}」的书目已经不在了（可能已在另一个窗口或应用外删除）。为避免重新生成影子文件，已阻止这次保存。`
    };
  }
  const chapters = Array.isArray(meta.chapters) ? meta.chapters : [];
  const index = chapters.findIndex((chapter) => chapter && chapter.id === chapterId);
  if (index < 0) {
    return {
      ok: false,
      code: CODE.CHAPTER_NOT_FOUND,
      message: '这一章已经不在书目里了（可能已在另一个窗口删除）。为避免重新生成影子文件，已阻止这次保存。'
    };
  }
  const chapter = chapters[index];
  if (file && chapter.file !== file) {
    return {
      ok: false,
      code: CODE.CHAPTER_NOT_FOUND,
      message: '这一章的记录已经变了（可能已在另一个窗口改名或重建）。为避免写错文件，已阻止这次保存。'
    };
  }
  if (!chapterExists) {
    return {
      ok: false,
      code: CODE.CHAPTER_MISSING,
      message: '这一章的正文文件已经不在了（可能已在另一个窗口或应用外删除）。为避免重新生成影子文件，已阻止这次保存。'
    };
  }
  return { ok: true, chapter, index };
}

module.exports = {
  CODE,
  OpenBookRegistry,
  createRegistry,
  normalizeBookPath,
  bookLabel,
  crossWindowMessage,
  openInOtherWindowMessage,
  checkOpenBook,
  checkMutation,
  verifySaveTarget
};
