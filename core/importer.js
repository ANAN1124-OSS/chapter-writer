// 导入小说：把一个外部文件夹变成书架里的一本书。
// 支持两种来源：
//   1) 现成的章节写作器书（含合法 书目.json）→ 整本复制进来
//   2) 一堆 txt（旧稿/别的软件导出的章节）→ 复制 txt 后按文件名重建 书目.json
// 只复制、不移动源文件；文件夹重名自动加 -2/-3。
const fs = require('node:fs/promises');
const path = require('node:path');
const chaptersLib = require('./chapters');
const storage = require('./storage');
const repair = require('./repair');

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function uniqueFolderName(booksRoot, desired) {
  const base = chaptersLib.safeName(desired) || '导入的书';
  let candidate = base;
  let i = 2;
  for (;;) {
    if (!(await storage.exists(path.join(booksRoot, candidate)))) return candidate;
    candidate = `${base}-${i}`;
    i += 1;
  }
}

async function analyzeSource(sourceDir) {
  let txtFiles = [];
  try {
    txtFiles = await storage.listTxtFiles(sourceDir);
  } catch {
    txtFiles = [];
  }
  try {
    const meta = await storage.readBookMeta(sourceDir);
    return { kind: 'book', meta, txtFiles };
  } catch (err) {
    if (txtFiles.length) {
      return { kind: 'txts', txtFiles, reason: err.message };
    }
    return { kind: 'nothing', reason: err.message };
  }
}

async function copyAsBook(sourceDir, target) {
  await fs.cp(sourceDir, target, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== storage.TRASH_DIR && !base.startsWith('.');
    }
  });
}

async function copyAsTexts(sourceDir, target, txtFiles) {
  await fs.mkdir(target, { recursive: true });
  for (const file of txtFiles) {
    await fs.copyFile(path.join(sourceDir, file), path.join(target, file));
  }
}

// 导入单个文件夹，返回 { imported:true, ... } 或 { skipped:true, reason }
async function importOne(booksRoot, sourceDirRaw) {
  const sourceDir = path.resolve(String(sourceDirRaw || ''));
  const root = path.resolve(booksRoot);

  if (!(await isDirectory(sourceDir))) {
    return { skipped: true, source: sourceDirRaw, reason: '不是文件夹' };
  }
  if (isInside(root, sourceDir)) {
    return { skipped: true, source: sourceDirRaw, reason: '已经在书架目录里了' };
  }
  if (isInside(sourceDir, root)) {
    return { skipped: true, source: sourceDirRaw, reason: '不能导入包含书架目录的上级文件夹' };
  }

  const analysis = await analyzeSource(sourceDir);
  if (analysis.kind === 'nothing') {
    return {
      skipped: true,
      source: sourceDirRaw,
      reason: '既没有可用的 书目.json，也没有 txt 文件'
    };
  }

  const desiredFolder =
    analysis.kind === 'book'
      ? analysis.meta.title || path.basename(sourceDir)
      : path.basename(sourceDir);
  const folder = await uniqueFolderName(root, desiredFolder);
  const target = path.join(root, folder);

  try {
    if (analysis.kind === 'book') {
      await copyAsBook(sourceDir, target);
      const meta = await storage.readBookMeta(target);
      return {
        imported: true,
        kind: 'book',
        folder,
        path: target,
        title: meta.title,
        chapters: meta.chapters.length
      };
    }
    await copyAsTexts(sourceDir, target, analysis.txtFiles);
    const rebuilt = await repair.rebuildFromFiles(target);
    return {
      imported: true,
      kind: 'txts',
      folder,
      path: target,
      title: rebuilt.meta.title,
      chapters: rebuilt.meta.chapters.length
    };
  } catch (err) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw new storage.StorageError('IMPORT_FAILED', `复制失败：${err.message}`);
  }
}

async function importFolders(booksRoot, sources) {
  const imported = [];
  const skipped = [];
  const failed = [];
  for (const source of sources || []) {
    try {
      const result = await importOne(booksRoot, source);
      if (result.skipped) skipped.push(result);
      else imported.push(result);
    } catch (err) {
      failed.push({ source, message: err.message });
    }
  }
  return { imported, skipped, failed };
}

module.exports = { importFolders, importOne, analyzeSource, isInside };
