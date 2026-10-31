// 纯文本小说解析：编码识别 + 章节切分。
// 给「导入小说」用：一个 txt 就是一本书时，按「第X章 / 第X幕 / 楔子 / 番外 / Chapter N」等标题行切章。
// 注意：标题识别只决定「在哪里切」，章节名一律保留原文标题行，不改写作者的字。
const CHAPTER_NUM_RE =
  /^\s*第\s*([0-9零〇一二三四五六七八九十百千万两]{1,12})\s*([章节回卷集篇部话幕])([\s\S]*)$/;
const CHAPTER_KEY_RE =
  /^\s*(楔子|序章|序言|引子|前言|前传|外传|尾声|后记|番外篇?|终章|大结局|附录|Chapter\s+\d+)([\s\S]*)$/i;

// 标题行允许的长度上限（极长的一行更可能是正文，直接排除）
const MAX_HEADING_LENGTH = 300;
// 「第X章」后面没有分隔符、直接接文字时，只接受较短的行（避免把「第三节课结束时……」这种正文当成标题）
const MAX_NO_SEPARATOR_TITLE = 80;
// 「楔子 / 番外 / 前言」这类没有编号的关键词标题，无分隔符时行长度上限（如「后记和设定说明」）
const MAX_KEYWORD_HEADING = 40;

// 「第X章」后面的分隔符（不带逗号句号，避免把「第一章，他……」这种正文当标题）
const NUM_SEPARATORS = /^[：:、.．\-—–”"'‘’】）》」』（(【《「『，,;；\s]/;
// 关键词标题（楔子/番外/后记…）后面的分隔符可以更宽，因为关键词本身已经很明确
const KEY_SEPARATORS = /^[：:、.．\-—–”"'‘’】）》」』（(【《「『，,;；。!！?？·…\s]/;
// 关键词标题后面没有分隔符时，只有这些开头才像标题；
// 「尾声的序章，便是…」「引子内容」这类是正文，不能当标题。
const KEYWORD_NO_SEPARATOR_OK =
  /^(?:[0-9０-９零〇一二三四五六七八九十百千万两]+[.、．]?|[和与及、·\-—–][\s\S]*)/;

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

function trimLeadingPunctuation(text) {
  return String(text || '')
    .replace(/^[：:、.．\-—–”"'‘’】）》」』（(【《「『，,;；。!！?？·…\s]+/, '')
    .trim();
}

// 判断一行是不是章节标题；返回 { kind, name } 或 null
function parseHeading(line) {
  const raw = String(line == null ? '' : line);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return null;

  const numMatch = CHAPTER_NUM_RE.exec(trimmed);
  if (numMatch) {
    const restRaw = numMatch[3] || '';
    const marker = numMatch[2];
    const hasSeparator = restRaw === '' || NUM_SEPARATORS.test(restRaw);
    if (!hasSeparator) {
      // 「第三节课…」「第二节课后…」是正文常用说法，不是章节标题
      if (marker === '节' && restRaw.startsWith('课')) return null;
      // 没有分隔符又很长：基本是正文句子
      if (trimmed.length > MAX_NO_SEPARATOR_TITLE) return null;
    }
    return { kind: 'num', raw: trimmed, name: trimLeadingPunctuation(restRaw) };
  }

  const keyMatch = CHAPTER_KEY_RE.exec(trimmed);
  if (keyMatch) {
    const keyword = String(keyMatch[1] || '').trim();
    const restRaw = keyMatch[2] || '';
    const hasSeparator = restRaw === '' || KEY_SEPARATORS.test(restRaw);
    if (!hasSeparator) {
      // 没有分隔符时只接受「后记和设定说明」这类短标题，拒绝「尾声的序章，便是…」这类正文
      if (!KEYWORD_NO_SEPARATOR_OK.test(restRaw)) return null;
      if (trimmed.length > MAX_KEYWORD_HEADING) return null;
    }
    const rest = trimLeadingPunctuation(restRaw);
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

// 把整本书文本切成 [{ title, text }]（旧版自动分章用）
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

// 把整本书文本按原文标题行切成 [{ title, body }]：
// title = 原文标题行（去掉首尾空白），body = 该标题之后到下一标题之前的原文（不做 trim，保留空行）。
// 用于「按原文章节导入」：章名和正文都保持原样。
// 第一个标题之前的书名/作者/简介等，会并入第一章正文，避免多出一个原文没有的「开篇」章。
function splitChaptersRaw(text) {
  const normalized = stripBom(String(text == null ? '' : text)).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const marks = [];
  lines.forEach((line, index) => {
    const parsed = parseHeading(line);
    if (parsed) marks.push({ index, title: line.trim() });
  });

  if (!marks.length) return [{ title: '', body: normalized }];

  const parts = [];
  const preface = marks[0].index > 0 ? lines.slice(0, marks[0].index).join('\n') : '';
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    let body = lines.slice(start, end).join('\n');
    if (i === 0 && preface.trim()) body = `${preface}\n${body}`;
    parts.push({ title: marks[i].title, body });
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
  splitChaptersRaw,
  MAX_HEADING_LENGTH,
  MAX_NO_SEPARATOR_TITLE,
  MAX_KEYWORD_HEADING
};
