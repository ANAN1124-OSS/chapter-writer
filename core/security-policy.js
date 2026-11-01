// Electron 安全开关的「唯一事实来源」（v0.9 C-1，对照 Electron Security Checklist 自查）——
// 纯逻辑：不 require electron、不读盘、不联网、不写盘。
//
// 为什么要有这个模块：窗口的 webPreferences 与「浏览器权限允许不允许」以前只写在 main.js 的
// createWindow 里，单测完全碰不到；以后加新窗口 / 新 partition（例如某个功能用了自定义 session）
// 时很容易漏掉 setWindowOpenHandler / setPermissionRequestHandler 这类开关，而 Electron 的默认
// 行为是「没有权限处理器就一律允许」。现在把期望值集中成一份常量：
//   · main.js 直接展开使用（不多写一份），
//   · 单测断言这份常量（改宽了会立刻红），
//   · E2E 在真实 Electron 里用 webContents.getLastWebPreferences() 复核（三头对得上才算过）。
//
// 本轮范围（C-1）只做「安全开关 + 窗口行为」：CSP 与外部内容（C-4）、IPC 参数校验（C-2 / C-5）、
// 日志脱敏的完整审计（C-4 / C-5）仍在施工队列里，见 下一阶段提案.md §6。

// 窗口的 webPreferences：每一项都是「收紧方向」，没有任何一项是为了方便而放宽。
// 说明：
//   contextIsolation / nodeIntegration / sandbox —— 渲染层拿不到 Node，preload 与页面世界隔离；
//   webSecurity —— 不关同源策略（关掉等于给所有跨源资源开后门，本项目不需要）；
//   allowRunningInsecureContent / experimentalFeatures —— 不开启任何实验性 / 混合内容放行；
//   webviewTag —— 不用 <webview>（本应用只有一个页面，不需要嵌套浏览器）；
//   nodeIntegrationInWorker / nodeIntegrationInSubFrames —— Worker / 子框架里也不给 Node；
//   spellcheck —— 关掉 Chromium 拼写检查（纯中文写作不需要，也避免它去读输入文本做词典查询）。
const WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false
});

// 权限名只记一个可打印短串：Chromium 传进来的是 'geolocation' / 'media' 之类的固定词，
// 但日志字段不能假设调用方一定守规矩（坏输入 / 超长串都按空串 / 截断处理）。
const MAX_PERMISSION_CHARS = 40;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

// webContents.getLastWebPreferences() 不是「原样回读」：Electron 45 实测只回 16 个键，
// preload 与 spellcheck 都不在里面（preload 由 preload 脚本自己证明、spellcheck 只由单测锁）。
// 这两个键不能算进「和真实窗口对账」的差异里，否则 E2E 会因为 Electron 不回读而误报。
const PREFERENCES_NOT_READ_BACK = Object.freeze(['preload', 'spellcheck']);

// 与真实窗口回读值对账：返回与策略不一致的键（只比较 Electron 真能回读的项）。
// 回读里缺键（undefined）也算不一致 —— 宁可 E2E 红，也不要「Electron 哪天不报了」悄悄放过。
function preferenceDiff(reported) {
  const source = reported && typeof reported === 'object' ? reported : {};
  const diff = [];
  for (const [key, value] of Object.entries(WINDOW_WEB_PREFERENCES)) {
    if (PREFERENCES_NOT_READ_BACK.includes(key)) continue;
    if (source[key] !== value) diff.push(key);
  }
  return diff;
}

function sanitizePermissionName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, '').trim().slice(0, MAX_PERMISSION_CHARS);
}

// 记日志用的「来源」：只留协议 + 主机（含端口），绝不含本机路径 / 查询串 / 账号密码。
// 钩子里的 requestingOrigin 可能是 file:///C:/Users/xxx/... 这种带本机绝对路径的串，
// 直接写进日志等于把作者的目录结构泄漏出去（日志是允许作者贴出来的）。
function safeOrigin(value) {
  if (typeof value !== 'string') return 'unknown';
  const text = value.trim();
  if (!text) return 'unknown';
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'unknown';
  }
  if (!url.protocol) return 'unknown';
  // file:// 的 origin 在 Chromium 里是不透明的：统一记成 'file://'，盘符 / 用户名 / 文件名一律丢掉
  if (url.protocol === 'file:') return 'file://';
  // data: / about: / blob: 之类的 origin 是 'null'，记成 'opaque' 便于区分「没有来源」
  if (!url.origin || url.origin === 'null') return 'opaque';
  return url.origin;
}

// 一条「被拒绝的权限请求」的日志字段（main.js 直接交给 logs：kind=permission-denied + 这句 message）。
function permissionLogRecord(permission, requestingOrigin) {
  const name = sanitizePermissionName(permission);
  return {
    permission: name || 'unknown',
    origin: safeOrigin(requestingOrigin),
    denied: true
  };
}

// 权限策略：一律拒绝。本应用是纯文本编辑器——没有摄像头 / 麦克风 / 通知 / 定位 / 剪贴板读取 /
// 全屏 / 传感器 / 串口 / 蓝牙等任何需求，窗内也不提供「允许一次」的入口。
// 返回值恒为 false：Electron 的 request 处理器要 callback(false)、check 处理器要返回 false。
function deniesPermission() {
  return false;
}

// 窗口的 webPreferences（唯一入口）。preload 必须是应用自己的绝对路径——传空 / 非字符串直接抛错，
// 让「忘了传 preload」在开发时就炸掉，而不是悄悄建一个没有桥接能力的窗口。
function windowPreferences(preloadPath) {
  if (typeof preloadPath !== 'string' || !preloadPath.trim()) {
    throw new TypeError('windowPreferences 需要 preload 的绝对路径');
  }
  return { ...WINDOW_WEB_PREFERENCES, preload: preloadPath };
}

module.exports = {
  WINDOW_WEB_PREFERENCES,
  PREFERENCES_NOT_READ_BACK,
  MAX_PERMISSION_CHARS,
  windowPreferences,
  preferenceDiff,
  sanitizePermissionName,
  safeOrigin,
  permissionLogRecord,
  deniesPermission
};
