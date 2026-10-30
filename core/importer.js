// 导入小说：把外部文件夹 / txt 文件变成书架里的一本书或多本书。
// 支持三种来源：
//   1) 现成的章节写作器书（含合法 书目.json）→ 整本复制
//   2) 一本书的章节目录（txt 文件名形如 001-xxx.txt / 第一章 xxx.txt）→ 复制后重建书目
//   3) 一堆独立小说 txt（每个 txt 是一整本小说，如 小说txt文件夹 那种收藏夹）
//      → 每个 txt 导入成一本书，并按「第X章 / 楔子 / Chapter N」自动分章
// 只复制、不移动源文件；文件夹重名自动加 -2/-3。
const fs = require('node:fs/promises');
const path = require('node:path');
const chaptersLib = require('./chapters');
const storage = require('./storage');
const repair = require('./repair');
const { decodeBuffer, normalizeText, splitChapters } = require('./txt');

const CHAPTER_FILE_RE =
  /^\s*(?:\d+\s*[-_.、\s]|第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷集篇部])/;

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

// 文件名看起来像「一本书的章节文件」（001-xxx.txt / 第一章 xxx.txt），而不是一本完整小说
function looksLikeChapterFile(fileName) {
  const base = String(fileName || '').replace(/\.txt$/i, '');
  return CHAPTER_FILE_RE.test(base);
}

async function analyzeSource(sourceDir) {
  const txtFiles = await storage.listTxtFiles(sourceDir).catch(() => []);
  try {
    const meta = await storage.readBookMeta(sourceDir);
    return { kind: 'book', meta, txtFiles };
  } catch (err) {
    if (!txtFiles.length) return { kind: 'nothing', reason: err.message };
    if (txtFiles.length === 1) {
      // 只有一个 txt：文件名像章节（001-xxx.txt）就当「一本书的章节目录」，
      // 否则当成一本完整的独立小说（例如「书名 - 作者.txt」）
      return looksLikeChapterFile(txtFiles[0])
        ? { kind: 'chapter-folder', txtFiles, reason: err.message }
        : { kind: 'novels', files: txtFiles, reason: err.message };
    }
    const chapterLike = txtFiles.filter(looksLikeChapterFile).length;
    if (chapterLike >= Math.ceil(txtFiles.length * 0.6)) {
      return { kind: 'chapter-folder', txtFiles, reason: err.message };
    }
    return { kind: 'novels', files: txtFiles, reason: err.message };
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

// 现成的书 / 一本书的章节目录
async function importBookFolder(booksRoot, sourceDir, analysis) {
  const desiredFolder =
    analysis.kind === 'book'
      ? analysis.meta.title || path.basename(sourceDir)
      : path.basename(sourceDir);
  const folder = await uniqueFolderName(booksRoot, desiredFolder);
  const target = path.join(booksRoot, folder);

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
      kind: 'chapter-folder',
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

// 一个完整小说 txt → 一本书（自动识别编码、自动分章）
async function importNovelFile(booksRoot, filePath) {
  const buffer = await fs.readFile(filePath);
  const text = normalizeText(decodeBuffer(buffer)).trim();
  const baseName = path.basename(filePath, path.extname(filePath)).trim() || '未命名小说';
  if (!text) {
    throw new storage.StorageError('EMPTY_FILE', `《${baseName}》是空文件，跳过`);
  }

  const folder = await uniqueFolderName(booksRoot, baseName);
  const target = path.join(booksRoot, folder);
  // 先写到隐藏的临时目录，写完再改名成正式书文件夹：
  // 导入中途崩溃时不会留下半本「看起来正常」的书（隐藏目录不会被书架扫描）。
  const staging = path.join(
    booksRoot,
    `.import-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  );
  await fs.mkdir(staging, { recursive: true });

  try {
    const parts = splitChapters(text);
    if (!parts.length) {
      throw new storage.StorageError('NO_CONTENT', `《${baseName}》没有可导入的正文`);
    }
    const now = new Date().toISOString();
    const chapters = [];
    const usedFiles = [];
    for (let i = 0; i < parts.length; i += 1) {
      const seq = i + 1;
      const file = chaptersLib.uniqueFileName(seq, parts[i].title || '', usedFiles);
      // 导入的是「源文件仍在的副本」，这里用普通写入换取速度；崩溃最多丢这次导入，可从源文件重来
      await fs.writeFile(path.join(staging, file), chaptersLib.toDiskNewlines(parts[i].text), 'utf8');
      usedFiles.push(file);
      chapters.push({
        id: `ch_${chaptersLib.pad3(i + 1)}`,
        file,
        name: parts[i].title || '',
        chars: chaptersLib.countChars(parts[i].text),
        createdAt: now
      });
    }
    const meta = {
      version: 1,
      id: `b_${Date.now().toString(36)}`,
      title: baseName,
      titleTemplate: chaptersLib.TITLE_TEMPLATE,
      fileSeq: chapters.length,
      chapters,
      lastOpenChapterId: chapters[0].id,
      createdAt: now
    };
    await storage.writeBookMeta(staging, meta);
    await fs.rename(staging, target);
    return {
      imported: true,
      kind: 'novel',
      folder,
      path: target,
      title: baseName,
      chapters: chapters.length
    };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// 清理上次导入崩溃留下的隐藏临时目录（只动自己前缀的，1 小时以前的）
async function cleanupStaleStaging(booksRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(booksRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.import-')) continue;
    const full = path.join(booksRoot, entry.name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > 3600 * 1000) {
        await fs.rm(full, { recursive: true, force: true });
      }
    } catch { /* 忽略 */ }
  }
}

function normalizeSources(sources) {
  return (sources || []).filter((s) => typeof s === 'string' && s.trim());
}

async function importFolders(booksRoot, sources, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const imported = [];
  const skipped = [];
  const failed = [];
  const root = path.resolve(booksRoot);
  await fs.mkdir(root, { recursive: true });
  await cleanupStaleStaging(root);

  // 第一遍：分析来源并算总进度
  const plans = [];
  let total = 0;
  for (const source of normalizeSources(sources)) {
    const sourceDir = path.resolve(source);
    if (!(await isDirectory(sourceDir))) {
      skipped.push({ source, reason: '不是文件夹' });
      continue;
    }
    if (isInside(root, sourceDir)) {
      skipped.push({ source, reason: '已经在书架目录里了' });
      continue;
    }
    if (isInside(sourceDir, root)) {
      skipped.push({ source, reason: '不能导入包含书架目录的上级文件夹' });
      continue;
    }
    const analysis = await analyzeSource(sourceDir);
    if (analysis.kind === 'nothing') {
      skipped.push({ source, reason: '既没有可用的 书目.json，也没有 txt 文件' });
      continue;
    }
    const items = analysis.kind === 'novels' ? analysis.files.length : 1;
    plans.push({ source, sourceDir, analysis, items });
    total += items;
  }
  if (onProgress) onProgress({ done: 0, total });

  let done = 0;
  const bump = (current) => {
    done += 1;
    if (onProgress) onProgress({ done, total, current });
  };

  for (const plan of plans) {
    if (plan.analysis.kind === 'novels') {
      for (const file of plan.analysis.files) {
        try {
          const result = await importNovelFile(root, path.join(plan.sourceDir, file));
          imported.push(result);
        } catch (err) {
          failed.push({ source: path.join(plan.sourceDir, file), message: err.message });
        }
        bump(file);
      }
    } else {
      try {
        const result = await importBookFolder(root, plan.sourceDir, plan.analysis);
        imported.push(result);
      } catch (err) {
        failed.push({ source: plan.source, message: err.message });
      }
      bump(path.basename(plan.sourceDir));
    }
  }

  return { imported, skipped, failed };
}

module.exports = {
  importFolders,
  importNovelFile,
  analyzeSource,
  looksLikeChapterFile,
  isInside
};
