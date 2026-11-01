/* IPC 参数边界（v0.9 C-5，安全审计 C2）—— 纯逻辑：不 require electron、不读盘、不联网、不依赖配置。
 *
 * 为什么要有这一层：主进程的文本类 / 查找替换 / 导出类 IPC 直接把渲染层传来的正文、查找词、
 * 替换词、当前章覆盖内容（override）、章节列表拿去跑 O(n) 甚至 O(n × 词表) 的纯计算。
 * 参数类型不对（对象当正文）、超大输入（几百 MB 字符串）、超长替换（放大成几十 GB 结果）
 * 都会把主进程拖到假死，界面看起来就像「保存不动了」。这里统一在入口处校验：
 *   · 类型不对 → 用固定错误码（BAD_TEXT / BAD_QUERY / BAD_REPLACEMENT / BAD_CHAPTERS）拒绝；
 *   · 超过上限 → TEXT_TOO_LARGE / QUERY_TOO_LARGE / REPLACEMENT_TOO_LARGE / REPLACE_TOO_LARGE；
 *   · 历史行为里「坏参数被静默忽略」的（override / range），这里同样降级（返回 null / 清洗后的值），
 *     不把本来能用的导出 / 校对变成报错。
 *
 * 上限怎么定的（正常写作绝不碰到，手误 / 恶意调用一定碰到）：
 *   · 正文 500 万字：java 一章 3 千～3 万字；整本一章导入的极端书也就百万字级；
 *   · 查找词 1 万字、替换词 1 万字：作者最多搜一句话 / 换一段话；
 *   · 替换结果 2000 万字：替换最多 5000 处（core/find.js 的 MAX_MATCHES），
 *     单次替换结果上限只防「长替换 × 多处命中」放大成天文数字；
 *   · 章节列表 20000 条：沿用 main.js 原来的截断值（Ctrl+G 只需章号 / 章名，超出部分不看）。
 *
 * 错误信息一律中文、不含任何本机路径；错误码原样回给渲染层（界面按 code 分支，见 v0.9 C-4）。
 */

const MAX_TEXT_CHARS = 5000000;
const MAX_QUERY_CHARS = 10000;
const MAX_REPLACEMENT_CHARS = 10000;
const MAX_REPLACE_OUTPUT_CHARS = 20000000;
const MAX_CHAPTER_ITEMS = 20000;
const MAX_CHAPTER_NAME_CHARS = 2000;
const MAX_ID_CHARS = 200;

const RANGE_MODES = ['all', 'volume', 'range'];

class IpcLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IpcLimitError';
    this.code = code;
  }
}

// 5000000 → '5,000,000'（不依赖 toLocaleString 的 ICU 数据，测试里输出稳定）
function formatCount(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function tooLong(label, length, max) {
  return `${label}太长（${formatCount(length)} 字，最多 ${formatCount(max)} 字）`;
}

// 返回 null = 合法；否则 { code, message }（调用方转成错误回包；纯函数便于单测）
function textProblem(text, { max = MAX_TEXT_CHARS, label = '正文' } = {}) {
  if (typeof text !== 'string') return { code: 'BAD_TEXT', message: `${label}必须是文本` };
  if (text.length > max) return { code: 'TEXT_TOO_LARGE', message: tooLong(label, text.length, max) };
  return null;
}

function queryProblem(query, { max = MAX_QUERY_CHARS, label = '查找内容' } = {}) {
  if (query == null) return null; // 和旧行为一致：没传 = 空查询（找不到，不报错）
  if (typeof query !== 'string') return { code: 'BAD_QUERY', message: `${label}必须是文本` };
  if (query.length > max) return { code: 'QUERY_TOO_LARGE', message: tooLong(label, query.length, max) };
  return null;
}

function replacementProblem(replacement, { max = MAX_REPLACEMENT_CHARS } = {}) {
  if (replacement == null) return null; // 旧行为：没传 = 空替换（等于删除）
  if (typeof replacement !== 'string') {
    return { code: 'BAD_REPLACEMENT', message: '替换内容必须是文本' };
  }
  if (replacement.length > max) {
    return { code: 'REPLACEMENT_TOO_LARGE', message: tooLong('替换内容', replacement.length, max) };
  }
  return null;
}

// 替换结果会变成多大：原文长度 + 命中数 ×（替换词长度 − 查找词长度）。
// 只估长度、不生成字符串；超过上限就拒绝，免得「一处替换一万字 × 五千处」把内存打爆。
function replaceOutputProblem(
  textLength,
  matchCount,
  queryLength,
  replacementLength,
  { max = MAX_REPLACE_OUTPUT_CHARS } = {}
) {
  const source = Math.max(0, Math.floor(Number(textLength) || 0));
  const count = Math.max(0, Math.floor(Number(matchCount) || 0));
  const query = Math.max(1, Math.floor(Number(queryLength) || 1));
  const insert = Math.max(0, Math.floor(Number(replacementLength) || 0));
  const estimate = Math.max(0, source + count * (insert - query));
  if (estimate > max) {
    return {
      code: 'REPLACE_TOO_LARGE',
      message: `替换结果太大（约 ${formatCount(estimate)} 字，最多 ${formatCount(max)} 字）；请缩短替换内容或减少替换处数`
    };
  }
  return null;
}

function raise(problem) {
  if (problem) throw new IpcLimitError(problem.code, problem.message);
}

function assertText(text, options) {
  raise(textProblem(text, options));
  return text;
}

// 查找词：null / undefined 归一成 ''（旧行为），其它非字符串拒绝；返回原字符串（保留空白，口径不变）
function assertQuery(query, options) {
  raise(queryProblem(query, options));
  return query == null ? '' : query;
}

function assertReplacement(replacement, options) {
  raise(replacementProblem(replacement, options));
  return replacement == null ? '' : replacement;
}

function assertReplaceOutput(textLength, matchCount, queryLength, replacementLength, options) {
  raise(replaceOutputProblem(textLength, matchCount, queryLength, replacementLength, options));
}

// 当前章未保存内容（override / 复制本章的 ref）：
//   旧行为是「形状不对就当没有」，这里保持降级（返回 null），只对超长正文报错（防止绕过正文上限）；
//   id 太长 / 不是字符串的字段直接丢掉（真章节 id 只有十几字节，长 id 必然匹配不到）。
function sanitizeOverride(override, { maxText = MAX_TEXT_CHARS, label = '当前章正文' } = {}) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return null;
  const clean = {};
  const text = override.text;
  if (text != null) {
    raise(textProblem(text, { max: maxText, label }));
    clean.text = text;
  }
  for (const key of ['chapterId', 'chapterFile']) {
    const value = override[key];
    if (typeof value === 'string' && value.length <= MAX_ID_CHARS) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : null;
}

// 导出范围：沿用 core/exporter.resolveExportRange 的「越界自动收紧、坏值当没传」口径，
// 这里只把对象形状归一化（非对象 = 全书；未知 mode = 全书；from/to 按数字解析，非法给 null）。
// 不抛错：历史上坏 range 就是「按全书导出」，没必要把能用的一次导出变成报错。
function sanitizeRange(range) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) return null;
  const mode = typeof range.mode === 'string' && RANGE_MODES.includes(range.mode) ? range.mode : 'all';
  const toNumber = (value) => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  let volumeId = null;
  if (typeof range.volumeId === 'string' && range.volumeId.length <= MAX_ID_CHARS) {
    volumeId = range.volumeId;
  } else if (range.volumeId == null) {
    volumeId = null;
  }
  return { mode, from: toNumber(range.from), to: toNumber(range.to), volumeId };
}

// Ctrl+G 章节列表：非数组照旧报 BAD_CHAPTERS（文案不变）；超过 20000 条只看前 20000 条；
// 每条只留 id / name（jump.js 只用这两个字段），章名限长，坏条目变成 null（jump.js 会跳过）。
function sanitizeChapterList(chapters, { max = MAX_CHAPTER_ITEMS } = {}) {
  if (!Array.isArray(chapters)) {
    throw new IpcLimitError('BAD_CHAPTERS', '章节列表格式不对');
  }
  const list = chapters.slice(0, max);
  return list.map((chapter) => {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return null;
    let id;
    let name;
    try {
      id = chapter.id;
      name = chapter.name;
    } catch {
      return null; // 带 getter 的坏对象：当成无效条目，不让整次跳章失败
    }
    const clean = {};
    if (typeof id === 'string') clean.id = id.length > MAX_ID_CHARS ? id.slice(0, MAX_ID_CHARS) : id;
    if (typeof name === 'string') {
      clean.name = name.length > MAX_CHAPTER_NAME_CHARS ? name.slice(0, MAX_CHAPTER_NAME_CHARS) : name;
    }
    return Object.keys(clean).length ? clean : null;
  });
}

// 全书查找 / 替换的 options：非对象按 {}（旧行为：没有选项就用默认），字段类型收紧
function sanitizeSearchOptions(options) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    query: assertQuery(source.query),
    caseSensitive: Boolean(source.caseSensitive)
  };
}

function sanitizeReplaceOptions(options) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    query: assertQuery(source.query),
    replacement: assertReplacement(source.replacement),
    caseSensitive: Boolean(source.caseSensitive)
  };
}

module.exports = {
  MAX_TEXT_CHARS,
  MAX_QUERY_CHARS,
  MAX_REPLACEMENT_CHARS,
  MAX_REPLACE_OUTPUT_CHARS,
  MAX_CHAPTER_ITEMS,
  MAX_CHAPTER_NAME_CHARS,
  MAX_ID_CHARS,
  RANGE_MODES,
  IpcLimitError,
  formatCount,
  textProblem,
  queryProblem,
  replacementProblem,
  replaceOutputProblem,
  assertText,
  assertQuery,
  assertReplacement,
  assertReplaceOutput,
  sanitizeOverride,
  sanitizeRange,
  sanitizeChapterList,
  sanitizeSearchOptions,
  sanitizeReplaceOptions
};
