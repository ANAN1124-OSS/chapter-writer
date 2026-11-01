// E2E 第 69 组：动效克制与统一（v0.9 A-6）。
//
// 钉住的是「全界面只有两档过渡 / 动画时长」这条规矩——以前同一个「悬停变色」在
// 书卡上是 .15s、按钮上是 .12s、下拉菜单上是 .1s、进度条上是 .2s、toast 是 .16s
// （renderer.js 里还有一处写死 .25s 的淡出），实测全界面同时存在 5 种时长；
// 卡片悬停还额外做 1px 上浮（唯一会连带移动命中区域的动效）。
//
// 为什么必须 E2E：读的是浏览器算出来的 transitionDuration / transitionProperty /
// animationDuration（var() / 简写 / 伪元素 / 内联样式都在这一步解析），
// 静态扫 CSS 文本既看不见 var() 解析后的值，也看不见 JS 写进去的内联过渡。
// 悬停用真实鼠标事件（sendInputEvent mouseMove）：:hover 走不到脚本桩。
//
// 自足：自己造一本 2 章的演练书，收尾走书架 _trash 删掉；不写配置、不碰真实书架。
const QUICK = '0.12s';
const OVERLAY = '0.16s';
// 令牌本身写的是 .12s（不带前导零），getComputedStyle 的 transitionDuration 是 0.12s：
// 两边按数值比，别按字符串比。
const QUICK_SEC = 0.12;
const OVERLAY_SEC = 0.16;
const isDuration = (value, seconds) => Math.abs(Number.parseFloat(value) - seconds) < 1e-6;

// 整页扫一遍：哪些元素带动效、落到元素上的时长有几种、有没有人还在做 transform 过渡
const SCAN = `(() => {
  const skip = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE']);
  const durations = {};
  const propSets = {};
  const transformMotion = [];
  let animated = 0;
  for (const el of document.querySelectorAll('*')) {
    if (skip.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const list = cs.transitionDuration.split(',').map((s) => s.trim());
    if (list.some((d) => d !== '0s')) {
      animated += 1;
      for (const d of list) durations[d] = (durations[d] || 0) + 1;
      const props = cs.transitionProperty.split(',').map((s) => s.trim());
      const key = props.slice().sort().join('+');
      propSets[key] = (propSets[key] || 0) + 1;
      // 位移类过渡会额外提升合成层、还会把命中区域一起移走：一条都不该有
      if (props.some((p) => p === 'transform' || p === 'translate' || p === 'top' || p === 'left')) {
        transformMotion.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '.' + String(el.className || '').split(' ')[0]));
      }
    }
    if (cs.animationName !== 'none' && cs.animationDuration !== '0s') {
      durations[cs.animationDuration] = (durations[cs.animationDuration] || 0) + 1;
    }
  }
  return JSON.stringify({
    animated,
    durations: Object.keys(durations).sort(),
    propSets,
    transformMotion: transformMotion.slice(0, 5),
    tokens: {
      quick: getComputedStyle(document.documentElement).getPropertyValue('--motion-quick').trim(),
      overlay: getComputedStyle(document.documentElement).getPropertyValue('--motion-overlay').trim()
    }
  });
})()`;

// 指定选择器（含伪元素）上的动效：时长清单 + 属性清单
const jsSpec = (selector, pseudo) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ found: false });
  const cs = getComputedStyle(el${pseudo ? `, ${JSON.stringify(pseudo)}` : ''});
  const durations = cs.transitionDuration.split(',').map((s) => s.trim());
  const props = cs.transitionProperty.split(',').map((s) => s.trim());
  return JSON.stringify({
    found: true,
    durations: [...new Set(durations)].sort(),
    props: [...new Set(props)].sort(),
    animation: cs.animationName === 'none' ? '' : cs.animationDuration
  });
})()`;

// 悬停现场：:hover 有没有命中、有没有位移、过渡属性是什么、边框是不是变成了强调色
const JS_HOVER = `(() => {
  const el = document.querySelector('.book-card');
  const cs = getComputedStyle(el);
  // 把 --accent-soft 解析成 rgb，用来核对「悬停反馈还在」
  const probe = document.createElement('span');
  probe.style.color = 'var(--accent-soft)';
  document.body.appendChild(probe);
  const accentSoft = getComputedStyle(probe).color;
  probe.remove();
  return JSON.stringify({
    hovered: el.matches(':hover'),
    transform: cs.transform,
    borderColor: cs.borderTopColor,
    accentSoft,
    props: cs.transitionProperty.split(',').map((s) => s.trim()).sort(),
    durations: [...new Set(cs.transitionDuration.split(',').map((s) => s.trim()))].sort(),
    boxShadow: cs.boxShadow
  });
})()`;

const jsToast = `(() => {
  const el = document.querySelector('#toast-area .toast');
  if (!el) return JSON.stringify({ present: false });
  const cs = getComputedStyle(el);
  return JSON.stringify({
    present: true,
    opacity: cs.opacity,
    animation: cs.animationName,
    animationDuration: cs.animationDuration,
    transitionDuration: cs.transitionDuration,
    transitionProperty: cs.transitionProperty
  });
})()`;

module.exports = async function group69Motion(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry, win, sleep } = t;

  const scan = async (label) => {
    const data = JSON.parse(await exec(SCAN));
    check(
      `${label}：全界面过渡 / 动画时长只有两档（${QUICK} / ${OVERLAY}）`,
      JSON.stringify(data.durations) === JSON.stringify([QUICK, OVERLAY]),
      data.durations
    );
    check(
      `${label}：令牌就是这两档（--motion-quick / --motion-overlay）`,
      isDuration(data.tokens.quick, QUICK_SEC) && isDuration(data.tokens.overlay, OVERLAY_SEC),
      data.tokens
    );
    check(`${label}：没有任何元素还在做位移类过渡`, data.transformMotion.length === 0, data.transformMotion);
    return data;
  };
  const spec = async (label, selector, pseudo) => JSON.parse(await exec(jsSpec(selector, pseudo)));

  // ---------- 演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;
  const created = await storage.createBook(booksRoot, '动效演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  await exec('window.__cwTest.refreshShelf()');
  await sleep(300);
  check('动效：演练书造好（2 章）', (await storage.readBookMeta(bookPath)).chapters.length === 2);

  // ---------- 书架 ----------
  const shelfScan = await scan('动效-书架');
  check('动效-书架：确实有元素带动效（不是把动效全删了）', shelfScan.animated > 50, shelfScan.animated);

  const card = await spec('动效-书架', '.book-card');
  check('动效-书架：书卡只过渡边框色与阴影（不再有 transform）', JSON.stringify(card.props) === JSON.stringify(['border-color', 'box-shadow']), card.props);
  check('动效-书架：书卡时长 = --motion-quick', JSON.stringify(card.durations) === JSON.stringify([QUICK]), card.durations);

  const more = await spec('动效-书架', '.book-card-more');
  check('动效-书架：「⋯」按钮 = 淡入 + 悬停底色，都走 quick', JSON.stringify(more.durations) === JSON.stringify([QUICK]) && JSON.stringify(more.props) === JSON.stringify(['background', 'opacity']), more);

  const btn = await spec('动效-书架', '.btn');
  check('动效-书架：按钮四个属性统一走 quick', JSON.stringify(btn.durations) === JSON.stringify([QUICK]) && btn.props.length === 4, btn);

  const track = await spec('动效-书架', '.goal-track > i');
  check('动效-书架：进度条宽度动画从 .2s 收到 quick', JSON.stringify(track.durations) === JSON.stringify([QUICK]) && JSON.stringify(track.props) === JSON.stringify(['width']), track);

  const menuBtn = await spec('动效-书架', '.dropdown-menu button');
  check('动效-书架：顶栏下拉菜单从 .1s 提到 quick', JSON.stringify(menuBtn.durations) === JSON.stringify([QUICK]), menuBtn);

  const focusBar = await spec('动效-书架', '.focus-bar');
  check('动效-书架：专注模式悬浮条淡出走 overlay（面状进出那一档）', JSON.stringify(focusBar.durations) === JSON.stringify([OVERLAY]) && JSON.stringify(focusBar.props) === JSON.stringify(['opacity']), focusBar);

  // ---------- 悬停：真实鼠标移到第一张书卡中心 ----------
  const rect = JSON.parse(
    await exec(
      "(() => { const el = document.querySelector('.book-card'); const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()"
    )
  );
  win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
  await sleep(400);
  const hover = JSON.parse(await exec(JS_HOVER));
  check('动效-悬停：真实鼠标命中 .book-card 的 :hover', hover.hovered === true, hover);
  check('动效-悬停：悬停不再上浮 1px（transform 保持 none）', hover.transform === 'none', hover.transform);
  check('动效-悬停：悬停反馈还在（边框变成 --accent-soft）', hover.borderColor === hover.accentSoft, { got: hover.borderColor, want: hover.accentSoft });
  check('动效-悬停：阴影照常浮起（不是把悬停态删了）', hover.boxShadow !== 'none' && hover.boxShadow !== '', hover.boxShadow);
  check('动效-悬停：过渡属性里没有 transform', !hover.props.includes('transform'), hover.props);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
  await sleep(200);

  // ---------- 写作页 ----------
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await sleep(300);
  await scan('动效-写作页');

  const chapterItem = await spec('动效-写作页', '.chapter-item');
  check('动效-写作页：章节条目 = 底色 + 当前章内描边，都走 quick', JSON.stringify(chapterItem.durations) === JSON.stringify([QUICK]) && JSON.stringify(chapterItem.props) === JSON.stringify(['background', 'box-shadow']), chapterItem);

  const resizer = await spec('动效-写作页', '.sidebar-resizer', '::after');
  check('动效-写作页：分隔条的悬停反馈（::after）走 quick', JSON.stringify(resizer.durations) === JSON.stringify([QUICK]), resizer);

  // ---------- toast：真实冒烟一条（弹出 0.16s → 3.6s 后淡出 0.16s → 消失） ----------
  // 先等干净：前面各组留下的 toast 会自己消失（3.6s + 300ms），不等它们会让下面数错。
  await waitFor("document.querySelectorAll('#toast-area .toast').length === 0", 12000);
  await exec('window.__cwTest.saveVisible()'); // 当前章没有改动 → 只弹一条「当前章节没有改动」，不写盘
  await waitFor("document.querySelectorAll('#toast-area .toast').length > 0");
  const toastIn = JSON.parse(await exec(jsToast));
  check('动效-toast：入场动画还是 toast-in', toastIn.animation === 'toast-in', toastIn.animation);
  check('动效-toast：入场时长 = --motion-overlay', toastIn.animationDuration === OVERLAY, toastIn.animationDuration);

  // 3.6 秒后才开始淡出。这里**不能**等「opacity === 0」：toast 的入场动画第一帧
  // 就是从 opacity 0 开始（keyframe from），一创建就叫醒，量到的还是入场中的元素
  // （第一版就是这么误判的：计算出来的过渡是 all / 0s，因为淡出 class 还没加上）。
  // 等真正的淡出信号（.leaving class）出现，并在同一次 exec 里把计算值一起读回来，
  // 免得中间隔着 120ms 轮询、撞上 300ms 后元素被移除。
  const fade = JSON.parse(
    await waitFor(
      `(() => {
        const el = document.querySelector('#toast-area .toast');
        if (!el || !el.classList.contains('leaving')) return false;
        const cs = getComputedStyle(el);
        return JSON.stringify({
          opacity: cs.opacity,
          transitionDuration: cs.transitionDuration,
          transitionProperty: cs.transitionProperty,
          animations: (el.getAnimations ? el.getAnimations() : []).map((a) => ({
            prop: a.transitionProperty || '',
            duration: a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null
          }))
        });
      })()`,
      8000
    )
  );
  check('动效-toast：3.6 秒后真的进入淡出（.leaving，透明度正在往下走）', Number(fade.opacity) < 1, fade);
  check('动效-toast：淡出过渡 = --motion-overlay（以前 JS 里写死 .25s）', fade.transitionDuration === OVERLAY, fade);
  check('动效-toast：淡出只过渡 opacity', fade.transitionProperty === 'opacity', fade.transitionProperty);
  // 光看计算值只能证明「声明对了」，这里再要求真有一条 opacity 过渡在跑（160ms，不是瞬间跳没）
  check(
    '动效-toast：淡出真有一条 opacity 过渡在跑（160ms）',
    fade.animations.some((a) => a.prop === 'opacity' && a.duration === Math.round(OVERLAY_SEC * 1000)),
    fade.animations
  );
  // 淡出后 300ms 里被移除
  const gone = await waitFor("document.querySelectorAll('#toast-area .toast').length === 0", 4000);
  check('动效-toast：淡出结束后元素被移除（不留透明节点）', gone === true);

  // ---------- 设置弹层：弹层里也没有第三档时长 ----------
  await exec('window.__cwTest.openSettings()');
  await waitFor("!document.getElementById('settings-backdrop').classList.contains('hidden')");
  await sleep(250);
  await scan('动效-设置弹层');
  await exec('window.__cwTest.closeSettings()');
  await waitFor("document.getElementById('settings-backdrop').classList.contains('hidden')");

  // ---------- 收尾：不留演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const removed = await deleteBookWithRetry(bookPath);
  check('动效：演练书已删掉（走 _trash）', removed && removed.ok === true, removed);
  const shelfAfter = (await storage.listBooks(booksRoot)).length;
  check('动效：书架数量回到演练前', shelfAfter === shelfBefore, { before: shelfBefore, after: shelfAfter });
};
