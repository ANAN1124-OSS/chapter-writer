// 敏感词预检（只报告、不改动）——纯逻辑 + 词表读取，不依赖 Electron，可单测。
//
// 设计前提（提案 5.2）：词表完全由作者管理，应用**不内置任何词表**、保持中立。
// 作者在设置里指定一个自己的 txt（每行一个词），预检只按这个词表做字面匹配：
//   · 只报告命中的词、章名、行号列号与上下文，绝不改正文、绝不写盘
//   · 词表只读，不复制、不改写；文件缺失 / 编码异常 / 空词表都有明确提示
//   · 空行忽略；同一个词重复出现只算一次；单行超过 100 字视为坏行跳过
//   · 同一处有多个词重叠（例如词表里既有「色情」又有「色情小说」）只报最长的那个
//   · 字面匹配、区分大小写（不做正则、不做大小写折叠，避免作者以为「没命中」）
//
// 定位约定：index / length 都是「把 CRLF 归一成 \n、去掉 BOM」之后的字符位置，
// 与编辑区 textarea 的 value 一致，因此可以直接 setSelectionRange。
const fs = require('node:fs/promises');
const path = require('node:path');
const findLib = require('./find');
const txtLib = require('./txt');

// 词表文件上限：再大就不像「每行一个词」的词表了，读进来只会拖慢整本检查
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// 最多取前 5000 个词；超出部分不读，但会明确告诉作者（truncated）
const MAX_WORDS = 5000;
// 单行超过 100 字基本是误粘进来的正文，跳过并统计，不参与匹配
const MAX_WORD_LENGTH = 100;
// 单次扫描最多收集多少条原始命中（防止词表里混进「的」这类超高频字把内存打爆）
const RAW_MATCH_LIMIT = 100000;
// 结果列表里显示的上下文半径（和校对 / 查找一致）
const SNIPPET_RADIUS = 18;
// 摘要里最多列多少个词的命中数（明细里每一条仍会列出具体词）
const BY_WORD_LIMIT = 20;
// 整本预检最多返回多少条明细（总数照实统计）
const BOOK_ISSUE_LIMIT = 1500;

const DEFAULT_OPTIONS = Object.freeze({
  maxIssues: 500 // 单章最多返回多少条（总数仍会照实统计）
});

const OPTION_LIMITS = Object.freeze({
  maxIssues: [20, 5000]
});

function clampInt(value, fallback, range) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, range[0]), range[1]);
}

function sanitizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    maxIssues: clampInt(source.maxIssues, DEFAULT_OPTIONS.maxIssues, OPTION_LIMITS.maxIssues)
  };
}

// 和 storage.loadChapterText / 编辑区保持一致：去掉 BOM、CRLF 归一成 LF
function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

// 渲染层 / 旧调用方传进来的词数组也兜底：去空白、去空、去重、限制长度与数量
function sanitizeWords(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const word = typeof item === 'string' ? item.trim() : '';
    if (!word || word.length > MAX_WORD_LENGTH || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

// 词表文本 → { words, stats }。只做「每行一个词」这一件事：
// 空行忽略、重复只留一次、超长行跳过；超过 MAX_WORDS 后不再读（truncated）。
function parseWordList(text) {
  const source = normalizeText(text);
  const lines = source.split('\n');
  const words = [];
  const seen = new Set();
  const stats = { lines: lines.length, emptyLines: 0, duplicates: 0, tooLong: 0, truncated: false };
  for (const line of lines) {
    const word = line.trim();
    if (!word) {
      stats.emptyLines += 1;
      continue;
    }
    if (word.length > MAX_WORD_LENGTH) {
      stats.tooLong += 1;
      continue;
    }
    if (seen.has(word)) {
      stats.duplicates += 1;
      continue;
    }
    if (words.length >= MAX_WORDS) {
      stats.truncated = true;
      break;
    }
    seen.add(word);
    words.push(word);
  }
  return { words, stats };
}

// 词表字节 → { ok, words, stats } 或 { ok:false, code, message }。
// 编码复用 txt.decodeBuffer（UTF-8 / UTF-16 BOM / GB18030），并额外识别两种「不是纯文本」：
// 带 NUL 的二进制、解码出替换字符 U+FFFD 的坏编码。
function decodeWordListBuffer(buffer) {
  if (!buffer || !buffer.length) {
    return { ok: false, code: 'WORD_LIST_EMPTY', message: '词表是空文件（每行一个词）' };
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return { ok: false, code: 'WORD_LIST_TOO_BIG', message: '词表文件太大（上限 4MB），请换一个小一点的 txt' };
  }
  const hasUtf16Bom =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
  if (!hasUtf16Bom && buffer.includes(0)) {
    return {
      ok: false,
      code: 'WORD_LIST_BAD_ENCODING',
      message: '词表不像是纯文本（检测到二进制内容），请用 UTF-8 / UTF-16 / GBK 编码的 txt'
    };
  }
  const text = txtLib.decodeBuffer(buffer);
  if (text.includes('\uFFFD')) {
    return {
      ok: false,
      code: 'WORD_LIST_BAD_ENCODING',
      message: '词表编码无法识别（不是 UTF-8 / UTF-16 / GBK 文本），请另存为 UTF-8 的 txt'
    };
  }
  const parsed = parseWordList(text);
  if (!parsed.words.length) {
    return {
      ok: false,
      code: 'WORD_LIST_EMPTY',
      message: '词表里没有有效的词（每行一个词，空行会被忽略）'
    };
  }
  return { ok: true, words: parsed.words, stats: parsed.stats };
}

// 读词表文件（只读）。任何失败都返回结构化结果，由界面给出明确提示，不抛异常。
async function readWordListFile(filePath) {
  const rawPath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!rawPath) {
    return {
      ok: false,
      configured: false,
      code: 'WORD_LIST_NOT_CONFIGURED',
      message: '还没有指定敏感词表（应用不内置词表，请先选一个自己的 txt）',
      path: '',
      name: ''
    };
  }
  const resolved = path.resolve(rawPath);
  const base = { configured: true, path: resolved, name: path.basename(resolved) };
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      ...base,
      ok: false,
      code: missing ? 'WORD_LIST_MISSING' : 'WORD_LIST_UNREADABLE',
      message: missing
        ? `词表文件不存在：${resolved}（可能被移动或删除了，请重新选择）`
        : `读不了词表文件：${(err && err.message) || err}`
    };
  }
  if (!stat.isFile()) {
    return { ...base, ok: false, code: 'WORD_LIST_NOT_FILE', message: '选中的不是一个文件，请选词表 txt' };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ...base,
      ok: false,
      size: stat.size,
      code: 'WORD_LIST_TOO_BIG',
      message: '词表文件太大（上限 4MB），请换一个小一点的 txt'
    };
  }
  let buffer;
  try {
    buffer = await fs.readFile(resolved);
  } catch (err) {
    return {
      ...base,
      ok: false,
      code: 'WORD_LIST_UNREADABLE',
      message: `读不了词表文件：${(err && err.message) || err}`
    };
  }
  const decoded = decodeWordListBuffer(buffer);
  if (!decoded.ok) return { ...base, size: stat.size, ...decoded };
  return { ...base, ok: true, size: stat.size, words: decoded.words, stats: decoded.stats };
}

// 只给渲染层的词表信息：绝不把词表内容（words）带过去，界面只需要数量与状态
function publicWordListInfo(list) {
  if (!list || typeof list !== 'object') {
    return {
      ok: false,
      configured: false,
      code: 'WORD_LIST_NOT_CONFIGURED',
      message: '还没有指定敏感词表',
      path: '',
      name: '',
      count: 0
    };
  }
  const { words, ...rest } = list;
  return { ...rest, count: Array.isArray(words) ? words.length : 0 };
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

// 字符位置 → 1 基的行 / 列（二分查找行首）
function positionOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

// 扫描一段正文。返回 { total, issues, byWord, wordHitCount, wordCount, truncated, chars }。
// total 是「去重叠之后」的全部命中数；issues 只保留前 maxIssues 条明细（带行号列号与上下文）。
function scanText(text, rawWords, rawOptions) {
  const options = sanitizeOptions(rawOptions);
  const words = sanitizeWords(rawWords);
  const source = normalizeText(text);
  const raw = [];
  let rawLimitHit = false;
  for (const word of words) {
    let from = 0;
    for (;;) {
      const index = source.indexOf(word, from);
      if (index < 0) break;
      if (raw.length >= RAW_MATCH_LIMIT) {
        rawLimitHit = true;
        break;
      }
      raw.push({ word, index });
      from = index + 1; // +1 而不是 +word.length：重叠命中先全收下，再统一去重
    }
    if (rawLimitHit) break;
  }

  // 按位置排；同一个起点有多个词时先看长的（「色情小说」优先于「色情」）
  raw.sort(
    (a, b) =>
      a.index - b.index ||
      b.word.length - a.word.length ||
      (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)
  );
  const kept = [];
  let lastEnd = -1;
  for (const hit of raw) {
    if (hit.index < lastEnd) continue; // 和已经报过的那一处重叠，跳过
    kept.push(hit);
    lastEnd = hit.index + hit.word.length;
  }

  const byWordMap = new Map();
  for (const hit of kept) byWordMap.set(hit.word, (byWordMap.get(hit.word) || 0) + 1);
  // 完整返回每个命中词的次数（最多 = 词表词数），由调用方决定摘要里显示前几个
  const byWord = Array.from(byWordMap, ([word, count]) => ({ word, count })).sort(
    (a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)
  );

  const total = kept.length;
  const lineStarts = lineStartsOf(source);
  const issues = kept.slice(0, options.maxIssues).map((hit) => {
    const pos = positionOf(lineStarts, hit.index);
    return {
      word: hit.word,
      index: hit.index,
      length: hit.word.length,
      line: pos.line,
      column: pos.column,
      snippet: findLib.makeSnippet(source, hit.index, hit.word.length, SNIPPET_RADIUS)
    };
  });

  return {
    total,
    issues,
    byWord,
    wordHitCount: byWordMap.size,
    wordCount: words.length,
    truncated: rawLimitHit || total > issues.length,
    chars: source.length
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_WORDS,
  MAX_WORD_LENGTH,
  RAW_MATCH_LIMIT,
  BY_WORD_LIMIT,
  BOOK_ISSUE_LIMIT,
  DEFAULT_OPTIONS,
  OPTION_LIMITS,
  sanitizeOptions,
  sanitizeWords,
  normalizeText,
  parseWordList,
  decodeWordListBuffer,
  readWordListFile,
  publicWordListInfo,
  scanText
};
