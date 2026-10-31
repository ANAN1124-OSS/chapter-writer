// 正文排版整理（纯逻辑，不依赖 Electron，可单测）。
// 设计原则：只在作者点「排版 → 整理本章」时调用，绝不自动执行；
// 只动空白、标点这类「排版层」内容，不改字词；同一份文本反复整理的结果必须一致（幂等）。
const INDENT = '\u3000\u3000'; // 段首缩进：两个全角空格（中文小说惯例）
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const FULL_PUNCT = new Set(['，', '。', '；', '：', '！', '？']);
const PUNCT_MAP = { ',': '，', '.': '。', ';': '；', ':': '：', '!': '！', '?': '？' };
const BLANK_MODES = ['keep', 'single', 'singleIndent', 'none'];
const INDENT_MODES = ['none', '0', '2'];

const DEFAULT_OPTIONS = Object.freeze({
  indent: '2',             // 段首缩进：none 不处理 / '0' 去掉缩进 / '2' 两个全角空格
  blankLines: 'single',    // 段间空行：keep 保持原样 / single 空一行 / singleIndent 空一行（含缩进）/ none 不空行
  trimTrailing: true,      // 删除每行行尾空白
  normalizePunct: true,    // 中文旁边的半角标点转全角（，。；：！？）
  removeCjkSpaces: false   // 删除中文之间的多余空格（默认关：可能影响语感）
});

// 兼容旧配置：以前 indent 是布尔值（true=缩进两格 / false=不管）
function normalizeIndentMode(raw) {
  if (typeof raw === 'boolean') return raw ? '2' : 'none';
  if (INDENT_MODES.includes(raw)) return raw;
  return DEFAULT_OPTIONS.indent;
}

function sanitizeOptions(raw) {
  const merged = { ...DEFAULT_OPTIONS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    indent: normalizeIndentMode(merged.indent),
    blankLines: BLANK_MODES.includes(merged.blankLines) ? merged.blankLines : DEFAULT_OPTIONS.blankLines,
    trimTrailing: Boolean(merged.trimTrailing),
    normalizePunct: Boolean(merged.normalizePunct),
    removeCjkSpaces: Boolean(merged.removeCjkSpaces)
  };
}

const isBlank = (line) => line.trim() === '';
const stripLeading = (line) => line.replace(/^[ \t\u3000\u00a0]+/, '');
const stripTrailing = (line) => line.replace(/[ \t\u3000\u00a0]+$/, '');

// 半角标点 → 全角：仅当旁边是中文（或已转换过的全角标点，处理「什么?!」这种连排）。
// 数字、英文缩写、URL、时间里的半角标点保持原样（3.14 / www.a.com / 12:30 / A. 开头）。
function convertPunct(text) {
  let count = 0;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const full = PUNCT_MAP[ch];
    if (!full) {
      out += ch;
      continue;
    }
    const prev = out ? out[out.length - 1] : '';
    const next = text[i + 1] || '';
    // 「...」「。。。」这类省略号连排保持原样，不逐个转换
    if (ch === '.' && (text[i - 1] === '.' || text[i + 1] === '.')) {
      out += ch;
      continue;
    }
    // 句点单独收紧：只认「中文 + .」，避免把 A. / 3.14 / www.a.com 里的点转成句号
    if (ch === '.') {
      if (!(HAN_RE.test(prev) || FULL_PUNCT.has(prev))) {
        out += ch;
        continue;
      }
      out += full;
      count += 1;
      continue;
    }
    const nearHan = HAN_RE.test(prev) || HAN_RE.test(next) || FULL_PUNCT.has(prev) || FULL_PUNCT.has(next);
    if (!nearHan) {
      out += ch;
      continue;
    }
    out += full;
    count += 1;
  }
  return { text: out, count };
}

// 删除两个中文字符之间的半角空格（缩进用的全角空格不受影响）
function removeCjkSpaces(text) {
  let count = 0;
  const out = text.replace(
    /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \u00a0]+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    (match, lead) => {
      count += 1;
      return lead;
    }
  );
  return { text: out, count };
}

function formatText(text, rawOptions) {
  const options = sanitizeOptions(rawOptions);
  const indent = options.indent;
  const stats = {
    paragraphs: 0,
    indentFixed: 0,
    trailingTrimmed: 0,
    blankCollapsed: 0,
    punctFixed: 0,
    cjkSpacesRemoved: 0
  };

  const source = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  if (isBlank(source)) {
    return { text: '', stats, changed: source !== '' };
  }

  const endsWithNewline = source.endsWith('\n');
  const paragraphs = []; // { text, gap } gap = 与上一段之间原有的空行数
  let gap = 0;

  for (const rawLine of source.split('\n')) {
    if (isBlank(rawLine)) {
      if (paragraphs.length) gap += 1;
      continue; // 开头的空行直接丢掉
    }

    let line = rawLine;
    if (options.trimTrailing) {
      const trimmed = stripTrailing(line);
      if (trimmed !== line) {
        stats.trailingTrimmed += 1;
        line = trimmed;
      }
    }

    if (indent !== 'none') {
      // '2' = 两个全角空格；'0' = 去掉原有缩进（不补空格）
      const next = (indent === '2' ? INDENT : '') + stripLeading(line);
      if (next !== line) stats.indentFixed += 1;
      line = next;
    }

    if (options.removeCjkSpaces) {
      const res = removeCjkSpaces(line);
      line = res.text;
      stats.cjkSpacesRemoved += res.count;
    }

    if (options.normalizePunct) {
      const res = convertPunct(line);
      line = res.text;
      stats.punctFixed += res.count;
    }

    paragraphs.push({ text: line, gap });
    gap = 0;
  }

  stats.paragraphs = paragraphs.length;

  // 「空一行（含缩进）」：空行里放两个全角空格，粘到会吃掉纯空行的平台也不塌；
  // 缩进设为 0 / 不处理时没有缩进可带，退化成普通空行。
  const blankLineText = indent === '2' ? INDENT : '';

  let result;
  if (!paragraphs.length) {
    result = '';
  } else if (options.blankLines === 'keep') {
    result = paragraphs[0].text;
    for (let i = 1; i < paragraphs.length; i += 1) {
      result += '\n'.repeat(paragraphs[i].gap + 1) + paragraphs[i].text;
    }
  } else {
    let separator = '\n';
    let wanted = 0;
    if (options.blankLines === 'single') {
      separator = '\n\n';
      wanted = 1;
    } else if (options.blankLines === 'singleIndent') {
      separator = `\n${blankLineText}\n`;
      wanted = 1;
    }
    for (let i = 1; i < paragraphs.length; i += 1) {
      if (paragraphs[i].gap !== wanted) stats.blankCollapsed += 1;
    }
    result = paragraphs.map((p) => p.text).join(separator);
  }

  if (endsWithNewline && result) result += '\n';

  return { text: result, stats, changed: result !== source };
}

module.exports = {
  INDENT,
  DEFAULT_OPTIONS,
  sanitizeOptions,
  formatText,
  // 供测试/预览使用
  convertPunct,
  removeCjkSpaces
};
