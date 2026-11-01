// 校对词表（自定义错别字 / 禁用词）——纯逻辑 + 词表读取，不依赖 Electron，可单测。
//
// 设计（提案 N6，参考墨者 / 番茄的「自定义词表」；复用敏感词预检的读取与提示思路）：
//   · 词表完全归作者：应用**不内置任何词表**，只按作者在设置里选的 txt 做字面匹配
//   · 每行一个词；也可以写「错词 → 建议」，箭头认 => / -> / → 三种（建议只用于显示，
//     应用绝不替作者改字）；没有建议就是纯禁用词
//   · # 开头的行是注释（方便分组 / 写说明）；空行忽略；同一个词重复出现只算第一次
//   · 只报告命中位置与建议，绝不改正文、绝不写盘；词表本身只读、不复制、不改写
//   · 单行超过 100 字 / 词表超过 4MB / 超过 5000 个词都明确告知（跳过或截断）
//   · 字面匹配、区分大小写（不做正则、不做大小写折叠，避免作者以为「没命中」）
//
// 定位约定：index / length 都是「把 CRLF 归一成 \n、去掉 BOM」之后的字符位置，
// 与编辑区 textarea 的 value 一致，因此可以直接 setSelectionRange。
const fs = require('node:fs/promises');
const path = require('node:path');
const txtLib = require('./txt');
const errorText = require('./error-text');

// 词表文件上限：再大就不像「每行一个词」的词表了，读进来只会拖慢整本检查
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// 最多取前 5000 个词；超出部分不读，但会明确告诉作者（truncated）
const MAX_ENTRIES = 5000;
// 单行超过 100 字基本是误粘进来的正文，跳过并统计，不参与匹配
const MAX_TERM_LENGTH = 100;
// 建议文字同样限长（只用于显示，长到离谱的建议没有意义）
const MAX_SUGGESTION_LENGTH = 100;
// 单次扫描最多收集多少条原始命中（防止词表里混进「的」这类超高频字把内存打爆）
const RAW_MATCH_LIMIT = 100000;
// 建议箭头的写法（顺序无所谓，取最先出现的那个）
const ARROWS = ['=>', '->', '→'];

// 和 storage.loadChapterText / 编辑区保持一致：去掉 BOM、CRLF 归一成 LF
function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

// 一行 → { term, suggestion }：取最先出现的箭头切开；没有箭头就是纯词
function splitLine(line) {
  let cut = -1;
  let arrow = '';
  for (const token of ARROWS) {
    const at = line.indexOf(token);
    if (at >= 0 && (cut < 0 || at < cut)) {
      cut = at;
      arrow = token;
    }
  }
  if (cut < 0) return { term: line.trim(), suggestion: '' };
  return {
    term: line.slice(0, cut).trim(),
    suggestion: line.slice(cut + arrow.length).trim()
  };
}

// 词表文本 → { entries, stats }。只做「每行一个词 / 可选建议」这一件事：
// 空行与注释忽略、重复只留一次、超长行跳过；超过 MAX_ENTRIES 后不再读（truncated）。
function parseGlossary(text) {
  const source = normalizeText(text);
  const lines = source.split('\n');
  const entries = [];
  const seen = new Set();
  const stats = {
    lines: lines.length,
    emptyLines: 0,
    comments: 0,
    duplicates: 0,
    invalid: 0,
    tooLong: 0,
    suggestions: 0,
    truncated: false
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      stats.emptyLines += 1;
      continue;
    }
    if (line.startsWith('#')) {
      stats.comments += 1;
      continue;
    }
    const parsed = splitLine(line);
    if (!parsed.term) {
      stats.invalid += 1;
      continue;
    }
    if (parsed.term.length > MAX_TERM_LENGTH || parsed.suggestion.length > MAX_SUGGESTION_LENGTH) {
      stats.tooLong += 1;
      continue;
    }
    if (seen.has(parsed.term)) {
      stats.duplicates += 1;
      continue;
    }
    if (entries.length >= MAX_ENTRIES) {
      stats.truncated = true;
      break;
    }
    seen.add(parsed.term);
    entries.push({ term: parsed.term, suggestion: parsed.suggestion });
    if (parsed.suggestion) stats.suggestions += 1;
  }
  return { entries, stats };
}

// 渲染层 / 旧调用方传进来的词数组也兜底：清洗词、建议、去重、限长与数量。
// 除了 { term, suggestion } 对象，也接受纯字符串（等价于没有建议）。
function sanitizeEntries(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    let term = '';
    let suggestion = '';
    if (typeof item === 'string') {
      term = item.trim();
    } else if (item && typeof item === 'object') {
      term = typeof item.term === 'string' ? item.term.trim() : '';
      suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';
    }
    if (!term || term.length > MAX_TERM_LENGTH || seen.has(term)) continue;
    if (suggestion.length > MAX_SUGGESTION_LENGTH) suggestion = '';
    seen.add(term);
    out.push({ term, suggestion });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// 词表字节 → { ok, entries, stats } 或 { ok:false, code, message }。
// 编码复用 txt.decodeBuffer（UTF-8 / UTF-16 BOM / GB18030），并额外识别两种「不是纯文本」：
// 带 NUL 的二进制、解码出替换字符 U+FFFD 的坏编码。
function decodeGlossaryBuffer(buffer) {
  if (!buffer || !buffer.length) {
    return {
      ok: false,
      code: 'GLOSSARY_EMPTY',
      message: '词表是空文件（每行一个词，可写「错词 → 建议」）'
    };
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: 'GLOSSARY_TOO_BIG',
      message: '词表文件太大（上限 4MB），请换一个小一点的 txt'
    };
  }
  const hasUtf16Bom =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
  if (!hasUtf16Bom && buffer.includes(0)) {
    return {
      ok: false,
      code: 'GLOSSARY_BAD_ENCODING',
      message: '词表不像是纯文本（检测到二进制内容），请用 UTF-8 / UTF-16 / GBK 编码的 txt'
    };
  }
  const text = txtLib.decodeBuffer(buffer);
  if (text.includes('\uFFFD')) {
    return {
      ok: false,
      code: 'GLOSSARY_BAD_ENCODING',
      message: '词表编码无法识别（不是 UTF-8 / UTF-16 / GBK 文本），请另存为 UTF-8 的 txt'
    };
  }
  const parsed = parseGlossary(text);
  if (!parsed.entries.length) {
    return {
      ok: false,
      code: 'GLOSSARY_EMPTY',
      message: '词表里没有有效的词（每行一个词，空行和 # 注释会被忽略）'
    };
  }
  return { ok: true, entries: parsed.entries, stats: parsed.stats };
}

// 读词表文件（只读）。任何失败都返回结构化结果，由界面给出明确提示，不抛异常。
async function readGlossaryFile(filePath) {
  const rawPath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!rawPath) {
    return {
      ok: false,
      configured: false,
      code: 'GLOSSARY_NOT_CONFIGURED',
      message: '还没有指定校对词表（应用不内置词表；没有词表时只跑内置的五条规则）',
      path: '',
      name: '',
      count: 0
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
      code: missing ? 'GLOSSARY_MISSING' : 'GLOSSARY_UNREADABLE',
      message: missing
        ? `词表文件不存在：${errorText.maskPath(resolved)}（可能被移动或删除了，请重新选择）`
        : `读不了词表文件：${errorText.describeForUi(err).message}`
    };
  }
  if (!stat.isFile()) {
    return {
      ...base,
      ok: false,
      code: 'GLOSSARY_NOT_FILE',
      message: '选中的不是一个文件，请选校对词表 txt'
    };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ...base,
      ok: false,
      size: stat.size,
      code: 'GLOSSARY_TOO_BIG',
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
      code: 'GLOSSARY_UNREADABLE',
      message: `读不了词表文件：${errorText.describeForUi(err).message}`
    };
  }
  const decoded = decodeGlossaryBuffer(buffer);
  if (!decoded.ok) return { ...base, size: stat.size, ...decoded };
  return { ...base, ok: true, size: stat.size, entries: decoded.entries, stats: decoded.stats };
}

// 只给渲染层的词表信息：绝不把词表正文（entries）带过去，界面只需要数量与状态。
// 命中结果里仍会带命中词与建议（那是作者要看的），和整个词表不是一回事。
function publicGlossaryInfo(list) {
  if (!list || typeof list !== 'object') {
    return {
      ok: false,
      configured: false,
      code: 'GLOSSARY_NOT_CONFIGURED',
      message: '还没有指定校对词表',
      path: '',
      name: '',
      count: 0
    };
  }
  const { entries, ...rest } = list;
  return { ...rest, count: Array.isArray(entries) ? entries.length : 0 };
}

// 扫描一段正文：字面量找每个词的全部出现位置，同一处重叠时只留最长的那个
// （和敏感词预检同一套去重规则）。返回 { hits, truncated, entryCount }。
// hits 是 { term, suggestion, index, length }，按位置排序，可直接 setSelectionRange。
function findHits(text, rawEntries) {
  const entries = sanitizeEntries(rawEntries);
  const source = normalizeText(text);
  const raw = [];
  let limitHit = false;
  for (const entry of entries) {
    let from = 0;
    for (;;) {
      const index = source.indexOf(entry.term, from);
      if (index < 0) break;
      if (raw.length >= RAW_MATCH_LIMIT) {
        limitHit = true;
        break;
      }
      raw.push({ term: entry.term, suggestion: entry.suggestion, index });
      from = index + 1; // +1 而不是 +term.length：重叠命中先全收下，再统一去重
    }
    if (limitHit) break;
  }

  // 按位置排；同一个起点有多个词时先看长的
  raw.sort(
    (a, b) =>
      a.index - b.index ||
      b.term.length - a.term.length ||
      (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)
  );
  const hits = [];
  let lastEnd = -1;
  for (const hit of raw) {
    if (hit.index < lastEnd) continue; // 和已经报过的那一处重叠，跳过
    hits.push({
      term: hit.term,
      suggestion: hit.suggestion,
      index: hit.index,
      length: hit.term.length
    });
    lastEnd = hit.index + hit.term.length;
  }
  return { hits, truncated: limitHit, entryCount: entries.length };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_ENTRIES,
  MAX_TERM_LENGTH,
  MAX_SUGGESTION_LENGTH,
  RAW_MATCH_LIMIT,
  normalizeText,
  parseGlossary,
  sanitizeEntries,
  decodeGlossaryBuffer,
  readGlossaryFile,
  publicGlossaryInfo,
  findHits
};
