'use strict';
// 终端表格对齐（v0.9 A-4 抽自 scripts/bench.js 的 displayWidth / padCell）——纯字符串处理、
// 零依赖、不读盘。开发自检脚本（bench / contrast）都要往终端打中文表格：
// 中文 / 全角标点在等宽字体里占两列，用 `String.length` 补位会一列比一列歪。
//
// 口径（与 bench.js 原来那一份逐字节相同，bench 的 17 项单测钉着行为）：
//   * displayWidth：中日韩统一表意文字 / 假名 / 谚文 / 全角标点 / 代理对里的扩展 B 区都算 2 列，
//     其余算 1 列；制表符按 1 列（表格里本来不该出现）。
//   * padCell：右边（或左边）补空格到指定列宽，已经超宽就原样返回（不截断——宁可歪，
//     也不要把「等待超时：xxx」这类现场信息吃掉）。
function displayWidth(text) {
  const value = String(text == null ? '' : text);
  let width = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function padCell(text, width, align = 'left') {
  const value = String(text == null ? '' : text);
  const gap = Math.max(0, width - displayWidth(value));
  return align === 'right' ? ' '.repeat(gap) + value : value + ' '.repeat(gap);
}

// 把若干行单元格渲染成对齐的表格文本：第一行是表头，第二行是分隔线（-），
// 每行之间两个空格；行尾空白去掉（免得日志里出现看不见的尾随空格）。
// aligns：每列 'left' / 'right'，缺省按 'left'；表头列一律左对齐。
function tableLines(rows, aligns) {
  const data = (Array.isArray(rows) ? rows : []).filter((row) => Array.isArray(row) && row.length);
  if (!data.length) return [];
  const columns = Math.max(...data.map((row) => row.length));
  const widths = [];
  for (let col = 0; col < columns; col += 1) {
    widths.push(Math.max(...data.map((row) => displayWidth(row[col]))));
  }
  const alignOf = (col, index) => {
    if (index === 0) return 'left';
    const list = Array.isArray(aligns) ? aligns : [];
    return list[col] === 'right' ? 'right' : 'left';
  };
  return data.map((row, index) =>
    widths
      .map((width, col) => padCell(row[col], width, alignOf(col, index)))
      .join('  ')
      .replace(/\s+$/, '')
  );
}

module.exports = { displayWidth, padCell, tableLines };
