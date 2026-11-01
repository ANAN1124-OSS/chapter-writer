// 配置里「指向磁盘」的三项值的来源校验（v0.9 C-2b，C1 安全模型一致性的延伸）——
// 纯逻辑：不 require electron、不读盘、不写盘，可在 node:test 里直接测。
//
// 问题：渲染层没有 fs，所有文件操作都在主进程；但 config:set 能改 booksRoot / 两份词表路径，
// 等于「渲染层让主进程下一刻去读写它点名的目录 / 文件」（书架根目录会被列目录、建书、删书
// 走回收站；词表会被读）。这和其他入口的模型不一致：书路径过 assertBookPath、字体只认对话框
// 选中的路径（v0.8.6 F1/F11）、导入目录只认对话框（v0.9 C-2）。
//
// 规则（三项一样，参照 v0.8.6 的 font:pick → font:read）：
//   · 空值 / 纯空白：允许（等于「清空」，配置清洗自己会回默认值或空串）；
//   · 与原值相同：允许（设置界面每次保存都会原样回传整张表单，包括没改的路径）；
//   · 等于「这个窗口刚在系统对话框里选中的那个」：允许（主进程自己记下来、渲染层伪造不了）；
//   · 其它一律忽略该字段（保留原值），并回一份字段名清单（只带字段名，绝不带路径值）。
//
// 已知边界（写进 README 已知限制，不在本模块处理）：
//   · 判定是「字符串等价」：接在刚才选中目录里的子目录也算不同路径，需要重新选一次；
//   · 最后一项在窗口关闭时清理（main.js 的 closed 事件），不跨窗口、不写盘。
const path = require('node:path');

// 需要来源校验的字段（审计结论本身：以后往 config 里加「路径」字段必须加到这里）
const GUARDED_PATH_FIELDS = Object.freeze([
  'booksRoot', // 书架目录：主进程会 mkdir / 列目录 / 建书 / 删书走回收站
  'proofreadWordsPath', // 校对词表：主进程会读这个 txt
  'sensitiveWordsPath' // 敏感词表：同上
]);

const WIN32 = process.platform === 'win32';
const pathLib = WIN32 ? path.win32 : path.posix;

// 路径的规范形式（只用于「是不是同一个路径」的判断，不改变要存进配置的原字符串）：
// trim → resolve（去掉末尾分隔符 / 折叠 `.` `..`）→ Windows 下统一小写、反斜杠。
function pathKey(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  let resolved;
  try {
    resolved = pathLib.resolve(trimmed);
  } catch {
    return WIN32 ? trimmed.toLowerCase() : trimmed;
  }
  return WIN32 ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
}

// 两个路径是不是同一个（Windows 大小写不敏感；末尾分隔符、`/` 与 `\` 混用都算同一个）
function samePath(a, b) {
  const left = pathKey(a);
  const right = pathKey(b);
  return Boolean(left) && left === right;
}

// 过滤 config:set 的 patch：
//   patch    —— 渲染层传来的一整份改动（可能带非路径字段）
//   options.current —— 当前生效配置（main.js 传 getConfig() 的结果，含 booksRoot 覆盖）
//   options.picked  —— 本窗口「刚在对话框里选中的值」{ 字段: 路径 }（没有就传 null）
// 返回 { patch: 只含放行字段的新 patch, rejected: [字段名] }。
// 非路径字段原样透传；坏类型（数字 / 数组 / 对象）一律当作「来源不明」拒绝（不做类型转换）。
function filterPathPatch(patch, options = {}) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const current = options.current && typeof options.current === 'object' ? options.current : {};
  const picked = options.picked && typeof options.picked === 'object' ? options.picked : {};
  const result = {};
  const rejected = [];
  for (const key of Object.keys(source)) {
    if (!GUARDED_PATH_FIELDS.includes(key)) {
      result[key] = source[key];
      continue;
    }
    const value = source[key];
    if (typeof value !== 'string') {
      rejected.push(key);
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      result[key] = ''; // 清空：允许（配置清洗决定最终落什么）
      continue;
    }
    if (samePath(trimmed, current[key]) || samePath(trimmed, picked[key])) {
      result[key] = trimmed;
      continue;
    }
    rejected.push(key); // 来源不明：忽略该字段，保留原值
  }
  return { patch: result, rejected };
}

// 按窗口记「刚在系统对话框里选中的路径」：windowId -> { 字段: 路径 }。
// 每个窗口每个字段只留最后一次（作者重选就覆盖），窗口关了要 forget（main.js 的 closed 事件）。
function createPickedPathStore() {
  const byWindow = new Map();

  function idOf(windowId) {
    const raw = windowId == null ? '' : String(windowId).trim();
    return raw;
  }

  // 记住一次选择；value 为空等于「清掉这个字段的登记」
  function remember(windowId, field, value) {
    const id = idOf(windowId);
    if (!id || !GUARDED_PATH_FIELDS.includes(field)) return false;
    const entry = byWindow.get(id) || {};
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      delete entry[field];
      if (Object.keys(entry).length) byWindow.set(id, entry);
      else byWindow.delete(id);
      return true;
    }
    entry[field] = trimmed;
    byWindow.set(id, entry);
    return true;
  }

  // 取某个窗口当前登记的一份快照（filterPathPatch 的 picked 参数用）
  function snapshot(windowId) {
    const id = idOf(windowId);
    if (!id) return {};
    const entry = byWindow.get(id);
    return entry ? { ...entry } : {};
  }

  function recall(windowId, field) {
    return snapshot(windowId)[field] || '';
  }

  // 窗口关掉时清理（不清理也不会出错，只是内存里多几条；清理更干净）
  function forget(windowId) {
    const id = idOf(windowId);
    if (!id) return false;
    return byWindow.delete(id);
  }

  function size() {
    return byWindow.size;
  }

  return { remember, snapshot, recall, forget, size };
}

module.exports = {
  GUARDED_PATH_FIELDS,
  pathKey,
  samePath,
  filterPathPatch,
  createPickedPathStore
};
