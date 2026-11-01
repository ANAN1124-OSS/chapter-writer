// E2E 第 67 组：主题对比度与状态可见性（v0.9 A-4 视觉细节）。
//
// 钉住的东西：6 套纸色主题（paper / cream / green / kraft / grid / night）下，作者真正在看的
// 那些文字与界面图形，在**真实浏览器算出来的颜色**上要达到 WCAG AA：
//   · 普通文字 4.5:1（书卡 / 正文 / 章节列表 / 状态栏 / 占位提示 / 主按钮）；
//   · 非文字界面图形 3:1（焦点环 / 滚动条滑块）；
//   · 夜间主题的原生控件配色（color-scheme）和「正文命中高亮」的固定深色字。
//
// 为什么值得一组 E2E：颜色是**各主题变量算出来的**（rgba 叠加 + color-mix + var()），
// 单测只能钉住某个具体颜色字符串，钉不住「最终看起来能不能读」。这一组切主题、读
// getComputedStyle、把元素往上走的背景一层层叠成实际底色，再算对比度；以后谁改了主题色、
// 或者把某处颜色写死成浅色（损坏书卡 / 冲突徽标以前就是），这里会立刻红。
//
// 公式是**独立实现**的（tests 里的 scripts/contrast-color.js 是审计脚本用的那一份）：
// 两套实现互相对照，比共用一份「看不出错在哪」的代码更可靠。两边的阈值口径必须一致：
// 普通文字 4.5:1、界面图形 3:1。
//
// 自足：本组自己造一本演练书（作者 / 简介 / 标签 / 分卷 / 章节备注 / 完稿 + 同步冲突副本）
// 和一本「书目坏掉」的书，收尾时都移进书架 _trash；不写配置、不碰真实书架。
const fsp = require('node:fs/promises');
const path = require('node:path');

const NEED_TEXT = 4.5;
const NEED_UI = 3;

// 页面里跑的那一段：给每一套主题算「规格 → 对比度」。
// 注意这个函数会被 toString() 丢进渲染层，**只能用浏览器全局**（不能引用本文件的变量）。
function sampleThemes(view, specs) {
  return (() => {
    const THEMES = ['paper', 'cream', 'green', 'kraft', 'grid', 'night'];
    const CLASSES = ['cream', 'green', 'kraft', 'grid', 'night'];

    const parse = (raw) => {
      const text = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!text) return null;
      if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      let hit = /^rgba?\(([^)]*)\)$/.exec(text);
      if (hit) {
        const parts = hit[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean).map(Number);
        if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
      hit = /^color\(\s*srgb\s+([^)]*)\)$/.exec(text);
      if (hit) {
        const parts = hit[1].replace(/\//g, ' ').split(/\s+/).filter(Boolean).map(Number);
        if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
        return {
          r: parts[0] * 255,
          g: parts[1] * 255,
          b: parts[2] * 255,
          a: parts.length > 3 ? parts[3] : 1
        };
      }
      hit = /^#([0-9a-f]{6})$/.exec(text);
      if (hit) {
        return {
          r: parseInt(hit[1].slice(0, 2), 16),
          g: parseInt(hit[1].slice(2, 4), 16),
          b: parseInt(hit[1].slice(4, 6), 16),
          a: 1
        };
      }
      // oklab / oklch 之类不做色域换算；完全透明（color-mix 到 transparent）当「没有这一层」。
      hit = /^[a-z-]+\(([^)]*)\)$/.exec(text);
      if (hit) {
        const alphaText = hit[1].includes('/') ? hit[1].split('/').pop() : '';
        return Number(alphaText) === 0 ? { r: 0, g: 0, b: 0, a: 0 } : null;
      }
      return null;
    };

    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1
    });

    const luminance = (c) => {
      const channel = (raw) => {
        const value = Math.min(255, Math.max(0, raw)) / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };

    const ratioOf = (fg, bg) => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    // 元素「实际看到的底色」：从元素自身往上收集，再从最下层往上合成。
    // 同时把最上面几层原样带回去——采样出问题时（比如读到过渡中间帧的 oklab 颜色）
    // 失败详情里能看到「到底读到了什么」，不用再猜。
    const bgOf = (el) => {
      const layers = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) layers.push(color);
      }
      let result = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) result = over(layers[i], result);
      return result;
    };
    const bgRawOf = (el) => {
      const layers = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const raw = getComputedStyle(node).backgroundColor;
        if (raw && raw !== 'rgba(0, 0, 0, 0)' && raw !== 'transparent') layers.push(raw);
        if (layers.length >= 2) break;
      }
      return layers;
    };

    const resolveVar = (name) => {
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.left = '-10000px';
      probe.style.color = 'var(' + name + ')';
      probe.style.backgroundColor = 'var(' + name + ')';
      document.body.appendChild(probe);
      const styles = getComputedStyle(probe);
      const color = parse(styles.color);
      const background = parse(styles.backgroundColor);
      probe.remove();
      return { color, background };
    };

    // 关掉颜色过渡（往 styles.css 里临时插一条时长归零的规则）：.btn / .chapter-item 带
    // 120–150ms 的颜色过渡，切主题后立刻读 computed style 会读到过渡中间帧。
    const killTransitions = () => {
      const sheet = Array.from(document.styleSheets).find(
        (item) => item.href && /styles\.css$/.test(item.href)
      );
      if (!sheet) return null;
      try {
        const index = sheet.insertRule(
          '*{transition-duration:0s !important;animation-duration:0s !important}',
          sheet.cssRules.length
        );
        return { sheet, index };
      } catch {
        return null;
      }
    };
    const restoreTransitions = (handle) => {
      if (!handle) return;
      try {
        handle.sheet.deleteRule(handle.index);
      } catch {
        /* 已经被别处删掉也无所谓 */
      }
    };

    const transitions = killTransitions();
    const out = [];
    for (const theme of THEMES) {
      for (const name of CLASSES) document.body.classList.toggle('theme-' + name, theme === name);
      document.body.offsetHeight; // 强制同步样式 / 布局（不用 rAF / 定时器）
      for (const spec of specs) {
        const base = { view, theme, key: spec.key, need: spec.need };
        if (spec.token) {
          const fg = resolveVar(spec.token).color;
          const bg = resolveVar(spec.bgToken).background;
          out.push({
            ...base,
            found: Boolean(fg && bg),
            ratio: fg && bg ? Math.round(ratioOf(fg, bg) * 100) / 100 : null
          });
          continue;
        }
        const el = document.querySelector(spec.selector);
        if (!el) {
          out.push({ ...base, found: false, optional: Boolean(spec.optional), ratio: null });
          continue;
        }
        const styles = getComputedStyle(el, spec.pseudo || null);
        const fg = parse(styles.color);
        const bg = bgOf(el);
        out.push({
          ...base,
          found: true,
          ratio: fg ? Math.round(ratioOf(fg, bg) * 100) / 100 : null,
          color: styles.color,
          bgRaw: bgRawOf(el)
        });
      }
    }
    for (const name of CLASSES) document.body.classList.remove('theme-' + name);
    restoreTransitions(transitions);
    return { transitionsOff: Boolean(transitions), samples: out };
  })();
}

// 「正文命中高亮」的固定深色字（styles.css 里 .shelf-content-snippet mark）。这个面板要点开
// 正文搜索才会出现，所以这里临时造一个同样结构的小片段读颜色——测的仍是同一条 CSS 规则。
function sampleSnippetMark() {
  return (() => {
    const THEMES = ['paper', 'cream', 'green', 'kraft', 'grid', 'night'];
    const CLASSES = ['cream', 'green', 'kraft', 'grid', 'night'];
    const out = [];
    const sheet = Array.from(document.styleSheets).find(
      (item) => item.href && /styles\.css$/.test(item.href)
    );
    let inserted = null;
    if (sheet) {
      try {
        inserted = sheet.insertRule(
          '*{transition-duration:0s !important;animation-duration:0s !important}',
          sheet.cssRules.length
        );
      } catch {
        inserted = null;
      }
    }
    for (const theme of THEMES) {
      for (const name of CLASSES) document.body.classList.toggle('theme-' + name, theme === name);
      const wrap = document.createElement('div');
      wrap.className = 'shelf-content-snippet';
      wrap.textContent = '正文命中 ';
      const mark = document.createElement('mark');
      mark.textContent = '关键词';
      wrap.appendChild(mark);
      wrap.style.position = 'absolute';
      wrap.style.left = '-10000px';
      document.body.appendChild(wrap);
      const styles = getComputedStyle(mark);
      out.push({ theme, color: styles.color, background: styles.backgroundColor });
      wrap.remove();
    }
    for (const name of CLASSES) document.body.classList.remove('theme-' + name);
    if (inserted != null) {
      try {
        sheet.deleteRule(inserted);
      } catch {
        /* 忽略 */
      }
    }
    return { transitionsOff: inserted != null, samples: out };
  })();
}

function sampleColorScheme() {
  return (() => {
    const THEMES = ['paper', 'cream', 'green', 'kraft', 'grid', 'night'];
    const CLASSES = ['cream', 'green', 'kraft', 'grid', 'night'];
    const out = [];
    for (const theme of THEMES) {
      for (const name of CLASSES) document.body.classList.toggle('theme-' + name, theme === name);
      out.push({ theme, scheme: getComputedStyle(document.body).colorScheme });
    }
    for (const name of CLASSES) document.body.classList.remove('theme-' + name);
    return out;
  })();
}

const SHELF_SPECS = [
  { key: '书卡书名', selector: '.book-card[data-path] .book-card-title', need: NEED_TEXT },
  { key: '书卡作者', selector: '.book-card[data-path] .book-card-author', need: NEED_TEXT, optional: true },
  { key: '书卡标签', selector: '.book-card[data-path] .book-card-tags', need: NEED_TEXT, optional: true },
  { key: '书卡「最后修改」', selector: '.book-card[data-path] .book-card-time', need: NEED_TEXT },
  { key: '冲突副本徽标', selector: '.book-conflict-badge', need: NEED_TEXT, optional: true },
  { key: '损坏书卡的标题', selector: '.book-card.corrupt .book-card-title', need: NEED_TEXT, optional: true },
  { key: '搜索框占位提示', selector: '#shelf-search', pseudo: '::placeholder', need: NEED_TEXT }
];

const EDITOR_SPECS = [
  { key: '章节标题', selector: '#chapter-title', need: NEED_TEXT },
  { key: '正文', selector: '#editor', need: NEED_TEXT },
  { key: '正文占位提示', selector: '#editor', pseudo: '::placeholder', need: NEED_TEXT },
  { key: '章节列表章名', selector: '#chapter-list .chapter-item:not(.active) .chapter-name', need: NEED_TEXT },
  { key: '章节号', selector: '#chapter-list .chapter-item:not(.active) .chapter-num', need: NEED_TEXT, optional: true },
  { key: '章节字数', selector: '#chapter-list .chapter-item:not(.active) .chapter-chars', need: NEED_TEXT },
  {
    key: '章节备注标记',
    selector: '#chapter-list .chapter-item:not(.active) .chapter-note-mark',
    need: NEED_TEXT,
    optional: true
  },
  {
    key: '当前章章节号（强调色）',
    selector: '#chapter-list .chapter-item.active .chapter-num',
    need: NEED_TEXT,
    optional: true
  },
  { key: '分卷名', selector: '#chapter-list .volume-item .volume-name', need: NEED_TEXT, optional: true },
  { key: '状态栏文字', selector: '#status-text', need: NEED_TEXT },
  { key: '状态栏快捷键提示', selector: '.status-hints .kbd', need: NEED_TEXT, optional: true },
  { key: '焦点环', token: '--focus-ring', bgToken: '--paper-soft', need: NEED_UI },
  { key: '滚动条滑块', token: '--scroll-thumb', bgToken: '--paper', need: NEED_UI },
  { key: '警示色文字', token: '--warn', bgToken: '--paper-soft', need: NEED_TEXT },
  { key: '危险色文字', token: '--danger', bgToken: '--paper-soft', need: NEED_TEXT }
];

const DIRTY_SPECS = [{ key: '主按钮「保存」（启用态）', selector: '#btn-save', need: NEED_TEXT }];

// 不达标的采样（缺元素但标了 optional 的不算；非 optional 的缺了要报出来）。
function offenders(samples) {
  return (samples || [])
    .filter((sample) => {
      if (sample.missing === true || (sample.found === false && sample.optional)) return false;
      if (sample.found === false) return true;
      return !(sample.ratio != null && sample.ratio >= sample.need);
    })
    .map((sample) => ({
      theme: sample.theme,
      key: sample.key,
      ratio: sample.ratio,
      need: sample.need,
      color: sample.color || null
    }));
}

function compact(samples) {
  const rows = {};
  for (const sample of samples || []) {
    if (!rows[sample.theme]) rows[sample.theme] = {};
    rows[sample.theme][sample.key] = sample.ratio;
  }
  return rows;
}

module.exports = async function group67ContrastA11y(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  // 67a. 造演练书：分卷 / 章节备注 / 完稿 / 作者 / 简介 / 标签 + 一份同步冲突副本
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  // 前面的组可能留下书架搜索词 / 分组筛选（组 15 就设过分组），不清掉的话新书根本不会画出来
  await exec("window.__cwTest.setShelfQuery('')");
  await exec("window.__cwTest.setShelfGroup('')");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  const created = await storage.createBook(booksRoot, '对比度演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章 起风');
  await storage.createChapter(bookPath, 2, '第三章 夜雨');
  const baseMeta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, baseMeta.chapters[0].file, '');
  await storage.saveChapterText(bookPath, baseMeta.chapters[1].file, '风从窗缝里挤进来，灯芯跳了一下。');
  const meta = await storage.readBookMeta(bookPath);
  meta.volumes = [{ id: 'v1', name: '第一卷 秋' }];
  meta.chapters = meta.chapters.map((chapter, index) => ({
    ...chapter,
    volumeId: index === 0 ? null : 'v1',
    note: index === 1 ? '回头补一段' : '',
    status: index === 1 ? 'done' : 'draft'
  }));
  meta.author = '演练作者';
  meta.brief = '只用来量对比度的临时书，收尾就移进 _trash。';
  meta.group = '演练';
  meta.tags = ['对比度'];
  await storage.writeBookMeta(bookPath, meta);
  await fsp.writeFile(path.join(bookPath, '001-起风-冲突副本.txt'), '冲突副本', 'utf8');

  // 书目坏掉的书：书架上画成「损坏」卡片（以前这张卡的底色是写死的浅色，夜间主题会读不清）
  const corruptPath = path.join(booksRoot, '损坏的书');
  await fsp.mkdir(corruptPath, { recursive: true });
  await fsp.writeFile(path.join(corruptPath, '书目.json'), '{ 这不是 json', 'utf8');
  await fsp.writeFile(path.join(corruptPath, '001-断章.txt'), '断章', 'utf8');

  await exec('window.__cwTest.refreshShelf()');
  // 等这两张卡真的画出来（不数总数：书架上还有「新建一本书」这张假卡，而且别的组可能留下筛选）
  await waitFor(
    `Array.from(document.querySelectorAll('#book-grid .book-card')).some((el) => el.dataset.path === ${JSON.stringify(bookPath)})`
  );
  await waitFor(
    `Array.from(document.querySelectorAll('#book-grid .book-card')).some((el) => el.dataset.path === ${JSON.stringify(corruptPath)})`
  );
  check(
    '对比度：演练书（带作者 / 简介 / 标签 / 冲突副本）与损坏书都出现在书架上',
    (await storage.listBooks(booksRoot)).length === shelfBefore + 2,
    (await storage.listBooks(booksRoot)).length
  );

  // 67b. 书架：6 套主题下书卡 / 冲突徽标 / 损坏卡 / 占位提示都要能读
  const shelfReport = await exec(`(${sampleThemes.toString()})('shelf', ${JSON.stringify(SHELF_SPECS)})`);
  const shelfSamples = shelfReport.samples;
  check(
    '对比度：采样前能关掉颜色过渡（否则读到的会是过渡中间帧，数字不可信）',
    shelfReport.transitionsOff === true,
    { transitionsOff: shelfReport.transitionsOff }
  );
  check(
    '对比度：6 套主题下书架上的文字都达到 AA（书卡书名 / 作者 / 最后修改 / 标签 / 冲突徽标 / 损坏卡标题 / 占位提示）',
    offenders(shelfSamples).length === 0,
    { offenders: offenders(shelfSamples), ratios: compact(shelfSamples) }
  );

  // 67c. 写作页（第 1 章是空正文，所以占位提示也在采样范围内）
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 3");
  const editorReport = await exec(`(${sampleThemes.toString()})('editor', ${JSON.stringify(EDITOR_SPECS)})`);
  const editorSamples = editorReport.samples;
  check(
    '对比度：写作页采样时颜色过渡同样是关掉的（切主题立刻读最终色）',
    editorReport.transitionsOff === true,
    { transitionsOff: editorReport.transitionsOff }
  );
  const editorFails = offenders(editorSamples);
  check(
    '对比度：6 套主题下写作页正文 / 标题 / 章节列表 / 状态栏 / 占位提示都达到 AA',
    editorFails.length === 0,
    { offenders: editorFails, ratios: compact(editorSamples) }
  );

  const uiFails = editorFails.filter((item) => item.key === '焦点环' || item.key === '滚动条滑块');
  check(
    '对比度：焦点环与滚动条滑块在 6 套主题下都过 3:1（键盘操作能看见焦点，滚动条不是一道白影）',
    uiFails.length === 0,
    { offenders: uiFails }
  );

  const tokenFails = editorFails.filter((item) => item.key === '警示色文字' || item.key === '危险色文字');
  check(
    '对比度：警示色 / 危险色当文字用在纸白上时也过 4.5:1（校对规则名 / 损坏提示 / 字数不足提示）',
    tokenFails.length === 0,
    { offenders: tokenFails }
  );

  // 67d. 主按钮（保存）启用态：夜间主题是深色字，浅色主题是白字，两边都要过 4.5:1
  await exec("window.__cwTest.setText(window.__cwTest.text() + '字')");
  await waitFor('window.__cwTest.dirty() === true');
  const dirtyReport = await exec(`(${sampleThemes.toString()})('dirty', ${JSON.stringify(DIRTY_SPECS)})`);
  const dirtySamples = dirtyReport.samples;
  check(
    '对比度：主按钮「保存」启用态的文字在 6 套主题下都过 4.5:1（夜间改深色字）',
    offenders(dirtySamples).length === 0,
    { offenders: offenders(dirtySamples), ratios: compact(dirtySamples) }
  );
  // 改回原文（dirty 变回 false），否则回书架会弹「保存吗」把整轮 E2E 卡死
  await exec('window.__cwTest.setText("")');
  await waitFor('window.__cwTest.dirty() === false');

  // 67e. 正文命中高亮的固定深色字（夜间主题以前用 inherit，浅灰字压在浅琥珀上只有 2.08:1）
  const markReport = await exec(`(${sampleSnippetMark.toString()})()`);
  const markSamples = markReport.samples;
  const markFails = markSamples.filter((sample) => {
    const fg = /rgba?\(([^)]+)\)/.exec(sample.color);
    const bg = /rgba?\(([^)]+)\)/.exec(sample.background);
    if (!fg || !bg) return true;
    const channel = (raw) => {
      const value = raw / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    const lum = (parts) => 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2]);
    const a = lum(fg[1].split(',').map(Number));
    const b = lum(bg[1].split(',').map(Number));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < NEED_TEXT;
  });
  check(
    '对比度：正文命中高亮（浅琥珀底）用的是固定深色字，6 套主题下都过 4.5:1',
    markFails.length === 0,
    { offenders: markFails, samples: markSamples }
  );

  // 67f. 夜间主题的原生控件配色：只有夜间是 dark，浅色主题保持不变
  const schemes = await exec(`(${sampleColorScheme.toString()})()`);
  const schemeFails = schemes.filter((item) => (item.theme === 'night' ? item.scheme !== 'dark' : item.scheme === 'dark'));
  check(
    '对比度：夜间主题给原生控件开深色（color-scheme: dark），其余 5 套主题保持浅色',
    schemeFails.length === 0,
    { samples: schemes }
  );

  // 67g. 收尾：两本书都移进书架 _trash，书架数量复原
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const removedBook = await deleteBookWithRetry(bookPath);
  const removedCorrupt = await deleteBookWithRetry(corruptPath);
  check(
    '对比度：演练书与损坏书都移入书架 _trash（没有真删）',
    Boolean(removedBook && removedBook.ok === true) &&
      Boolean(removedCorrupt && removedCorrupt.ok === true) &&
      removedBook.data.method === 'move' &&
      removedCorrupt.data.method === 'move',
    { removedBook, removedCorrupt }
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '对比度：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};

module.exports.__test = { sampleThemes, sampleSnippetMark, sampleColorScheme, offenders, SHELF_SPECS, EDITOR_SPECS, DIRTY_SPECS };
