'use strict';
// 章节写作器 · 前端基准驱动（v0.9 A-1，开发自检专用）
//
// 只在 `--bench` 时由 main.js 的 runAutomation() 懒加载（和 screenshot-driver 同一条路），
// 打包配置 build.files 不含 scripts/，所以安装版里没有这段代码；正常启动也不会 require 它。
//
// 约定与 screenshot-driver.js 一致：本文件**不 require electron**，窗口 / app / 启动参数全部
// 由 host 传入，因此 tests/bench.test.js 可以直接 require 它做静态与语法检查。
//
// 干什么：等渲染层测试钩子就绪 → 把 benchScenario 整段注入页面 → 页面里按固定顺序跑场景
// （每步只调真实的界面入口，不写盘、不改配置）→ 把 { env, scenarios } 打回主进程，由
// main.js 退出；scripts/bench.js 负责建夹具、解析 BENCH_RESULT、打印表格与落 JSON。

const { waitForRenderer } = require('./screenshot-driver');

// 这个函数会被 toString() 丢进渲染层执行：**只能用浏览器全局**（window / document /
// performance / Math / JSON），不许引用本文件里的任何变量或 Node API，否则页面里 ReferenceError。
function benchScenario(cfg) {
  return (async () => {
    const T = window.__cwTest;
    if (!T) return { ok: false, error: '测试钩子没加载（地址里应当带 ?test=1）' };
    const now = () => performance.now();
    const round = (n) => Math.round(n * 100) / 100;
    const cards = () => document.querySelectorAll('#book-grid .book-card[data-path]').length;
    const items = () => document.querySelectorAll('#chapter-list .chapter-item').length;
    // 强制一次同步布局：把「建完 DOM 之后的样式计算 + 布局」算进这一笔。
    // 不用 requestAnimationFrame / 定时器：窗口被遮挡或工作站锁屏时 Chromium 会节流它们，
    // 计时会变成假数；同步布局在任何可见性状态下都照常算。
    const flushLayout = () => {
      const body = document.body;
      return body ? body.offsetHeight : 0;
    };
    const runs = Math.max(1, Math.min(30, Number(cfg.runs) || 5));
    const scenarios = [];

    // 一个场景 = 可选的「准备」（不计时）+ 计时主体；先预热一次，再取 runs 次样本。
    async function measure(name, prepare, action, options) {
      const opt = options || {};
      const warmup = opt.warmup == null ? 1 : Math.max(0, Number(opt.warmup) || 0);
      const times = opt.times == null ? runs : Math.max(1, Number(opt.times) || 1);
      for (let i = 0; i < warmup; i += 1) {
        if (prepare) await prepare();
        await action();
      }
      const samples = [];
      let detail = null;
      for (let i = 0; i < times; i += 1) {
        if (prepare) await prepare();
        const startedAt = now();
        const value = await action();
        flushLayout();
        samples.push(round(now() - startedAt));
        if (value !== undefined && value !== null) detail = value;
      }
      scenarios.push({ name, note: opt.note || '', samples, detail });
    }

    // 预热：回书架 → 刷新一次 → 等正文索引建完（后台建索引会抢 CPU，先等它跑完再量）
    if (T.state.view !== 'shelf') await T.backToShelf();
    await T.refreshShelf();
    await T.ensureSearchIndex({ deep: true });

    const env = {
      windowSize: window.innerWidth + '×' + window.innerHeight,
      dpr: window.devicePixelRatio,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      bookCards: cards(),
      view: T.state.view
    };

    // 1) 书架刷新：listBooks（整库书目 + 字数缓存 + 冲突副本扫描）→ 重建整格书卡
    await measure(
      '书架刷新（全部书）',
      null,
      async () => {
        await T.refreshShelf();
        return cards();
      },
      { note: 'listBooks（读全部书目 + 字数缓存）→ 重建全部书卡；detail = 书卡数' }
    );

    // 2) 书架搜索：书名 / 作者 / 分组 / 标签 / 章节名的内存过滤 + 重渲染（同步）
    const query = String(cfg.searchQuery || '练习');
    await measure(
      '书架搜索（输入即出）',
      null,
      async () => {
        T.setShelfQuery(query);
        flushLayout();
        return cards();
      },
      {
        note:
          '查询「' +
          query +
          '」的内存过滤 + 重渲染（正文索引那一段是防抖后的异步流程，不在这一笔里）；detail = 书卡数'
      }
    );
    T.setShelfQuery(''); // 清掉查询（也会取消防抖里的正文搜索，避免污染后面的场景）

    // 3) 打开普通书（3 章的日常书）：从书架点开
    await measure(
      '打开普通书（3 章）',
      async () => {
        await T.backToShelf();
      },
      async () => {
        await T.openBookPath(cfg.smallBookPath);
      },
      { note: 'openBook（读书目 + 缺章校验）+ 章节栏 + 首章正文' }
    );

    // 4) 打开千章大书：量「章节栏条目多 + 书目大」时的打开成本
    await measure(
      '打开千章书',
      async () => {
        await T.backToShelf();
      },
      async () => {
        await T.openBookPath(cfg.bigBookPath);
        return items();
      },
      { note: '读千章书目 + 渲染整个章节栏 + 首章正文；detail = 章节栏条目数' }
    );

    // 5) 切换章节（普通章）：在几个固定位置上轮换，每次都不一样（否则 switchTo 会直接短路）
    const total = Number(cfg.chapters) || (T.state.chapters || []).length;
    const targets = [1, 120, 300, 512, 700, 900].filter((i) => i >= 0 && i < total);
    let cursor = 0;
    const nextTarget = () => {
      let target = targets.length ? targets[cursor % targets.length] : 0;
      cursor += 1;
      if (target === T.state.index) {
        target = (target + 1) % total;
        cursor += 1;
      }
      return target;
    };
    await measure(
      '切换章节（普通章）',
      null,
      async () => {
        await T.switchTo(nextTarget(), 'discard');
      },
      { note: 'loadChapter IPC + 编辑区赋值 + 标记层同步' }
    );

    // 6) 切换章节（最长那一章，A-3 的 10 万字场景）：
    //    每次先退到邻章（不计时），再切回大章（计时）——
    //    否则 switchTo 同一章会短路返回，量不到读盘与渲染。
    const longIndex = Number(cfg.longIndex);
    if (Number.isFinite(longIndex) && longIndex >= 0 && longIndex < total) {
      await measure(
        '切换章节（10 万字大章）',
        async () => {
          if (T.state.index === longIndex) {
            await T.switchTo(longIndex === 0 ? Math.min(1, total - 1) : longIndex - 1, 'discard');
          }
        },
        async () => {
          await T.switchTo(longIndex, 'discard');
        },
        { note: '换到最长那一章：读盘 + 编辑区赋值 + 标记层（超长走大章门控路径）' }
      );
    }

    // 7) 章节栏重渲染：折叠第 1 卷（只渲染其余章）→ 展开（整表重建）。
    //    这是真实交互（点分卷标题），只改内存里的折叠状态，不写书目。
    const volumes =
      T.state.meta && Array.isArray(T.state.meta.volumes) ? T.state.meta.volumes : [];
    if (volumes.length) {
      const volumeId = volumes[0].id;
      await measure(
        '章节栏渲染（展开分卷）',
        async () => {
          if (!T.state.collapsedVolumes.has(volumeId)) T.collapseVolume(volumeId);
        },
        async () => {
          T.collapseVolume(volumeId);
          return items();
        },
        { note: 'renderChapterList() 整表重建（真实交互：展开分卷）；detail = 条目数' }
      );
    }

    return { ok: true, env, scenarios };
  })().catch((err) => ({ ok: false, error: String((err && err.stack) || err) }));
}

// 注入脚本 = 函数源码 + 参数。用 toString() 而不是再抄一份字符串，页面里跑的就是本文件里
// 这一份（改一处就够，也不会出现「字符串里的代码和文件里的代码不一致」）。
function buildBenchScript(cfg) {
  return `(${benchScenario.toString()})(${JSON.stringify(cfg)})`;
}

function benchConfig(argValue) {
  const read = typeof argValue === 'function' ? argValue : () => null;
  const num = (name, fallback) => {
    const raw = read(name);
    // 启动参数没给时是 null / 空串：不能当 0 用（否则 --bench-runs 缺省会变成 1）
    if (raw == null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    runs: Math.max(1, Math.min(30, num('bench-runs', 5))),
    books: num('bench-books', 0),
    chapters: num('bench-chapters', 0),
    longIndex: num('bench-long-index', -1),
    bigBookPath: String(read('bench-big-book') || ''),
    smallBookPath: String(read('bench-small-book') || ''),
    searchQuery: String(read('bench-search-query') || '练习')
  };
}

async function run(host) {
  const win = host.getWin();
  const app = host.app;
  try {
    if (!win || win.isDestroyed()) throw new Error('基准模式没有可用窗口');
    // 数字对窗口大小 / 可见性敏感：确保窗口是显示出来的，并把实际状态一起带回报告
    if (!win.isVisible()) win.show();
    win.focus();
    await waitForRenderer(win, 'Boolean(window.__cwTest && window.__cwTest.ready)', 20000);
    const script = buildBenchScript(benchConfig(host.argValue));
    const result = await win.webContents.executeJavaScript(script, true);
    console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
    app.exit(result && result.ok ? 0 : 1);
  } catch (err) {
    console.error('[bench] 失败:', err && err.stack ? err.stack : err);
    console.log(
      `BENCH_RESULT ${JSON.stringify({ ok: false, error: String((err && err.stack) || err) })}`
    );
    app.exit(1);
  }
}

module.exports = {
  run,
  benchScenario,
  buildBenchScript,
  benchConfig
};
