// E2E 第 58 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组只做「config:set 的路径来源校验」（v0.9 C-2b，安全审计 C1 的延伸）：书架目录 / 校对词表 /
// 敏感词表这三项「指向磁盘」的配置只认「主进程自己弹出的对话框刚选中的路径」或「与原值相同 / 清空」
// （core/config-gate.js）；期望值来源是 tests/config-gate.test.js。窗口接线（开 / 关第二个窗口、在别的
// 窗口里执行表达式）由场景交进来，组文件只 require node 内建，不碰产品代码。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group58ConfigGate(t) {
  const { exec, execIn, check, sleep, userData, fileExists, windowsInfo, openWindow, destroyWindow } = t;

  // 58. 配置来源校验（v0.9 C-2b，安全审计 C1 的延伸）：
  //     config:set 能改的三项「指向磁盘」的配置（书架目录 / 校对词表 / 敏感词表）只认
  //     「主进程自己弹出的对话框刚选中的路径」或「与原值相同 / 清空」（core/config-gate.js）：
  //       · 渲染层直接塞任意目录 / 文件 → 忽略该字段、保留原值，config.json 里也看不到；
  //       · 伪造的书架目录不会被 mkdir 出来（主进程没往那儿写东西）；
  //       · 同一 patch 里其它字段照旧生效（设置保存链路行为不变）；
  //       · 自检用 config:test-pick 模拟「对话框选中」，之后才生效（走的是生产同一条校验链）；
  //       · 空串 = 清空，仍然允许；原值原样回传也允许（设置界面每次保存都回传整张表单）；
  //       · 登记按窗口分开：A 窗口选过的路径在 B 窗口不生效，B 自己选一次才生效；
  //       · 设置里书架目录输入框是只读的（只能点「选择…」）。
  //     期望值的来源是单测 tests/config-gate.test.js；这一组证明真实 Electron 里真的这样，
  //     并断言被拒的调用没有副作用（磁盘配置没变、没多出目录）。
  const gateDir = path.join(userData, '配置来源演练');
  await fs.mkdir(gateDir, { recursive: true });
  const gateForgedRoot = path.join(gateDir, '伪造书架目录');
  const gateWordsFile = path.join(gateDir, '来源演练词表甲.txt');
  const gateWordsFileB = path.join(gateDir, '来源演练词表乙.txt');
  await fs.writeFile(gateWordsFile, '甲词\n乙词\n', 'utf8');
  await fs.writeFile(gateWordsFileB, '丙词\n', 'utf8');
  const readGateConfigDisk = async () =>
    JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const gateConfigBefore = await exec('window.api.getConfig().then((r) => (r && r.ok ? r.data : null))');
  const gateDiskBefore = await readGateConfigDisk();

  // 58a. 伪造路径：三项全塞一遍 + 一个「合法字段与伪造字段混在一起」的 patch + 一组坏类型
  const gateForged = JSON.parse(
    await exec(`(async () => {
      const P = ${JSON.stringify({ root: gateForgedRoot, words: gateWordsFile })};
      const out = {};
      const grab = async (name, fn) => {
        try {
          const res = await fn();
          out[name] = {
            ok: Boolean(res && res.ok === true),
            data: res && res.data ? res.data : null,
            code: (res && res.code) || ''
          };
        } catch (err) {
          out[name] = { ok: false, code: 'THREW', message: String(err && err.message) };
        }
      };
      await grab('root', () => window.api.setConfig({ booksRoot: P.root }));
      await grab('proofread', () => window.api.setConfig({ proofreadWordsPath: P.words }));
      await grab('sensitive', () => window.api.setConfig({ sensitiveWordsPath: P.words }));
      await grab('mixed', () => window.api.setConfig({ dailyGoal: 4321, booksRoot: P.root }));
      await grab('badTypes', () => window.api.setConfig({ booksRoot: 123, proofreadWordsPath: [P.words] }));
      return JSON.stringify(out);
    })()`)
  );
  check(
    '配置来源：伪造的书架目录被忽略（生效的 booksRoot 不变）',
    gateForged.root.ok === true && gateForged.root.data.booksRoot === gateConfigBefore.booksRoot,
    gateForged.root
  );
  check(
    '配置来源：伪造的校对词表路径被忽略（配置里仍是原值）',
    gateForged.proofread.ok === true &&
      gateForged.proofread.data.proofreadWordsPath === gateConfigBefore.proofreadWordsPath,
    gateForged.proofread.data
  );
  check(
    '配置来源：伪造的敏感词表路径被忽略（配置里仍是原值）',
    gateForged.sensitive.ok === true &&
      gateForged.sensitive.data.sensitiveWordsPath === gateConfigBefore.sensitiveWordsPath,
    gateForged.sensitive.data
  );
  const gateDiskAfterForged = await readGateConfigDisk();
  check(
    '配置来源：伪造路径没有被写进 config.json（磁盘上找不到这段字符串）',
    !JSON.stringify(gateDiskAfterForged).includes('伪造书架目录') &&
      !JSON.stringify(gateDiskAfterForged).includes('来源演练词表甲'),
    gateDiskAfterForged
  );
  check(
    '配置来源：伪造的书架目录没有被创建（主进程没往那儿 mkdir / 写文件）',
    (await fileExists(gateForgedRoot)) === false
  );
  check(
    '配置来源：同一 patch 里其它字段照旧生效，只有伪造的路径被摘掉',
    gateForged.mixed.ok === true &&
      Number(gateForged.mixed.data.dailyGoal) === 4321 &&
      gateForged.mixed.data.booksRoot === gateConfigBefore.booksRoot,
    { dailyGoal: gateForged.mixed.data && gateForged.mixed.data.dailyGoal }
  );
  check(
    '配置来源：坏类型（数字 / 数组）不生效，也不抛错',
    gateForged.badTypes.ok === true &&
      gateForged.badTypes.data.booksRoot === gateConfigBefore.booksRoot &&
      gateForged.badTypes.data.proofreadWordsPath === gateConfigBefore.proofreadWordsPath,
    gateForged.badTypes.data
  );
  check(
    '配置来源：回包里没有带出伪造路径（不把本机目录泄漏给渲染层 / 日志）',
    !JSON.stringify(gateForged.root).includes('伪造书架目录') &&
      !JSON.stringify(gateForged.proofread).includes('来源演练词表甲') &&
      !JSON.stringify(gateForged.sensitive).includes('来源演练词表甲')
  );

  // 58b. 正当来源：模拟「系统对话框选中」之后才生效；原值回传、清空仍然允许
  const gateLegit = JSON.parse(
    await exec(`(async () => {
      const P = ${JSON.stringify({ words: gateWordsFile })};
      const out = {};
      const before = await window.api.setConfig({ sensitiveWordsPath: P.words });
      out.notPicked = before && before.ok ? before.data.sensitiveWordsPath : 'ERROR';
      const pick = await window.api.testPickConfigPath(P.words, 'sensitiveWordsPath');
      out.pickOk = Boolean(pick && pick.ok === true && pick.data === true);
      const saved = await window.api.setConfig({ sensitiveWordsPath: P.words });
      out.saved = saved && saved.ok ? saved.data.sensitiveWordsPath : 'ERROR';
      const info = await window.api.sensitiveWordsInfo();
      out.count = info && info.ok ? info.data.count : -1;
      // 设置界面每次保存都会原样回传整张表单：同样的值再存一次不能被当成「来源不明」丢掉
      const again = await window.api.setConfig({ sensitiveWordsPath: P.words });
      out.again = again && again.ok ? again.data.sensitiveWordsPath : 'ERROR';
      const cleared = await window.api.setConfig({ sensitiveWordsPath: '' });
      out.cleared = cleared && cleared.ok ? cleared.data.sensitiveWordsPath : 'ERROR';
      return JSON.stringify(out);
    })()`)
  );
  check(
    '配置来源：没在对话框里选过就传路径 → 不生效（保留原值）',
    gateLegit.notPicked === gateConfigBefore.sensitiveWordsPath &&
      gateConfigBefore.sensitiveWordsPath !== gateWordsFile,
    gateLegit.notPicked
  );
  check(
    '配置来源：模拟「对话框选中」之后才生效（config.json 里出现该路径）',
    gateLegit.pickOk === true && gateLegit.saved === gateWordsFile,
    gateLegit
  );
  check('配置来源：选中后词表真的能读到（2 个词）', gateLegit.count === 2, gateLegit.count);
  check(
    '配置来源：原值原样回传仍然生效（设置界面整表单保存不会把词表弄丢）',
    gateLegit.again === gateWordsFile,
    gateLegit.again
  );
  check('配置来源：清空（空串）仍然允许', gateLegit.cleared === '', gateLegit.cleared);
  check(
    '配置来源：清空后 config.json 里也没有那段路径',
    !JSON.stringify(await readGateConfigDisk()).includes('来源演练词表甲')
  );
  check(
    '配置来源：设置里书架目录只能点「选择…」（输入框只读，主进程也只认对话框）',
    (await exec("document.getElementById('settings-root').readOnly === true")) === true
  );

  // 58c. 登记按窗口分开：A 窗口刚选中的路径，B 窗口不能直接拿去用（B 自己选一次才生效）
  const gateWinId = await openWindow(null);
  const waitGateIn = async (windowId, expr, timeout = 20000) => {
    const startedAt = Date.now();
    for (;;) {
      let value;
      try {
        value = await execIn(windowId, expr);
      } catch {
        /* 窗口刚建好，页面还没就绪 */
      }
      if (value) return value;
      if (Date.now() - startedAt > timeout) throw new Error(`窗口 ${windowId} 等待超时：${expr}`);
      await sleep(120);
    }
  };
  await waitGateIn(gateWinId, 'Boolean(window.__cwTest && window.__cwTest.ready)');
  // 先清空（空串允许），这样「被拒」一眼能看出还是空
  await exec("window.api.setConfig({ sensitiveWordsPath: '' })");
  const gatePickInA = await exec(
    `window.api.testPickConfigPath(${JSON.stringify(gateWordsFileB)}, 'sensitiveWordsPath')`
  );
  const gateSaveFromB = await execIn(
    gateWinId,
    `window.api.setConfig({ sensitiveWordsPath: ${JSON.stringify(gateWordsFileB)} })
      .then((r) => (r && r.ok ? r.data.sensitiveWordsPath : 'ERROR'))`
  );
  check(
    '配置来源：别的窗口没选过 → A 窗口选过的路径在 B 窗口不生效（按窗口记账）',
    gatePickInA.ok === true && gatePickInA.data === true && gateSaveFromB === '',
    { pickInA: gatePickInA, saveFromB: gateSaveFromB }
  );
  const gatePickInB = await execIn(
    gateWinId,
    `window.api.testPickConfigPath(${JSON.stringify(gateWordsFileB)}, 'sensitiveWordsPath')`
  );
  const gateSaveFromB2 = await execIn(
    gateWinId,
    `window.api.setConfig({ sensitiveWordsPath: ${JSON.stringify(gateWordsFileB)} })
      .then((r) => (r && r.ok ? r.data.sensitiveWordsPath : 'ERROR'))`
  );
  check(
    '配置来源：B 窗口自己选过一次就生效（多窗口各选各的，互不顶替）',
    gatePickInB.ok === true && gatePickInB.data === true && gateSaveFromB2 === gateWordsFileB,
    { pickInB: gatePickInB, saved: gateSaveFromB2 }
  );
  // 收尾：关掉演练用的第二个窗口，把配置恢复成演练前的样子（词表 / 每日目标）
  destroyWindow(gateWinId);
  const gateLiveWindows = () => windowsInfo().filter((window) => !window.destroyed).length;
  for (let i = 0; i < 100 && gateLiveWindows() !== 1; i += 1) await sleep(100);
  await exec(
    `(async () => {
      const restore = ${JSON.stringify(gateConfigBefore.sensitiveWordsPath)};
      if (restore) await window.api.testPickConfigPath(restore, 'sensitiveWordsPath');
      await window.api.setConfig({ sensitiveWordsPath: restore });
      await window.api.setConfig({ dailyGoal: ${Number(gateConfigBefore.dailyGoal) || 0} });
      return true;
    })()`
  );
  check(
    '配置来源：演练用的第二个窗口已关掉（后面多窗口组仍从单窗口开始）',
    gateLiveWindows() === 1,
    windowsInfo()
  );
  check(
    '配置来源：演练结束后敏感词表与每日目标恢复原样（没有改动前面的测试状态）',
    (await readGateConfigDisk()).dailyGoal === gateDiskBefore.dailyGoal &&
      (await readGateConfigDisk()).sensitiveWordsPath === gateDiskBefore.sensitiveWordsPath
  );
};

