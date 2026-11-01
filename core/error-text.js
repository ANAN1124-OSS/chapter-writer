// 错误文案脱敏（v0.9 C-4，安全审计 C5）：主进程要把错误回给界面 / 写进诊断日志时，
// 统一走这里，避免把作者本机的绝对路径（`C:\Users\名字\...`、`D:\我的小说\某本书\第3章.txt`）、
// 控制字符、整段正文泄漏到 toast、设置面板或日志里。
//
// 设计约束（来自项目红线）：
// - **纯逻辑**：不 require electron、不读盘、不联网、不抛错；同一个输入永远同一个输出。
// - **只收窄不改写含义**：路径只保留最后一节（作者仍看得出是哪个文件 / 文件夹），
//   错误码原样保留（界面与 E2E 都按 code 分支），常见文件系统错误码额外给一句中文。
// - 日志里的正文遮罩仍由 core/logs.js 负责（连续 24 个以上汉字），这里只管「路径 + 控制字符 + 长度」。
// - URL（`https://…`）不是本机路径，一个字节都不动；相对路径（`0001-第1章.txt`、`sub\x.txt`）也不动。
const PLACEHOLDER = '…';
const MAX_MESSAGE_CHARS = 300;
const MAX_CODE_CHARS = 40;
// 界面文案不比日志，300 字足够说清「哪个文件、为什么」，再长就影响 toast 阅读。
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
// `https://…` / `http://…`：外部地址不是本机路径，先切出来保护住再处理其余部分。
const URL_SPLIT_RE = /(https?:\/\/[^\s'"<>「」（）()[\]]+)/i;
const FILE_URL_RE = /file:\/{2,3}[^\s'"<>「」（）()[\]]*/gi;
const DEVICE_PATH_RE = /\\\\\?\\[^\s'"<>|*?]+/g;
const UNC_PATH_RE = /\\\\[^\s'"<>|*?\\]+\\[^\s'"<>|*?]*/g;
const DRIVE_PATH_RE = /[A-Za-z]:[\\/][^\s'"<>|*?]*/g;
const POSIX_PATH_RE = /(^|[\s'"（(「【:：,，;；=])(\/(?:[^\s'"<>|*?/]+\/)+[^\s'"<>|*?/]*)/g;

// 常见文件系统错误码 → 一句作者看得懂的中文（英文原文只留在本机日志里）。
// 只认 Node / Electron 真实会抛的码；自定义 StorageError 的错误码不在表里，走原文（本来就是中文）。
const FS_CODE_TEXT = Object.freeze({
  ENOENT: '找不到文件或目录',
  EACCES: '没有访问权限',
  EPERM: '操作被系统拒绝（可能是只读文件或权限不足）',
  EBUSY: '文件正被别的程序占用',
  ENOSPC: '磁盘空间不足',
  EROFS: '所在的磁盘是只读的',
  EISDIR: '本来要读文件，却碰到了文件夹',
  ENOTDIR: '路径里有一段不是文件夹',
  EEXIST: '同名文件或文件夹已经存在',
  EMFILE: '打开的文件太多，请重启应用',
  ENFILE: '系统打开的文件太多，请稍后再试',
  ENAMETOOLONG: '文件名或路径太长',
  ELOOP: '路径里有循环的快捷方式',
  UNKNOWN: '系统拒绝了这次操作'
});

function safeString(value) {
  try {
    return String(value == null ? '' : value);
  } catch {
    return '[无法读取的错误信息]';
  }
}

function normalizeKeep(value) {
  const n = Math.round(Number(value));
  // 非法值 / 小于 1 一律按默认（最后一节）：保留 0 节没有实际用途，不支持
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(3, n);
}

// 一个绝对路径 → `…\最后一节`（keep=2 时保留最后两节，栈里的 `core\storage.js` 要这个）。
// 分隔符跟着原路径走（Windows 反斜杠 / POSIX 斜杠）；`..`、空段、盘符根（`C:`）都丢掉，
// 只有盘符根（`C:\`）时收成一个省略号。
function maskPath(raw, keep = 1) {
  const text = safeString(raw);
  const sep = text.includes('\\') ? '\\' : '/';
  const segments = text
    .split(/[\\/]+/)
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^[A-Za-z]:$/.test(seg));
  const kept = keep > 0 ? segments.slice(-keep) : [];
  if (!kept.length) return PLACEHOLDER;
  return `${PLACEHOLDER}${sep}${kept.join(sep)}`;
}

function redactInText(text, keep) {
  let out = text;
  // file:///C:/… / file://localhost/C:/…：本地文件的 URL 形式，当作路径处理
  out = out.replace(FILE_URL_RE, (match) =>
    maskPath(match.replace(/^file:\/{2,3}/i, '').replace(/^localhost[\\/]/i, ''), keep)
  );
  // \\?\C:\…：Windows 设备前缀，先摘掉前缀再按盘符路径处理
  out = out.replace(DEVICE_PATH_RE, (match) => maskPath(match.replace(/^\\\\\?\\/, ''), keep));
  // \\server\share\…：UNC 路径
  out = out.replace(UNC_PATH_RE, (match) => maskPath(match, keep));
  // C:\… / C:/…
  out = out.replace(DRIVE_PATH_RE, (match) => maskPath(match, keep));
  // /home/user/x：POSIX 绝对路径（至少两段，前面必须有分隔符，避免误伤 `UTF-8 / UTF-16`）
  out = out.replace(POSIX_PATH_RE, (match, lead, pathPart) => `${lead}${maskPath(pathPart, keep)}`);
  return out;
}

// 把文本里所有本机绝对路径收成「…\最后一节」。options.keep = 保留最后几节（默认 1）。
// 不抛错：传 null / 数字 / 对象都返回字符串。
function redactPaths(value, options = {}) {
  const text = safeString(value);
  if (!text) return '';
  const keep = normalizeKeep(options && typeof options === 'object' ? options.keep : undefined);
  // 先把 http(s) URL 切出来不动，剩下的片段才做路径替换
  return text
    .split(URL_SPLIT_RE)
    .map((part, index) => (index % 2 === 1 ? part : redactInText(part, keep)))
    .join('');
}

// 单行、去控制字符、压空白、限长：界面与日志共用的「干净文本」。
function cleanText(value, maxChars = MAX_MESSAGE_CHARS) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.round(Number(maxChars)) : MAX_MESSAGE_CHARS;
  let text = safeString(value);
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  text = text.replace(CONTROL_RE, '');
  text = text.replace(/\n+/g, ' ');
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > limit) {
    const rest = text.length - limit;
    text = `${text.slice(0, limit)}…[已截断 ${rest} 字]`;
  }
  return text;
}

// Node 文件系统错误的 message 形如：
//   ENOENT: no such file or directory, open 'D:\书\001.txt'
//   EPERM: operation not permitted, open 'D:\书\001.txt'
// 只取那个被引起来的路径（脱敏后），拿不到就回空串。
function fsErrorDetail(message) {
  const text = safeString(message);
  const quoted = /'([^']*)'\s*$/.exec(text);
  if (quoted && /[\\/]/.test(quoted[1])) return maskPath(quoted[1], 1);
  const syscall = /,\s*[a-z]+\s+([^\s'"]+)\s*$/.exec(text);
  if (syscall && /[\\/]/.test(syscall[1])) return maskPath(syscall[1], 1);
  return '';
}

function cleanCode(value) {
  const raw = safeString(value).trim();
  if (!raw) return '';
  const clipped = raw.slice(0, MAX_CODE_CHARS);
  return CODE_RE.test(clipped) ? clipped : '';
}

// 没有 err.code 但 message 以 `ENOENT: …` 这种「码 + 冒号」开头时，把码补回来，
// 这样仍然能给出中文提示（Node 的 fs 错误通常自带 code，这里只是兜底）。
function inferCodeFromMessage(message) {
  const match = /^\s*([A-Z][A-Z0-9_]{2,39}):/.exec(safeString(message));
  return match ? match[1] : '';
}

// 给界面看的 { code, message }：错误码原样保留（只做字符白名单），
// 常见文件系统错误码换成中文 + 最后一节文件名，其它错误只做脱敏。
function describeForUi(err) {
  const raw = readRaw(err);
  const code = cleanCode(raw.code) || cleanCode(inferCodeFromMessage(raw.message)) || 'ERROR';
  return { code, message: uiMessage(code, raw.message) };
}

function uiMessage(code, rawMessage) {
  const friendly = FS_CODE_TEXT[code];
  if (friendly) {
    const detail = fsErrorDetail(rawMessage);
    return cleanText(detail ? `${friendly}：${detail}` : friendly);
  }
  const redacted = cleanText(redactPaths(rawMessage));
  return redacted || '未知错误';
}

// 错误对象 → { code, message }（不读 stack，界面用不上）
function readRaw(err) {
  if (err == null) return { code: '', message: '' };
  if (typeof err === 'string') return { code: '', message: err };
  if (typeof err === 'object') {
    let code = '';
    let message = '';
    try {
      code = typeof err.code === 'string' ? err.code : typeof err.code === 'number' ? String(err.code) : '';
    } catch {
      code = '';
    }
    try {
      message = typeof err.message === 'string' ? err.message : safeString(err);
    } catch {
      message = '[无法读取的错误信息]';
    }
    return { code, message };
  }
  return { code: '', message: safeString(err) };
}

module.exports = {
  PLACEHOLDER,
  MAX_MESSAGE_CHARS,
  MAX_CODE_CHARS,
  FS_CODE_TEXT,
  maskPath,
  redactPaths,
  cleanText,
  fsErrorDetail,
  cleanCode,
  describeForUi
};
