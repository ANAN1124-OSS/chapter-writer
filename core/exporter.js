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
function composeBook(meta, texts) {
  const blocks = meta.chapters.map((chapter, index) => {
    const title = chaptersLib.formatTitle(meta, index, chapter.name);
    const text = Array.isArray(texts) ? texts[index] : '';
    return blockFor(title, text);
  });
  return `${blocks.join('\r\n\r\n')}\r\n`;
}

// 导出文件用：UTF-8 带 BOM，方便记事本等老工具识别
function exportBuffer(meta, texts) {
  return Buffer.from(`${BOM}${composeBook(meta, texts)}`, 'utf8');
}

module.exports = { BOM, composeBook, exportBuffer };
