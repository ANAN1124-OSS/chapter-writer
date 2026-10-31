// 整本导出/复制的拼接逻辑。导出与复制共用，保证两处格式永远一致。
const chaptersLib = require('./chapters');

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

// 导出/复制时，把「编辑区里当前章的最新内容」一起拼进去（只影响这一次输出，绝不写盘）。
// override = { chapterId?, chapterFile?, text }；返回章节下标，-1 表示没匹配到（就按磁盘内容来）。
function chapterIndexOf(meta, override) {
  if (!override || typeof override.text !== 'string') return -1;
  const chapters = (meta && Array.isArray(meta.chapters) && meta.chapters) || [];
  if (override.chapterId) {
    const byId = chapters.findIndex((chapter) => chapter && chapter.id === override.chapterId);
    if (byId >= 0) return byId;
  }
  if (override.chapterFile) {
    return chapters.findIndex((chapter) => chapter && chapter.file === override.chapterFile);
  }
  return -1;
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
  resolveExportDir
};
