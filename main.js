// 章节写作器 —— Electron 主进程（版本号见 package.json，界面版本号由 app.getVersion() 回报）
// 职责：窗口与生命周期、关闭拦截、所有文件读写（渲染层零文件系统权限）。
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  clipboard,
  screen,
  net,
  // 注意：Electron 的 session 模块与「每个窗口一个会话」的 session 同名，这里别名导入，
  // 避免 main.js 里到处用的窗口 session 变量被遮蔽（createWindow 里就有 const session = ...）
  session: electronSession,
  webContents
} = require('electron');

// ---------- 启动参数（自动化/隔离用，正常用户启动不受影响） ----------
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const userDataArg = argValue('user-data');
if (userDataArg) {
  fsSync.mkdirSync(userDataArg, { recursive: true });
  app.setPath('userData', userDataArg);
}

const isE2E = process.argv.includes('--e2e');
const booksRootOverride = argValue('books-root');
const screenshotPath = argValue('screenshot');
const screenshotBook = argValue('book');
const screenshotChapter = argValue('chapter');
const screenshotDialog = argValue('dialog');
const automation = isE2E || Boolean(screenshotPath);

const { createConfigStore } = require('./core/config');
const { atomicWriteFile } = require('./core/atomic');
const storage = require('./core/storage');
const repair = require('./core/repair');
const importer = require('./core/importer');
const exporter = require('./core/exporter');
const chaptersLib = require('./core/chapters');
const formatLib = require('./core/format');
const findLib = require('./core/find');
const proofreadLib = require('./core/proofread');
const jumpLib = require('./core/jump');
const textMenu = require('./core/textmenu');
const statsLib = require('./core/stats');
const epubLib = require('./core/epub');
const docxLib = require('./core/docx');
const fragmentsLib = require('./core/fragments');
const sensitiveLib = require('./core/sensitive');
const glossaryLib = require('./core/glossary');
const s2tLib = require('./core/s2t');
const ttsLib = require('./core/tts');
const logsLib = require('./core/logs');
const searchIndexLib = require('./core/search-index');
const updateLib = require('./core/update');
const openBooksLib = require('./core/open-books');
const fontPolicy = require('./core/font-policy');
const securityPolicy = require('./core/security-policy');
const ipcPaths = require('./core/ipc-paths');
const configGate = require('./core/config-gate');
const errorText = require('./core/error-text');
const ipcLimits = require('./core/ipc-limits');

// ---------- 多窗口会话 ----------
// 每个 BrowserWindow 一个会话：独立的 bookPath（登记在 storage 的打开登记表里）、
// 脏状态、关闭状态、进度事件目标。窗口对象、窗口 id、webContents id 三张表互相对应；
// IPC 处理函数用 AsyncLocalStorage 记住「这次调用来自哪个窗口」，弹窗 / 进度事件按窗口路由。
let automationWin = null; // 仅截图 / E2E 驱动用（第一个窗口）；生产逻辑一律按会话路由
const windowSessions = new Map(); // windowId(number) -> session
const webContentsSessions = new Map(); // webContents.id(number) -> session
const ipcFlow = new AsyncLocalStorage();
// E2E：close-ready 回执按窗口记录；isE2E 下默认不真的关窗口，'真实关窗'模式用于多窗口用例
const e2eCloseReadyByWindow = new Map();
let e2eLastCloseReady = undefined;
let e2eRealClose = false;
let e2eWindowAllClosed = false;

let configStore = null;
let config = null;
let statsStore = null; // 每日字数统计（userData/stats.json，绝不写书库）
let configWarning = null; // 配置损坏被归档时的提示，界面启动后取一次
// 配置里「指向磁盘」的三项（书架目录 / 两份词表）只认对话框选中的值：
// 按窗口记「刚在系统对话框里选中的路径」，config:set 拿它做来源校验（v0.9 C-2b）。
// 只在内存里，窗口关闭时清掉；不写盘、不跨窗口。
const pickedConfigPaths = configGate.createPickedPathStore();
// 正常使用时就是 Electron 的系统剪贴板；只有 E2E 在锁屏/无交互桌面环境（系统剪贴板
// 拒绝所有读写）时会临时换成进程内剪贴板，见 scripts/screenshot-driver.js 的 createE2EClipboard()。
let activeClipboard = clipboard;

// ---------- 窗口会话工具 ----------
function createSession(browserWin) {
  const session = {
    id: browserWin.id,
    win: browserWin,
    dirty: false,
    closePending: false,
    closeTimer: null,
    forceClose: false,
    boundsTimer: null,
    e2eCloseReady: undefined
  };
  windowSessions.set(session.id, session);
  webContentsSessions.set(browserWin.webContents.id, session);
  try {
    storage.openBookRegistry.registerWindow(session.id);
  } catch {
    /* 登记失败也不影响开窗口；跨窗口检查会退化成「没有开着的书」 */
  }
  return session;
}

function sessionOfSender(event) {
  if (!event || !event.sender) return null;
  return webContentsSessions.get(event.sender.id) || null;
}

function sessionById(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id)) return null;
  const session = windowSessions.get(id);
  return session && !session.win.isDestroyed() ? session : null;
}

function flowSession() {
  const store = ipcFlow.getStore();
  if (!store) return null;
  return sessionById(store.windowId);
}

function mostRecentSession() {
  const recentId = storage.openBookRegistry.mostRecentWindow();
  const recent = recentId ? sessionById(recentId) : null;
  if (recent) return recent;
  // 兜底：登记表异常时取最后创建且还活着的窗口
  let last = null;
  for (const session of windowSessions.values()) {
    if (!session.win.isDestroyed()) last = session;
  }
  return last;
}

// 当前 IPC 调用所属窗口；没有上下文（主进程内部触发）时退回最近使用的窗口
function liveSession() {
  return flowSession() || mostRecentSession();
}

function webContentsAlive(session) {
  return Boolean(
    session &&
      !session.win.isDestroyed() &&
      session.win.webContents &&
      !session.win.webContents.isDestroyed()
  );
}

function sendToSession(session, channel, payload) {
  if (!webContentsAlive(session)) return false;
  try {
    session.win.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function sendToFlow(channel, payload) {
  const session = liveSession();
  if (session) return sendToSession(session, channel, payload);
  return false;
}

function broadcast(channel, payload, { except = null } = {}) {
  const skip = except == null ? null : String(except);
  for (const session of windowSessions.values()) {
    if (skip && String(session.id) === skip) continue;
    sendToSession(session, channel, payload);
  }
}

function focusSession(session) {
  if (!session || session.win.isDestroyed()) return false;
  try {
    if (session.win.isMinimized()) session.win.restore();
    session.win.show();
    session.win.focus();
    if (session.win.flashFrame) session.win.flashFrame(true);
    storage.openBookRegistry.touch(session.id);
    return true;
  } catch {
    return false;
  }
}

// 系统对话框的父窗口：发起这次 IPC 的窗口；没有就退回最近使用的窗口
function dialogParent() {
  const session = liveSession();
  if (session && !session.win.isDestroyed()) return session.win;
  return null;
}

function showOpenDialog(options) {
  const parent = dialogParent();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

function showSaveDialog(options) {
  const parent = dialogParent();
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}

function showMessageBox(options, parent = dialogParent()) {
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

// 书架数据变了：其它窗口若正停在书架就刷新；在写作页的窗口回书架时会自己刷新
function notifyShelfChanged(session, reason = '') {
  broadcast('shelf:changed', { reason }, { except: session ? session.id : null });
}

// 只保存「最近使用的窗口」的位置 / 大小（下次启动按它恢复）
async function saveRecentWindowBounds(session) {
  if (!session || session.win.isDestroyed()) return false;
  const recentId = storage.openBookRegistry.mostRecentWindow();
  if (recentId && String(recentId) !== String(session.id) && windowSessions.size > 1) return false;
  try {
    await configStore.set({ windowBounds: session.win.getBounds() });
    return true;
  } catch {
    return false;
  }
}


// ---------- 崩溃 / 错误日志（提案 7.4） ----------
// 只记元数据（时间 / 类型 / 级别 / 错误码 / IPC 频道 / message / 栈 / pid / 版本），绝不传正文；
// 格式里还有 `path` 字段，但当前没有任何调用方填它（v0.9 C-4 审计结论），别把「日志记了路径」当既有行为。
// 日志写不进去只吞掉，绝不能影响正文保存、界面和退出（实现在 core/logs.js，单测覆盖）。
let logStore = null;

function getLogStore() {
  if (!logStore) {
    try {
      logStore = logsLib.createLogStore(app.getPath('userData'));
    } catch {
      logStore = null; // 连路径都拿不到：静默降级，不影响应用
    }
  }
  return logStore;
}

// 记一条错误日志（不 await：主流程不能等日志落盘）。extra 里只允许元数据字段。
function logError(kind, err, extra = {}) {
  try {
    const store = getLogStore();
    if (!store) return;
    const described = logsLib.describeError(err);
    let version = '';
    try { version = app.getVersion(); } catch { version = ''; }
    store.write({
      level: extra.level || 'error',
      kind,
      code: extra.code != null ? extra.code : described.code,
      channel: extra.channel,
      path: extra.path,
      message: extra.message != null ? extra.message : described.message,
      stack: described.stack,
      pid: process.pid,
      app: version
    });
  } catch {
    /* 日志本身永远不能影响应用 */
  }
}

// 配置里「指向磁盘」的项被来源不明地改动时记一条 info 日志：
// 只记字段名 —— 绝不记路径值，也不把任何路径回给渲染层（日志里没有本机目录）。
function logRejectedConfigPaths(fields) {
  if (!Array.isArray(fields) || !fields.length) return;
  try {
    logError(
      'config-rejected-path',
      {
        code: 'BAD_CONFIG_SOURCE',
        message: `已忽略来源不明的配置项：${fields.join('、')}（设置里请用「选择…」按钮挑）`
      },
      { level: 'info' }
    );
  } catch {
    /* 日志失败不影响设置保存 */
  }
}

// 记住「这个窗口刚在系统对话框里选中的路径」；没有窗口上下文就忽略（不写盘）。
function rememberPickedConfigPath(field, value) {
  const session = flowSession();
  if (!session) return;
  pickedConfigPaths.remember(session.id, field, value);
}

// 给作者看的固定提示（不把错误细节 / 任何正文塞进界面）
const INTERNAL_ERROR_TEXT = {
  uncaughtException:
    '程序遇到一个内部错误，已写进日志。建议先按 Ctrl+S 保存，再重启应用（设置 → 诊断日志里可以打开日志文件夹）。',
  unhandledRejection:
    '程序有一项后台操作失败了，已写进日志。写作和保存不受影响；如果反复出现，可在设置 → 诊断日志里查看。'
};

function notifyInternalError(kind, err) {
  try {
    const described = logsLib.describeError(err);
    console.error(`[${kind}]`, described.code || '', described.message);
    logError(kind, err);
    // 所有窗口都提示一句固定文案（哪个窗口都可能正开着稿子）
    broadcast('app:internal-error', {
      kind,
      code: described.code || '',
      message: INTERNAL_ERROR_TEXT[kind] || INTERNAL_ERROR_TEXT.uncaughtException,
      time: new Date().toISOString()
    });
  } catch {
    /* 处理错误时再抛错就真没救了：吞掉 */
  }
}

// 主进程崩溃 / 未处理的 Promise：写日志 + 通知界面，进程不退出（作者可能还有没保存的稿子，
// 至少让他先 Ctrl+S 再重启）。日志失败也只影响日志。
process.on('uncaughtException', (err) => notifyInternalError('uncaughtException', err));
process.on('unhandledRejection', (reason) => notifyInternalError('unhandledRejection', reason));

function logStartup() {
  try {
    const store = getLogStore();
    if (!store) return;
    let version = '';
    try { version = app.getVersion(); } catch { version = ''; }
    store.write({
      level: 'info',
      kind: 'app-start',
      message: `启动：v${version || '?'}（${process.platform} ${process.arch}，Electron ${process.versions.electron || '?'}，pid ${process.pid}）`,
      pid: process.pid,
      app: version
    });
  } catch {
    /* 忽略 */
  }
}

// ---------- 正文全文搜索索引（提案 7.3） ----------
// 索引文件只在 userData（不进书库、不改正文）；建索引 / 校验都是异步的，渲染层只拿搜索结果。
let searchIndexStore = null;
let searchProgressAt = 0;

function getSearchIndexStore() {
  if (!searchIndexStore) {
    searchIndexStore = searchIndexLib.createSearchStore({ userDataDir: app.getPath('userData') });
  }
  return searchIndexStore;
}

function sendSearchProgress(info) {
  const session = liveSession();
  if (!session) return;
  const now = Date.now();
  // 进度事件很密：除「完成」外 120ms 合并一次（渲染层只需要大致进度）
  if (info && info.phase !== 'done' && now - searchProgressAt < 120) return;
  searchProgressAt = now;
  try {
    sendToSession(session, 'search:progress', info);
  } catch {
    /* 进度事件丢了不影响建索引 */
  }
}

// ---------- 自动更新轻量版（提案 7.1） ----------
// 只在作者点「检查更新」时访问一次 GitHub Release API，用 Electron 内置 net.fetch；
// 不下载、不安装、不写配置、不写书库。网络失败 / 超时由 core/update 转成一句提示，绝不抛错。
// E2E / 截图自检可以注入假网络（update:test-mock 只在 automation 下注册），不会真连 GitHub。
let updateMock = null;
let lastUpdateLaunch = null;

async function fetchReleaseResponse({ url, timeoutMs }) {
  if (automation && updateMock) {
    const mock = updateMock;
    if (mock.type === 'network-error') {
      throw Object.assign(new Error('mock network error'), { code: 'ENOTFOUND' });
    }
    if (mock.type === 'timeout') {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    if (mock.type === 'http') {
      return {
        status: Number(mock.status) || 500,
        text: typeof mock.text === 'string' ? mock.text : ''
      };
    }
    return { status: 200, text: JSON.stringify(mock.body == null ? {} : mock.body) };
  }
  const controller = new AbortController();
  const waitMs = Math.max(1500, Math.min(30000, Number(timeoutMs) || updateLib.DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `chapter-writer/${app.getVersion()}`
      },
      signal: controller.signal
    });
    const length = Number(res.headers.get('content-length') || 0);
    if (length > updateLib.MAX_RESPONSE_CHARS) return { status: res.status, text: '' };
    const text = await res.text();
    return { status: res.status, text: text.slice(0, updateLib.MAX_RESPONSE_CHARS + 1) };
  } finally {
    clearTimeout(timer);
  }
}

function ok(data) {
  return { ok: true, data };
}

// IPC 失败统一出口（v0.9 C-4，安全审计 C5）：
// 回给界面的文案先过 core/error-text.js —— 本机绝对路径只留最后一节、常见文件系统错误码换成中文、
// 控制字符与超长文本收掉；原始错误对象仍交给 logError 写进本机日志（日志侧同样只留文件名）。
// 错误码（code）原样保留：界面与 E2E 都按 code 分支，不受文案影响。
function fail(err, channel) {
  const described = errorText.describeForUi(err);
  console.error('[ipc-fail]', channel ? `${channel}:` : '', described.code, described.message);
  // 保存失败单独记一条（错误码 + 章节文件名，绝不含正文），方便排查「保存失败」类反馈
  logError(channel === 'chapter:save' ? 'save-failed' : 'ipc-error', err, { channel });
  return { ok: false, code: described.code, message: described.message };
}

// 只接受来自本应用管理的窗口的 IPC（防止将来引入 webview / 远程内容后越权）：
// 判定在 handle() 里做（sessionOfSender(event) 为空就回 BAD_SENDER），
// 以前那个单独包一层 Boolean() 的 isTrustedSender() 没有任何调用点，v0.9 B-4 删掉了。
function runInWindowFlow(session, fn) {
  return ipcFlow.run({ windowId: session.id }, fn);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const session = sessionOfSender(event);
    if (!session) return fail(Object.assign(new Error('不可信的调用来源'), { code: 'BAD_SENDER' }), channel);
    return runInWindowFlow(session, async () => {
      try {
        return ok(await fn(...args));
      } catch (err) {
        return fail(err, channel);
      }
    });
  });
}

// 书架相关的 IPC：第一个参数必须是「书架目录的直接子目录」，
// 渲染层理论上不会传别的路径，但加一层校验，越权/手误都读不到书架以外的文件。
// 校验本身搬到 core/ipc-paths.js（纯逻辑，单测覆盖 `..` / 绝对路径 / 孙目录 / 空串），
// 这里的名字保持不变：handleBook 与 window:open-book 照旧调用它（book:delete 另有一处
// 自己的再校验，文案更具体：「只能删除书架目录下的书」）。
const assertBookPath = ipcPaths.assertBookPath;

// 文本类 IPC 的前置校验（v0.9 C-5）：正文必须是字符串，且不超过 core/ipc-limits.js 的
// MAX_TEXT_CHARS（500 万字）。排版 / 查找 / 替换 / 校对 / 朗读都是 O(n) 甚至 O(n × 词表) 的计算，
// 在入口先挡住超大输入，免得渲染层一次手误 / 注入就把主进程拖到假死；超限回 TEXT_TOO_LARGE。
const assertText = ipcLimits.assertText;

// mutation：写书的操作（save / delete / rename / format / replace / write）。
// 有值时统一做跨窗口拦截：别的窗口正开着这本书 → 拒绝并提示先关 / 先切过去。
function handleBook(channel, fn, { mutation = null } = {}) {
  ipcMain.handle(channel, async (event, bookPath, ...args) => {
    const session = sessionOfSender(event);
    if (!session) return fail(Object.assign(new Error('不可信的调用来源'), { code: 'BAD_SENDER' }), channel);
    return runInWindowFlow(session, async () => {
      try {
        const cfg = await getConfig();
        const target = assertBookPath(bookPath, cfg.booksRoot);
        if (mutation) storage.assertBookNotBusy(target, session.id, mutation);
        const result = await fn(target, ...args);
        // 书架数据可能变了（字数 / 章节 / 书名）：其它窗口的书架跟着刷新
        if (mutation && channel !== 'book:set-last') notifyShelfChanged(session, channel);
        return ok(result);
      } catch (err) {
        return fail(err, channel);
      }
    });
  });
}

async function getConfig() {
  if (!config) {
    configStore = createConfigStore(app.getPath('userData'));
    config = await configStore.get();
    configWarning = configStore.takeLoadWarning();
    if (booksRootOverride) config = { ...config, booksRoot: booksRootOverride };
  }
  return config;
}

// 每日统计只存在应用配置目录；首次用到时才建，读写失败不能影响保存正文。
function getStatsStore() {
  if (!statsStore) statsStore = statsLib.createStatsStore(app.getPath('userData'));
  return statsStore;
}

// 统计摘要统一出口：今天 + 近 30 天 + 连续写作天数（保存后与 stats:get 用同一套口径）。
// v0.8-2 起带上「写作时长」开关状态，界面据此决定要不要显示计时按钮（默认关）。
function statsSummaryPayload(stats, cfg, now = new Date()) {
  return {
    ...statsLib.summary(stats, { goal: cfg.dailyGoal, now }),
    streak: statsLib.streak(stats, { now }),
    writeDurationEnabled: cfg.writeDurationEnabled === true
  };
}

// 记住这次导出保存到的目录（下次导出默认还开在这里）；记不住也绝不影响导出结果。
async function rememberExportDir(dir) {
  if (!dir) return;
  const cfg = await getConfig();
  if (dir === cfg.lastExportDir) return;
  try {
    const updated = await configStore.set({ lastExportDir: dir });
    config = booksRootOverride ? { ...updated, booksRoot: booksRootOverride } : updated;
  } catch {
    /* 忽略：只是记个位置 */
  }
}

// ---------- 「继续上次写作」：书架级记忆（只写配置，不碰书库） ----------
// 书库里的 lastOpenChapterId 仍是「打开这本书回到哪一章」的唯一事实来源；
// 这里只记“上次写的是哪本书的哪一章 + 时间”，给书架顶部的入口用。
async function rememberRecentBook(bookPath, info) {
  if (!bookPath || !info) return false;
  const chapterId = String(info.chapterId == null ? '' : info.chapterId).trim();
  if (!chapterId) return false;
  const now = Date.now();
  const payload = {
    path: bookPath,
    title: String(info.title == null ? '' : info.title).slice(0, 200),
    chapterId,
    chapterIndex: Math.max(0, Math.round(Number(info.chapterIndex) || 0)),
    chapterName: String(info.chapterName == null ? '' : info.chapterName).slice(0, 200),
    at: now
  };
  try {
    await getConfig();
    const current = await configStore.get();
    const prev = current.lastBook;
    // 打开书时 open + set-last 会连着报同一个位置：5 秒内不重复写盘（换章照常更新）
    if (prev && prev.path === payload.path && prev.chapterId === payload.chapterId && now - prev.at < 5000) {
      return false;
    }
    const updated = await configStore.set({ lastBook: payload });
    config = booksRootOverride ? { ...updated, booksRoot: booksRootOverride } : updated;
    return true;
  } catch {
    return false; // 记不住位置不影响写作
  }
}

function clampBounds(bounds) {
  try {
    if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height))) {
      return null;
    }
    const display = screen.getDisplayMatching({
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width),
      height: Number(bounds.height)
    });
    const area = display.workArea;
    const width = Math.min(Number(bounds.width), area.width);
    const height = Math.min(Number(bounds.height), area.height);
    const x = Math.max(area.x, Math.min(Number(bounds.x) || 0, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(Number(bounds.y) || 0, area.y + area.height - height));
    return { x, y, width, height };
  } catch {
    return null;
  }
}

// ---------- 关闭流程（每个窗口各自拦截；保存失败不静默退出） ----------
function setupCloseFlow(session) {
  const browserWin = session.win;
  browserWin.on('close', (event) => {
    if (session.forceClose) return;
    event.preventDefault();
    if (session.closePending) return;
    session.closePending = true;
    try {
      browserWin.webContents.send('app:close-requested');
    } catch {
      session.closePending = false;
      return;
    }
    clearTimeout(session.closeTimer);
    session.closeTimer = setTimeout(async () => {
      if (!session.closePending || browserWin.isDestroyed()) return;
      const { response } = await showMessageBox(
        {
          type: 'warning',
          title: '编辑器无响应',
          message: '保存流程没有在 3 秒内完成。',
          detail: '继续等待通常更安全；强制退出可能丢失未保存的内容。',
          buttons: ['继续等待', '强制退出'],
          defaultId: 0,
          cancelId: 0
        },
        browserWin
      );
      if (response === 1) {
        session.closePending = false;
        session.forceClose = true;
        if (!browserWin.isDestroyed()) browserWin.destroy();
      } else {
        session.closePending = false;
      }
    }, 3000);
  });
}

// 关闭回执 / 脏状态上报只注册一次，按发送方窗口路由（多窗口各管各的）
function setupCloseIpc() {
  ipcMain.on('app:close-ready', async (event, allowed) => {
    const session = sessionOfSender(event);
    if (!session) return;
    session.closePending = false;
    clearTimeout(session.closeTimer);
    const okToClose = Boolean(allowed);
    session.e2eCloseReady = okToClose;
    e2eLastCloseReady = okToClose;
    if (isE2E) {
      // 默认只记回执、不真的关窗（既有 E2E 项都依赖窗口继续存在；不写死项数，加组就会过时）；
      // 多窗口用例显式打开「真实关窗」模式再关。
      e2eCloseReadyByWindow.set(String(session.id), okToClose);
      if (!e2eRealClose || !okToClose) return;
    } else if (!okToClose) {
      return;
    }
    // 只记「最近使用的窗口」的位置 / 大小；关一个非最近窗口不覆盖它
    await saveRecentWindowBounds(session);
    if (session.win.isDestroyed()) return;
    session.forceClose = true;
    session.win.close();
  });

  // 渲染层上报「是否有未保存修改」，供 Windows 关机拦截判断（按窗口记录）
  ipcMain.on('app:dirty', (event, dirty) => {
    const session = sessionOfSender(event);
    if (session) session.dirty = Boolean(dirty);
  });
}

// ---------- IPC ----------
function registerIpc() {
  // ---------- 窗口会话（多窗口） ----------
  // 属于哪个窗口、这个窗口开着哪本书（打开登记只有主进程 + storage 知道）
  handle('window:info', async () => {
    const session = flowSession();
    return {
      windowId: session ? session.id : null,
      bookPath: session ? storage.openBookRegistry.getBook(session.id) : null,
      windows: storage.openBookRegistry.counts().windows
    };
  });
  // 回书架 / 切到没有书的视图时释放登记（关窗由主进程在窗口销毁时统一释放）
  handle('window:release-book', async () => {
    const session = flowSession();
    if (!session) return { released: false };
    return { released: storage.releaseOpenBook(session.id) };
  });
  // 书卡右键「在新窗口打开」：同书已开在别窗口就聚焦那个窗口、绝不开第二个
  handle('window:open-book', async (bookPath) => {
    const session = flowSession();
    const cfg = await getConfig();
    const target = assertBookPath(bookPath, cfg.booksRoot);
    const owner = storage.findOpenBookWindow(target);
    if (owner) {
      const ownerSession = sessionById(owner);
      if (ownerSession) focusSession(ownerSession);
      return {
        focused: true,
        sameWindow: Boolean(session && String(session.id) === String(owner)),
        windowId: Number(owner),
        message: openBooksLib.openInOtherWindowMessage(target)
      };
    }
    // 先确认书能正常读，避免开出一个空窗口（读失败照常返回错误）
    await storage.openBook(target);
    const created = await createWindow({ bookPath: target, cascade: true });
    return { focused: false, windowId: created.id };
  });

  handle('config:get', async () => getConfig());
  // 界面上的版本号从 package.json 读，免得每次发版忘了改静态文字
  handle('app:version', async () => ({ version: app.getVersion() }));
  // 启动后取一次「配置损坏被归档」之类的提示（取完即清空）
  handle('app:warning', async () => {
    const warning = configWarning;
    configWarning = null;
    return warning;
  });

  // 书架顶部「继续上次写作」用：上次写的是哪本书、哪一章、什么时候
  handle('app:recent-book', async () => {
    const cfg = await getConfig();
    return cfg.lastBook || null;
  });

  // 改配置（v0.9 C-2b）：显示设置 / 统计 / 模板这些随便改，但「指向磁盘」的三项
  // （书架目录 + 两份词表）只认「这个窗口刚在系统对话框里选中的值」或「与原值相同 / 清空」。
  // 设置界面本来就只有「选择…」按钮（三个输入框都是只读的），所以正常用起来毫无区别；
  // 被注入的脚本想借 config:set 让主进程去读写别的目录 / 文件，会被 core/config-gate.js 挡掉。
  handle('config:set', async (patch) => {
    const current = await getConfig();
    const session = flowSession();
    const gated = configGate.filterPathPatch(patch, {
      current,
      picked: session ? pickedConfigPaths.snapshot(session.id) : null
    });
    // 只把放行的字段交给配置仓库：被拒的字段保留原值，正常字段照旧生效
    const next = await configStore.set(gated.patch);
    config = booksRootOverride ? { ...next, booksRoot: booksRootOverride } : next;
    await fs.mkdir(config.booksRoot, { recursive: true });
    if (gated.rejected.length) logRejectedConfigPaths(gated.rejected);
    return config;
  });

  if (automation) {
    // 仅自检：模拟「在系统目录对话框里选中了某个路径」（E2E 没法真的点原生对话框）。
    // 和 font:test-pick / update:test-mock 一样只在 automation 下注册，生产环境这个频道不存在。
    // 参数顺序有意把路径放第一位：tests/ipc-paths.test.js 的静态闸门只盯第一参数带路径的频道，
    // 这样以后谁再改这个频道也不会悄悄绕过清单（见 PATH_CHANNEL_ALLOWLIST）。
    handle('config:test-pick', async (pickedPath, field) => {
      const session = flowSession();
      const value = typeof pickedPath === 'string' ? pickedPath.trim() : '';
      const key = typeof field === 'string' ? field.trim() : '';
      if (!session || !value || !configGate.GUARDED_PATH_FIELDS.includes(key)) return false;
      pickedConfigPaths.remember(session.id, key, value);
      return true;
    });
  }

  // 每日字数统计摘要：今天多少字 + 近 30 天（含今天）+ 当月码字日历 + 连续写作天数。
  // 统计文件在 userData，不在书库；月视图只读，切换月份走 stats:calendar。
  handle('stats:get', async () => {
    const cfg = await getConfig();
    const stats = await getStatsStore().get();
    const now = new Date();
    return {
      ...statsSummaryPayload(stats, cfg, now),
      calendar: statsLib.monthView(stats, { now, goal: cfg.dailyGoal })
    };
  });
  handle('stats:calendar', async (request) => {
    const cfg = await getConfig();
    const stats = await getStatsStore().get();
    const now = new Date();
    return {
      calendar: statsLib.monthView(stats, {
        year: request && request.year,
        month: request && request.month,
        now,
        goal: cfg.dailyGoal
      }),
      streak: statsLib.streak(stats, { now })
    };
  });
  // 写作时长（v0.8-2）：渲染层在计时暂停 / 保存 / 每 30 秒上报一次整秒。
  // 默认关：关着时只读 stats.json 算一份摘要回给界面（不记时长、不写盘），旧用户行为完全不变。
  // 只记秒数，不接收正文、按键或任何内容；写盘仍走 core/atomic（和字数共用串行队列）。
  handle('stats:duration', async (request) => {
    const cfg = await getConfig();
    const now = new Date();
    const day = statsLib.localDayKey(now);
    if (cfg.writeDurationEnabled !== true) {
      const stats = await getStatsStore().get();
      return { recorded: 0, disabled: true, day, stats: statsSummaryPayload(stats, cfg, now) };
    }
    const requested = Math.min(
      statsLib.MAX_DAY_SECONDS,
      Math.max(0, Math.floor(Number(request && request.seconds) || 0))
    );
    if (requested <= 0) {
      const stats = await getStatsStore().get();
      return { recorded: 0, disabled: false, day, stats: statsSummaryPayload(stats, cfg, now) };
    }
    const recorded = await getStatsStore().addDuration({ day, seconds: requested });
    return {
      recorded: recorded.added,
      disabled: false,
      day: recorded.day,
      stats: statsSummaryPayload(recorded.stats, cfg, new Date())
    };
  });

  // 灵感箱（碎片速记）：书架根目录 _碎片 里的普通 txt。
  // 不传路径进来，文件名由主进程按日期 + 当天序号生成；写盘走 core/atomic，不碰 书目.json / 章节文件。
  handle('fragments:list', async () => {
    const cfg = await getConfig();
    return fragmentsLib.createFragmentStore(cfg.booksRoot).list();
  });
  handle('fragments:create', async (text) => {
    const cfg = await getConfig();
    return fragmentsLib.createFragmentStore(cfg.booksRoot).create(text);
  });
  handle('fragments:read', async (name) => {
    const cfg = await getConfig();
    return fragmentsLib.createFragmentStore(cfg.booksRoot).read(name);
  });

  // 每本书的显示设置覆盖（写作页里改的字体/背景/间距/章节栏宽度只影响这本书）
  handle('book:get-display', async (bookId) => {
    await getConfig();
    return configStore.getBookDisplay(bookId);
  });

  handle('book:set-display', async (bookId, patch) => {
    await getConfig();
    const display = await configStore.setBookDisplay(bookId, patch || {});
    config = await configStore.get();
    if (booksRootOverride) config = { ...config, booksRoot: booksRootOverride };
    return display;
  });

  handle('book:reset-display', async (bookId) => {
    await getConfig();
    await configStore.resetBookDisplay(bookId);
    config = await configStore.get();
    if (booksRootOverride) config = { ...config, booksRoot: booksRootOverride };
    return true;
  });

  // 查找书签（v0.8-11b，提案 N11b）：按「书 + 章」把查询词与大小写选项存在 userData/config.json。
  // 主进程做原子增 / 删（不整份覆盖数组），只写配置，绝不碰书库 / 书目 / 章节文件；
  // 渲染层仍然没有 fs 权限。
  handle('find:bookmark-list', async () => {
    await getConfig();
    return configStore.listFindBookmarks();
  });

  handle('find:bookmark-save', async (entry) => {
    await getConfig();
    const data = await configStore.upsertFindBookmark(entry || {});
    config = await configStore.get();
    if (booksRootOverride) config = { ...config, booksRoot: booksRootOverride };
    return data;
  });

  handle('find:bookmark-remove', async (bookId, chapterId) => {
    await getConfig();
    const data = await configStore.removeFindBookmark(bookId, chapterId);
    config = await configStore.get();
    if (booksRootOverride) config = { ...config, booksRoot: booksRootOverride };
    return data;
  });

  handle('books:list', async () => {
    const cfg = await getConfig();
    return storage.listBooks(cfg.booksRoot);
  });

  handle('book:create', async (title) => {
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    const created = await storage.createBook(cfg.booksRoot, title);
    notifyShelfChanged(flowSession(), 'book:create');
    return created;
  });

  handleBook('book:open', async (bookPath) => {
    const session = flowSession();
    // 同一本书只允许一个窗口：已开在别处就聚焦那个窗口并拒绝
    const owner = storage.findOpenBookWindow(bookPath);
    if (owner && session && String(owner) !== String(session.id)) {
      focusSession(sessionById(owner));
      throw new storage.StorageError(
        openBooksLib.CODE.BOOK_OPEN_IN_OTHER_WINDOW,
        openBooksLib.openInOtherWindowMessage(bookPath)
      );
    }
    const data = await storage.openBook(bookPath);
    if (session) {
      const registered = storage.registerOpenBook(session.id, bookPath);
      if (!registered.ok) {
        focusSession(sessionById(registered.ownerWindowId));
        throw new storage.StorageError(registered.code, registered.message);
      }
    }
    const meta = data && data.meta;
    if (meta && Array.isArray(meta.chapters) && meta.chapters.length) {
      let index = meta.chapters.findIndex((chapter) => chapter && chapter.id === meta.lastOpenChapterId);
      if (index < 0) index = 0;
      const chapter = meta.chapters[index];
      await rememberRecentBook(bookPath, {
        title: meta.title,
        chapterId: chapter.id,
        chapterIndex: index,
        chapterName: chapter.name
      });
    }
    return data;
  });
  handleBook('book:verify', async (bookPath) => storage.verifyBook(bookPath));
  handleBook('book:rename', async (bookPath, title) => storage.renameBook(bookPath, title), {
    mutation: 'rename'
  });
  // 书籍信息（v0.8-3）：作者 / 简介 / 分组 / 标签只写 书目.json 的可选字段，不动书文件夹 / 章节文件。
  handleBook('book:update-info', async (bookPath, patch) => storage.updateBookInfo(bookPath, patch), {
    mutation: 'write'
  });
  handleBook('book:set-last', async (bookPath, chapterId) => {
    const info = await storage.setLastOpenChapter(bookPath, chapterId);
    if (info && info.ok) await rememberRecentBook(bookPath, info);
    return info;
  }, { mutation: 'save' });

  handleBook('chapter:load', async (bookPath, file) => storage.loadChapterText(bookPath, file));
  handleBook('chapter:stat', async (bookPath, file) => storage.statChapter(bookPath, file));

  // 正文排版整理：纯文本变换，只计算不写盘（写盘仍由作者 Ctrl+S 决定）
  handle('text:format', async (text, options) => {
    assertText(text);
    return formatLib.formatText(text, options);
  });

  // 校对（提案 5.1 / N6）：只报告、不改动。当前章正文由渲染层传上来（和查找一样，不读盘）；
  // 整本版走 book:proofread，逐章只读磁盘。index 是归一 CRLF 后的字符位置，可直接选中。
  // 校对词表（可选，作者自己的错别字 / 禁用词）存在 config 里，主进程只读；渲染层不传路径。
  handle('text:proofread', async (text, options) => {
    assertText(text);
    const cfg = await getConfig();
    const list = await glossaryLib.readGlossaryFile(cfg.proofreadWordsPath);
    const wordList = glossaryLib.publicGlossaryInfo(list);
    const result = proofreadLib.proofreadText(text, options, list.ok ? list.entries : []);
    return { ...result, wordList };
  });

  // 校对词表状态（只读）：只给渲染层数量与错误提示，绝不带词表正文
  handle('proofread:words-info', async () => {
    const cfg = await getConfig();
    return glossaryLib.publicGlossaryInfo(await glossaryLib.readGlossaryFile(cfg.proofreadWordsPath));
  });

  // 选词表（校对 / 敏感词共用）：只允许通过系统文件对话框选，渲染层不能自己指定路径去读任意文件。
  // read 负责把选中的文件解析成「公开信息」（只含数量 / 提示，绝不含词表正文）。
  // field：这个对话框选出来的路径属于配置里的哪一项（v0.9 C-2b 的来源校验靠它记账——
  // 设置里点「选择…」→ 主进程记下这次选中的文件 → config:set 才允许写进配置）。
  async function pickWordListFile({ title, read, field }) {
    const { canceled, filePaths } = await showOpenDialog({
      title,
      buttonLabel: '使用这个词表',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    rememberPickedConfigPath(field, filePaths[0]);
    return { canceled: false, ...(await read(filePaths[0])) };
  }

  // 选校对词表：只允许通过系统对话框选（渲染层不能自己指定路径去读任意文件）
  handle('proofread:pick-words', async () => {
    return pickWordListFile({
      title: '选择校对词表（每行一个词，可写「错词 → 建议」）',
      field: 'proofreadWordsPath',
      read: async (filePath) => glossaryLib.publicGlossaryInfo(await glossaryLib.readGlossaryFile(filePath))
    });
  });

  // 敏感词预检（提案 5.2）：词表完全由作者管理，应用不内置任何词表。
  // 词表路径存在 config 里（渲染层不传路径）；这里只读词表、只报告命中，绝不改正文、不写盘。
  // 渲染层也拿不到词表内容——只回数量与状态（publicWordListInfo 会剥掉 words）。
  handle('sensitive:words-info', async () => {
    const cfg = await getConfig();
    return sensitiveLib.publicWordListInfo(await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath));
  });

  // 选敏感词表：只允许通过系统对话框选（渲染层不能自己指定路径去读任意文件）
  handle('sensitive:pick-words', async () => {
    return pickWordListFile({
      title: '选择敏感词表（每行一个词）',
      field: 'sensitiveWordsPath',
      read: async (filePath) => sensitiveLib.publicWordListInfo(await sensitiveLib.readWordListFile(filePath))
    });
  });

  handle('text:sensitive-check', async (text, options) => {
    assertText(text);
    const cfg = await getConfig();
    const list = await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath);
    const wordList = sensitiveLib.publicWordListInfo(list);
    if (!list.ok) return { ok: false, code: list.code, message: list.message, wordList };
    const result = sensitiveLib.scanText(text, list.words, options);
    return { ok: true, ...result, wordList };
  });

  // 朗读（提案 5.3）：只把正文切成「一段一段」，发声由渲染层交给系统语音（speechSynthesis）。
  // 主进程不读盘、不写盘；chunks 的 start/end 与编辑区 value 一致，供点击 / 跟随高亮定位。
  handle('text:tts-chunks', async (text, options) => {
    assertText(text);
    return ttsLib.buildChunks(text, options);
  });

  // 当前章的查找 / 替换（只算文本，不写盘；全书版本走 book:search / book:replace）
  // v0.9 C-5：查找词 / 替换词也走上限（1 万字），替换结果按「原文 + 命中 × 增长」估算，
  // 超过 2000 万字先拒绝，不生成那个字符串（一处换一万字 × 五千处 = 5 千万字起步）。
  handle('text:find', async (text, query, options) => {
    assertText(text);
    const matches = findLib.findMatches(text, ipcLimits.assertQuery(query), options);
    return {
      count: matches.length,
      matches: matches.slice(0, 12).map((match) => ({
        index: match.index,
        length: match.length,
        ...findLib.makeSnippet(text, match.index, match.length, 18)
      }))
    };
  });

  // 当前章全部命中（v0.8-11，提案 N11）：给「上一处 / 下一处 + 结果持续高亮」用。
  // 和 text:find 的区别：不截断成 12 条、不带上下文，只回下标和长度；命中上限仍是 5000 处，
  // 到上限还多找出一处时明确回 truncated（界面据此提示「命中太多」）。只算文本，不读盘、不写盘。
  handle('text:find-all', async (text, query, options) => {
    assertText(text);
    const result = findLib.findMatchesAll(text, ipcLimits.assertQuery(query), options);
    return { count: result.matches.length, truncated: result.truncated, matches: result.matches };
  });

  handle('text:replace', async (text, query, replacement, options) => {
    assertText(text);
    const wanted = ipcLimits.assertQuery(query);
    const insert = ipcLimits.assertReplacement(replacement);
    const findOptions = { caseSensitive: Boolean(options && options.caseSensitive) };
    // 替换词比查找词长时才可能放大；这时先数一遍命中（最多 5000 处）再估结果长度。
    // 替换词不长于查找词时结果只会变短 / 不变，不用多扫一遍。
    if (insert.length > wanted.length) {
      const found = findLib.findMatches(text, wanted, findOptions);
      ipcLimits.assertReplaceOutput(text.length, found.length, wanted.length, insert.length);
    }
    return findLib.replaceAllLiteral(text, wanted, insert, findOptions);
  });

  // Ctrl+G 跳章：纯匹配（章号 / 章名关键词），不读盘、不写盘。规则在 core/jump.js，单测覆盖。
  // v0.9 C-5：章节列表由 core/ipc-limits.js 清洗——只留前 20000 条、每条只留 id / name（各限长），
  // 坏条目变成 null 被 core/jump.js 跳过；非数组仍是 BAD_CHAPTERS（文案不变）。
  handle('jump:match', async (chapters, query, options) => {
    return jumpLib.findMatches(ipcLimits.sanitizeChapterList(chapters), query, options);
  });

  // 「只替换这一处」：从编辑区光标位置往后找下一处命中（纯计算，不写盘）
  handle('text:find-next', async (text, query, fromIndex, options) => {
    assertText(text);
    return findLib.findNextMatch(text, ipcLimits.assertQuery(query), fromIndex, options);
  });

  handleBook('chapter:save', async (bookPath, chapterId, text) => {
    const session = flowSession();
    return storage.withBookLock(bookPath, async () => {
      const cfg = await getConfig();
      // 保存前校验（写盘安全检查）：书文件夹、书目、章节记录、章节文件都还在才允许写，
      // 且书不能正开在另一个窗口。任何一项失效都报错，绝不 mkdir 重建影子文件。
      const prepared = await storage.prepareChapterSave(bookPath, chapterId, {
        windowId: session ? session.id : null
      });
      const meta = prepared.meta;
      const chapter = prepared.chapter;
      // 每日字数的「上次已知值」：优先书目里缓存的正文字符数；缓存缺失（老书/新章）时
      // 只在这一次读一遍旧文件，保证第一次保存的增量仍然准确。
      let previousChars = null;
      if (chapter.chars != null && chapter.chars !== '' && Number.isFinite(Number(chapter.chars))) {
        previousChars = Math.max(0, Math.round(Number(chapter.chars)));
      } else {
        try {
          const previous = await storage.loadChapterText(bookPath, chapter.file);
          previousChars = chaptersLib.countChars(previous.text);
        } catch {
          previousChars = null; // 旧文件读不到就当「不知道」，这次不计入统计
        }
      }
      // 可选每日快照：在写正文之前复制「上一版」。默认关；失败只记原因，绝不阻塞保存。
      let snapshot = { taken: false, reason: 'DISABLED', dir: null, file: chapter.file, bytes: 0, cleanup: null };
      if (cfg.snapshotEnabled) {
        try {
          snapshot = await storage.takeDailySnapshot(bookPath, chapter.file, {
            keepDays: cfg.snapshotKeepDays,
            now: new Date()
          });
        } catch (err) {
          snapshot = {
            taken: false,
            reason: 'ERROR',
            message: errorText.describeForUi(err).message,
            dir: null,
            file: chapter.file,
            bytes: 0,
            cleanup: null
          };
        }
      }
      const result = await storage.saveChapterText(bookPath, chapter.file, String(text == null ? '' : text), {
        ensureDir: false
      });
      // 同步章节字数缓存，书架就不用为了算字数去重读整本书
      chapter.chars = result.chars;
      await storage.writeBookMeta(bookPath, meta, { ensureDir: false });
      // 正文变了：告诉搜索索引这本书要重建（不 await，索引更新绝不能拖慢 / 挡住保存）
      try {
        getSearchIndexStore().markDirty(bookPath);
      } catch {
        /* 索引不可用时忽略 */
      }
      // 每日字数统计：只记这次保存带来的正字数增量（删字不扣今天的进度）。
      // 统计写盘失败绝不影响正文保存，只把原因带回去（界面不提示）。
      let stats = null;
      let statsDelta = 0;
      let statsError = null;
      try {
        if (previousChars !== null && result.chars > previousChars) statsDelta = result.chars - previousChars;
        const recorded = await getStatsStore().record({
          day: statsLib.localDayKey(),
          bookId: meta.id,
          delta: statsDelta
        });
        stats = statsSummaryPayload(recorded.stats, cfg);
      } catch (err) {
        statsError = err.message;
      }
      // 保存也算「写作过」：书架「继续上次写作」的时间戳跟着更新（只写配置，不碰书库）
      await rememberRecentBook(bookPath, {
        title: meta.title,
        chapterId: chapter.id,
        chapterIndex: meta.chapters.indexOf(chapter),
        chapterName: chapter.name
      });
      if (session) storage.openBookRegistry.touch(session.id);
      return { ...result, file: chapter.file, snapshot, stats, statsDelta, statsError };
    });
  });

  // 自定义正文字体：只允许字体文件，读成 base64 交给渲染层的 FontFace 加载（渲染层仍无 fs）
  // 代码审计 F1：font:pick 选中的路径只记在内存里（按窗口分开），font:read 只认「这次选的 /
  // 当前书的 bookDisplay / 全局配置」这三种主进程自己知道的路径，渲染层传进来的路径一律不看。
  const pickedFontPaths = new Map(); // windowId -> 本次在对话框里选中的字体路径

  function rememberPickedFont(windowId, fontPath) {
    const id = String(windowId == null ? '' : windowId);
    if (!id) return;
    const picked = typeof fontPath === 'string' ? fontPath.trim() : '';
    if (!picked) {
      pickedFontPaths.delete(id);
      return;
    }
    pickedFontPaths.set(id, picked);
  }

  // 读一次就清掉：选字体后的那一趟「预览」读到文件即用完；之后按书目 / 全局配置解析，
  // 免得同一个窗口里换书时把上一本书刚选的字体带过去。
  function takePickedFont(windowId) {
    const id = String(windowId == null ? '' : windowId);
    if (!id) return '';
    const picked = pickedFontPaths.get(id) || '';
    pickedFontPaths.delete(id);
    return picked;
  }

  handle('font:pick', async () => {
    const session = flowSession();
    const { canceled, filePaths } = await showOpenDialog({
      title: '选择正文字体文件',
      buttonLabel: '使用这个字体',
      properties: ['openFile'],
      filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'ttc'] }]
    });
    if (canceled || !filePaths || !filePaths.length) {
      if (session) rememberPickedFont(session.id, '');
      return { canceled: true };
    }
    const picked = filePaths[0];
    if (session) rememberPickedFont(session.id, picked);
    return { canceled: false, path: picked, name: path.basename(picked) };
  });

  handle('font:read', async () => {
    const session = flowSession();
    const picked = takePickedFont(session && session.id);
    const cfg = await getConfig();
    let bookEntry = null;
    const openBookPath = session ? storage.openBookRegistry.getBook(session.id) : null;
    if (openBookPath) {
      try {
        const meta = await storage.readBookMeta(openBookPath);
        const bookId = meta && meta.id ? String(meta.id) : '';
        if (bookId) bookEntry = (cfg.bookDisplay && cfg.bookDisplay[bookId]) || null;
      } catch {
        // 书目读不到就按全局设置来：字体加载失败最多退回内置字体，不影响打开书 / 写作
        bookEntry = null;
      }
    }
    const source = fontPolicy.resolveFontSource({ picked, book: bookEntry, global: cfg });
    if (!source.path) {
      throw new storage.StorageError('BAD_FONT', '还没有可用的自定义字体，请先在设置里选择字体文件');
    }
    const resolved = path.resolve(source.path);
    if (!fontPolicy.isFontFile(resolved)) {
      throw new storage.StorageError('BAD_FONT', '只支持 .ttf / .otf / .ttc 字体文件');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new storage.StorageError('BAD_FONT', '选中的不是一个字体文件');
    if (!fontPolicy.isFontSizeAllowed(stat.size)) {
      throw new storage.StorageError('FONT_TOO_BIG', '字体文件太大（超过 24MB），请换一个小一点的');
    }
    const buffer = await fs.readFile(resolved);
    return {
      name: path.basename(resolved),
      size: stat.size,
      base64: buffer.toString('base64'),
      path: resolved,
      source: source.source
    };
  });

  if (automation) {
    // 仅自检：模拟「在系统字体对话框里选中某个文件」（E2E 没法真的点原生对话框）。
    // 和 update:test-mock 一样只在 automation 下注册，生产环境这个频道不存在。
    handle('font:test-pick', async (fontPath) => {
      const session = flowSession();
      const picked = typeof fontPath === 'string' ? fontPath.trim() : '';
      if (!session || !picked) return false;
      rememberPickedFont(session.id, picked);
      return { path: path.resolve(picked), name: path.basename(picked) };
    });
  }

  handleBook('chapter:create', async (bookPath, insertIndex, name, volumeId) =>
    storage.createChapter(bookPath, insertIndex, name, volumeId), { mutation: 'write' }
  );
  handleBook('chapter:rename', async (bookPath, chapterId, name) =>
    storage.renameChapter(bookPath, chapterId, name), { mutation: 'rename' }
  );
  // 章节状态 / 备注：只改书目可选字段（txt 不动）
  handleBook('chapter:update-meta', async (bookPath, chapterId, patch) =>
    storage.updateChapterMeta(bookPath, chapterId, patch), { mutation: 'write' }
  );
  handleBook('chapter:delete', async (bookPath, chapterId) => storage.deleteChapter(bookPath, chapterId), {
    mutation: 'delete'
  });
  handleBook('chapter:move', async (bookPath, chapterId, toIndex) =>
    storage.moveChapter(bookPath, chapterId, toIndex), { mutation: 'write' }
  );
  // 分卷：新建 / 改名 / 删除（章节回未分卷，不删章）/ 把章移到别的卷
  handleBook('volume:create', async (bookPath, name) => storage.createVolume(bookPath, name), {
    mutation: 'write'
  });
  handleBook('volume:rename', async (bookPath, volumeId, name) =>
    storage.renameVolume(bookPath, volumeId, name), { mutation: 'write' }
  );
  handleBook('volume:delete', async (bookPath, volumeId) => storage.deleteVolume(bookPath, volumeId), {
    mutation: 'write'
  });
  handleBook('chapter:move-to-volume', async (bookPath, chapterId, volumeId) =>
    storage.moveChapterToVolume(bookPath, chapterId, volumeId), { mutation: 'write' }
  );
  handleBook('volume:move', async (bookPath, volumeId, toIndex) =>
    storage.moveVolume(bookPath, volumeId, toIndex), { mutation: 'write' }
  );
  handleBook('chapter:move-to', async (bookPath, chapterId, volumeId, beforeChapterId) =>
    storage.moveChapterTo(bookPath, chapterId, volumeId, beforeChapterId), { mutation: 'write' }
  );

  // 全书查找 / 替换：替换写盘前 storage 会把原章节备份到书内 _trash。
  // v0.9 C-5：options 由 core/ipc-limits.js 清洗——查找词 / 替换词必须是文本且各限 1 万字，
  // 非对象 options 按 {}（旧行为：没传选项 = 默认口径），坏类型直接回 BAD_QUERY / BAD_REPLACEMENT，
  // 不让一个超长替换词把整本书的 txt 撑爆（替换最多 5000 处 / 章）。
  handleBook('book:search', async (bookPath, options) =>
    storage.searchBook(bookPath, ipcLimits.sanitizeSearchOptions(options))
  );
  handleBook('book:replace', async (bookPath, options) =>
    storage.replaceInBook(bookPath, ipcLimits.sanitizeReplaceOptions(options)), {
    mutation: 'replace'
  });

  // 整本检查（校对 / 敏感词）共用：逐章读正文；当前章用 override 的最新内容；
  // 缺文件的章节跳过并计数（不让整本检查失败）。只读，不写盘。
  async function walkChapterTexts(bookPath, meta, override, onChapter) {
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    let skippedChapters = 0;
    for (let index = 0; index < meta.chapters.length; index += 1) {
      const chapter = meta.chapters[index];
      let text;
      if (index === overrideIndex) {
        text = override.text;
      } else {
        try {
          text = (await storage.loadChapterText(bookPath, chapter.file)).text;
        } catch (err) {
          if (err.code === 'CHAPTER_MISSING') {
            skippedChapters += 1;
            continue;
          }
          throw err;
        }
      }
      onChapter(text, chapter, index);
    }
    return skippedChapters;
  }

  // 校对整本（提案 5.1）：逐章只读正文，按 core/proofread.js 的规则列出可疑位置；
  // 全程不写盘。当前章未保存的内容用 override 传进来（和导出同一个惯例：只参与这一次检查）。
  // 每章最多保留 maxIssues 条明细，整本明细上限 1500 条，但总数 / 各规则条数照实统计。
  handleBook('book:proofread', async (bookPath, options, override) => {
    const meta = await storage.readBookMeta(bookPath);
    // v0.9 C-5：当前章未保存内容（override）先过边界（坏形状当没有；正文超 500 万字拒绝）
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const limits = proofreadLib.sanitizeOptions(options);
    // 校对词表只读一次，整本每章共用（没设置 / 读不了 = 只跑内置五条规则，面板会提示）
    const cfg = await getConfig();
    const list = await glossaryLib.readGlossaryFile(cfg.proofreadWordsPath);
    const wordList = glossaryLib.publicGlossaryInfo(list);
    const customEntries = list.ok ? list.entries : [];
    const BOOK_ISSUE_LIMIT = 1500;
    const byRule = {};
    for (const rule of proofreadLib.RULE_ORDER) byRule[rule] = 0;
    const chapters = [];
    const issues = [];
    let total = 0;
    let truncated = false;
    const skippedChapters = await walkChapterTexts(bookPath, meta, safeOverride, (text, chapter, index) => {
      const result = proofreadLib.proofreadText(text, limits, customEntries);
      total += result.total;
      for (const rule of proofreadLib.RULE_ORDER) byRule[rule] += result.byRule[rule] || 0;
      if (result.total) {
        chapters.push({
          chapterId: chapter.id,
          chapterIndex: index,
          name: chapter.name,
          total: result.total,
          byRule: result.byRule,
          truncated: result.truncated
        });
      }
      if (result.truncated) truncated = true;
      for (const issue of result.issues) {
        if (issues.length >= BOOK_ISSUE_LIMIT) {
          truncated = true;
          break;
        }
        issues.push({
          ...issue,
          chapterId: chapter.id,
          chapterIndex: index,
          chapterName: chapter.name
        });
      }
    });
    return {
      scope: 'book',
      total,
      byRule,
      issues,
      chapters,
      chapterCount: meta.chapters.length,
      // 有问题的章数（chapters 只收有问题的章）
      chapterHitCount: chapters.length,
      skippedChapters,
      truncated: truncated || total > issues.length,
      wordList,
      customWordCount: customEntries.length,
      options: limits
    };
  });

  // 敏感词预检整本（提案 5.2）：逐章只读磁盘，按作者词表列出命中；全程不写盘。
  // 当前章未保存的内容用 override 传进来（只参与这一次检查，和导出 / 校对同一个惯例）。
  // 每章明细上限由 core/sensitive.js 的 maxIssues 控制，整本明细上限 1500 条，但总数照实统计。
  handleBook('book:sensitive-check', async (bookPath, options, override) => {
    const cfg = await getConfig();
    const list = await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath);
    const wordList = sensitiveLib.publicWordListInfo(list);
    if (!list.ok) return { ok: false, code: list.code, message: list.message, wordList };
    const meta = await storage.readBookMeta(bookPath);
    // v0.9 C-5：override 与上面校对同一条边界（坏形状当没有；正文超 500 万字拒绝）
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const limits = sensitiveLib.sanitizeOptions(options);
    const matches = [];
    const chapters = [];
    const byWordMap = new Map();
    let total = 0;
    let truncated = false;
    const skippedChapters = await walkChapterTexts(bookPath, meta, safeOverride, (text, chapter, index) => {
      const result = sensitiveLib.scanText(text, list.words, limits);
      total += result.total;
      for (const item of result.byWord) {
        byWordMap.set(item.word, (byWordMap.get(item.word) || 0) + item.count);
      }
      if (result.total) {
        chapters.push({
          chapterId: chapter.id,
          chapterIndex: index,
          name: chapter.name,
          total: result.total,
          truncated: result.truncated
        });
      }
      if (result.truncated) truncated = true;
      for (const match of result.issues) {
        if (matches.length >= sensitiveLib.BOOK_ISSUE_LIMIT) {
          truncated = true;
          break;
        }
        matches.push({
          ...match,
          chapterId: chapter.id,
          chapterIndex: index,
          chapterName: chapter.name
        });
      }
    });
    const byWord = Array.from(byWordMap, ([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
      .slice(0, sensitiveLib.BY_WORD_LIMIT);
    return {
      ok: true,
      scope: 'book',
      total,
      matches,
      byWord,
      wordHitCount: byWordMap.size,
      wordCount: list.words.length,
      chapters,
      chapterCount: meta.chapters.length,
      // 有命中的章数（chapters 只收有命中的章）
      chapterHitCount: chapters.length,
      skippedChapters,
      truncated: truncated || total > matches.length,
      wordList,
      options: limits
    };
  });

  // 整本替换的还原：列出 / 还原书内 _trash/替换备份-*/（还原前把当前内容再备份一份）
  handleBook('book:list-replace-backups', async (bookPath) => storage.listReplaceBackups(bookPath));
  handleBook('book:restore-replace-backup', async (bookPath, backupName) =>
    storage.restoreReplaceBackup(bookPath, backupName), { mutation: 'replace' }
  );

  // 本书历史：统一列出 / 预览 / 还原书内 _trash 的各种备份（替换/整理/还原前/快照/删章 + 书目.json.bak）
  handleBook('book:list-history', async (bookPath) => storage.listBookHistory(bookPath));
  handleBook('book:preview-history-file', async (bookPath, groupId, fileName) =>
    storage.previewHistoryFile(bookPath, groupId, fileName)
  );
  handleBook('book:restore-history-file', async (bookPath, groupId, fileName) =>
    storage.restoreHistoryFile(bookPath, groupId, fileName), { mutation: 'write' }
  );
  handleBook('book:restore-history-dir', async (bookPath, groupId) =>
    storage.restoreHistoryGroup(bookPath, groupId), { mutation: 'write' }
  );

  // 整本智能排版：预检查只算不写；正式整理逐章写盘（写前把原章节备份到 _trash/整理备份-*）
  handleBook('book:format-preview', async (bookPath, options) =>
    storage.previewFormatBook(bookPath, options)
  );
  handleBook('book:format', async (bookPath, options) =>
    storage.formatBook(bookPath, options, (progress) => {
      sendToFlow('format:progress', progress);
    }), { mutation: 'format' }
  );

  // 拼导出/复制用的正文：默认读磁盘；override 是编辑区里当前章的最新内容（未保存也算，只参与拼接不写盘）
  // chars 回报的是「正文字数」（去掉空白/换行，和编辑页字数统计同一口径），不是文件字节数
  // indexes 可选：只读选中的章（按范围导出用），没选中的位置留空字符串但保持下标对齐
  async function collectExportTexts(bookPath, meta, override, indexes) {
    const selected = Array.isArray(indexes) ? new Set(indexes) : null;
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    const texts = [];
    let chars = 0;
    for (let i = 0; i < meta.chapters.length; i += 1) {
      if (selected && !selected.has(i)) {
        texts.push('');
        continue;
      }
      let text;
      if (i === overrideIndex) {
        text = override.text;
      } else {
        text = (await storage.loadChapterText(bookPath, meta.chapters[i].file)).text;
      }
      texts.push(text);
      chars += chaptersLib.countChars(text);
    }
    return {
      texts,
      chars,
      includedUnsaved: overrideIndex >= 0 && (!selected || selected.has(overrideIndex))
    };
  }

  // 导出范围预览（只读）：对话框里实时显示「选中几章 / 多少字 / 默认文件名」。
  // 字数优先用书目里的 chars 缓存求和（审计 F3）；缓存缺失 / 坏值才读盘现算，
  // 编辑区里当前章的未保存内容（override）永远现算。正式导出仍读全文，不受这里影响。
  // v0.9 C-5：override / range 先过 core/ipc-limits.js——正文超过 500 万字报 TEXT_TOO_LARGE，
  // 坏形状按旧行为降级（override 当没有、range 当全书 / 越界收紧）。
  handleBook('book:export-plan', async (bookPath, override, range) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    const overrideIndex = exporter.chapterIndexOf(meta, safeOverride);
    let chars = 0;
    for (const index of plan.indexes) {
      if (index === overrideIndex) {
        chars += chaptersLib.countChars(safeOverride.text);
        continue;
      }
      const chapter = meta.chapters[index];
      const cached = exporter.cachedCharsOf(chapter);
      if (cached != null) {
        chars += cached;
        continue;
      }
      const text = (await storage.loadChapterText(bookPath, chapter.file)).text;
      chars += chaptersLib.countChars(text);
    }
    return {
      mode: plan.mode,
      label: plan.label,
      chapterCount: plan.count,
      chars,
      from: plan.from,
      to: plan.to,
      volumeId: plan.volumeId,
      empty: plan.empty,
      fileName: exporter.exportFileName(meta, safeRange),
      epubFileName: epubLib.epubFileName(meta, safeRange),
      docxFileName: docxLib.docxFileName(meta, safeRange),
      includedUnsaved: overrideIndex >= 0 && plan.indexes.includes(overrideIndex)
    };
  });

  // 目录是否存在（导出默认目录兜底用）：读不到就当不存在
  function isDirectory(dir) {
    try {
      return fsSync.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }

  // 导出 TXT / EPUB / DOCX 共用的前置：读书目 → 解析范围（空范围明确报错）→ 拼正文
  // → 准备「上次导出目录 / 文档」作为默认落点。三个入口只负责各自的保存对话框、格式细节与返回字段。
  // v0.9 C-5：override / range 在这里统一过 core/ipc-limits.js（超长正文拒绝、坏形状降级），
  // 三个导出与下面的复制 / 校对 / 敏感词预检共用同一套口径，避免某个入口漏掉。
  async function prepareExport(bookPath, override, range) {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    if (!plan.count) {
      throw new storage.StorageError(
        'EMPTY_EXPORT_RANGE',
        plan.mode === 'all' ? '这本书里还没有章节' : '所选范围里没有章节'
      );
    }
    const { texts, chars, includedUnsaved } = await collectExportTexts(
      bookPath,
      meta,
      safeOverride,
      plan.indexes
    );
    const cfg = await getConfig();
    // 默认落到「上一次导出保存到的目录」；没记过、或那个目录已经不存在了，才退回「文档」
    const defaultDir = exporter.resolveExportDir(cfg.lastExportDir, app.getPath('documents'), isDirectory);
    return { meta, plan, texts, chars, includedUnsaved, cfg, defaultDir, range: safeRange };
  }

  // EPUB / DOCX 导出成功后的返回字段（两个入口完全一致，只是 built 来自不同的纯函数）
  function archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan) {
    return {
      canceled: false,
      filePath,
      chapterCount: built.chapterCount,
      volumeCount: built.volumeCount,
      chars,
      includedUnsaved,
      bytes: built.bytes,
      conversion,
      rangeLabel: plan.label
    };
  }

  handleBook('book:export', async (bookPath, override, range) => {
    const { meta, plan, texts, chars, includedUnsaved, cfg, defaultDir, range: safeRange } = await prepareExport(
      bookPath,
      override,
      range
    );
    // 文件名默认带上范围：书名.txt / 书名-卷名.txt / 书名-第X-Y章.txt（可在保存对话框里改）
    const defaultName = exporter.exportFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 TXT',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    const composed = exporter.composeBook(meta, texts, safeRange);
    // 简繁转换只作用于这份导出副本：字数仍按原稿算，磁盘上的章节 txt / 书目一个字节都不动
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    const text = s2tLib.convertText(composed, conversion);
    await atomicWriteFile(filePath, exporter.exportBufferFromText(text));
    // 记住这次导出的目录，下次导出默认还开在这里（记不住也不影响导出结果）
    await rememberExportDir(path.dirname(filePath));
    return {
      canceled: false,
      filePath,
      chapterCount: plan.count,
      chars,
      includedUnsaved,
      rangeLabel: plan.label,
      conversion
    };
  });

  // 导出 EPUB（提案 6.3 / v0.8 P0 N8）：整本或按卷 / 按章节范围 → 一本 EPUB 3
  // （分卷做目录级、一章一个 XHTML、没有封面图就生成纯文字封面页）。排版沿用「段首缩进 + 空一行」，
  // 由 EPUB 里的 CSS 控制，不动任何 txt 字节。和 TXT 导出一样：当前章未保存的内容参与拼接、只读、原子写盘。
  // range 不传 = 全书；只把选中的章节读出来打进包里，章号仍按全书顺序。
  handleBook('book:export-epub', async (bookPath, override, range) => {
    const { meta, plan, texts, chars, includedUnsaved, cfg, defaultDir, range: safeRange } = await prepareExport(
      bookPath,
      override,
      range
    );
    const defaultName = epubLib.epubFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 EPUB',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // 简繁转换：书名 / 卷名 / 章名 / 正文都换成导出用的副本，目录和正文才一致；
    // 书目与章节 txt 一概不动（chars 仍按原稿字数算）。
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    const exportMeta = s2tLib.convertMeta(meta, conversion);
    const exportTexts = conversion
      ? texts.map((text) => s2tLib.convertText(text, conversion))
      : texts;
    const built = epubLib.buildEpub({ meta: exportMeta, texts: exportTexts, range: safeRange });
    await atomicWriteFile(filePath, built.buffer);
    await rememberExportDir(path.dirname(filePath));
    return archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan);
  });

  // 导出 DOCX（v0.8 P0 N9）：整本或按卷 / 按章节范围 → 一份 Word 能直接打开的书稿。
  // 和 EPUB 导出同一套规则：范围解析复用 exporter.resolveExportRange，只读选中的章，
  // 章号 / 章名仍按全书顺序；当前章未保存内容参与、只读、原子写盘、简繁转换只作用于副本。
  handleBook('book:export-docx', async (bookPath, override, range) => {
    const { meta, plan, texts, chars, includedUnsaved, cfg, defaultDir, range: safeRange } = await prepareExport(
      bookPath,
      override,
      range
    );
    const defaultName = docxLib.docxFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 DOCX',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'Word 文档', extensions: ['docx'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // 简繁转换：书名 / 卷名 / 章名 / 正文都换成导出用的副本（书目与章节 txt 一概不动）
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    const exportMeta = s2tLib.convertMeta(meta, conversion);
    const exportTexts = conversion
      ? texts.map((text) => s2tLib.convertText(text, conversion))
      : texts;
    const built = docxLib.buildDocx({ meta: exportMeta, texts: exportTexts, range: safeRange });
    await atomicWriteFile(filePath, built.buffer);
    await rememberExportDir(path.dirname(filePath));
    return archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan);
  });

  handleBook('book:copy', async (bookPath, override) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const { texts, chars, includedUnsaved } = await collectExportTexts(bookPath, meta, safeOverride);
    const text = exporter.composeBook(meta, texts);
    await activeClipboard.writeText(text);
    return { chapterCount: meta.chapters.length, chars, includedUnsaved };
  });

  // 复制本章（平台格式）：只取这一章的正文，段首缩进两个全角空格、段间空一行（空行也带缩进），
  // 直接进剪贴板；不写盘。ref = { chapterId?, chapterFile?, text? }：
  // 带了 text 就用它（编辑区里当前章未保存的最新内容，沿用户导出惯例），没带就读磁盘。
  handleBook('chapter:copy-platform', async (bookPath, ref) => {
    const safeRef = ipcLimits.sanitizeOverride(ref);
    const meta = await storage.readBookMeta(bookPath);
    const index = exporter.chapterRefIndex(meta, safeRef);
    if (index < 0) throw new storage.StorageError('CHAPTER_NOT_FOUND', '找不到这一章（可能刚被删除）');
    const chapter = meta.chapters[index];
    const fromEditor = Boolean(safeRef && typeof safeRef.text === 'string');
    const text = fromEditor
      ? safeRef.text
      : (await storage.loadChapterText(bookPath, chapter.file)).text;
    const result = exporter.platformChapterText(text);
    const title = chaptersLib.formatTitle(meta, index, chapter.name);
    if (result.empty) {
      // 空章不覆盖剪贴板：免得把作者刚复制的东西冲掉
      return { empty: true, title, paragraphs: 0, chars: 0, includedUnsaved: fromEditor };
    }
    await activeClipboard.writeText(result.text);
    return {
      empty: false,
      title,
      paragraphs: result.paragraphs,
      chars: result.chars,
      includedUnsaved: fromEditor
    };
  });

  handleBook('book:repair', async (bookPath, mode) => {
    if (mode === 'bak') return repair.restoreFromBak(bookPath);
    if (mode === 'rebuild') return repair.rebuildFromFiles(bookPath);
    throw new storage.StorageError('BAD_MODE', `未知的修复方式：${mode}`);
  }, { mutation: 'write' });

  handle('book:import', async (explicitPaths, options) => {
    // 路径入口（v0.9 C-2）：导入目录的唯一正当来源是下面这个系统对话框。
    // 渲染层如果自己传了目录，只有 automation（自检 / 截图）才认；生产环境一律拒（BAD_IMPORT_PATH），
    // 免得被注入的脚本让主进程把任意文件夹（桌面 / 别的盘 / D:\我的小说）复制进书架。
    let dirs = ipcPaths.importSourceDirs(explicitPaths, { allowExplicit: automation });
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    if (!dirs.length) {
      const { canceled, filePaths } = await showOpenDialog({
        title: '导入小说（选择一个或多个书文件夹）',
        buttonLabel: '导入',
        properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
      });
      if (canceled || !filePaths || !filePaths.length) {
        return { canceled: true, imported: [], skipped: [], failed: [] };
      }
      dirs = filePaths;
    }
    // 导入会往书库里写文件夹：目标正好是别的窗口正开着的书 → 拒绝（「导入覆盖」也要拦）
    const session = flowSession();
    for (const sourceDir of dirs) {
      const base = path.basename(path.resolve(String(sourceDir)));
      const target = path.join(cfg.booksRoot, base);
      const owner = storage.findOpenBookWindow(target);
      if (owner && (!session || String(owner) !== String(session.id))) {
        throw new storage.StorageError(
          'CROSS_WINDOW_BUSY',
          `导入目标「${base}」正在另一个窗口打开。请先关掉另一个窗口，或先切换到那个窗口后再导入。`
        );
      }
    }
    const imported = await importer.importFolders(cfg.booksRoot, dirs, {
      mode: options && options.mode,
      onProgress: (progress) => {
        sendToFlow('import:progress', progress);
      }
    });
    notifyShelfChanged(session, 'book:import');
    return imported;
  });

  handleBook('book:delete', async (bookPath) => {
    const session = flowSession();
    const cfg = await getConfig();
    const root = path.resolve(cfg.booksRoot);
    const target = path.resolve(String(bookPath || ''));
    if (path.dirname(target).toLowerCase() !== root.toLowerCase()) {
      throw new storage.StorageError('BAD_PATH', '只能删除书架目录下的书');
    }
    // 别的窗口正开着这本书：拒绝，绝不让它在另一个窗口里继续盯着被删的文件夹
    if (!(await storage.exists(target))) {
      throw new storage.StorageError('NOT_FOUND', '这本书的文件夹已经不存在了');
    }
    let result;
    // 测试环境用固定兜底路径，避免把测试数据丢进你的回收站
    if (isE2E) {
      const trashPath = await storage.trashBook(cfg.booksRoot, target);
      result = { method: 'move', folder: path.basename(target), trashPath };
    } else {
      try {
        await shell.trashItem(target);
        result = { method: 'recycle', folder: path.basename(target) };
      } catch (err) {
        const trashPath = await storage.trashBook(cfg.booksRoot, target);
        result = {
          method: 'move',
          folder: path.basename(target),
          trashPath,
          note: `回收站不可用（${errorText.describeForUi(err).message}），已移到书架的 _trash`
        };
      }
    }
    // 删除成功：清掉可能存在的登记（自己的 / 残留的）；书架变动的广播由 handleBook 统一发
    storage.releaseOpenBookPath(target);
    return result;
  }, { mutation: 'delete' });

  handle('shell:pick-folder', async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: '选择书架目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    // v0.9 C-2b：书架目录同样只认这次对话框选中的路径（设置里的输入框是只读的）
    rememberPickedConfigPath('booksRoot', filePaths[0]);
    return filePaths[0];
  });

  handleBook('shell:open-book-folder', async (bookPath) => {
    const err = await shell.openPath(bookPath);
    if (err) throw new storage.StorageError('OPEN_FAILED', errorText.cleanText(errorText.redactPaths(err)));
    return true;
  });

  // 诊断日志（提案 7.4）：目录 / 文件清单给设置弹层显示；「打开日志文件夹」由主进程调资源管理器。
  // 日志只存在于 userData/logs，渲染层拿不到也写不了任何文件。
  handle('logs:info', async () => {
    const store = getLogStore();
    if (!store) throw new storage.StorageError('LOG_UNAVAILABLE', '日志目录暂时不可用');
    return store.info();
  });

  handle('logs:open-folder', async () => {
    const store = getLogStore();
    if (!store) throw new storage.StorageError('LOG_UNAVAILABLE', '日志目录暂时不可用');
    await fs.mkdir(store.dir, { recursive: true });
    // 自检环境不要真的在作者桌面上弹出资源管理器窗口，只回报目录
    if (isE2E) return { dir: store.dir, opened: false, note: '自检环境不打开资源管理器' };
    const err = await shell.openPath(store.dir);
    if (err) throw new storage.StorageError('OPEN_FAILED', errorText.cleanText(errorText.redactPaths(err)));
    return { dir: store.dir, opened: true };
  });

  // 正文全文搜索（提案 7.3）：书架搜索升级成能搜正文。
  // 索引存 userData/search-index.json，只含「双字哈希位图 + 每章 mtime/size」，不含正文；
  // 书 / 章一动（保存、改名、删除、外部改 txt）由下一次校验自动增量更新，作者不需要手动操作。
  handle('search:index-status', async () => {
    await getConfig();
    return getSearchIndexStore().status();
  });

  handle('search:ensure-index', async (options) => {
    const cfg = await getConfig();
    return getSearchIndexStore().ensure({
      booksRoot: cfg.booksRoot,
      force: Boolean(options && options.force),
      // 回书架时做深度校验（逐章 stat，发现外部改过的 txt）；搜索自己只用轻量校验
      deep: !(options && options.deep === false),
      onProgress: sendSearchProgress
    });
  });

  handle('search:content', async (query, options) => {
    const cfg = await getConfig();
    return getSearchIndexStore().search({
      booksRoot: cfg.booksRoot,
      query,
      limit: options && options.limit,
      onProgress: sendSearchProgress
    });
  });

  // 自动更新轻量版（提案 7.1）：手动检查 GitHub Release → 提示有新版本 → 打开下载页。
  // 不自动下载 / 安装；检查结果只在内存里（lastUpdateLaunch），渲染层不能传任意 URL 进来。
  handle('update:check', async () => {
    const result = await updateLib.checkForUpdates({
      currentVersion: app.getVersion(),
      fetchText: fetchReleaseResponse
    });
    const releaseUrl = result && result.status === 'update' ? updateLib.safeReleaseUrl(result.releaseUrl) : '';
    lastUpdateLaunch = releaseUrl
      ? { url: releaseUrl, latestVersion: result.latestVersion, at: Date.now() }
      : null;
    return result;
  });

  handle('update:open-download', async () => {
    if (!lastUpdateLaunch) {
      return { opened: false, url: '', message: '还没有检查到新版本，请先点「检查更新」' };
    }
    const url = updateLib.safeReleaseUrl(lastUpdateLaunch.url);
    if (!url) {
      return { opened: false, url: '', message: '下载页地址不可用，请到 GitHub Releases 手动查看' };
    }
    // 自检环境不要真的在作者桌面上打开浏览器，只回报地址
    if (automation) return { opened: false, url, note: '自检环境不打开浏览器' };
    try {
      await shell.openExternal(url);
    } catch (err) {
      return { opened: false, url, message: `打不开浏览器：${errorText.describeForUi(err).message}` };
    }
    return { opened: true, url };
  });

  if (automation) {
    // 仅自检 / 截图：注入假网络响应（E2E 绝不真连 GitHub；生产环境这个频道不会注册）
    handle('update:test-mock', async (mock) => {
      updateMock = mock && typeof mock === 'object' ? mock : null;
      return true;
    });
  }
}

// ---------- Electron 安全加固（v0.9 C-1） ----------
// 窗口级（每个 webContents）：
//   · 不允许开新窗口（window.open / target=_blank 一律 deny）；
//   · 不允许导航离开本页（点外链、被注入的 location 赋值都拦在本页内）；
//   · 不允许挂 <webview>（真挂了就先抹掉 preload / Node 能力再拦下）。
// 会话级：浏览器权限（摄像头 / 麦克风 / 通知 / 定位 / 剪贴板读取 / 全屏 / 传感器…）一律拒绝 ——
//   注意 Electron 的默认行为是「没有权限处理器就一律允许」，所以必须显式拒绝。
// 这些约束统一挂在 app 的 web-contents-created / session-created 上兜底：以后谁再加窗口或
// 自定义 partition，也自动带上同样的开关，不会再出现「新窗口忘写 setWindowOpenHandler」这种缺口。
// 期望值来自 core/security-policy.js（单测断言同一份常量，E2E 在真实 Electron 里复核）。
const hardenedContents = new WeakSet();
const hardenedSessions = new WeakSet();
// 实际注册给 Electron 的处理器留个引用：自检要直接调它们，证明「真的拒绝」而不是「以为拒绝了」
const permissionHandlers = { request: null, check: null };
let lastPermissionDenial = null; // 只留最近一条（不含本机路径），自检断言用

function hardenWebContents(contents) {
  if (!contents || contents.isDestroyed() || hardenedContents.has(contents)) return;
  hardenedContents.add(contents);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event, webPreferences) => {
    // 双保险：就算哪天误开了 webviewTag，也不让被挂的 webview 带上 preload / Node 能力
    if (webPreferences && typeof webPreferences === 'object') {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    }
    event.preventDefault();
  });
}

function hardenSession(ses) {
  if (!ses || hardenedSessions.has(ses)) return;
  hardenedSessions.add(ses);
  permissionHandlers.request = (contents, permission, callback, details) => {
    try {
      lastPermissionDenial = securityPolicy.permissionLogRecord(
        permission,
        details && details.requestingOrigin
      );
      logError(
        'permission-denied',
        {
          code: 'PERMISSION_DENIED',
          message: `拒绝权限请求：${lastPermissionDenial.permission}（来源 ${lastPermissionDenial.origin}）`
        },
        { level: 'info' }
      );
    } catch {
      /* 记日志失败也必须照样拒绝 */
    }
    callback(false);
  };
  // 权限「检查」（Permissions API / 页面初始化时查询）同样一律 false
  permissionHandlers.check = () => securityPolicy.deniesPermission();
  try {
    ses.setPermissionRequestHandler(permissionHandlers.request);
  } catch (err) {
    logError('permission-handler', err, { level: 'warn' });
  }
  try {
    ses.setPermissionCheckHandler(permissionHandlers.check);
  } catch (err) {
    logError('permission-handler', err, { level: 'warn' });
  }
  // 设备权限（串口 / HID / USB / 蓝牙）走另一条通道，Electron 的 request 处理器管不到它
  if (typeof ses.setDevicePermissionHandler === 'function') {
    try {
      ses.setDevicePermissionHandler(() => false);
    } catch (err) {
      logError('permission-handler', err, { level: 'warn' });
    }
  }
}

// ---------- 窗口 ----------
// 每个窗口一个会话；可选直接在第二窗口打开某本书（书卡右键「在新窗口打开」）。
// 新窗口的书在 BrowserWindow 创建后立刻登记（同步），再加载页面 —— 连点两次也只会开一个。
async function createWindow({ bookPath = null, cascade = false, runAutomationFlow = false } = {}) {
  const cfg = await getConfig();
  let bounds = null;
  if (windowSessions.size === 0) {
    bounds = clampBounds(cfg.windowBounds);
  } else if (cascade) {
    const focused = BrowserWindow.getFocusedWindow();
    const sourceBounds =
      focused && !focused.isDestroyed()
        ? focused.getBounds()
        : mostRecentSession() && !mostRecentSession().win.isDestroyed()
          ? mostRecentSession().win.getBounds()
          : null;
    if (sourceBounds) {
      bounds = clampBounds({
        x: sourceBounds.x + 32,
        y: sourceBounds.y + 32,
        width: sourceBounds.width,
        height: sourceBounds.height
      });
    }
  }

  const browserWin = new BrowserWindow({
    ...(bounds || { width: 1200, height: 760 }),
    minWidth: 960,
    minHeight: 620,
    title: '章节写作器',
    backgroundColor: '#f6f4ef',
    show: false,
    autoHideMenuBar: true,
    // 安全开关（sandbox / contextIsolation / webSecurity / nodeIntegration…）的唯一来源：
    // core/security-policy.js。这里不另写一份，避免以后两边改歪。
    webPreferences: securityPolicy.windowPreferences(path.join(__dirname, 'preload.js'))
  });
  const session = createSession(browserWin);
  const webContentsId = browserWin.webContents.id;
  if (runAutomationFlow && automation) automationWin = browserWin;

  // 先在登记表里占住这本书（同步完成，加载页面前生效），失败就销毁这个刚建的窗口
  if (bookPath) {
    const registered = storage.registerOpenBook(session.id, bookPath);
    if (!registered.ok) {
      windowSessions.delete(session.id);
      webContentsSessions.delete(webContentsId);
      storage.openBookRegistry.unregisterWindow(session.id);
      if (!browserWin.isDestroyed()) browserWin.destroy();
      focusSession(sessionById(registered.ownerWindowId));
      throw new storage.StorageError(registered.code, registered.message);
    }
  }

  Menu.setApplicationMenu(null);
  browserWin.once('ready-to-show', () => {
    if (!browserWin.isDestroyed()) browserWin.show();
  });
  // 开新窗口 / 导航 / webview / 权限的约束来自上面的安全加固：app 的 web-contents-created 已经
  // 给每个新建的 webContents 挂过一次，这里再显式加固一次（hardenWebContents 幂等，不会重复挂）。
  hardenWebContents(browserWin.webContents);
  // 能填文字的地方（正文 / 章节名 / 书名 / 搜索框 / 查找替换输入框）右键出中文菜单：剪切 / 复制 / 粘贴 / 全选
  // 章节列表、书架卡片有自带的 HTML 右键菜单，这里只认 isEditable，不会冲突
  browserWin.webContents.on('context-menu', (_event, params) => {
    if (!textMenu.shouldShow(params) || browserWin.isDestroyed()) return;
    Menu.buildFromTemplate(textMenu.buildTemplate(params)).popup({ window: browserWin });
  });
  browserWin.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toLowerCase() === 'i') {
      browserWin.webContents.toggleDevTools();
    }
  });
  browserWin.on('closed', () => {
    clearTimeout(session.closeTimer);
    clearTimeout(session.boundsTimer);
    windowSessions.delete(session.id);
    webContentsSessions.delete(webContentsId);
    // 这个窗口「刚在对话框里选中的配置路径」登记也一起清掉（只在内存里）
    pickedConfigPaths.forget(session.id);
    try {
      storage.openBookRegistry.unregisterWindow(session.id);
    } catch {
      /* 登记表清理失败不影响退出 */
    }
    if (automationWin === browserWin) automationWin = null;
  });
  browserWin.on('focus', () => {
    try {
      storage.openBookRegistry.touch(session.id);
    } catch {
      /* 忽略 */
    }
  });
  setupCloseFlow(session);

  // 渲染进程崩溃 / 窗口无响应也记一条（主进程的 uncaughtException 抓不到渲染层崩溃）
  browserWin.webContents.on('render-process-gone', (_event, details) => {
    const reason = (details && details.reason) || 'unknown';
    logError('render-process-gone', {
      code: reason,
      message: `渲染进程退出：${reason}（exitCode ${details && details.exitCode}，appCrashed ${Boolean(details && details.appCrashed)}）`
    });
  });
  browserWin.on('unresponsive', () => logError('unresponsive', { message: '窗口无响应（界面可能卡住）' }));

  // Windows 关机/注销：尽力而为地拦住一次，提示先保存（系统不强等应用，不能保证）。
  // 多窗口：哪个窗口有未保存修改就拦一次并让它先问；其它窗口照常。
  browserWin.on('query-session-end', (event) => {
    if (!session.dirty || browserWin.isDestroyed()) return;
    event.preventDefault();
    focusSession(session);
    sendToSession(session, 'app:close-requested');
  });

  const query = {};
  if (automation || isE2E) query.test = '1';
  if (bookPath) query.open = bookPath;
  const loadOptions = Object.keys(query).length ? { query } : undefined;
  try {
    await browserWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), loadOptions);
  } catch (err) {
    // 页面都没加载出来：清掉登记，别把书锁在一个空窗口上
    windowSessions.delete(session.id);
    webContentsSessions.delete(webContentsId);
    try {
      storage.openBookRegistry.unregisterWindow(session.id);
    } catch {
      /* 忽略 */
    }
    if (!browserWin.isDestroyed()) browserWin.destroy();
    throw err;
  }

  // 窗口位置保存（防抖，避免每次拖动都写盘）；只记最近使用的窗口
  const scheduleSaveBounds = () => {
    clearTimeout(session.boundsTimer);
    session.boundsTimer = setTimeout(() => {
      saveRecentWindowBounds(session).catch(() => {});
    }, 900);
  };
  browserWin.on('resize', scheduleSaveBounds);
  browserWin.on('move', scheduleSaveBounds);

  if (runAutomationFlow && automation) await runAutomation();
  return session;
}

// ---------- 自动化驱动（截图 / E2E，v0.9 B-1） ----------
// 驱动本体在 scripts/screenshot-driver.js：只有 --screenshot / --e2e 才会走到这里，require 就放在
// 函数里（懒加载）——正常启动路径不加载它，打包配置 files 也不含 scripts/，安装版里没有这段
// 只用于开发截图 / 自检的代码。host 把窗口 / 会话 / 配置 / 剪贴板 / 关闭流状态按引用交过去，
// 行为与挪出前逐条一致（`git show 754e1a5:main.js` 可对照）。
function automationHost() {
  return {
    app,
    fs,
    path,
    isE2E,
    getConfig,
    storage,
    repair,
    exporter,
    clipboard,
    getWin: () => automationWin,
    screenshot: {
      path: screenshotPath,
      book: screenshotBook,
      chapter: screenshotChapter,
      dialog: screenshotDialog
    },
    argValue,
    createWindow: (options) => createWindow(options),
    sessionById: (windowId) => sessionById(windowId),
    focusSession: (session) => focusSession(session),
    listSessions: () => Array.from(windowSessions.values()),
    setClipboard: (value) => {
      activeClipboard = value;
    },
    setRealClose: (on) => {
      e2eRealClose = Boolean(on);
      return e2eRealClose;
    },
    isWindowAllClosed: () => e2eWindowAllClosed,
    getCloseReady: (windowId) =>
      windowId == null ? e2eLastCloseReady : e2eCloseReadyByWindow.get(String(windowId)),
    resetCloseReady: (windowId) => {
      if (windowId == null) {
        e2eLastCloseReady = undefined;
        e2eCloseReadyByWindow.clear();
      } else {
        e2eCloseReadyByWindow.delete(String(windowId));
      }
    },
    getPermissionHandlers: () => permissionHandlers,
    getLastPermissionDenial: () => lastPermissionDenial,
    getContentTypes: () => webContents.getAllWebContents().map((item) => item.getType())
  };
}

async function runAutomation() {
  // 懒加载：只有自动化模式才需要这份驱动（scripts/ 不进安装包，生产启动路径不会 require）
  const driver = require('./scripts/screenshot-driver.js');
  await driver.run(automationHost());
}

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 安全加固兜底（v0.9 C-1）：之后新建的任何 webContents / session 都自动带上同一套约束
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  app.on('session-created', (ses) => hardenSession(ses));

  app.on('second-instance', () => {
    const session = mostRecentSession();
    if (session) {
      focusSession(session);
    } else {
      createWindow({ runAutomationFlow: false }).catch((err) => {
        console.error('[window] 第二次启动建窗失败:', err && err.stack ? err.stack : err);
      });
    }
  });

  app.whenReady().then(async () => {
    setupCloseIpc();
    registerIpc();
    // 默认 session 在第一次建窗时才真正被用到，这里先加固一次（session-created 还会兜一次）
    hardenSession(electronSession.defaultSession);
    try {
      await getConfig();
    } catch (err) {
      console.error('[config] 读取失败:', err);
    }
    // 每次启动记一条 info（版本 / 平台 / Electron 版本），排查反馈时先看这里
    logStartup();
    try {
      await createWindow({ runAutomationFlow: true });
    } catch (err) {
      console.error('[window] 创建失败:', err && err.stack ? err.stack : err);
      app.exit(1);
    }
  });

  // 只有最后一个窗口关闭时才退出（E2E 记一笔、由场景断言后自行收尾）
  app.on('window-all-closed', () => {
    if (isE2E) {
      e2eWindowAllClosed = true;
      return;
    }
    app.quit();
  });
}
