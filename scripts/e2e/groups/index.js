// E2E 场景的组索引（v0.9 B-7）。
//
// 以前所有组都挤在 scripts/e2e-scenario.js 那一个函数里（1.2 万行），改一组要在大函数里
// 上下翻。现在按组拆到本目录：**只拆文件、不改断言**，顺序等于原文件里的执行顺序，
// 由 e2e-scenario.js 里那个 for 循环依次 await。
//
// 加一组：在本目录新建 `NN-名字.js`（NN = 原场景里的组号），导出 async (t) => {...}，
// 再在下面的数组里按顺序加一行；断言口径与 e2e-scenario.js 保持一致。
const groups = [
  require('./60-log-redaction'),
  require('./61-ipc-limits'),
  require('./62-common-tools')
];

module.exports = groups;
