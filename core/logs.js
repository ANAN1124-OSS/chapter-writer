// 崩溃 / 错误日志（提案 7.4）：主进程异常、未处理的 Promise、IPC 错误、保存失败写进
// 应用配置目录的 logs/，方便排查「保存失败」类反馈。
//
// 设计约束（来自提案与项目红线）：
// - 只记元数据：时间、级别、类型、错误码、IPC 频道、路径、应用版本、pid、栈。
//   **绝不写正文**：调用方只传这些字段；message / stack 里还会把连续 24 个以上的汉字
//   当成正文隐去（错误信息、路径、栈里正常不会出现这么长的连续汉字）。
// - **不写本机完整路径**（v0.9 C-4，安全审计 C5）：message / stack 里的绝对路径统一收成
//   `…\最后一节`（栈保留最后两节，`…\core\storage.js` 仍看得懂是哪一行），
//   本机用户名 / 书架上级目录 / 章节所在书的完整位置都不会落进日志。
//   路径字段（path）只收调用方显式给出的「书相对」信息，不在这里做二次改写。
// - 写日志永远吞掉错误：日志目录没权限、磁盘满、被别的程序占用都不能影响正文保存与界面。
// - 按天 + 按大小滚动：每天一个 chapter-writer-YYYY-MM-DD[.N].log，单份超过上限就换下一个
//   序号；只保留最近 12 份（旧的按文件名里的日期 / 序号删，不碰别的文件）。
// - 追加写：同一队列串行，打开文件后用一次 write + fsync，不会把已有条目写坏。
// - 不读也不写 config.json，旧配置一键照常启动；日志只存在 %APPDATA%\chapter-writer\logs。
const fs = require('node:fs/promises');
const path = require('node:path');
const errorText = require('./error-text');

const LOG_DIR_NAME = 'logs';
const FILE_PREFIX = 'chapter-writer';
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 12;
const MAX_INDEX = 999;
const MAX_MESSAGE_CHARS = 400;
const MAX_PATH_CHARS = 320;
const MAX_STACK_LINES = 20;
const MAX_STACK_LINE_CHARS = 320;
const MAX_STACK_CHARS = 4000;
// 连续这么多个汉字几乎不可能是错误信息 / 路径，按「正文」隐去（防手滑把正文拼进错误信息）。
const CJK_RUN = 24;
// 同一个错误一秒内可能抛很多次（渲染进程崩溃循环等），5 秒内同样的内容只记一条。
const DEDUPE_WINDOW_MS = 5000;

const LEVELS = new Set(['error', 'warn', 'info']);
const KIND_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,59}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const CHANNEL_RE = /^[A-Za-z0-9:_-]{1,60}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{0,24}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CJK_RE = new RegExp(`[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]{${CJK_RUN},}`, 'g');
const LOG_NAME_RE = /^chapter-writer-(\d{4}-\d{2}-\d{2})(?:\.(\d{1,3}))?\.log$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(value, fallback = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const safeFallback = fallback instanceof Date && Number.isFinite(fallback.getTime()) ? fallback : new Date();
  return safeFallback;
}

// 本机时区的日期键（和每日统计同口径，跨过午夜就换新文件）
function localDayKey(date = new Date()) {
  const d = toDate(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isValidDayKey(key) {
  if (typeof key !== 'string') return false;
  const match = DAY_RE.exec(key.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999) return false;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// 2026-11-01 02:15:03.123 +08:00（本地时间 + 时区偏移，作者直接看得懂）
function formatTime(date) {
  const d = toDate(date);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')} ` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

function fileNameForDay(day, index = 1) {
  const key = isValidDayKey(day) ? day.trim() : localDayKey();
  const n = Math.min(MAX_INDEX, Math.max(1, Math.round(Number(index)) || 1));
  return n === 1 ? `${FILE_PREFIX}-${key}.log` : `${FILE_PREFIX}-${key}.${n}.log`;
}

// 只认本应用生成的日志文件名；别的文件（作者的备注、旧的 debug.txt）一律不碰。
function parseLogFileName(name) {
  const text = typeof name === 'string' ? name : '';
  const match = LOG_NAME_RE.exec(text);
  if (!match) return null;
  const day = match[1];
  if (!isValidDayKey(day)) return null;
  const index = match[2] ? Number(match[2]) : 1;
  if (!Number.isFinite(index) || index < 1 || index > MAX_INDEX) return null;
  return { name: text, day, index };
}

function maskLongCjk(text) {
  return String(text == null ? '' : text).replace(CJK_RE, (run) => `[正文已隐藏 ${run.length} 字]`);
}

function safeString(value) {
  try {
    return String(value == null ? '' : value);
  } catch {
    return '[无法读取的错误信息]';
  }
}

function sanitizeToken(value, pattern, fallback = '') {
  const raw = safeString(value).trim();
  if (!raw) return fallback;
  const clipped = raw.slice(0, 80);
  return pattern.test(clipped) ? clipped : fallback;
}

function sanitizePid(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2147483647) : 0;
}

// message：单行、去控制字符、隐去长串汉字、隐去本机绝对路径、限制长度。
// 正文不会出现在这里（调用方只传错误信息）。
function sanitizeMessage(value) {
  let text = typeof value === 'string' ? value : safeString(value);
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  text = text.replace(CONTROL_RE, '');
  text = text.replace(/\n+/g, ' ');
  text = maskLongCjk(text);
  text = errorText.redactPaths(text);
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > MAX_MESSAGE_CHARS) {
    const rest = text.length - MAX_MESSAGE_CHARS;
    text = `${text.slice(0, MAX_MESSAGE_CHARS)}…[已截断 ${rest} 字]`;
  }
  return text;
}

function sanitizePath(value) {
  let text = safeString(value).replace(/[\r\n\t]+/g, ' ');
  text = text.replace(CONTROL_RE, '').trim();
  if (!text) return '';
  return text.length > MAX_PATH_CHARS ? `${text.slice(0, MAX_PATH_CHARS)}…` : text;
}

function sanitizeStack(value) {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value.join('\n') : '';
  if (!raw) return [];
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(CONTROL_RE, '').trim())
    .filter((line) => line.trim())
    .slice(0, MAX_STACK_LINES)
    .map((line) => {
      // 栈里保留最后两节（`…\core\storage.js:395:11`）：够定位文件，又不会把本机目录写进日志
      const masked = errorText.redactPaths(maskLongCjk(line), { keep: 2 });
      return masked.length > MAX_STACK_LINE_CHARS ? `${masked.slice(0, MAX_STACK_LINE_CHARS)}…` : masked;
    });
  // 总量兜底：栈再长也不能把日志撑大
  const out = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > MAX_STACK_CHARS) break;
    out.push(line);
    total += line.length + 1;
  }
  return out;
}

// 把任意错误对象（Error / 字符串 / 随便什么 rejection 值）变成可记录的三个字段。
function describeError(err) {
  if (err == null) return { code: '', message: '', stack: '' };
  if (typeof err === 'string') return { code: '', message: err, stack: '' };
  if (typeof err === 'object') {
    let message = '';
    let stack = '';
    let code = '';
    try { message = typeof err.message === 'string' ? err.message : safeString(err); } catch { message = '[无法读取的错误信息]'; }
    try { stack = typeof err.stack === 'string' ? err.stack : ''; } catch { stack = ''; }
    try { code = typeof err.code === 'string' ? err.code : typeof err.code === 'number' ? String(err.code) : ''; } catch { code = ''; }
    return { code, message, stack };
  }
  return { code: '', message: safeString(err), stack: '' };
}

function sanitizeEntry(raw, now = new Date()) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = toDate(now);
  const time = toDate(src.time, fallback);
  const levelRaw = safeString(src.level).trim().toLowerCase();
  return {
    time,
    day: localDayKey(time),
    level: LEVELS.has(levelRaw) ? levelRaw : 'error',
    kind: sanitizeToken(src.kind, KIND_RE, 'unknown'),
    code: sanitizeToken(src.code, CODE_RE, ''),
    channel: sanitizeToken(src.channel, CHANNEL_RE, ''),
    path: sanitizePath(src.path),
    message: sanitizeMessage(src.message),
    stack: sanitizeStack(src.stack),
    pid: sanitizePid(src.pid),
    app: sanitizeToken(src.app, VERSION_RE, '')
  };
}

// 一条日志 = 一行头 + 可选 path / message / stack，条目之间空一行；记事本直接看得懂。
function renderEntry(entry) {
  const head = [formatTime(entry.time), String(entry.level || 'error').toUpperCase(), entry.kind || 'unknown'];
  if (entry.code) head.push(`code=${entry.code}`);
  if (entry.channel) head.push(`channel=${entry.channel}`);
  if (entry.pid) head.push(`pid=${entry.pid}`);
  if (entry.app) head.push(`app=${entry.app}`);
  const lines = [head.join(' ')];
  if (entry.path) lines.push(`  path: ${entry.path}`);
  if (entry.message) lines.push(`  message: ${entry.message}`);
  if (Array.isArray(entry.stack) && entry.stack.length) {
    lines.push('  stack:');
    for (const line of entry.stack) lines.push(`    ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function formatEntry(raw, now = new Date()) {
  return renderEntry(sanitizeEntry(raw, now));
}

function compareLogFiles(a, b) {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return a.index - b.index;
}

function normalizeLimits({ maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const bytes = Math.round(Number(maxFileBytes));
  const files = Math.round(Number(maxFiles));
  return {
    // 大小上限 0 / 负数 / 非数字都当没配（用默认 256KB）；配得太小按 256 字节兜底。
    maxFileBytes: Number.isFinite(bytes) && bytes > 0
      ? Math.min(64 * 1024 * 1024, Math.max(256, bytes))
      : DEFAULT_MAX_FILE_BYTES,
    // 保留份数至少 1 份，避免把刚写的日志自己删掉。
    maxFiles: Number.isFinite(files) ? Math.min(500, Math.max(1, files)) : DEFAULT_MAX_FILES
  };
}

// 今天是哪个文件：先用没超大小的最后一份；当天都满了就开下一个序号（上限 999）。
function chooseLogFile(files, { now = new Date(), maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const day = localDayKey(now);
  const limit = normalizeLimits({ maxFileBytes }).maxFileBytes;
  const todays = (Array.isArray(files) ? files : [])
    .filter((file) => file && file.day === day && Number.isFinite(Number(file.index)))
    .sort(compareLogFiles);
  const usable = todays.filter((file) => Number(file.size) < limit);
  if (usable.length) return usable[usable.length - 1].name || fileNameForDay(day, usable[usable.length - 1].index);
  const nextIndex = todays.length ? Math.min(MAX_INDEX, todays[todays.length - 1].index + 1) : 1;
  return fileNameForDay(day, nextIndex);
}

// 只保留最新 maxFiles 份（按文件名里的日期 + 序号），返回要删的文件名。
// 文件名解析不出来的一律不动（作者自己放进日志目录的东西不能被日志滚动删掉）。
function planPrune(files, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  const keep = normalizeLimits({ maxFiles }).maxFiles;
  const known = (Array.isArray(files) ? files : [])
    .map((file) => (file && typeof file.name === 'string' ? parseLogFileName(file.name) : null))
    .filter(Boolean)
    .sort(compareLogFiles);
  if (known.length <= keep) return [];
  return known.slice(0, known.length - keep).map((file) => file.name);
}

// 日志目录里的文件清单（只认本应用的日志文件；读不到就当空目录）
async function listLogFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const parsed = parseLogFileName(name);
    if (!parsed) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      if (!stat.isFile()) continue;
      out.push({ ...parsed, size: stat.size });
    } catch {
      /* 正在被别的程序占用 / 刚被删：跳过 */
    }
  }
  return out;
}

// 日志写入器：所有方法都不会抛错，写失败只返回 { ok:false }。
// baseDir 传 app.getPath('userData')，日志落在 baseDir/logs。
function createLogStore(baseDir, options = {}) {
  const dir = options.dir
    ? path.resolve(String(options.dir))
    : path.join(path.resolve(String(baseDir == null ? '' : baseDir)), LOG_DIR_NAME);
  const limits = normalizeLimits(options);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  let queue = Promise.resolve();
  let lastSignature = '';
  let lastSignatureAt = 0;
  const counters = { written: 0, failed: 0, suppressed: 0, pruned: 0 };

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function append(text, time) {
    await fs.mkdir(dir, { recursive: true });
    const files = await listLogFiles(dir);
    const name = chooseLogFile(files, { now: time, maxFileBytes: limits.maxFileBytes });
    const filePath = path.join(dir, name);
    // 追加：一次 write + fsync，已有条目不会被截断 / 重写。
    const handle = await fs.open(filePath, 'a');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      try { await handle.close(); } catch { /* 忽略 */ }
    }
    const after = files.some((file) => file.name === name)
      ? files
      : files.concat([{ ...(parseLogFileName(name) || { day: localDayKey(time), index: 1 }), name, size: 0 }]);
    const remove = planPrune(after, { maxFiles: limits.maxFiles });
    for (const old of remove) {
      try {
        await fs.unlink(path.join(dir, old));
        counters.pruned += 1;
      } catch { /* 删不掉就留着，下次再试 */ }
    }
    return { file: name, pruned: remove };
  }

  function write(raw) {
    return enqueue(async () => {
      try {
        const now = toDate(clock());
        const entry = sanitizeEntry(raw, now);
        const signature = `${entry.level}|${entry.kind}|${entry.code}|${entry.message}`;
        const stamp = entry.time.getTime();
        if (signature === lastSignature && stamp - lastSignatureAt < DEDUPE_WINDOW_MS) {
          counters.suppressed += 1;
          return { ok: true, suppressed: true, file: null, pruned: [] };
        }
        lastSignature = signature;
        lastSignatureAt = stamp;
        const written = await append(renderEntry(entry), entry.time);
        counters.written += 1;
        return { ok: true, suppressed: false, file: written.file, pruned: written.pruned };
      } catch (err) {
        counters.failed += 1;
        return {
          ok: false,
          code: (err && err.code) || 'ERROR',
          message: sanitizeMessage(err && err.message ? err.message : err),
          file: null,
          pruned: []
        };
      }
    });
  }

  // 设置弹层 / 自检用：日志目录、文件清单（新→旧）、总大小；读失败也不抛。
  async function info() {
    try {
      const files = (await listLogFiles(dir)).sort(compareLogFiles).reverse();
      return {
        dir,
        files: files.map((file) => ({ name: file.name, day: file.day, index: file.index, bytes: file.size })),
        totalBytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
        latest: files.length ? files[0].name : null,
        limits: { ...limits }
      };
    } catch {
      return { dir, files: [], totalBytes: 0, latest: null, limits: { ...limits } };
    }
  }

  async function flush() {
    await queue;
  }

  return {
    dir,
    write,
    info,
    flush,
    limits: { ...limits },
    counters: () => ({ ...counters })
  };
}

module.exports = {
  LOG_DIR_NAME,
  FILE_PREFIX,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  MAX_INDEX,
  MAX_MESSAGE_CHARS,
  MAX_PATH_CHARS,
  MAX_STACK_CHARS,
  MAX_STACK_LINE_CHARS,
  MAX_STACK_LINES,
  CJK_RUN,
  DEDUPE_WINDOW_MS,
  localDayKey,
  isValidDayKey,
  formatTime,
  fileNameForDay,
  parseLogFileName,
  maskLongCjk,
  sanitizeMessage,
  sanitizePath,
  sanitizeStack,
  sanitizeEntry,
  describeError,
  renderEntry,
  formatEntry,
  chooseLogFile,
  planPrune,
  listLogFiles,
  createLogStore
};
