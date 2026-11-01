// 「本书历史」：统一扫描书内 _trash 的各种备份 + 书文件夹根部的 书目.json.bak。
// 只读扫描 / 预览；真正的还原在 core/storage.js（要拿书界面的章节列表、原子写盘、字数缓存），
// 这里只提供路径校验、归类和读取，方便单测，也不让渲染层直接碰文件系统。
const fs = require('node:fs/promises');
const path = require('node:path');
const { stripBom } = require('./atomic');
const { pad2 } = require('./common');

const TRASH_DIR = '_trash';
const BOOK_BAK = '书目.json.bak';
// 预览上限：足够看一整章，也不至于把一本巨大的书一次性塞进渲染层
const PREVIEW_MAX_BYTES = 512 * 1024;

const SOURCE_META = {
  replace: {
    label: '整本替换',
    prefix: '替换备份-',
    restorable: true,
    note: '整本替换前自动备份的原文。可以预览、还原单章或整组；只还原现在仍在书里的章节，已删除的章节不会偷偷复活。'
  },
  format: {
    label: '整本整理',
    prefix: '整理备份-',
    restorable: true,
    note: '整本整理前自动备份的原文。可以预览、还原单章或整组；只还原现在仍在书里的章节。'
  },
  restore: {
    label: '还原前备份',
    prefix: '还原前备份-',
    restorable: true,
    note: '每次还原前自动留下的反向备份，方便把还原这一步也退回去。可以预览、还原单章或整组。'
  },
  snapshot: {
    label: '每日快照',
    prefix: '快照-',
    restorable: true,
    note: '每日快照留下的章节副本。可以预览、还原单章或整组。'
  },
  delete: {
    label: '删除章节',
    restorable: true,
    note: '删除章节时移到 _trash 的原文。还原会把 txt 放回书文件夹，但不会自动加回章节列表（需要的话可用「从目录重建」找回）；书里已有同名文件时不会覆盖。'
  },
  bookmeta: {
    label: '书目备份',
    restorable: false,
    note: '上一版 书目.json。只供查看，避免用旧书目覆盖现在的章节列表；损坏时请走书卡的「修复」。'
  },
  other: {
    label: '其他备份',
    restorable: false,
    note: '没有识别出用途的备份文件，只供查看；写作器不会自动处理、移动或删除它们。'
  }
};

const KNOWN_DIR_SOURCES = ['replace', 'format', 'restore', 'snapshot'];
const RESTORABLE_SOURCES = new Set(['replace', 'format', 'restore', 'snapshot']);
const TEXT_EXTS = new Set(['.txt', '.json', '.bak', '.md']);

class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

// 目录名里的时间戳是 moveToTrash/uniqueTrashDir 生成的本地时间：YYYY-MM-DD-HHMMSS[-序号]。
// 认不出或日期非法返回 0，调用方会退回文件的 mtime。
function parseStampTime(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{6})(?:-\d+)?$/.exec(String(stamp == null ? '' : stamp).trim());
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4].slice(0, 2));
  const minute = Number(match[4].slice(2, 4));
  const second = Number(match[4].slice(4, 6));
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return 0;
  }
  return date.getTime();
}

function formatHistoryTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const date = new Date(n);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function sourceLabel(source) {
  return (SOURCE_META[source] || SOURCE_META.other).label;
}

function sourceNote(source) {
  return (SOURCE_META[source] || SOURCE_META.other).note;
}

function isValidBaseName(name) {
  return Boolean(name) && path.basename(name) === name && name !== '.' && name !== '..';
}

// 解析删除章节时留下的散文件：{时间戳}-{原文件名}.txt
// 同一次删除撞名会生成 {时间戳}-{序号}-{原文件名}.txt（序号从 2 开始、不补零），
// 而原文件名本身是 3 位序号开头（001-xxx.txt），所以要避免把「001」误当撞名序号。
function parseDeletedName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return null;
  const match = /^(\d{4}-\d{2}-\d{2}-\d{6})-(.+)$/.exec(name);
  if (!match) return null;
  let rest = match[2];
  const ordinal = /^([1-9]\d*)-(.+)$/.exec(rest);
  if (ordinal && /^\d{3}-.*\.txt$/i.test(ordinal[2])) rest = ordinal[2];
  if (!/\.txt$/i.test(rest)) return null;
  return { stamp: match[1], originalName: rest };
}

function classifyDirName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidBaseName(name) || name.startsWith('.')) return null;
  for (const source of KNOWN_DIR_SOURCES) {
    const prefix = SOURCE_META[source].prefix;
    if (!name.startsWith(prefix)) continue;
    const stamp = name.slice(prefix.length);
    return { name, kind: 'dir', source, stamp, time: parseStampTime(stamp) };
  }
  return { name, kind: 'dir', source: 'other', stamp: '', time: 0 };
}

function classifyLooseName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidBaseName(name) || name.startsWith('.')) return null;
  if (name === BOOK_BAK) {
    return { name, kind: 'file', source: 'bookmeta', stamp: '', time: 0, originalName: BOOK_BAK };
  }
  const deleted = parseDeletedName(name);
  if (deleted) {
    return {
      name,
      kind: 'file',
      source: 'delete',
      stamp: deleted.stamp,
      time: parseStampTime(deleted.stamp),
      originalName: deleted.originalName
    };
  }
  return { name, kind: 'file', source: 'other', stamp: '', time: 0, originalName: name };
}

function isPreviewableName(name) {
  const text = String(name == null ? '' : name);
  if (text === BOOK_BAK) return true;
  return TEXT_EXTS.has(path.extname(text).toLowerCase());
}

function makeFileEntry({ name, trashName, size, mtimeMs, inBook, restorable, reason, source }) {
  return {
    name,
    trashName,
    size: Math.max(0, Number(size) || 0),
    mtimeMs: Math.round(Number(mtimeMs) || 0),
    inBook: Boolean(inBook),
    restorable: Boolean(restorable),
    previewable: isPreviewableName(trashName || name) && (Number(size) || 0) <= PREVIEW_MAX_BYTES,
    reason: reason || '',
    source
  };
}

function compareGroups(a, b) {
  if (b.time !== a.time) return b.time - a.time;
  return String(b.id).localeCompare(String(a.id), 'zh-Hans-CN');
}

// 扫描一本书的备份。chapterFiles 是当前书目的章节文件名（用于判断「还在不在书里」）。
// 只读，不改任何文件；_trash 不存在时返回空列表（旧书/新书都可能没有）。
async function listHistory(bookPath, options = {}) {
  const root = String(bookPath == null ? '' : bookPath);
  if (!root) throw new HistoryError('BAD_BOOK', '缺少书的路径');
  const chapterFiles = new Set(
    (Array.isArray(options.chapterFiles) ? options.chapterFiles : []).filter(
      (name) => typeof name === 'string' && name
    )
  );
  const groups = [];

  // 1) 书文件夹根部的 书目.json.bak（不是 _trash 里，但也是可回看的「历史」）
  const bakPath = path.join(root, BOOK_BAK);
  try {
    const stat = await fs.stat(bakPath);
    if (stat.isFile()) {
      groups.push({
        id: 'bak',
        kind: 'file',
        source: 'bookmeta',
        sourceLabel: sourceLabel('bookmeta'),
        note: sourceNote('bookmeta'),
        stamp: '',
        time: Math.round(stat.mtimeMs),
        timeText: formatHistoryTime(stat.mtimeMs),
        fileName: BOOK_BAK,
        dirName: '',
        fileCount: 1,
        totalBytes: stat.size,
        restorableCount: 0,
        files: [
          makeFileEntry({
            name: BOOK_BAK,
            trashName: BOOK_BAK,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            inBook: false,
            restorable: false,
            reason: '书目备份只供查看，不能自动覆盖现在的书目',
            source: 'bookmeta'
          })
        ]
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // 2) 书内 _trash：备份目录 + 散文件
  const trashPath = path.join(root, TRASH_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(trashPath, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const entry of entries) {
    if (!entry || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const info = classifyDirName(entry.name);
      if (!info) continue;
      const dirPath = path.join(trashPath, entry.name);
      let children;
      try {
        children = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue; // 目录刚好被移走/占用，跳过
      }
      const files = [];
      let mtimeMax = 0;
      for (const child of children) {
        if (!child.isFile() || child.name.startsWith('.')) continue;
        let stat;
        try {
          stat = await fs.stat(path.join(dirPath, child.name));
        } catch {
          continue;
        }
        mtimeMax = Math.max(mtimeMax, stat.mtimeMs);
        const inBook = chapterFiles.has(child.name);
        const isChapterFile = /\.txt$/i.test(child.name);
        const canRestore = isChapterFile && inBook && RESTORABLE_SOURCES.has(info.source);
        files.push(
          makeFileEntry({
            name: child.name,
            trashName: child.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            inBook,
            restorable: canRestore,
            reason: !isChapterFile
              ? '不是 .txt 章节文件，只供查看'
              : !RESTORABLE_SOURCES.has(info.source)
                ? '未识别的备份，只供查看'
                : !inBook
                  ? '这一章已经不在书里了，不会自动复活'
                  : '',
            source: info.source
          })
        );
      }
      if (!files.length) continue;
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      const stampTime = info.time || 0;
      const time = stampTime || Math.round(mtimeMax);
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      groups.push({
        id: `dir:${entry.name}`,
        kind: 'dir',
        source: info.source,
        sourceLabel: sourceLabel(info.source),
        note: sourceNote(info.source),
        stamp: info.stamp,
        time,
        timeText: formatHistoryTime(time),
        dirName: entry.name,
        fileName: '',
        fileCount: files.length,
        totalBytes,
        restorableCount: files.filter((file) => file.restorable).length,
        files
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const info = classifyLooseName(entry.name);
    if (!info) continue;
    let stat;
    try {
      stat = await fs.stat(path.join(trashPath, entry.name));
    } catch {
      continue;
    }
    const time = info.time || Math.round(stat.mtimeMs);
    let file;
    if (info.source === 'delete') {
      file = makeFileEntry({
        name: info.originalName,
        trashName: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        inBook: chapterFiles.has(info.originalName),
        restorable: true,
        reason: '',
        source: 'delete'
      });
    } else {
      file = makeFileEntry({
        name: entry.name,
        trashName: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        inBook: false,
        restorable: false,
        reason: '没有识别出用途的备份文件，只供查看',
        source: info.source
      });
    }
    groups.push({
      id: `file:${entry.name}`,
      kind: 'file',
      source: info.source,
      sourceLabel: sourceLabel(info.source),
      note: sourceNote(info.source),
      stamp: info.stamp,
      time,
      timeText: formatHistoryTime(time),
      dirName: '',
      fileName: entry.name,
      originalName: info.originalName || '',
      fileCount: 1,
      totalBytes: stat.size,
      restorableCount: file.restorable ? 1 : 0,
      files: [file]
    });
  }

  groups.sort(compareGroups);
  return {
    trashPath,
    groupCount: groups.length,
    fileCount: groups.reduce((sum, group) => sum + group.fileCount, 0),
    totalBytes: groups.reduce((sum, group) => sum + group.totalBytes, 0),
    groups
  };
}

// 严格解析渲染层传回来的备份组 id；id 只能落在本书 _trash / 书目.json.bak 范围内。
function resolveGroup(bookPath, groupId) {
  const root = String(bookPath == null ? '' : bookPath);
  if (!root) throw new HistoryError('BAD_BOOK', '缺少书的路径');
  const id = String(groupId == null ? '' : groupId).trim();
  const trashPath = path.join(root, TRASH_DIR);
  if (id === 'bak') {
    return {
      id,
      kind: 'file',
      source: 'bookmeta',
      fileName: BOOK_BAK,
      originalName: BOOK_BAK,
      filePath: path.join(root, BOOK_BAK)
    };
  }
  if (id.startsWith('dir:')) {
    const name = id.slice('dir:'.length);
    if (!isValidBaseName(name) || name.startsWith('.')) {
      throw new HistoryError('BAD_GROUP', '备份目录名不合法');
    }
    const info = classifyDirName(name);
    if (!info) throw new HistoryError('BAD_GROUP', '备份目录名不合法');
    return {
      id,
      kind: 'dir',
      source: info.source,
      dirName: name,
      dirPath: path.join(trashPath, name),
      stamp: info.stamp,
      time: info.time
    };
  }
  if (id.startsWith('file:')) {
    const name = id.slice('file:'.length);
    if (!isValidBaseName(name) || name.startsWith('.')) {
      throw new HistoryError('BAD_GROUP', '备份文件名不合法');
    }
    const info = classifyLooseName(name);
    if (!info) throw new HistoryError('BAD_GROUP', '备份文件名不合法');
    return {
      id,
      kind: 'file',
      source: info.source,
      fileName: name,
      originalName: info.originalName || name,
      filePath: path.join(trashPath, name),
      stamp: info.stamp,
      time: info.time
    };
  }
  throw new HistoryError('BAD_GROUP', '备份组 id 不合法');
}

// 把「组 + 文件名」解析成一个确定落在允许范围内的实际路径。
function resolveHistoryPath(bookPath, groupId, fileName) {
  const group = resolveGroup(bookPath, groupId);
  if (group.kind === 'file') return group.filePath;
  const name = String(fileName == null ? '' : fileName).trim();
  if (!isValidBaseName(name) || name.startsWith('.')) {
    throw new HistoryError('BAD_FILE', '备份文件名不合法');
  }
  return path.join(group.dirPath, name);
}

// 预览一个备份文件（只读）。大文件只读开头，返回值里用 truncated 标出来。
async function readHistoryFile(bookPath, groupId, fileName) {
  const group = resolveGroup(bookPath, groupId);
  const filePath = resolveHistoryPath(bookPath, groupId, fileName);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new HistoryError('HISTORY_FILE_MISSING', '这个备份文件已经不存在了');
    throw err;
  }
  if (!stat.isFile()) throw new HistoryError('HISTORY_NOT_FILE', '这个备份不是一个文件');
  const readBytes = Math.min(stat.size, PREVIEW_MAX_BYTES);
  let text = '';
  if (readBytes > 0) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      const { bytesRead } = await handle.read(buffer, 0, readBytes, 0);
      text = stripBom(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  }
  const displayName =
    group.kind === 'file' && group.source === 'delete'
      ? group.originalName
      : path.basename(filePath);
  return {
    groupId: group.id,
    source: group.source,
    sourceLabel: sourceLabel(group.source),
    fileName: displayName,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    truncated: stat.size > readBytes,
    text
  };
}

module.exports = {
  TRASH_DIR,
  BOOK_BAK,
  PREVIEW_MAX_BYTES,
  SOURCE_META,
  HistoryError,
  parseStampTime,
  formatHistoryTime,
  parseDeletedName,
  classifyDirName,
  classifyLooseName,
  isPreviewableName,
  sourceLabel,
  sourceNote,
  listHistory,
  resolveGroup,
  resolveHistoryPath,
  readHistoryFile
};
