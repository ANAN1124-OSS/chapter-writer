// 灵感箱（碎片速记）：纯逻辑 + 独立存储（书架根目录/_碎片）。
//
// 设计约束（来自提案 3.4 与项目红线）：
// - 全是普通 txt：资源管理器直接可见，不新增格式、不改 书目.json、不碰章节文件；
// - 文件名用「YYYY-MM-DD-N.txt」（本机日期 + 当天序号），新建时自动找下一个空号，绝不覆盖已有碎片；
// - 写盘一律走 core/atomic（临时文件 + fsync + rename），UTF-8 无 BOM、CRLF（记事本友好）；
// - _碎片 是书架根目录下以 _ 开头的目录，书架扫描本来就会跳过（不会当成一本书）；
// - 读取只认 _碎片 顶层的 .txt 文件名，拒绝路径穿越；超长文件/碎片明确报错，不硬塞进编辑区。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, stripBom } = require('./atomic');
const { pad2 } = require('./common');

const FRAGMENT_DIR_NAME = '_碎片';
const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d+)\.txt$/;
const MAX_TEXT_CHARS = 100000; // 单条碎片最多 10 万字（够放一整段灵感，又不会把界面卡死）
const MAX_READ_BYTES = 4 * 1024 * 1024; // 读外部手写 txt 的上限；超过只报错，不截断插入
const MAX_READ_CHARS = 200000;
const LIST_LIMIT = 300;
const PREVIEW_CHARS = 120;
const PREVIEW_READ_BYTES = 8192;

class FragmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FragmentError';
    this.code = code;
  }
}

// 本机时区的日期戳（YYYY-MM-DD）；坏日期退回「现在」，保证永远是合法文件名。
function formatDateStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const safe = d instanceof Date && Number.isFinite(d.getTime()) ? d : new Date();
  return `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}`;
}

function isValidDayStamp(stamp) {
  if (typeof stamp !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999) return false;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// 只认本应用生成的「日期-序号.txt」；手工改名的 txt 也会被列出可插入，只是没有日期/序号。
function parseFragmentName(name) {
  if (typeof name !== 'string') return null;
  const match = NAME_RE.exec(name.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isValidDayStamp(date)) return null;
  const seq = Number(match[4]);
  if (!Number.isFinite(seq) || seq < 1 || seq > 999999) return null;
  return { date, seq };
}

// 当天序号：取已有同日期碎片的最大序号 + 1（从 1 开始）。删掉的号不回收，避免和回收站里的旧文件撞名。
function nextFragmentSerial(names, stamp) {
  let max = 0;
  for (const name of Array.isArray(names) ? names : []) {
    const parsed = parseFragmentName(name);
    if (!parsed || parsed.date !== stamp) continue;
    if (parsed.seq > max) max = parsed.seq;
  }
  return max + 1;
}

function nextFragmentName(existingNames, now = new Date()) {
  const stamp = formatDateStamp(now);
  return `${stamp}-${nextFragmentSerial(existingNames, stamp)}.txt`;
}

// 写入前的清洗：去 BOM、CRLF/CR 归一成 LF、去掉首尾空白；空内容与超长明确拒绝。
function cleanFragmentText(text, { maxChars = MAX_TEXT_CHARS } = {}) {
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(1, Math.round(Number(maxChars))) : MAX_TEXT_CHARS;
  let value;
  try {
    value = String(text == null ? '' : text);
  } catch {
    value = '';
  }
  value = stripBom(value).replace(/\r\n?/g, '\n').trim();
  if (!value) {
    return { ok: false, code: 'EMPTY', message: '碎片内容是空的，写点什么再保存吧' };
  }
  if (value.length > limit) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message: `碎片太长（${value.length} 字，最多 ${limit} 字）；可以拆成两条，或先放正文里`
    };
  }
  return { ok: true, text: value, chars: countChars(value), maxChars: limit };
}

function countChars(text) {
  return String(text == null ? '' : text).replace(/\s/g, '').length;
}

// 列表里的预览：压成一行、去掉多余空白，超出加省略号。
function previewText(text, limit = PREVIEW_CHARS) {
  const oneLine = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  const max = Math.max(1, Math.round(Number(limit) || PREVIEW_CHARS));
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// 最新在前：先按修改时间倒序，时间相同再按文件名倒序（序号大的更新）。
function sortFragments(fragments) {
  return (Array.isArray(fragments) ? fragments.slice() : []).sort((a, b) => {
    const delta = (Number(b && b.mtimeMs) || 0) - (Number(a && a.mtimeMs) || 0);
    if (delta) return delta;
    return String((b && b.name) || '').localeCompare(String((a && a.name) || ''), 'zh-Hans-CN');
  });
}

function assertFragmentName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (
    !name ||
    name !== path.basename(name) ||
    name.startsWith('.') ||
    !/\.txt$/i.test(name) ||
    /[\\/:*?"<>|]/.test(name)
  ) {
    throw new FragmentError('BAD_NAME', '碎片文件名不合法');
  }
  return name;
}

function fragmentDir(booksRoot) {
  const root = String(booksRoot == null ? '' : booksRoot).trim();
  if (!root) throw new FragmentError('BAD_ROOT', '书架目录未设置');
  return path.join(root, FRAGMENT_DIR_NAME);
}

async function listTxtNames(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    if (err.code === 'ENOTDIR') {
      throw new FragmentError('BAD_DIR', '_碎片 不是一个文件夹，请先在资源管理器里检查');
    }
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.txt$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readPreview(filePath, size) {
  const length = Math.max(0, Math.min(Number(size) || 0, PREVIEW_READ_BYTES));
  if (!length) return { preview: '', text: '' };
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    let text = stripBom(buffer.subarray(0, bytesRead).toString('utf8')).replace(/\r\n?/g, '\n');
    // 截断可能切在 UTF-8 字符中间：末尾的替换字符不属于正文，预览里去掉。
    text = text.replace(/\uFFFD+$/, '');
    return { preview: previewText(text), text };
  } catch {
    return { preview: '', text: '' };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

function createFragmentStore(booksRoot) {
  const dir = fragmentDir(booksRoot);
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  // 列表：_碎片 顶层所有 .txt（含用户自己放进去的 txt），最新在前，最多 LIST_LIMIT 条。
  // 目录不存在 = 空列表，绝不因为列表动作创建文件夹。
  async function list() {
    const names = await listTxtNames(dir);
    const fragments = [];
    for (const name of names) {
      const filePath = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue; // 刚好被移走/占用：跳过，不影响其它碎片
      }
      if (!stat.isFile()) continue;
      const preview = await readPreview(filePath, stat.size);
      const parsed = parseFragmentName(name);
      fragments.push({
        name,
        date: parsed ? parsed.date : null,
        seq: parsed ? parsed.seq : null,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        preview: preview.preview
      });
    }
    const sorted = sortFragments(fragments);
    return {
      dir,
      total: sorted.length,
      truncated: sorted.length > LIST_LIMIT,
      fragments: sorted.slice(0, LIST_LIMIT)
    };
  }

  // 新建：内容非空、长度受控；文件名当天递增；写盘前再确认一次不重名（双保险，绝不覆盖旧碎片）。
  function create(text, { now = new Date(), maxChars = MAX_TEXT_CHARS } = {}) {
    return enqueue(async () => {
      const cleaned = cleanFragmentText(text, { maxChars });
      if (!cleaned.ok) throw new FragmentError(cleaned.code, cleaned.message);
      const names = await listTxtNames(dir);
      const stamp = formatDateStamp(now);
      const name = nextFragmentName(names, now);
      const target = path.join(dir, name);
      // 双保险：同进程写入已串行、序号取最大 + 1；这里再确认一次目标不存在，绝不覆盖旧碎片。
      try {
        await fs.stat(target);
        throw new FragmentError('NAME_CONFLICT', '同名碎片已存在，请再点一次保存');
      } catch (err) {
        if (err instanceof FragmentError) throw err;
        if (err.code !== 'ENOENT') throw err;
      }
      const diskText = cleaned.text.replace(/\n/g, '\r\n');
      await atomicWriteFile(target, diskText);
      const stat = await fs.stat(target);
      return {
        dir,
        name,
        path: target,
        date: stamp,
        chars: cleaned.chars,
        length: cleaned.text.length,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs
      };
    });
  }

  // 读取一条碎片：只认 _碎片 顶层的 .txt，拒绝路径穿越；统一成 LF 给编辑区用。
  async function read(rawName) {
    const name = assertFragmentName(rawName);
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new FragmentError('NOT_FOUND', '这条碎片已经不在 _碎片 文件夹里了');
      throw err;
    }
    if (!stat.isFile()) throw new FragmentError('NOT_FOUND', '这条碎片已经不在 _碎片 文件夹里了');
    if (stat.size > MAX_READ_BYTES) {
      throw new FragmentError('TOO_LARGE', '碎片文件太大（超过 4MB），请先在记事本里拆分');
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const text = stripBom(raw).replace(/\r\n?/g, '\n');
    if (text.length > MAX_READ_CHARS) {
      throw new FragmentError('TOO_LARGE', `碎片太长（${text.length} 字），请先拆分再插入`);
    }
    return { name, text, chars: countChars(text), size: stat.size, mtimeMs: stat.mtimeMs };
  }

  return { dir, list, create, read };
}

module.exports = {
  FRAGMENT_DIR_NAME,
  MAX_TEXT_CHARS,
  MAX_READ_BYTES,
  MAX_READ_CHARS,
  LIST_LIMIT,
  FragmentError,
  formatDateStamp,
  isValidDayStamp,
  parseFragmentName,
  nextFragmentSerial,
  nextFragmentName,
  cleanFragmentText,
  countChars,
  previewText,
  sortFragments,
  assertFragmentName,
  fragmentDir,
  createFragmentStore
};
