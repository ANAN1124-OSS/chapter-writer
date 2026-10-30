// 章节相关的纯逻辑：编号、标题、文件名净化、顺序增删。
// 这里不碰磁盘，全部可单测。
const TITLE_TEMPLATE = '第{num}章：{name}';
const MAX_NAME_LENGTH = 40;
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const EDGE_DOTS_SPACES = /^[.\s]+|[.\s]+$/g;
// 原文自带章节标题（导进来的书）：显示时原样保留，不再叠加「第N章：」
const RAW_TITLE_RE =
  /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷集篇部]|楔子|序章|序言|引子|前言|尾声|后记|番外|终章|大结局|开篇|Chapter\s+\d+)/i;

function pad3(n) {
  return String(n).padStart(3, '0');
}

function formatTitle(meta, index, name) {
  const template =
    meta && typeof meta.titleTemplate === 'string' && meta.titleTemplate.trim()
      ? meta.titleTemplate
      : TITLE_TEMPLATE;
  const number = String(index + 1);
  const clean = String(name == null ? '' : name).trim();
  // 原文自带的章节标题（如「第1章 关于本作品」）原样显示，避免「第1章：第1章 …」重复
  if (clean && RAW_TITLE_RE.test(clean)) return clean;
  // 没有名字的章节：显示「第N章」，不再显示「第N章：未命名」
  if (!clean) return `第${number}章`;
  return template.split('{num}').join(number).split('{name}').join(clean);
}

function safeName(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(ILLEGAL_CHARS, '').replace(EDGE_DOTS_SPACES, '');
  if (!s) s = '未命名';
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).replace(EDGE_DOTS_SPACES, '');
  return s || '未命名';
}

function buildFileName(seq, name) {
  return `${pad3(seq)}-${safeName(name)}.txt`;
}

function uniqueFileName(seq, name, existingFiles = []) {
  const used = new Set(existingFiles);
  let candidate = buildFileName(seq, name);
  let i = 2;
  while (used.has(candidate)) {
    candidate = buildFileName(seq, `${safeName(name)}-${i}`);
    i += 1;
  }
  return candidate;
}

function nextFileSeq(meta) {
  const n = Number(meta && meta.fileSeq);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.floor(n) + 1;
}

function findChapterIndex(meta, chapterId) {
  if (!meta || !Array.isArray(meta.chapters)) return -1;
  return meta.chapters.findIndex((c) => c && c.id === chapterId);
}

function insertChapter(meta, insertIndex, chapter) {
  const list = Array.isArray(meta.chapters) ? meta.chapters.slice() : [];
  const rawIndex = Number(insertIndex);
  const index = Number.isFinite(rawIndex) ? Math.max(0, Math.min(Math.floor(rawIndex), list.length)) : list.length;
  list.splice(index, 0, chapter);
  return { ...meta, chapters: list };
}

function removeChapter(meta, chapterId) {
  const list = (meta.chapters || []).filter((c) => c.id !== chapterId);
  return { ...meta, chapters: list };
}

function updateChapter(meta, chapterId, patch) {
  return {
    ...meta,
    chapters: (meta.chapters || []).map((c) => (c.id === chapterId ? { ...c, ...patch } : c))
  };
}

function countChars(text) {
  return String(text == null ? '' : text).replace(/\s/g, '').length;
}

function normalizeNewlines(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

function toDiskNewlines(text) {
  return normalizeNewlines(text).replace(/\n/g, '\r\n');
}

module.exports = {
  TITLE_TEMPLATE,
  MAX_NAME_LENGTH,
  RAW_TITLE_RE,
  pad3,
  formatTitle,
  safeName,
  buildFileName,
  uniqueFileName,
  nextFileSeq,
  findChapterIndex,
  insertChapter,
  removeChapter,
  updateChapter,
  countChars,
  normalizeNewlines,
  toDiskNewlines
};
