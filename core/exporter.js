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

// meta.chapters 与 texts 一一对应（texts 顺序同 chapters）
// 有分卷的书：每卷第一段前面多输出一行卷名（卷名照抄原文，不加「第N卷」前缀）
function composeBook(meta, texts) {
  const volumes = new Map(
    (meta && Array.isArray(meta.volumes) ? meta.volumes : []).map((volume) => [volume.id, volume])
  );
  const blocks = [];
  let currentVolumeId = null;
  meta.chapters.forEach((chapter, index) => {
    const volumeId = (chapter && chapter.volumeId) || null;
    if (volumeId !== currentVolumeId) {
      currentVolumeId = volumeId;
      const volume = volumeId ? volumes.get(volumeId) : null;
      const volumeName = volume ? String(volume.name || '').trim() : '';
      if (volumeName) blocks.push(volumeName);
    }
    const title = chaptersLib.formatTitle(meta, index, chapter.name);
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
  exportBuffer,
  exportBufferFromText,
  chapterIndexOf,
  chapterRefIndex,
  PLATFORM_FORMAT_OPTIONS,
  platformChapterText,
  resolveExportDir
};
