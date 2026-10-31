// 整本导出/复制的拼接逻辑。导出与复制共用，保证两处格式永远一致。
const chaptersLib = require('./chapters');
const formatLib = require('./format');

const BOM = '\uFEFF';

// 章与章之间空一行；标题与正文之间空一行；正文首尾的空行去掉。
function blockFor(title, text) {
  const body = chaptersLib
    .normalizeNewlines(text)
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .replace(/\n/g, '\r\n');
  return body ? `${title}\r\n\r\n${body}` : title;
}

function chapterList(meta) {
  return meta && Array.isArray(meta.chapters) ? meta.chapters : [];
}

function volumeList(meta) {
  return meta && Array.isArray(meta.volumes) ? meta.volumes : [];
}

function toInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : null;
}

// 解析导出范围（只读，不改 meta）：
//   null / { mode: 'all' }                          → 全书
//   { mode: 'volume', volumeId }                    → 某一卷（volumeId 为 null = 未分卷）
//   { mode: 'range', from, to }                     → 第 from–to 章（1 基、含两端，按全书顺序）
// 返回 { mode, indexes, count, from, to, label, volumeId, empty }：
//   indexes 是「全书 chapters 数组里的下标」，导出时章号仍按全书连续编号；
//   越界自动收进 [1, 总章数]；from > to 或卷里没章节时 count = 0（调用方据此提示，不写空文件）。
function resolveExportRange(meta, range) {
  const chapters = chapterList(meta);
  const total = chapters.length;
  const mode = range && typeof range.mode === 'string' ? range.mode : 'all';
  const allIndexes = [];
  for (let i = 0; i < total; i += 1) allIndexes.push(i);

  if (mode === 'volume') {
    const wanted = range && range.volumeId != null ? String(range.volumeId) : null;
    const indexes = [];
    chapters.forEach((chapter, index) => {
      const volumeId = chapter && chapter.volumeId ? String(chapter.volumeId) : null;
      if (volumeId === wanted) indexes.push(index);
    });
    const volume = wanted ? volumeList(meta).find((v) => v && v.id === wanted) : null;
    const volumeName = volume ? String(volume.name || '').trim() : '';
    return {
      mode: 'volume',
      indexes,
      count: indexes.length,
      from: indexes.length ? indexes[0] + 1 : 0,
      to: indexes.length ? indexes[indexes.length - 1] + 1 : 0,
      label: !wanted ? '未分卷' : volume ? volumeName || '未命名卷' : '未找到的卷',
      volumeId: wanted,
      empty: indexes.length === 0
    };
  }

  if (mode === 'range') {
    let from = toInt(range && range.from);
    let to = toInt(range && range.to);
    if (from == null) from = 1;
    if (to == null) to = total;
    if (total > 0) {
      from = Math.min(Math.max(from, 1), total);
      to = Math.min(Math.max(to, 1), total);
    }
    const indexes = [];
    if (total > 0) {
      for (let n = from; n <= to; n += 1) indexes.push(n - 1);
    }
    return {
      mode: 'range',
      indexes,
      count: indexes.length,
      from: total > 0 ? from : 0,
      to: total > 0 ? to : 0,
      label: from === to ? `第${from}章` : `第${from}-${to}章`,
      volumeId: null,
      empty: indexes.length === 0
    };
  }

  return {
    mode: 'all',
    indexes: allIndexes,
    count: total,
    from: total > 0 ? 1 : 0,
    to: total,
    label: '全书',
    volumeId: null,
    empty: total === 0
  };
}

// 导出对话框默认文件名（不含目录）：
//   全书 → 书名.txt；按卷 → 书名-卷名.txt；章节范围 → 书名-第X-Y章.txt（单章 书名-第X章.txt）
function exportFileName(meta, range) {
  const plan = resolveExportRange(meta, range);
  const bookName = chaptersLib.safeName(meta && meta.title);
  if (plan.mode === 'all') return `${bookName}.txt`;
  return `${bookName}-${chaptersLib.safeName(plan.label)}.txt`;
}

// meta.chapters 与 texts 一一对应（texts 顺序同 chapters）
// 有分卷的书：每卷第一段前面多输出一行卷名（卷名照抄原文，不加「第N卷」前缀）
// range 可选（见 resolveExportRange）：只输出范围内的章节，章号仍按全书顺序。
function composeBook(meta, texts, range) {
  const chapters = chapterList(meta);
  const volumes = new Map(
    volumeList(meta).map((volume) => [volume.id, volume])
  );
  const plan = resolveExportRange(meta, range);
  const blocks = [];
  let currentVolumeId = null;
  plan.indexes.forEach((index) => {
    const chapter = chapters[index];
    const volumeId = (chapter && chapter.volumeId) || null;
    if (volumeId !== currentVolumeId) {
      currentVolumeId = volumeId;
      const volume = volumeId ? volumes.get(volumeId) : null;
      const volumeName = volume ? String(volume.name || '').trim() : '';
      if (volumeName) blocks.push(volumeName);
    }
    const title = chaptersLib.formatTitle(meta, index, chapter && chapter.name);
    const text = Array.isArray(texts) ? texts[index] : '';
    blocks.push(blockFor(title, text));
  });
  return `${blocks.join('\r\n\r\n')}\r\n`;
}

// 导出文件用：UTF-8 带 BOM，方便记事本等老工具识别
function exportBufferFromText(text) {
  return Buffer.from(`${BOM}${String(text == null ? '' : text)}`, 'utf8');
}

function exportBuffer(meta, texts) {
  return exportBufferFromText(composeBook(meta, texts));
}

// 按 chapterId（优先）/ chapterFile 找章节下标；找不到返回 -1。
// 「复制本章」只要指定是哪一章，不用带正文；导出覆盖判断则要求必须有 text（见 chapterIndexOf）。
function chapterRefIndex(meta, ref) {
  if (!ref || typeof ref !== 'object') return -1;
  const chapters = (meta && Array.isArray(meta.chapters) && meta.chapters) || [];
  if (ref.chapterId) {
    const byId = chapters.findIndex((chapter) => chapter && chapter.id === ref.chapterId);
    if (byId >= 0) return byId;
  }
  if (ref.chapterFile) {
    return chapters.findIndex((chapter) => chapter && chapter.file === ref.chapterFile);
  }
  return -1;
}

// 导出/复制时，把「编辑区里当前章的最新内容」一起拼进去（只影响这一次输出，绝不写盘）。
// override = { chapterId?, chapterFile?, text }；返回章节下标，-1 表示没匹配到（就按磁盘内容来）。
function chapterIndexOf(meta, override) {
  if (!override || typeof override.text !== 'string') return -1;
  return chapterRefIndex(meta, override);
}

// 「复制本章（平台格式）」的排版规则：只动空白，不改字词/标点。
// 段首缩进两个全角空格；段与段之间空一行，且这个空行里也带两个全角空格
// （有些平台/编辑器会吃掉纯空行，带缩进的空行粘过去不会塌）。
const PLATFORM_FORMAT_OPTIONS = Object.freeze({
  indent: '2',
  blankLines: 'singleIndent',
  trimTrailing: false,
  normalizePunct: false,
  removeCjkSpaces: false,
  curlyQuotes: false,
  ellipsis: false
});

// 单章正文 → 平台粘贴格式（不含章名；章名在平台后台是单独一栏）。
// 返回 { text, paragraphs, chars, empty }：text 用 CRLF、末尾一个换行（和导出一致）；
// 空章 / 只有空白的章 text 为空字符串，调用方不要拿它覆盖剪贴板。
function platformChapterText(text) {
  const source = String(text == null ? '' : text);
  const formatted = formatLib.formatText(source, PLATFORM_FORMAT_OPTIONS);
  const body = formatted.text.replace(/\n/g, '\r\n').replace(/(?:\r\n)+$/, '');
  return {
    text: body ? `${body}\r\n` : '',
    paragraphs: formatted.stats.paragraphs,
    chars: chaptersLib.countChars(source),
    empty: !body
  };
}

// 导出对话框的默认目录：优先用「上一次导出保存到的目录」，没记过或目录已经没了才退回默认目录（文档）。
// exists 传进来是为了能在单测里替换掉真实的文件系统检查。
function resolveExportDir(remembered, fallback, exists) {
  const dir = typeof remembered === 'string' ? remembered.trim() : '';
  if (dir && (!exists || exists(dir))) return dir;
  return fallback;
}

module.exports = {
  BOM,
  composeBook,
  resolveExportRange,
  exportFileName,
  exportBuffer,
  exportBufferFromText,
  chapterIndexOf,
  chapterRefIndex,
  PLATFORM_FORMAT_OPTIONS,
  platformChapterText,
  resolveExportDir
};
