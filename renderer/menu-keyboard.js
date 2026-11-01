/* 菜单键盘可达（v0.9 A-5c 无障碍与键盘）——浏览器侧，只决定「焦点去哪儿」，不碰数据、不写盘。
 *
 * A-5b 把弹层、章节条目、书卡补成键盘可达之后，还剩三块是「只有鼠标才拿得到」的：
 *   1. 右键菜单（#context-menu / #volume-menu / #book-menu）：右键或点「⋯」打开后焦点不进菜单，
 *      而菜单条目在 DOM 末尾——Tab 走一整圈也到不了，键盘用户拿不到「重命名 / 编辑备注 / 移到卷…」；
 *   2. 顶栏下拉（整理 ▾ / 显示 ▾ / 导出 ▾）：整理卡与导出菜单按 Esc 收起后焦点不还给按钮
 *      （导出直接丢到 <body>；整理更糟——把焦点还给按钮会立刻把卡片重新打开，等于 Esc 关不掉）；
 *   3. 分卷标题行（折叠 / 展开）：一行普通 <div>，Tab 到不了、键盘收不起卷。
 *   （第 3 件在 renderer/list-keyboard.js 的 installVolumeHeaders 里，和章节条目的键盘通道放一起。）
 *
 * 做法（和 renderer/dialog-focus.js 一个口径）：
 *   · 盯 6 个菜单的 class：右键菜单变成可见的那一刻记住「谁打开的」，把焦点带进第一条可用条目；
 *     关掉时只有焦点「没归属」（掉到 body / 还停在菜单里 / 已经不可见）才还给打开它的元素；
 *   · 菜单里方向键上下绕回、Home / End 到头，跳过 disabled 与 .hidden 的条目；
 *   · Esc 收起菜单并把焦点还给打开它的元素；右键菜单里按 Tab 也算「收起」（菜单条目在 DOM 末尾，
 *     不收起的话 Tab 会一路跑到页面开头，等于迷路）；
 *   · **顶栏下拉不主动抢焦点**：沿用浏览器原生的 Tab 顺序（A-5b 量到「显示」本来就能 Tab 进去），
 *     只在焦点已经在菜单里时管 Esc / Tab。
 *
 * 为什么单独一个文件：renderer.js 有 9600 行闸门测试；焦点策略集中在一处也方便单测（纯决策函数）
 * 与 E2E（真实 Electron + 真实按键）。边界：只管这 6 个菜单，弹层归 dialog-focus.js。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (root) root.CWMenuKeyboard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 菜单清单：右键菜单「谁打开的」由事件目标决定；顶栏下拉由固定按钮决定。
  // kind = 'context' 的才在打开时把焦点带进去（顶栏下拉保持浏览器原生 Tab 顺序）。
  const MENUS = [
    { id: 'context-menu', kind: 'context', openerSelector: '.chapter-item' },
    { id: 'volume-menu', kind: 'context', openerSelector: '.volume-item' },
    { id: 'book-menu', kind: 'context', openerSelector: '.book-card, .book-card-more' },
    { id: 'format-menu', kind: 'dropdown', openerId: 'btn-format' },
    { id: 'display-menu', kind: 'dropdown', openerId: 'btn-display' },
    { id: 'export-menu', kind: 'dropdown', openerId: 'btn-export' }
  ];

  // 菜单里能拿焦点的条目：按钮与原生控件（顶栏「显示」里还有取色器 input 与色块按钮）。
  const ITEM_SELECTOR = 'button, input, select, textarea, [tabindex]';

  const NEXT_KEYS = ['ArrowDown'];
  const PREV_KEYS = ['ArrowUp'];

  // 菜单里按方向键：上下绕回一圈，Home / End 到两头。不认识的键、空菜单返回 null。
  function stepIndex(position, key, count) {
    if (!Number.isFinite(count) || count <= 0) return null;
    const last = count - 1;
    const at = Number.isFinite(position) && position >= 0 && position <= last ? Math.floor(position) : -1;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    if (NEXT_KEYS.indexOf(key) >= 0) return at < 0 ? 0 : (at + 1) % count;
    if (PREV_KEYS.indexOf(key) >= 0) return at < 0 ? last : (at - 1 + count) % count;
    return null;
  }

  // 一次按键的处置：{ type: 'close' } 收起并把焦点还回去；{ type: 'move', index } 在菜单里挪。
  // Esc 一律收起；Tab / Shift+Tab 只在右键菜单里算收起（顶栏下拉保持原生 Tab）。
  // 带 Ctrl / Alt / Meta / Shift 的一律不接管（那些组合有自己的含义，例如 Shift+F10 开菜单）。
  function menuKeyAction(event, kind, position, count) {
    if (!event || typeof event.key !== 'string') return null;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
    if (event.key === 'Escape') return { type: 'close', reason: 'escape' };
    if (event.key === 'Tab' && kind === 'context') return { type: 'close', reason: 'tab' };
    const index = stepIndex(position, event.key, count);
    return index === null ? null : { type: 'move', index };
  }

  // 关掉菜单时，焦点是不是「没归属」了：掉到 body / html、还停在菜单里、或者已经不可见。
  // 业务代码自己 focus 了别处（例如点菜单项后弹层接管）就不抢。
  function shouldReturnFocus(state) {
    if (!state) return true;
    if (state.isBody) return true;
    if (state.insideMenu) return true;
    return Boolean(state.hidden);
  }

  // 菜单条目能不能拿焦点：禁用、aria-hidden、负 tabindex、.hidden、0 尺寸都排除。
  // 做成吃「事实」的纯函数，单测不用搭 DOM。
  function isUsableItem(facts) {
    if (!facts) return false;
    if (facts.disabled) return false;
    if (facts.ariaHidden) return false;
    if (Number.isFinite(facts.tabIndex) && facts.tabIndex < 0) return false;
    if (facts.hiddenClass) return false;
    if (facts.hasRects === false) return false;
    return true;
  }

  let installed = null;

  function install(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const view = opts.window || (doc && doc.defaultView) || null;
    const MO = opts.MutationObserver || (view && view.MutationObserver) || (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (installed || !doc || !view) return installed;
    if (typeof doc.addEventListener !== 'function') return null;

    const specs = Array.isArray(opts.menus) ? opts.menus : MENUS;
    const entries = [];
    for (const spec of specs) {
      const el = doc.getElementById(spec.id);
      if (!el) continue;
      entries.push({
        spec,
        el,
        state: { open: false, opener: null }
      });
    }
    if (!entries.length) return null;

    const doFocus = (el) => {
      if (!el || typeof el.focus !== 'function') return false;
      try {
        el.focus({ preventScroll: true });
      } catch {
        try { el.focus(); } catch { return false; }
      }
      return true;
    };

    const activeOf = () => doc.activeElement || null;
    const isBody = (el) => !el || el === doc.body || el === doc.documentElement;
    const hiddenElement = (el) => {
      if (!el || el.isConnected === false) return true;
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return true;
      const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
      return Boolean(style && (style.display === 'none' || style.visibility === 'hidden'));
    };
    const usableItems = (menu) => {
      const all = Array.from(menu.querySelectorAll(ITEM_SELECTOR));
      return all.filter((el) =>
        isUsableItem({
          disabled: Boolean(el.disabled),
          ariaHidden: el.getAttribute && el.getAttribute('aria-hidden') === 'true',
          tabIndex: typeof el.tabIndex === 'number' ? el.tabIndex : 0,
          hiddenClass: Boolean(el.classList && el.classList.contains('hidden')),
          hasRects: typeof el.getClientRects !== 'function' ? true : el.getClientRects().length > 0
        })
      );
    };
    const focusItem = (menu, index) => {
      const items = usableItems(menu);
      if (!items.length) return false;
      const at = Number.isFinite(index) ? ((index % items.length) + items.length) % items.length : 0;
      return doFocus(items[at]);
    };

    // 右键 / 点击时鼠标落在哪一条上（右键不会移动焦点，所以要自己记「谁打开的」）。
    // 键盘 Shift+F10 / ContextMenu 键由浏览器合成 contextmenu 事件，target 就是焦点所在的那一条，
    // 所以这一条通道两种输入都覆盖。
    let lastPointerTarget = null;
    const POINTER_TARGETS = '.chapter-item, .volume-item, .book-card, .book-card-more';
    const pointerTargetOf = (event) => {
      const target = event && event.target;
      if (!target || typeof target.closest !== 'function') return null;
      return target.closest(POINTER_TARGETS);
    };
    const matchesOpener = (el, selector) =>
      Boolean(el && typeof el.matches === 'function' && el.matches(selector));

    const openerFor = (entry) => {
      const spec = entry.spec;
      if (spec.openerId) return doc.getElementById(spec.openerId) || null;
      // 先认「鼠标 / 合成右键落在哪一条」——右键另一条时焦点可能还停在上一条上，不能拿焦点当打开者
      if (matchesOpener(lastPointerTarget, spec.openerSelector)) return lastPointerTarget;
      const active = activeOf();
      if (matchesOpener(active, spec.openerSelector)) return active;
      return isBody(active) ? null : active;
    };

    const entryById = (id) => entries.find((entry) => entry.spec.id === id) || null;

    // 收起一个菜单：只摘 hidden 之外的可见状态，交给渲染层的观察者 / 下一次打开重设。
    // 状态字段（state.contextIndex 等）不清也不影响：菜单已经看不见，条目点不到。
    const closeMenu = (entry) => {
      if (!entry || entry.el.classList.contains('hidden')) return false;
      entry.el.classList.add('hidden');
      return true;
    };

    // 「整理」卡的特殊情况：Esc 把焦点还给按钮时，按钮的 focusin 又会把卡片打开（等于关不掉）。
    // 在 #format-dropdown 上挂一个捕获阶段的 focusin 一次性闸门，拦掉这一次的重开。
    let suppressFormatFocusIn = false;
    const formatDropdown = doc.getElementById('format-dropdown');
    if (formatDropdown && typeof formatDropdown.addEventListener === 'function') {
      formatDropdown.addEventListener(
        'focusin',
        (event) => {
          if (!suppressFormatFocusIn) return;
          suppressFormatFocusIn = false;
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        },
        true
      );
    }

    const returnFocus = (entry) => {
      entry.state.open = false;
      const opener = entry.state.opener;
      entry.state.opener = null;
      if (!opener || opener.isConnected === false) return false;
      if (typeof opener.getClientRects === 'function' && opener.getClientRects().length === 0) return false;
      if (entry.spec.id === 'format-menu') suppressFormatFocusIn = true;
      const ok = doFocus(opener);
      // focus() 会同步派发 focusin：闸门若没被消费（焦点本来就在按钮上），这里清掉别留到下回
      suppressFormatFocusIn = false;
      return ok;
    };

    function syncEntry(entry) {
      const visible = !entry.el.classList.contains('hidden');
      if (visible && !entry.state.open) {
        entry.state.open = true;
        entry.state.opener = openerFor(entry);
        if (entry.spec.kind === 'context') focusItem(entry.el, 0);
        return;
      }
      if (!visible && entry.state.open) {
        const active = activeOf();
        const lost = shouldReturnFocus({
          isBody: isBody(active),
          insideMenu: Boolean(active) && entry.el.contains(active),
          hidden: Boolean(active) && hiddenElement(active)
        });
        if (lost && entry.state.opener) returnFocus(entry);
        else {
          entry.state.open = false;
          entry.state.opener = null;
        }
      }
    }

    function syncAll() {
      for (const entry of entries) syncEntry(entry);
    }

    function onKeyDown(event) {
      const menu = event && event.currentTarget;
      if (!menu) return;
      const entry = entries.find((it) => it.el === menu);
      if (!entry) return;
      const items = usableItems(menu);
      const position = items.indexOf(activeOf());
      const action = menuKeyAction(event, entry.spec.kind, position, items.length);
      if (!action) return;
      if (action.type === 'close') {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        // 按键收起时同步把焦点还回去（不等 MutationObserver 那一拍）：键盘用户的焦点不能闪一下空档
        returnFocus(entry);
        closeMenu(entry);
        return;
      }
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      focusItem(menu, action.index);
    }

    for (const entry of entries) entry.el.addEventListener('keydown', onKeyDown);
    // 捕获阶段记「最后落在哪一条上」：右键与点击都走这里（不能只看焦点——右键不移动焦点，
    // 点「⋯」是程序化点击时也不一定有焦点）。
    doc.addEventListener('click', (event) => {
      const target = pointerTargetOf(event);
      if (target) lastPointerTarget = target;
    }, true);
    doc.addEventListener('contextmenu', (event) => {
      const target = pointerTargetOf(event);
      if (target) lastPointerTarget = target;
      // 右键菜单已经在开着时又右键了另一条：菜单不会重新「变成可见」（class 没变），
      // 这里补一次「换人」——记住新的打开者并把焦点带回第一条。
      const open = entries.find((it) => it.spec.openerSelector && !it.el.classList.contains('hidden'));
      if (open && target && target.isConnected !== false) {
        open.state.opener = target;
        if (open.spec.kind === 'context') focusItem(open.el, 0);
      }
    }, true);

    let observer = null;
    if (typeof MO === 'function') {
      observer = new MO(() => syncAll());
      for (const entry of entries) observer.observe(entry.el, { attributes: true, attributeFilter: ['class'] });
    }
    syncAll();

    installed = {
      document: doc,
      entries,
      sync: syncAll,
      openerFor: (id) => {
        const entry = entryById(id);
        return entry ? entry.state.opener : null;
      },
      close: (id) => closeMenu(entryById(id)),
      destroy() {
        for (const entry of entries) entry.el.removeEventListener('keydown', onKeyDown);
        if (observer) observer.disconnect();
        installed = null;
      }
    };
    return installed;
  }

  return {
    MENUS,
    ITEM_SELECTOR,
    stepIndex,
    menuKeyAction,
    shouldReturnFocus,
    isUsableItem,
    install
  };
});
