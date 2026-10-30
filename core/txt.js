// 纯文本小说解析：编码识别 + 章节切分。
// 给「导入小说」用：一个 txt 就是一本书时，按「第X章 / 楔子 / Chapter N」等标题行切章。
const CHAPTER_NUM_RE =
  /^\s*第\s*([0-9零〇一二三四五六七八九十百千万两]{1,12})\s*([章节回卷集篇部])\s*([：:、.．\-—–”"'‘’\s]*)(.*)$/;
const CHAPTER_KEY_RE =
  /^\s*(楔子|序章|序言|引子|前言|尾声|后记|番外|终章|大结局|Chapter\s+\d+)(?:\s*[：:、.．\-—–”"'‘’]+\s*|\s+|$)(.*)$/i;
const MAX_HEADING_LENGTH = 80;

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

// 把任意编码的文本文件解码成字符串：UTF-8（含 BOM）→ UTF-16 BOM → 严格 UTF-8 → GB18030 → latin1 兜底
function decodeBuffer(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16BE)) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch { /* 不是合法 UTF-8，继续试中文编码 */ }
  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch { /* 忽略 */ }
  return buffer.toString('latin1');
}

function stripBom(text) {
  const s = String(text == null ? '' : text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normalizeText(text) {
  return stripBom(text).replace(/\r\n?/g, '\n');
}

// 判断一行是不是章节标题；返回 { kind, name } 或 null
function parseHeading(line) {
  const raw = String(line == null ? '' : line);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return null;
  const numMatch = CHAPTER_NUM_RE.exec(raw);
  if (numMatch) {
    const name = String(numMatch[4] || '').trim();
    return { kind: 'num', raw: trimmed, name };
  }
  const keyMatch = CHAPTER_KEY_RE.exec(raw);
  if (keyMatch) {
    const keyword = String(keyMatch[1] || '').trim();
    const rest = String(keyMatch[2] || '').trim();
    return { kind: 'key', raw: trimmed, name: rest ? `${keyword} ${rest}` : keyword };
  }
  return null;
}

function isChapterHeading(line) {
  return Boolean(parseHeading(line));
}

// 章节标题行 → 章节名：去掉「第N章」「第一章：」这类前缀，只留标题本身
function headingToName(line) {
  const parsed = parseHeading(line);
  return parsed ? parsed.name : '';
}

// 把整本书文本切成 [{ title, text }]
function splitChapters(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  const marks = [];
  lines.forEach((line, index) => {
    const parsed = parseHeading(line);
    if (parsed) marks.push({ index, name: parsed.name });
  });

  if (!marks.length) {
    const body = normalized.trim();
    return body ? [{ title: '全文', text: body }] : [];
  }

  const parts = [];
  if (marks[0].index > 0) {
    const preface = lines.slice(0, marks[0].index).join('\n').trim();
    if (preface) parts.push({ title: '开篇', text: preface });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    parts.push({ title: marks[i].name, text: lines.slice(start, end).join('\n').trim() });
  }
  return parts;
}

module.exports = {
  decodeBuffer,
  normalizeText,
  parseHeading,
  isChapterHeading,
  headingToName,
  splitChapters,
  MAX_HEADING_LENGTH
};
