// 自定义字体「读哪个文件」的策略（代码审计 F1）——纯逻辑，不碰磁盘、不 require electron。
//
// 改前：渲染层可以把任意路径传给 font:read，主进程只按扩展名（.ttf / .otf / .ttc）+ 24MB 上限
//       把它读成 base64 返回。渲染层理论上没有 fs 权限，但通过这个 IPC 仍然能读到磁盘上任何
//       字体文件（路径由调用方决定）。
// 改后：font:read 不再看渲染层传来的路径。主进程只认自己知道的三种字体路径：
//   1. picked —— 本次窗口在「选择字体文件」对话框里刚选的（只在内存里，读到一次就清掉）；
//   2. book   —— 当前打开的这本书在 config.bookDisplay[bookId].editorCustomFontPath 里记的；
//   3. global —— 全局 config.editorCustomFontPath。
// 一个都没有就报 BAD_FONT。这里只决定「用哪个路径」和「路径 / 大小是否合规」，真正的
// fs.stat / fs.readFile 仍在 main.js（渲染层照样没有文件系统权限）。
//
// 生效值的合并规则必须和渲染层 effectiveConfig()（全局 + 本书覆盖）一致，否则「按书架 / 按书
// 选的自定义字体重启后还能不能加载」会跟界面对不上（单测覆盖）。
const path = require('node:path');

const FONT_EXTS = ['.ttf', '.otf', '.ttc'];
const FONT_MAX_BYTES = 24 * 1024 * 1024;

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// 字体文件的扩展名（小写、带点）；不是字符串 / 没有扩展名返回空串
function fontExtension(filePath) {
  const text = toText(filePath);
  return text ? path.extname(text).toLowerCase() : '';
}

// 只接受 .ttf / .otf / .ttc（大小写不敏感）
function isFontFile(filePath) {
  return FONT_EXTS.includes(fontExtension(filePath));
}

// 24MB 上限：正好 24MB 仍允许（和改前 `stat.size > FONT_MAX_BYTES` 的判定一致）
function isFontSizeAllowed(size) {
  const value = Number(size);
  return Number.isFinite(value) && value >= 0 && value <= FONT_MAX_BYTES;
}

// 全局默认 + 本书覆盖（bookDisplay[bookId]）→ 真正生效的自定义字体。
// 返回 { font, path, source }：font 是生效的字体档位，path 是生效的自定义字体路径（'' = 没有），
// source 是路径来自哪一层（'book' / 'global'）。合并规则：有覆盖用覆盖，没有才用全局。
function effectiveFont(bookEntry, globalConfig) {
  const book = isPlainObject(bookEntry) ? bookEntry : {};
  const global = isPlainObject(globalConfig) ? globalConfig : {};
  const font = toText(has(book, 'editorFont') ? book.editorFont : global.editorFont);
  const fromBook = has(book, 'editorCustomFontPath');
  const fontPath = toText(fromBook ? book.editorCustomFontPath : global.editorCustomFontPath);
  return { font, path: fontPath, source: fromBook ? 'book' : 'global' };
}

// 这次 font:read 该读哪个文件：picked > book > global。
// 只有生效档位是 'custom' 且路径非空才算数（和渲染层 applyEditorStyle / loadCustomFont 的判定一致）。
function resolveFontSource(options) {
  const opts = isPlainObject(options) ? options : {};
  const picked = toText(opts.picked);
  if (picked) return { path: picked, source: 'picked' };
  const merged = effectiveFont(opts.book, opts.global);
  if (merged.font !== 'custom' || !merged.path) return { path: '', source: 'none' };
  return { path: merged.path, source: merged.source };
}

module.exports = {
  FONT_EXTS,
  FONT_MAX_BYTES,
  fontExtension,
  isFontFile,
  isFontSizeAllowed,
  effectiveFont,
  resolveFontSource
};
