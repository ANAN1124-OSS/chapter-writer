// 损坏恢复：从 .bak 恢复；或按目录里的 txt 文件重建书目。
const fs = require('node:fs/promises');
const path = require('node:path');
const { stripBom } = require('./atomic');
const chaptersLib = require('./chapters');
const schemaLib = require('./schema');
const conflictLib = require('./conflict');
const storage = require('./storage');

function stampForBackup(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function archiveCorruptMeta(bookPath) {
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  try {
    await fs.access(metaPath);
  } catch {
    return null;
  }
  const archived = path.join(bookPath, `${storage.CORRUPT_PREFIX}${stampForBackup()}`);
  await fs.rename(metaPath, archived);
  return archived;
}

// 从目录里的 txt 重建：文件名形如 001-起风.txt，按序号排序。
// 同步盘的冲突副本（*conflicted* / *-冲突副本*）不是真正的章节，不参与重建、原样留在文件夹里。
async function rebuildFromFiles(bookPath) {
  const allFiles = await storage.listTxtFiles(bookPath);
  const files = allFiles.filter((file) => !conflictLib.isConflictCopyName(file));
  const conflictCopies = conflictLib.findConflictCopies(allFiles);
  if (!files.length) {
    throw new storage.StorageError(
      'NO_FILES',
      allFiles.length
        ? '这个文件夹里只有同步冲突副本，没有可用的章节 txt，无法重建'
        : '这个文件夹里没有找到章节 txt，无法重建'
    );
  }
  const parsed = files.map((file, index) => {
    const match = /^(\d+)-(.+)\.txt$/i.exec(file);
    const seq = match ? Number(match[1]) : index + 1;
    let name = match ? match[2] : file.replace(/\.txt$/i, '');
    if (name === '未命名') name = '';
    return { file, seq, name };
  });
  parsed.sort((a, b) => a.seq - b.seq || a.file.localeCompare(b.file, 'zh-Hans-CN'));

  const archived = await archiveCorruptMeta(bookPath);
  const now = new Date().toISOString();
  const meta = {
    version: 1,
    schemaVersion: schemaLib.CURRENT_SCHEMA_VERSION,
    id: `b_${Date.now().toString(36)}`,
    title: path.basename(bookPath),
    titleTemplate: chaptersLib.TITLE_TEMPLATE,
    fileSeq: parsed.reduce((max, p) => Math.max(max, p.seq), 0),
    chapters: parsed.map((p, i) => ({
      id: `ch_${chaptersLib.pad3(i + 1)}`,
      file: p.file,
      name: p.name,
      createdAt: now
    })),
    lastOpenChapterId: `ch_${chaptersLib.pad3(1)}`,
    createdAt: now
  };
  const saved = await storage.writeBookMeta(bookPath, meta);
  return {
    meta: saved,
    archived,
    count: saved.chapters.length,
    // 只用来说明「跳过了几个同步冲突副本」；这些文件原样保留，不删也不合并
    skippedConflicts: conflictCopies.length,
    conflictCopies
  };
}

// 从 书目.json.bak 恢复（.bak 是上一次成功写入前的版本）
async function restoreFromBak(bookPath) {
  const bakPath = path.join(bookPath, storage.BOOK_BAK);
  let raw;
  try {
    raw = await fs.readFile(bakPath, 'utf8');
  } catch {
    throw new storage.StorageError('NO_BAK', '没有找到 书目.json.bak，无法从备份恢复');
  }
  let meta;
  try {
    meta = JSON.parse(stripBom(raw));
  } catch {
    throw new storage.StorageError('BAK_INVALID', '备份的 书目.json.bak 也无法解析，只能从目录重建');
  }
  // 校验结构，不合法就直接抛错
  if (!meta || !Array.isArray(meta.chapters)) {
    throw new storage.StorageError('BAK_INVALID', '备份的 书目.json.bak 结构不完整，只能从目录重建');
  }
  const archived = await archiveCorruptMeta(bookPath);
  const saved = await storage.writeBookMeta(bookPath, {
    ...schemaLib.migrateMeta(meta),
    title: typeof meta.title === 'string' && meta.title ? meta.title : path.basename(bookPath)
  });
  // writeBookMeta 会再次把（已经不存在的）主文件备份逻辑跳过，.bak 保持原样
  return { meta: saved, archived };
}

module.exports = {
  rebuildFromFiles: (bookPath) => storage.withBookLock(bookPath, () => rebuildFromFiles(bookPath)),
  restoreFromBak: (bookPath) => storage.withBookLock(bookPath, () => restoreFromBak(bookPath)),
  archiveCorruptMeta
};
