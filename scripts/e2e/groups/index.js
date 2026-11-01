// E2E 场景的组索引（v0.9 B-7）。
//
// 以前所有组都挤在 scripts/e2e-scenario.js 那一个函数里（1.2 万行），改一组要在大函数里
// 上下翻。现在按组拆到本目录：**只拆文件、不改断言**，顺序等于原文件里的执行顺序。
//
// 加一组：在本目录新建 `NN-名字.js`（NN = 原场景里的组号），导出 async (t) => {...}，
// 再在下面的数组里按组号插进去（数组顺序 = 执行顺序）；断言口径与 e2e-scenario.js 保持一致。
//
// 为什么每项带 id：拆出来的组不一定都落在场景的同一个位置。第 52 组在原场景第 52 组的位置跑，
// 60 起的那批在原来 60–62 的循环位置跑（后面才是第 55 多窗口组）——顺序必须与原文件一致，
// 否则 FAIL 时不好对照场景。所以场景里用 runGroups(t, [52]) / runGroups(t, idsFrom(60))
// 明确指定「在哪一段跑哪几组」，索引本身只负责登记与组号排序。
const groups = [
  { id: 52, run: require('./52-crash-logs') },
  { id: 53, run: require('./53-search-index') },
  { id: 54, run: require('./54-check-update') },
  { id: 56, run: require('./56-security-switches') },
  { id: 60, run: require('./60-log-redaction') },
  { id: 61, run: require('./61-ipc-limits') },
  { id: 62, run: require('./62-common-tools') },
  { id: 63, run: require('./63-chapter-list-perf') },
  { id: 64, run: require('./64-data-safety') },
  { id: 65, run: require('./65-marks-lazy-spans') },
  { id: 66, run: require('./66-destructive-recovery') },
  { id: 67, run: require('./67-contrast-a11y') },
  { id: 68, run: require('./68-dialog-focus') },
  { id: 69, run: require('./69-motion') },
  { id: 70, run: require('./70-a11y-keyboard') },
  { id: 71, run: require('./71-menu-keyboard') }
];

// 按给定组号依次跑（组号 → 组文件；顺序就是参数顺序，调用点决定「在哪一段」）。
async function runGroups(t, ids) {
  for (const id of ids) {
    const entry = groups.find((group) => group.id === id);
    if (!entry) throw new Error(`E2E 组索引里没有第 ${id} 组`);
    await entry.run(t);
  }
}

// 从某一组号起的所有组（给「场景尾部那一批」用：idsFrom(60) = 60 → 71）。
const idsFrom = (from) => groups.filter((group) => group.id >= from).map((group) => group.id);

module.exports = { groups, runGroups, idsFrom };
