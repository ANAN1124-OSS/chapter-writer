// 自动更新轻量版（提案 7.1）：只做「检查更新 → 提示有新版本 → 打开 GitHub Release 下载页」。
//
// 设计约束（来自提案与项目红线）：
// - **不下载、不安装、不做静默更新、不碰代码签名**：只比较版本号，然后交给浏览器打开下载页。
// - **不写任何文件**：不写 config.json、不写书库、不生成 _trash；检查结果只存在内存里。
// - 网络失败 / 没网 / 超时 / GitHub 限流都返回结构化错误 + 一句中文提示，**绝不抛错、不影响写作**。
// - 不引入运行时依赖：主进程用 Electron 内置的 net.fetch，本模块自己解析版本号与 GitHub JSON。
// - 只认本仓库的 Release 链接：打开前再校验一次域名与路径，渲染层不能传任意 URL 进来。
// - 纯 Node、可单测：网络请求由调用方注入 fetchText，单测不会真连 GitHub。

const REPO_OWNER = 'ANAN1124-OSS';
const REPO_NAME = 'chapter-writer';
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const RELEASES_URL = `${REPO_URL}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_TAG_CHARS = 64;
const MAX_NAME_CHARS = 160;
const MAX_VERSION_TEXT_CHARS = 64;

const NUMERIC_PART_RE = /^\d{1,9}$/;
const PRERELEASE_ID_RE = /^[0-9A-Za-z-]{1,20}$/;
const TAG_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

const MESSAGES = {
  NETWORK: '连不上 GitHub（可能没联网，或被代理 / 防火墙拦住），不影响写作，稍后再试',
  TIMEOUT: '检查超时（网络太慢），不影响写作，稍后再试',
  RATE_LIMIT: 'GitHub 说请求太频繁，请过一会儿再试',
  NO_RELEASE: 'GitHub 上还没有发布版本（或仓库暂时不可用）',
  BAD_RESPONSE: '更新信息格式不对（可能被网络代理改过）',
  BAD_JSON: '更新信息格式不对（可能被网络代理改过）',
  TOO_LARGE: '更新信息太大，已忽略',
  BAD_RELEASE: '更新信息里没有可用的版本号',
  BAD_CURRENT: '当前版本号读不出来，无法比较',
  UNEXPECTED: '检查更新失败，不影响写作，稍后再试'
};

function httpMessage(status) {
  const code = Number(status) || 0;
  if (code >= 500) return `GitHub 暂时不可用（HTTP ${code}），稍后再试`;
  return `GitHub 返回 HTTP ${code}，稍后再试`;
}

// 版本号：接受 0.4.1 / v0.4.1 / 0.4 / 0.5.0-beta.1，忽略 +build 元数据。
// 只用于「比较新旧」，不会拿它做任何文件名 / 路径。
function parseVersion(raw) {
  let text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > MAX_VERSION_TEXT_CHARS) return null;
  if (text[0] === 'v' || text[0] === 'V') text = text.slice(1);
  const plus = text.indexOf('+');
  if (plus >= 0) {
    const build = text.slice(plus + 1);
    // 空 build 元数据 / 多个 + 都不是合法版本号（0.5.0+ / 0.5.0+a+b）
    if (!build || build.includes('+')) return null;
    text = text.slice(0, plus);
  }
  const dash = text.indexOf('-');
  const coreText = dash >= 0 ? text.slice(0, dash) : text;
  const preText = dash >= 0 ? text.slice(dash + 1) : '';
  if (dash >= 0 && (!preText || preText.includes('+'))) return null;
  const parts = coreText.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = [0, 0, 0];
  for (let i = 0; i < parts.length; i += 1) {
    if (!NUMERIC_PART_RE.test(parts[i])) return null;
    nums[i] = Number(parts[i]);
  }
  const prerelease = [];
  if (preText) {
    if (preText.length > 40) return null;
    const ids = preText.split('.');
    if (ids.length > 8) return null;
    for (const id of ids) {
      if (!PRERELEASE_ID_RE.test(id)) return null;
      prerelease.push(id);
    }
  }
  const suffix = prerelease.length ? `-${prerelease.join('.')}` : '';
  return {
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    prerelease,
    text: `${nums[0]}.${nums[1]}.${nums[2]}${suffix}`
  };
}

function asParsedVersion(value) {
  if (value && typeof value === 'object' && Array.isArray(value.prerelease)) return value;
  return parseVersion(value);
}

// 按 semver 的优先级比较：正式版 > 同号预发布版；数字标识按数值、字母标识按 ASCII。
// 解析失败返回 null（调用方自己决定怎么兜底），不会把坏版本号当成「更新」。
function compareVersions(a, b) {
  const left = asParsedVersion(a);
  const right = asParsedVersion(b);
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // 1.0.0 > 1.0.0-beta
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const x = String(a[i]);
    const y = String(b[i]);
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      // 数字标识的优先级低于字母标识
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function isNewerVersion(latest, current) {
  return compareVersions(latest, current) === 1;
}

// 只接受 https://github.com/<owner>/<repo>/releases[/...]；其它域名 / 协议 / 路径一律拒绝。
// 这样即使 GitHub 返回被中间人改过的 JSON，主进程也不会去打开任意网站。
function safeReleaseUrl(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text || text.length > 300) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (url.port) return '';
  if (url.hostname.toLowerCase() !== 'github.com') return '';
  const prefix = `/${REPO_OWNER}/${REPO_NAME}/releases`.toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return '';
  return `https://github.com${url.pathname}${url.search}`;
}

// 没有可用 html_url 时，用 tag 自己拼一个下载页（tag 只允许安全字符，防路径拼接）。
function releasePageUrl(tag) {
  const text = typeof tag === 'string' ? tag.trim() : '';
  if (text && text.length <= MAX_TAG_CHARS && TAG_RE.test(text)) {
    return `${RELEASES_URL}/tag/${encodeURIComponent(text)}`;
  }
  return RELEASES_URL;
}

function safeIsoDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const date = new Date(raw.trim());
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

// GitHub /releases/latest 的 JSON → 干净的内部结构；任何缺字段 / 坏草稿都返回错误。
function parseReleasePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'BAD_RESPONSE', message: MESSAGES.BAD_RESPONSE };
  }
  if (payload.draft === true) {
    return { ok: false, code: 'BAD_RELEASE', message: 'GitHub 返回的是草稿版本（还没有正式发布）' };
  }
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  const version = parseVersion(tag);
  if (!tag || !version) {
    return { ok: false, code: 'BAD_RELEASE', message: MESSAGES.BAD_RELEASE };
  }
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, MAX_NAME_CHARS) : '';
  const url = safeReleaseUrl(payload.html_url) || releasePageUrl(tag);
  return {
    ok: true,
    release: {
      tag: tag.slice(0, MAX_TAG_CHARS),
      version: version.text,
      name: name || tag,
      url,
      publishedAt: safeIsoDate(payload.published_at),
      prerelease: payload.prerelease === true
    }
  };
}

function errorResult(currentVersion, code, message, checkedAt) {
  return {
    status: 'error',
    code,
    message: message || MESSAGES.UNEXPECTED,
    currentVersion: currentVersion || '',
    latestVersion: '',
    releaseName: '',
    releaseUrl: '',
    publishedAt: '',
    checkedAt: checkedAt || new Date().toISOString()
  };
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  return /abort/i.test(String(err.name || ''));
}

// 检查更新（不写盘、不抛错）。
// options.currentVersion：当前应用版本（app.getVersion()）
// options.fetchText：注入的网络实现，签名 ({url, timeoutMs}) => Promise<{status, text}>；
//   主进程用 Electron net.fetch，单测用假函数（本模块绝不自己联网）。
// 返回 { status: 'update' | 'latest' | 'error', currentVersion, ... }。
async function checkForUpdates(options = {}) {
  const current = parseVersion(options.currentVersion);
  const checkedAt = (() => {
    try {
      const now = typeof options.now === 'function' ? options.now() : Date.now();
      return new Date(Number(now) || Date.now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();
  if (!current) return errorResult('', 'BAD_CURRENT', MESSAGES.BAD_CURRENT, checkedAt);
  const base = {
    currentVersion: current.text,
    latestVersion: '',
    releaseName: '',
    releaseUrl: '',
    publishedAt: '',
    checkedAt
  };
  if (typeof options.fetchText !== 'function') {
    return { ...base, status: 'error', code: 'NO_FETCH', message: MESSAGES.UNEXPECTED };
  }
  const timeoutMs = Math.max(1500, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  let response;
  try {
    response = await options.fetchText({ url: LATEST_RELEASE_API, timeoutMs });
  } catch (err) {
    const code = isAbortError(err) ? 'TIMEOUT' : 'NETWORK';
    return { ...base, status: 'error', code, message: MESSAGES[code] };
  }
  if (!response || typeof response !== 'object') {
    return { ...base, status: 'error', code: 'BAD_RESPONSE', message: MESSAGES.BAD_RESPONSE };
  }
  const status = Number(response.status);
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return { ...base, status: 'error', code: 'BAD_RESPONSE', message: MESSAGES.BAD_RESPONSE };
  }
  if (status === 404) {
    return { ...base, status: 'error', code: 'NO_RELEASE', message: MESSAGES.NO_RELEASE };
  }
  if (status === 403 || status === 429) {
    return { ...base, status: 'error', code: 'RATE_LIMIT', message: MESSAGES.RATE_LIMIT };
  }
  if (status < 200 || status >= 300) {
    return { ...base, status: 'error', code: 'HTTP_ERROR', message: httpMessage(status) };
  }
  if (typeof response.text !== 'string' || !response.text.trim()) {
    return { ...base, status: 'error', code: 'BAD_RESPONSE', message: MESSAGES.BAD_RESPONSE };
  }
  if (response.text.length > MAX_RESPONSE_CHARS) {
    return { ...base, status: 'error', code: 'TOO_LARGE', message: MESSAGES.TOO_LARGE };
  }
  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    return { ...base, status: 'error', code: 'BAD_JSON', message: MESSAGES.BAD_JSON };
  }
  const parsed = parseReleasePayload(payload);
  if (!parsed.ok) {
    return { ...base, status: 'error', code: parsed.code, message: parsed.message };
  }
  const release = parsed.release;
  const common = {
    ...base,
    latestVersion: release.version,
    releaseName: release.name,
    releaseUrl: release.url,
    publishedAt: release.publishedAt
  };
  if (isNewerVersion(release.version, current)) {
    return {
      ...common,
      status: 'update',
      tag: release.tag,
      prerelease: release.prerelease,
      message: `发现新版本 v${release.version}（当前 v${current.text}）`
    };
  }
  return {
    ...common,
    status: 'latest',
    tag: release.tag,
    prerelease: release.prerelease,
    message: `已经是最新版本（v${current.text}）`
  };
}

module.exports = {
  REPO_OWNER,
  REPO_NAME,
  REPO_URL,
  RELEASES_URL,
  LATEST_RELEASE_API,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_CHARS,
  MESSAGES,
  parseVersion,
  compareVersions,
  isNewerVersion,
  safeReleaseUrl,
  releasePageUrl,
  parseReleasePayload,
  checkForUpdates
};
