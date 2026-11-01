// 渲染层能塞进来的「路径类参数」的统一校验（v0.9 C-2，IPC 路径入口审计）——
// 纯逻辑：不 require electron、不读盘、不写盘。
//
// 安全模型：渲染层没有 Node / fs，所有文件操作都在主进程做（见 preload.js 白名单）。
// 所以「渲染层传上来的一串字符」绝不能直接当路径用。全部 90 个 IPC 频道里带路径的入口只能是两类：
//   1. 书架里的书：main.js 用 handleBook 注册，第一参数统一过 assertBookPath——
//      只有「书架目录的直接子目录」合法，`..`、绝对路径、孙目录、空串都会被拒（BAD_PATH）；
//   2. 非书架的路径（历史备份 / 碎片 / 字体 / 导入）：各自有显式校验，即本模块的
//      importSourceDirs 与 core/history.js 的 resolveGroup / resolveHistoryPath、
//      core/fragments.js 的 assertFragmentName、core/font-policy.js 的 resolveFontSource。
// 本模块只收「以前写在 main.js 里、单测碰不到」的那两条，方便钉住。
//
// 已知残余风险（本轮不修，写进验收清单 / README 已知限制）：
//   · 书文件夹本身是符号链接 / 目录联接指到库外时，文本路径判定拦不住（要作者自己先造出这种链接）；
//   · config:set 里 booksRoot / 两份词表路径已由 core/config-gate.js 做「来源校验」（v0.9 C-2b，
//     只认主进程自己弹出的对话框刚选中的路径），不再是残余风险。
const path = require('node:path');

class IpcPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IpcPathError';
    this.code = code;
  }
}

// 书架里的书：必须是书架目录（booksRoot）的直接子目录。
// 说明：先 resolve 再比 dirname，所以 'D:\书架\某本\..\..\Windows'、'D:\书架\某本\子目录'、
// 'D:\书架' 自己、空串 / null / 数字都会被拒；Windows 大小写不敏感，比较时统一小写。
// 书架目录空着时必须直接报错 —— 空 root 会 resolve 成进程 cwd，绝不能让「没设置书架」悄悄变成
// 「当前目录就是书架」（失败也要往关的方向失败）。
// 返回值是 resolve 后的绝对路径（调用方直接用它，不要再用原始字符串）。
function assertBookPath(bookPath, booksRoot) {
  const rawRoot = String(booksRoot == null ? '' : booksRoot).trim();
  if (!rawRoot) throw new IpcPathError('BAD_PATH', '书架目录还没有设置');
  const root = path.resolve(rawRoot);
  // 两端空白一律清掉：配置文件里的路径本来就按 trim 存（和 core/config.js 的口径一致），
  // 带上空白的串如果直接 path.resolve，会被当成以空格开头的相对路径，校验结果变得莫名其妙。
  const target = path.resolve(String(bookPath == null ? '' : bookPath).trim());
  if (path.dirname(target).toLowerCase() !== root.toLowerCase()) {
    throw new IpcPathError('BAD_PATH', '只能操作书架目录下的书');
  }
  return target;
}

// 导入小说的来源目录：唯一正当来源是主进程弹的系统对话框（properties: ['openDirectory']）。
// 渲染层还能传 explicitPaths（自检 / 截图批量导入用），但只在 automation 模式下认——
// 否则被注入的脚本就能让主进程把任意文件夹（桌面、别的盘、D:\我的小说）复制进书架。
// 返回 resolve 后的绝对路径数组；没有显式路径时返回空数组（调用方退回系统对话框）。
function importSourceDirs(rawPaths, options = {}) {
  const list = Array.isArray(rawPaths) ? rawPaths : [];
  const dirs = list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => path.resolve(item.trim()));
  if (!dirs.length) return [];
  if (options.allowExplicit !== true) {
    throw new IpcPathError('BAD_IMPORT_PATH', '导入目录只能通过系统对话框选择');
  }
  return dirs;
}

module.exports = {
  IpcPathError,
  assertBookPath,
  importSourceDirs
};
