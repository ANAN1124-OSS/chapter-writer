// 朗读（提案 5.3）——纯逻辑，不读盘、不依赖 Electron，可单测。
//
// 渲染层只负责把 chunks 交给系统语音（Electron 的 speechSynthesis，Windows 走本地 SAPI）；
// 「正文怎么切成一段一段」在这里算，单测覆盖。朗读**只读正文**：不改编辑区、不写盘。
//
// 切分原则：
//   ① 一个自然段（非空行）先占一个 chunk —— 这样「上一段 / 下一段」和跟随高亮都对得上段落；
//   ② 单段太长（超过 maxChunkChars）时按句末标点（。！？；…）切开再拼，仍超长才硬切；
//   ③ 首尾空白（含全角空格）不进朗读文本，也不会被切到句子中间；
//   ④ 不切开代理对（emoji 等），不会把两个字符合成一个乱码。
//
// 定位约定：start / end 都是「去掉 BOM、CRLF 归一成 \n」之后的字符位置，
// 与编辑区 textarea 的 value 完全一致，因此可以直接 setSelectionRange(start, end)。
const chaptersLib = require('./chapters');
const { clampInt } = require('./common');

const DEFAULT_OPTIONS = Object.freeze({
  maxChunkChars: 160, // 单个 chunk 最多多少字（太长系统语音会吞字 / 卡顿，进度也看不见）
  maxChunks: 5000 // 单章最多返回多少段（防止病态长文撑爆渲染层）
});

const OPTION_LIMITS = Object.freeze({
  maxChunkChars: [40, 1200],
  maxChunks: [50, 20000]
});

// 正文超过这么多字符只处理前面的部分（病态输入兜底，正常一章远小于这个数）
const MAX_SOURCE_CHARS = 1000000;

// 句末标点：遇到它们就认为一句话结束（连续的 …… 只算一个单位，见 consumeEnders）
const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?', '；', ';', '…']);
// 句末标点后面紧跟的收尾符号要留在同一句里（引号、括号等），别被切到下一句开头
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '】', ']', '》', '〉', '－', '—']);
// 硬切长句时优先在这些位置断开（次级标点 + 空白），比直接砍在字中间自然
const SOFT_BREAKS = new Set(['，', '、', '：', ',', ':', '—']);

function sanitizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const caret = Number(source.caret);
  return {
    maxChunkChars: clampInt(source.maxChunkChars, DEFAULT_OPTIONS.maxChunkChars, OPTION_LIMITS.maxChunkChars),
    maxChunks: clampInt(source.maxChunks, DEFAULT_OPTIONS.maxChunks, OPTION_LIMITS.maxChunks),
    // caret 只影响返回的 startIndex（从光标处开始朗读），不影响切分
    caret: Number.isFinite(caret) ? Math.max(0, Math.floor(caret)) : 0
  };
}

// 和 storage.loadChapterText / 编辑区保持一致：去掉 BOM、CRLF 归一成 LF
function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

// 把 [start, end) 两端的空白（含全角空格）去掉；全空白返回 null
function trimmedRange(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return e > s ? { start: s, end: e } : null;
}

// 每个非空行算一个自然段；返回 { start, end, paragraph, line }（都已去掉首尾空白）
function paragraphRanges(text) {
  const ranges = [];
  let lineStart = 0;
  let paragraph = 0;
  let line = 0;
  const lines = text.split('\n');
  for (const raw of lines) {
    line += 1;
    const range = trimmedRange(text, lineStart, lineStart + raw.length);
    if (range) {
      paragraph += 1;
      ranges.push({ start: range.start, end: range.end, paragraph, line });
    }
    lineStart += raw.length + 1; // 加上换行符
  }
  return ranges;
}

// 把一段切成「句子」范围：句末标点 + 紧跟的收尾符号算一句，返回范围已 trim
function sentencePieces(text, start, end) {
  const pieces = [];
  let from = start;
  let i = start;
  while (i < end) {
    if (!SENTENCE_ENDERS.has(text[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < end && (SENTENCE_ENDERS.has(text[j]) || CLOSERS.has(text[j]))) j += 1;
    const piece = trimmedRange(text, from, j);
    if (piece) pieces.push(piece);
    from = j;
    i = j;
  }
  const tail = trimmedRange(text, from, end);
  if (tail) pieces.push(tail);
  return pieces;
}

// 超长句子硬切：优先落在空白 / 次级标点，且绝不切开代理对
function hardSplit(text, start, end, maxChars, push) {
  let cursor = start;
  while (end - cursor > maxChars) {
    let cut = Math.min(end, cursor + maxChars);
    if (cut < end && isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) {
      cut -= 1;
    }
    // 只在窗口后 40% 里找更自然的断点，避免切出很多几字的小段
    const floor = cursor + Math.max(1, Math.floor(maxChars * 0.6));
    let preferred = -1;
    for (let i = cut; i > floor; i -= 1) {
      const ch = text[i - 1];
      if (/\s/.test(ch) || SOFT_BREAKS.has(ch)) {
        preferred = i;
        break;
      }
    }
    if (preferred > cursor) cut = preferred;
    push(trimmedRange(text, cursor, cut));
    cursor = cut;
    // 下一段从非空白处开始，别让朗读文本以空格开头
    while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
  }
  if (cursor < end) push(trimmedRange(text, cursor, end));
}

// 把一段（可能很长）拆成若干 chunk：先按句子装，装不下再硬切
function paragraphChunks(text, para, maxChunkChars, push) {
  const pieces = sentencePieces(text, para.start, para.end);
  let chunkStart = -1;
  let chunkEnd = -1;
  const flush = () => {
    if (chunkStart < 0) return;
    const range = trimmedRange(text, chunkStart, chunkEnd);
    if (range) push(range);
    chunkStart = -1;
    chunkEnd = -1;
  };
  for (const piece of pieces) {
    if (piece.end - piece.start > maxChunkChars) {
      flush();
      hardSplit(text, piece.start, piece.end, maxChunkChars, push);
      continue;
    }
    if (chunkStart < 0) {
      chunkStart = piece.start;
      chunkEnd = piece.end;
    } else if (piece.end - chunkStart <= maxChunkChars) {
      chunkEnd = piece.end;
    } else {
      flush();
      chunkStart = piece.start;
      chunkEnd = piece.end;
    }
  }
  flush();
}

// 光标位置落在哪一段：落在两段之间算「下一段」；越界夹到首尾；空数组返回 -1
function chunkIndexAt(chunks, position) {
  if (!Array.isArray(chunks) || !chunks.length) return -1;
  const n = Number(position);
  if (!Number.isFinite(n)) return 0;
  const pos = Math.max(0, Math.floor(n));
  let lo = 0;
  let hi = chunks.length - 1;
  let answer = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < chunks[mid].end) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

// 主入口：返回 { chunks, startIndex, paragraphs, chars, totalChars, truncated, options }
function buildChunks(text, rawOptions) {
  const options = sanitizeOptions(rawOptions);
  const source = String(text == null ? '' : text);
  const normalized = normalizeText(source);
  const limit = Math.min(normalized.length, MAX_SOURCE_CHARS);
  const body = limit < normalized.length ? normalized.slice(0, limit) : normalized;

  const chunks = [];
  let truncated = limit < normalized.length;
  const paragraphs = paragraphRanges(body);
  for (const para of paragraphs) {
    if (chunks.length >= options.maxChunks) {
      truncated = true;
      break;
    }
    paragraphChunks(body, para, options.maxChunkChars, (range) => {
      if (!range) return;
      chunks.push({
        start: range.start,
        end: range.end,
        text: body.slice(range.start, range.end),
        paragraph: para.paragraph,
        line: para.line
      });
    });
  }
  if (chunks.length > options.maxChunks) {
    chunks.length = options.maxChunks;
    truncated = true;
  }

  return {
    chunks,
    startIndex: chunkIndexAt(chunks, options.caret),
    paragraphs: paragraphs.length,
    chars: normalized.length,
    totalChars: chaptersLib.countChars(normalized),
    truncated,
    options
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  OPTION_LIMITS,
  MAX_SOURCE_CHARS,
  sanitizeOptions,
  normalizeText,
  paragraphRanges,
  trimmedRange,
  sentencePieces,
  hardSplit,
  chunkIndexAt,
  buildChunks
};
