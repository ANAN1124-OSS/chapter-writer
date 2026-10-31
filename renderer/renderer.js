/* 章节写作器 v0.1 —— 渲染层
 * 规则：这里的任何东西都不能直接访问文件系统；所有读写都通过 window.api（白名单 IPC）。
 * 保存策略：完全手动。只有按 Ctrl+S / 点保存才写正文；切章、关窗、导出前只提醒，不偷偷写。
 */
(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const editorEl = $('editor');

  // ---------- 小工具 ----------
  const pad2 = (n) => String(n).padStart(2, '0');

  function formatClock(date) {
    if (!date) return '';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatRelativeTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfThatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((startOfToday - startOfThatDay) / 86400000);
    if (dayDiff === 0) return `今天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (dayDiff === 1) return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (dayDiff > 1 && dayDiff < 7) return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function formatChars(n) {
    const value = Number(n) || 0;
    if (value < 10000) return `${value} 字`;
    if (value < 100000000) return `${(value / 10000).toFixed(2)} 万字`;
    return `${(value / 100000000).toFixed(2)} 亿字`;
  }

  function formatBytes(n) {
    const value = Math.max(0, Number(n) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function countChars(text) {
    return String(text == null ? '' : text).replace(/\s/g, '').length;
  }

  // 章节标题显示规则（与 core/chapters.js 的 formatTitle 保持一致）：
  // 原文自带章节标题（第1章 / 楔子 / Chapter N…）原样显示；没有名字显示「第N章」；其余显示「第N章：名字」
  const RAW_TITLE_RE =
    /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷集篇部话幕]|楔子|序章|序言|引子|前言|前传|外传|尾声|后记|番外|终章|大结局|附录|开篇|Chapter\s+\d+)/i;

  function chapterTitle(index, name) {
    const clean = String(name == null ? '' : name).trim();
    if (clean && RAW_TITLE_RE.test(clean)) return clean;
    if (!clean) return `第${index + 1}章`;
    return `第${index + 1}章：${clean}`;
  }

  // 章节状态 / 备注（与 core/chapters.js 的清洗规则保持一致）：只存在 书目.json 里，不动正文。
  const CHAPTER_STATUSES = ['draft', 'revising', 'done'];
  const CHAPTER_STATUS_LABELS = { draft: '草稿', revising: '待修', done: '完稿' };

  function chapterStatus(chapter) {
    const raw = chapter && typeof chapter.status === 'string' ? chapter.status.trim().toLowerCase() : '';
    return CHAPTER_STATUSES.includes(raw) ? raw : 'draft';
  }

  function chapterNote(chapter) {
    const raw = chapter && chapter.note;
    if (typeof raw !== 'string') return '';
    const note = raw.trim();
    return note.length > 200 ? note.slice(0, 200) : note;
  }

  class ApiError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
    }
  }

  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res || res.ok === false) {
      throw new ApiError((res && res.message) || '未知错误', res && res.code);
    }
    return res.data;
  }

  // ---------- 状态 ----------
  const state = {
    config: null, // 显示设置的「生效值」= 全局 + 当前书覆盖
    globalConfig: null, // 全局显示设置（书架 →「设置」里改的那份）
    books: [],
    view: 'shelf',
    bookPath: null,
    meta: null,
    bookId: null, // 当前书的 meta.id（按书记忆显示设置的 key）
    chapters: [],
    index: -1,
    baseText: '',
    dirty: false,
    loading: false,
    saving: false,
    saveError: null,
    savedAt: null,
    loadedMtimeMs: 0,
    lastEditAt: 0,
    modal: null,
    contextIndex: -1,
    contextBook: null,
    contextVolumeId: null, // 当前右键的卷（卷菜单用）
    collapsedVolumes: new Set(), // 折叠起来的卷（'' = 未分卷组；只记在内存里，换书重置）
    importing: false,
    sidebarWidth: 250,
    sidebarDragging: false,
    formatUndo: [], // 「整理本章」的快照栈（只存在内存里，关掉应用就没了；最多 50 步）
    replaceBackups: [], // 当前书的「整本替换」备份列表（查找面板里展示 / 还原用）
    bookDisplay: {}, // 当前书的显示设置覆盖（只覆盖改过的项）
    recentBook: null, // 上次写作的书 / 章（书架顶部「继续上次写作」；主进程从 config 读）
    conflictBook: null, // 正在看「同步冲突副本」弹层的那本书（只用于打开文件夹）
    history: null, // 正在看的「本书历史」：{ path, title, groups, preview, loading, error, token }
    shelfQuery: '', // 书架搜索词（书名 / 章节名）
    stats: null, // 每日字数摘要：{ day, todayChars, goal, goalPercent, goalMet, recentTotal, days[] }
    jumpMatches: [], // Ctrl+G 跳章的当前匹配结果
    jumpQuery: '', // 跳章输入框里的词
    jumpOutOfRange: false, // 输入的是章号但超出本书章数
    jumpToken: 0, // 丢弃过期的异步匹配结果
    jumpTimer: null, // 输入防抖
    formatBookRunning: false, // 「一键整理本书」进行中（防重复触发）
    settingsScope: 'global', // 设置弹层作用域：global = 全局默认；book = 只改这本书
    settingsBackup: null, // 设置弹窗里实时预览用：取消时恢复
    settingsFontDraft: { path: '', name: '' }, // 设置里刚选的自定义字体（点保存才落配置）
    suppressChapterClick: 0, // 拖拽结束后短暂屏蔽 click，避免误切章
    testMode: new URLSearchParams(location.search).has('test')
  };

  // ---------- Toast ----------
  function toast(message, kind = 'info') {
    const area = $('toast-area');
    const el = document.createElement('div');
    el.className = `toast ${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : ''}`.trim();
    el.textContent = message;
    area.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s ease';
      setTimeout(() => el.remove(), 300);
    }, 3600);
  }

  // ---------- 通用模态 ----------
  function openModal({ title, message, input, buttons, cancelValue = null }) {
    return new Promise((resolve) => {
      state.modal = { resolve, opts: { title, message, input, buttons, cancelValue } };
      $('modal-title').textContent = title || '';
      const messageEl = $('modal-message');
      messageEl.textContent = message || '';
      messageEl.classList.toggle('hidden', !message);
      const inputEl = $('modal-input');
      if (input) {
        inputEl.classList.remove('hidden');
        inputEl.value = input.value == null ? '' : input.value;
        inputEl.placeholder = input.placeholder || '';
        setTimeout(() => {
          inputEl.focus();
          inputEl.select();
        }, 30);
      } else {
        inputEl.classList.add('hidden');
        inputEl.value = '';
      }
      const box = $('modal-buttons');
      box.innerHTML = '';
      (buttons || []).forEach((button) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${button.kind || 'ghost'}`;
        btn.textContent = button.label;
        btn.dataset.value = String(button.value);
        btn.addEventListener('click', () => {
          const value = input ? inputEl.value : undefined;
          closeModal({ action: button.value, value });
        });
        box.appendChild(btn);
      });
      $('modal-backdrop').classList.remove('hidden');
      if (!input) {
        const primary = box.querySelector('.btn.primary') || box.firstElementChild;
        if (primary) primary.focus();
      }
    });
  }

  function closeModal(result) {
    const current = state.modal;
    state.modal = null;
    $('modal-backdrop').classList.add('hidden');
    $('modal-input').classList.add('hidden');
    if (current) current.resolve(result || { action: null });
  }

  // 供自动化测试用：按 value 点掉当前弹窗
  function answerModalValue(value) {
    const btn = $('modal-buttons').querySelector(`button[data-value="${value}"]`);
    if (btn) btn.click();
    else closeModal({ action: value });
  }

  async function promptText({ title, message, value = '', placeholder = '' }) {
    const res = await openModal({
      title,
      message,
      input: { value, placeholder },
      buttons: [
        { label: '确定', value: 'ok', kind: 'primary' },
        { label: '取消', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    if (res.action !== 'ok') return null;
    return String(res.value == null ? '' : res.value);
  }

  async function askUnsaved({ title, message, saveLabel = '保存并继续', discardLabel = '不保存，丢弃修改' }) {
    const res = await openModal({
      title: title || '有未保存的修改',
      message: message || '当前章节有未保存的修改。',
      buttons: [
        { label: saveLabel, value: 'save', kind: 'primary' },
        { label: discardLabel, value: 'discard', kind: 'danger' },
        { label: '取消', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    return res.action || 'cancel';
  }

  // ---------- 视图切换 ----------
  function showView(view) {
    state.view = view;
    $('shelf-view').classList.toggle('hidden', view !== 'shelf');
    $('editor-view').classList.toggle('hidden', view !== 'editor');
    updateWindowTitle();
    renderStatsUi();
  }

  function updateWindowTitle() {
    const bookName = state.view === 'editor' && state.meta ? ` - ${state.meta.title}` : '';
    document.title = `${state.dirty ? '* ' : ''}章节写作器${bookName}`;
  }

  // 显示排版（字体/字号/行间距/字间距/边距/宽度/背景）只改 CSS 变量，绝不改正文
  const CUSTOM_FONT_FAMILY = '"cw-custom-font"';
  const loadedCustomFont = { path: '', name: '', ok: false };

  // 自定义字体：主进程读文件 → 这里用 FontFace 注册（渲染层仍然没有文件系统权限）
  async function loadCustomFont(fontPath, { silent = false } = {}) {
    const wanted = String(fontPath || '');
    if (!wanted) return false;
    if (loadedCustomFont.path === wanted && loadedCustomFont.ok) return true;
    try {
      const res = await call(api.readFont, wanted);
      const binary = atob(res.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const face = new FontFace('cw-custom-font', bytes.buffer);
      await face.load();
      document.fonts.add(face);
      loadedCustomFont.path = wanted;
      loadedCustomFont.name = res.name;
      loadedCustomFont.ok = true;
      return true;
    } catch (err) {
      loadedCustomFont.path = wanted;
      loadedCustomFont.name = '';
      loadedCustomFont.ok = false;
      if (!silent) toast(`字体加载失败：${err.message}`, 'error');
      return false;
    }
  }

  function applyEditorStyle(override) {
    const fonts = {
      serif: '"SimSun", "Songti SC", "Source Han Serif SC", serif',
      sans: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      kai: '"KaiTi", "STKaiti", "Kaiti SC", serif'
    };
    const cfg = override || state.config || {};
    const root = document.documentElement.style;
    const fontFamily =
      cfg.editorFont === 'custom' && cfg.editorCustomFontPath
        ? `${CUSTOM_FONT_FAMILY}, ${fonts.serif}`
        : fonts[cfg.editorFont] || fonts.serif;
    root.setProperty('--editor-font-family', fontFamily);
    root.setProperty('--editor-font-size', `${cfg.editorFontSize || 18}px`);
    root.setProperty('--editor-line-height', String(cfg.editorLineHeight || 1.95));
    const spacing = cfg.editorLetterSpacing == null ? 0.02 : Number(cfg.editorLetterSpacing);
    root.setProperty('--editor-letter-spacing', `${Number.isFinite(spacing) ? spacing : 0.02}em`);
    const pageWidth = Number(cfg.editorPageWidth) || 0;
    root.setProperty('--editor-max-width', pageWidth > 0 ? `${pageWidth}px` : 'none');
    const paddingX = Number(cfg.editorPaddingX);
    root.setProperty('--editor-padding-x', `${Number.isFinite(paddingX) && paddingX > 0 ? paddingX : 56}px`);
    for (const theme of ['cream', 'green', 'night', 'kraft', 'grid']) {
      document.body.classList.toggle(`theme-${theme}`, cfg.editorPaper === theme);
    }
  }

  // ---------- 章节栏 / 写作区 可拖动分隔条 ----------
  function clampSidebarWidth(width) {
    const maxByWindow = Math.max(180, Math.round(window.innerWidth * 0.6));
    return Math.min(Math.min(800, maxByWindow), Math.max(180, Math.round(Number(width) || 250)));
  }

  function applySidebarWidth(width) {
    state.sidebarWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
    return state.sidebarWidth;
  }

  // 显示设置的生效值 = 全局设置 + 当前书的覆盖
  function effectiveConfig() {
    return { ...(state.globalConfig || state.config || {}), ...(state.bookDisplay || {}) };
  }

  // 章节栏宽度：开着书就记到这本书，否则记全局
  async function persistSidebarWidth(width) {
    try {
      if (state.bookId) {
        const display = await call(api.setBookDisplay, state.bookId, { editorSidebarWidth: width });
        state.bookDisplay = display || {};
        state.config = effectiveConfig();
      } else {
        state.globalConfig = await call(api.setConfig, { editorSidebarWidth: width });
        state.config = effectiveConfig();
      }
    } catch { /* 记不住宽度不影响使用 */ }
  }

  // 打开一本书后套用这本书的显示设置（没有单独设置过就沿用全局）
  async function applyBookDisplay(bookId) {
    let display = {};
    try {
      display = (await call(api.getBookDisplay, bookId)) || {};
    } catch {
      display = {};
    }
    state.bookDisplay = display;
    state.config = effectiveConfig();
    if (state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
      await loadCustomFont(state.config.editorCustomFontPath, { silent: true });
    }
    applyEditorStyle();
    applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
  }

  function setupSidebarResizer() {
    const resizer = $('sidebar-resizer');
    if (!resizer) return;
    let dragStartX = 0;
    let dragStartWidth = 0;

    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      state.sidebarDragging = true;
      dragStartX = event.clientX;
      dragStartWidth = state.sidebarWidth;
      resizer.classList.add('dragging');
      document.body.classList.add('resizing');
      try { resizer.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    });

    window.addEventListener('pointermove', (event) => {
      if (!state.sidebarDragging) return;
      applySidebarWidth(dragStartWidth + (event.clientX - dragStartX));
    });

    window.addEventListener('pointerup', async () => {
      if (!state.sidebarDragging) return;
      state.sidebarDragging = false;
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
      await persistSidebarWidth(state.sidebarWidth);
    });

    // 双击恢复默认宽度（这本书恢复成 250）
    resizer.addEventListener('dblclick', async () => {
      applySidebarWidth(250);
      await persistSidebarWidth(250);
    });
  }

  // ---------- 书架 ----------
  async function refreshShelf() {
    // 上次写作位置每次回书架都重新取：在编辑页切章 / 保存后主进程已经更新了配置
    try {
      state.recentBook = await call(api.getRecentBook);
    } catch {
      state.recentBook = null;
    }
    // 今日字数 / 近 30 天统计（主进程算本地日期，界面不自己算）
    await refreshStats();
    try {
      state.books = await call(api.listBooks);
    } catch (err) {
      state.books = [];
      toast(`读取书架失败：${err.message}`, 'error');
    }
    renderShelf();
  }

  // ---------- 书架搜索（书名 + 章节名） ----------
  // 只搜书名和章名，不读正文：281 本书也能输入即出结果。
  function shelfQueryText() {
    return String(state.shelfQuery || '').trim();
  }

  function matchBookForSearch(book, queryLower) {
    if (!queryLower) return { visible: true, titleMatch: false, chapterHits: [] };
    const title = String(book.title || '').toLowerCase();
    const folder = String(book.folder || '').toLowerCase();
    if (title.includes(queryLower) || folder.includes(queryLower)) {
      return { visible: true, titleMatch: true, chapterHits: [] };
    }
    const names = Array.isArray(book.chapterNames) ? book.chapterNames : [];
    const chapterHits = [];
    for (let i = 0; i < names.length && chapterHits.length < 3; i += 1) {
      const name = String(names[i] || '');
      if (name && name.toLowerCase().includes(queryLower)) chapterHits.push({ index: i, name });
    }
    return { visible: chapterHits.length > 0, titleMatch: false, chapterHits };
  }

  function shelfSearchResults() {
    const queryLower = shelfQueryText().toLowerCase();
    const rows = [];
    for (const book of state.books) {
      const info = matchBookForSearch(book, queryLower);
      if (info.visible) rows.push({ book, info });
    }
    return rows;
  }

  function updateShelfSearchUi(matchedCount) {
    const summary = $('shelf-search-summary');
    const clear = $('btn-shelf-search-clear');
    const query = shelfQueryText();
    if (clear) clear.classList.toggle('hidden', !query);
    if (!summary) return;
    if (!query) {
      summary.classList.add('hidden');
      summary.textContent = '';
      return;
    }
    summary.classList.remove('hidden');
    summary.textContent =
      matchedCount > 0
        ? `搜索「${query}」：${matchedCount} / ${state.books.length} 本（回车打开第一本，Esc 清除）`
        : `搜索「${query}」：没有匹配的书（只搜书名和章节名，不搜正文；Esc 清除）`;
  }

  // ---------- 继续上次写作 ----------
  // 主进程在打开书 / 切章 / 保存时记 config.lastBook；这里只负责把它显示出来。
  // 书架里已经找不到那本书（被删/改名）或是损坏书时，入口直接隐藏，不做任何猜测。
  function continueTarget() {
    const recent = state.recentBook;
    if (!recent || !recent.path) return null;
    const wanted = String(recent.path).toLowerCase();
    const book = (state.books || []).find((item) => String(item.path || '').toLowerCase() === wanted);
    if (!book || book.status === 'corrupt') return null;
    return { book, recent };
  }

  function renderContinueWriting() {
    const wrap = $('shelf-continue');
    if (!wrap) return;
    const target = continueTarget();
    if (!target) {
      wrap.classList.add('hidden');
      return;
    }
    const { book, recent } = target;
    const total = Math.max(0, Number(book.chapterCount) || 0);
    let chapterIndex = Math.max(0, Math.round(Number(recent.chapterIndex) || 0));
    if (total > 0) chapterIndex = Math.min(chapterIndex, total - 1);
    const label = total > 0 ? chapterTitle(chapterIndex, recent.chapterName) : '';
    const title = `继续写《${book.title}》${label ? ` · ${label}` : ''}`;
    $('continue-title').textContent = title;
    $('continue-title').title = title;
    const metaParts = [];
    if (recent.at) metaParts.push(`最后写作 ${formatRelativeTime(recent.at)}`);
    if (total > 0) metaParts.push(`共 ${total} 章`);
    $('continue-meta').textContent = metaParts.join(' · ');
    wrap.classList.remove('hidden');
  }

  async function openContinueBook() {
    const target = continueTarget();
    if (!target) return { ok: false, message: '没有可继续的书' };
    await openBookByPath(target.book.path);
    return { ok: state.view === 'editor', index: state.index };
  }

  // ---------- 同步冲突副本提示 ----------
  // 只提示、不合并、不动文件：冲突副本可能含用户没合并的手稿，自动处理风险太大。
  function openConflictDialog(book) {
    if (!book) return;
    const conflicts = Array.isArray(book.conflicts) ? book.conflicts.slice() : [];
    if (!conflicts.length) return;
    state.conflictBook = book;
    $('conflict-book').textContent = `《${book.title || book.folder}》 · ${book.path || ''}`;
    $('conflict-book').title = book.path || '';
    $('conflict-summary').textContent = `共 ${conflicts.length} 个冲突副本（只提示，不会自动合并或删除）`;
    const list = $('conflict-files');
    list.innerHTML = '';
    for (const name of conflicts) {
      const row = document.createElement('div');
      row.className = 'conflict-file';
      row.textContent = name;
      row.title = name;
      list.appendChild(row);
    }
    $('conflict-backdrop').classList.remove('hidden');
  }

  function closeConflictDialog() {
    state.conflictBook = null;
    $('conflict-backdrop').classList.add('hidden');
  }

  function renderShelf() {
    $('books-root-label').textContent = state.config ? `书架：${state.config.booksRoot}` : '';
    $('books-root-label').title = state.config ? state.config.booksRoot : '';
    const grid = $('book-grid');
    grid.innerHTML = '';
    renderContinueWriting();

    const query = shelfQueryText();
    const rows = shelfSearchResults();
    updateShelfSearchUi(rows.length);

    if (!state.books.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      empty.textContent = '这里还没有书。点右边（或下面）的「新建一本书」开始，或者把已有的书文件夹放进书架目录。';
      grid.appendChild(empty);
    } else if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      empty.textContent = `没有找到匹配「${query}」的书（只搜书名和章节名，不搜正文）。`;
      grid.appendChild(empty);
    }

    for (const { book, info } of rows) {
      const card = document.createElement('div');
      const conflictCount = Array.isArray(book.conflicts) ? book.conflicts.length : 0;
      card.className =
        'book-card' +
        (book.status === 'corrupt' ? ' corrupt' : '') +
        (conflictCount ? ' has-conflict' : '');
      card.dataset.path = book.path;
      card.dataset.folder = book.folder;

      const title = document.createElement('div');
      title.className = 'book-card-title';
      title.textContent = book.status === 'corrupt' ? `⚠ ${book.title}` : book.title;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'book-card-meta';
      const done = Number(book.doneChapters) || 0;
      meta.textContent =
        book.status === 'corrupt'
          ? `书目损坏：${book.reason || '无法读取'}`
          : `${book.chapterCount} 章 · ${formatChars(book.totalChars)}` +
            (done > 0 ? ` · 完稿 ${done}/${book.chapterCount} 章` : '');
      card.appendChild(meta);

      // 同步盘冲突副本：醒目提示，点开看是哪几个文件；绝不自动合并/删除
      if (conflictCount) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'book-conflict-badge';
        badge.textContent = `⚠ 检测到同步冲突副本（${conflictCount} 个）`;
        badge.title = `这些文件不会被自动合并：\n${(book.conflicts || []).join('\n')}`;
        badge.addEventListener('click', (event) => {
          event.stopPropagation();
          openConflictDialog(book);
        });
        card.appendChild(badge);
      }

      // 书名没命中、靠章名命中时，把命中的章名列出来
      if (info.chapterHits && info.chapterHits.length) {
        const hitLine = document.createElement('div');
        hitLine.className = 'book-card-match';
        hitLine.textContent = `章节命中：${info.chapterHits
          .map((hit) => chapterTitle(hit.index, hit.name))
          .join('、')}`;
        card.appendChild(hitLine);
      }

      const time = document.createElement('div');
      time.className = 'book-card-time';
      time.textContent =
        book.status === 'corrupt' ? '点开可以修复' : `最后修改 ${formatRelativeTime(book.lastModified)}`;
      card.appendChild(time);

      if (book.status === 'corrupt') {
        const repairBtn = document.createElement('button');
        repairBtn.type = 'button';
        repairBtn.className = 'btn primary';
        repairBtn.textContent = '修复';
        repairBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          openRepair(book);
        });
        card.appendChild(repairBtn);
      }

      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'book-card-more';
      more.title = '更多操作（打开文件夹 / 删除）';
      more.textContent = '⋯';
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = more.getBoundingClientRect();
        showBookMenu(book, rect.right - 186, rect.bottom + 4);
      });
      card.appendChild(more);

      card.addEventListener('click', (event) => {
        if (event.target.closest('.book-card-more')) return;
        openBookByPath(book.path);
      });
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showBookMenu(book, event.clientX, event.clientY);
      });
      grid.appendChild(card);
    }

    // 搜索时不再显示「新建一本书」，避免挡结果
    if (!query) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'book-card new-book';
      const plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = '＋';
      const addLabel = document.createElement('span');
      addLabel.textContent = '新建一本书';
      add.appendChild(plus);
      add.appendChild(addLabel);
      add.addEventListener('click', onNewBookClick);
      grid.appendChild(add);
    }

    updateWindowTitle();
  }

  async function onNewBookClick() {
    const title = await promptText({
      title: '新建一本书',
      message: '给这本书起个名字；直接点确定就叫「我的新书」。',
      placeholder: '书名'
    });
    if (title === null) return;
    await createBookWithTitle(title);
  }

  async function createBookWithTitle(title) {
    try {
      const data = await call(api.createBook, title);
      toast(`已创建：${data.meta.title}`);
      await refreshShelf();
      await openBookByPath(data.path);
    } catch (err) {
      toast(`新建失败：${err.message}`, 'error');
    }
  }

  // ---------- 打开书 / 修复 ----------
  async function openBookByPath(bookPath) {
    let data;
    try {
      data = await call(api.openBook, bookPath);
    } catch (err) {
      if (err.code === 'PARSE_ERROR' || err.code === 'INVALID_META' || err.code === 'NO_BOOK') {
        const known = (state.books || []).find((b) => b.path === bookPath);
        await openRepair(
          known || { path: bookPath, title: '这本书', status: 'corrupt', reason: err.message }
        );
        return;
      }
      toast(`打开失败：${err.message}`, 'error');
      return;
    }

    if (data.missing && data.missing.length) {
      toast(`注意：${data.missing.length} 个章节文件缺失，可在「导出 → 打开本书文件夹」里检查`, 'warn');
    }

    state.bookPath = bookPath;
    state.meta = data.meta;
    state.bookId = data.meta.id;
    state.chapters = data.meta.chapters;
    state.collapsedVolumes = new Set(); // 换书重置折叠状态
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    $('book-title').textContent = data.meta.title;
    $('book-title').title = data.meta.title;
    showView('editor');
    renderChapterList();
    // 套用这本书自己的显示设置（没有单独设置过就沿用全局）
    await applyBookDisplay(data.meta.id);

    const startIndex = Math.max(
      0,
      state.chapters.findIndex((c) => c.id === data.meta.lastOpenChapterId)
    );
    await loadChapterAt(startIndex);
  }

  async function openRepair(book) {
    const res = await openModal({
      title: `修复「${book.title || '这本书'}」`,
      message:
        `书目无法读取：${book.reason || '未知原因'}\n\n` +
        '可以从上一版备份（书目.json.bak）恢复，或按文件夹里的 txt 文件名重建书目。\n' +
        '两种方式都会保留损坏的文件（改名成 .corrupt-时间戳），不会直接删掉。',
      buttons: [
        { label: '从备份恢复', value: 'bak', kind: 'primary' },
        { label: '从目录重建', value: 'rebuild' },
        { label: '取消', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    if (!res.action || res.action === 'cancel') return;
    try {
      const data = await call(api.repairBook, book.path, res.action);
      if (res.action === 'bak') {
        toast(`已从备份恢复：${data.meta.chapters.length} 章`);
      } else {
        const skipped = Number(data.skippedConflicts) || 0;
        toast(`已重建书目：${data.count} 章${skipped ? `（跳过 ${skipped} 个同步冲突副本）` : ''}`);
      }
      await refreshShelf();
    } catch (err) {
      toast(`修复失败：${err.message}`, 'error');
    }
  }

  // ---------- 章节拖拽排序 ----------
  // 只改 书目.json 的顺序，章节文件永不重命名；拖拽用 pointer 事件（比 HTML5 DnD 好测、也不挑渲染层）。
  let chapterDrag = null;

  function startChapterDrag(event, index) {
    if (event.button !== 0) return;
    if (state.saving || state.loading || !state.bookPath) return;
    if (state.chapters.length < 2) return;
    chapterDrag = {
      index,
      volumeId: chapterVolumeId(state.chapters[index]),
      startY: event.clientY,
      active: false,
      targetIndex: index,
      drop: null,
      item: event.currentTarget
    };
  }

  function clearDragMarks() {
    const list = $('chapter-list');
    if (!list) return;
    list.querySelectorAll('.chapter-item.dragging, .chapter-item.drop-before, .chapter-item.drop-after, .volume-item.drop-into')
      .forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into'));
    document.body.classList.remove('chapter-dragging');
  }

  // 拖拽落点：可以落在章节条目上（插到它前/后），也可以落在卷标题上（放进这一卷）
  function computeDropTarget(event) {
    const list = $('chapter-list');
    const children = Array.from(list.children);
    if (!children.length) return null;
    const y = event.clientY;
    let hovered = null;
    for (const el of children) {
      const rect = el.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        hovered = el;
        break;
      }
    }
    const chapterOf = (el) => (el && el.classList.contains('chapter-item') ? state.chapters[Number(el.dataset.index)] : null);
    if (!hovered) {
      // 指针在列表末尾之后：落到最后一组的末尾
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const el = children[i];
        const chapter = chapterOf(el);
        if (chapter) return { volumeId: chapterVolumeId(chapter), beforeChapterId: null, el, mode: 'after' };
        if (el.classList.contains('volume-item')) {
          return { volumeId: el.dataset.volumeId || null, beforeChapterId: null, el, mode: 'header' };
        }
      }
      return null;
    }
    if (hovered.classList.contains('volume-item')) {
      const volumeId = hovered.dataset.volumeId || null;
      const start = children.indexOf(hovered);
      let before = null;
      for (let i = start + 1; i < children.length; i += 1) {
        const el = children[i];
        if (el.classList.contains('volume-item')) break;
        const chapter = chapterOf(el);
        if (chapter) {
          before = chapter;
          break;
        }
      }
      return { volumeId, beforeChapterId: before ? before.id : null, el: hovered, mode: 'header' };
    }
    const chapter = chapterOf(hovered);
    if (!chapter) return null;
    const volumeId = chapterVolumeId(chapter);
    const rect = hovered.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return { volumeId, beforeChapterId: chapter.id, el: hovered, mode: 'before' };
    }
    const start = children.indexOf(hovered);
    let next = null;
    for (let i = start + 1; i < children.length; i += 1) {
      const el = children[i];
      if (el.classList.contains('volume-item')) break;
      const candidate = chapterOf(el);
      if (candidate) {
        if (chapterVolumeId(candidate) === volumeId) next = candidate;
        break;
      }
    }
    return { volumeId, beforeChapterId: next ? next.id : null, el: hovered, mode: 'after' };
  }

  function nextChapterIdInVolume(chapter) {
    const volumeId = chapterVolumeId(chapter);
    const index = state.chapters.findIndex((c) => c.id === chapter.id);
    for (let i = index + 1; i < state.chapters.length; i += 1) {
      if (chapterVolumeId(state.chapters[i]) !== volumeId) return null;
      return state.chapters[i].id;
    }
    return null;
  }

  function updateChapterDrag(event) {
    if (!chapterDrag) return;
    if (!chapterDrag.active) {
      if (Math.abs(event.clientY - chapterDrag.startY) < 5) return;
      chapterDrag.active = true;
      chapterDrag.item.classList.add('dragging');
      document.body.classList.add('chapter-dragging');
    }
    const list = $('chapter-list');
    list.querySelectorAll('.chapter-item.drop-before, .chapter-item.drop-after, .volume-item.drop-into')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));

    const target = computeDropTarget(event);
    chapterDrag.drop = target;
    if (target && target.el) {
      if (target.mode === 'header') target.el.classList.add('drop-into');
      else if (target.mode === 'before') target.el.classList.add('drop-before');
      else target.el.classList.add('drop-after');
    }

    // 拖动到列表顶部/底部附近时自动滚动
    const listRect = list.getBoundingClientRect();
    if (event.clientY < listRect.top + 28) list.scrollTop -= 12;
    else if (event.clientY > listRect.bottom - 28) list.scrollTop += 12;
  }

  async function endChapterDrag() {
    if (!chapterDrag) return;
    const drag = chapterDrag;
    chapterDrag = null;
    clearDragMarks();
    if (!drag.active) return; // 普通点击，交给 click 处理
    state.suppressChapterClick = Date.now() + 300;
    const chapter = state.chapters[drag.index];
    const target = drag.drop;
    if (!chapter || !target) return;
    // 原地不动就不写盘：落在自己身上、或落回自己原来的位置
    if (target.beforeChapterId === chapter.id) return;
    if (target.volumeId === chapterVolumeId(chapter) && target.beforeChapterId === nextChapterIdInVolume(chapter)) return;
    await moveChapterByDrop(chapter, target);
  }

  async function moveChapterByDrop(chapter, target) {
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(
        api.moveChapterTo,
        state.bookPath,
        chapter.id,
        target.volumeId || null,
        target.beforeChapterId || null
      );
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      if (currentId) {
        const at = state.chapters.findIndex((c) => c.id === currentId);
        if (at >= 0) state.index = at;
      }
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移动章节（${target.volumeId ? volumeDisplayName(target.volumeId) : '未分卷'}）`);
      if (currentId) {
        try {
          await api.setLastOpenChapter(state.bookPath, currentId);
        } catch {
          /* 记不住也无所谓 */
        }
      }
      return { ok: true };
    } catch (err) {
      toast(`移动章节失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function moveChapterByDrag(fromIndex, toIndex) {
    const chapter = state.chapters[fromIndex];
    if (!chapter || fromIndex === toIndex) return;
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(api.moveChapter, state.bookPath, chapter.id, toIndex);
      state.chapters = data.meta.chapters;
      state.meta = { ...state.meta, chapters: data.meta.chapters, updatedAt: data.meta.updatedAt };
      const newCurrent = currentId ? state.chapters.findIndex((c) => c.id === currentId) : -1;
      if (newCurrent >= 0) state.index = newCurrent;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移动章节：第${data.from + 1}章 → 第${data.to + 1}章（章节文件没有改名）`);
      if (currentId) {
        try { await api.setLastOpenChapter(state.bookPath, currentId); } catch { /* 记不住也无所谓 */ }
      }
    } catch (err) {
      toast(`移动章节失败：${err.message}`, 'error');
    }
  }

  function setupChapterDrag() {
    window.addEventListener('pointermove', (event) => {
      if (chapterDrag) updateChapterDrag(event);
    });
    window.addEventListener('pointerup', () => {
      if (chapterDrag) endChapterDrag();
    });
    window.addEventListener('pointercancel', () => clearDragMarks());
  }

  // ---------- 章节列表 ----------
  function volumeList() {
    return state.meta && Array.isArray(state.meta.volumes) ? state.meta.volumes : [];
  }

  function volumeById(volumeId) {
    return volumeList().find((v) => v.id === volumeId) || null;
  }

  function volumeDisplayName(volumeId) {
    if (!volumeId) return '未分卷';
    const volume = volumeById(volumeId);
    return (volume && String(volume.name || '').trim()) || '未命名卷';
  }

  function chapterVolumeId(chapter) {
    return (chapter && chapter.volumeId) || null;
  }

  function toggleVolumeCollapse(volumeId) {
    const key = volumeId || '';
    if (state.collapsedVolumes.has(key)) state.collapsedVolumes.delete(key);
    else state.collapsedVolumes.add(key);
    renderChapterList();
  }

  function makeVolumeHeader(volumeId, name, count) {
    const key = volumeId || '';
    const collapsed = state.collapsedVolumes.has(key);
    const row = document.createElement('div');
    row.className = 'volume-item' + (collapsed ? ' collapsed' : '') + (volumeId ? '' : ' orphan-volume');
    row.dataset.volumeId = key;
    const arrow = document.createElement('span');
    arrow.className = 'volume-arrow';
    arrow.textContent = collapsed ? '▸' : '▾';
    const label = document.createElement('span');
    label.className = 'volume-name';
    label.textContent = name;
    const num = document.createElement('span');
    num.className = 'volume-count';
    num.textContent = `${count} 章`;
    row.appendChild(arrow);
    row.appendChild(label);
    row.appendChild(num);
    row.title = '单击折叠 / 展开；右键更多（重命名卷 / 在此卷新建章节 / 删除卷）';
    row.addEventListener('click', () => toggleVolumeCollapse(volumeId));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showVolumeMenu(event, volumeId);
    });
    return row;
  }

  function makeChapterItem(chapter, index) {
    const status = chapterStatus(chapter);
    const note = chapterNote(chapter);
    const item = document.createElement('div');
    item.className = `chapter-item status-${status}` + (index === state.index ? ' active' : '');
    if (index === state.index && state.dirty) item.classList.add('dirty');
    item.dataset.index = String(index);
    item.dataset.status = status;
    const tip = [`状态：${CHAPTER_STATUS_LABELS[status]}`, note ? `备注：${note}` : ''].filter(Boolean).join('\n');
    item.title = `单击切换；双击重命名；右键更多\n${tip}`;

    const dot = document.createElement('span');
    dot.className = 'chapter-status-dot';
    dot.title = `状态：${CHAPTER_STATUS_LABELS[status]}（右键可改）`;

    const num = document.createElement('span');
    num.className = 'chapter-num';
    num.textContent = `第${index + 1}章`;

    const name = document.createElement('span');
    name.className = 'chapter-name';
    name.textContent = String(chapter.name || '').trim() || '未命名';

    item.appendChild(dot);
    item.appendChild(num);
    item.appendChild(name);
    if (note) {
      const noteMark = document.createElement('span');
      noteMark.className = 'chapter-note-mark';
      noteMark.textContent = '✎';
      noteMark.title = `备注：${note}`;
      item.appendChild(noteMark);
    }
    item.addEventListener('click', () => {
      if (state.suppressChapterClick && Date.now() < state.suppressChapterClick) {
        state.suppressChapterClick = 0;
        return; // 刚拖拽完，别把这次点击当成切章
      }
      switchChapter(index);
    });
    item.addEventListener('pointerdown', (event) => startChapterDrag(event, index));
    item.addEventListener('dblclick', () => renameChapterAt(index));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(event, index);
    });
    return item;
  }

  function renderChapterList() {
    const list = $('chapter-list');
    list.innerHTML = '';
    const volumes = volumeList();
    if (!volumes.length) {
      // 没分卷的书：和以前完全一样，平铺章节
      state.chapters.forEach((chapter, index) => list.appendChild(makeChapterItem(chapter, index)));
    } else {
      const buckets = new Map(volumes.map((v) => [v.id, []]));
      const orphans = [];
      state.chapters.forEach((chapter, index) => {
        const volumeId = chapterVolumeId(chapter);
        if (volumeId && buckets.has(volumeId)) buckets.get(volumeId).push({ chapter, index });
        else orphans.push({ chapter, index });
      });
      if (orphans.length) {
        list.appendChild(makeVolumeHeader(null, '未分卷', orphans.length));
        if (!state.collapsedVolumes.has('')) {
          orphans.forEach(({ chapter, index }) => list.appendChild(makeChapterItem(chapter, index)));
        }
      }
      for (const volume of volumes) {
        const items = buckets.get(volume.id) || [];
        list.appendChild(makeVolumeHeader(volume.id, volumeDisplayName(volume.id), items.length));
        if (!state.collapsedVolumes.has(volume.id)) {
          items.forEach(({ chapter, index }) => list.appendChild(makeChapterItem(chapter, index)));
        }
      }
    }
    const active = list.querySelector('.chapter-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function renderEditorHeader() {
    if (!state.chapters.length || state.index < 0) {
      $('chapter-title').textContent = '';
      return;
    }
    $('chapter-title').textContent = chapterTitle(state.index, state.chapters[state.index].name);
  }

  // ---------- 状态栏 ----------
  // 本章字数：正常章节即时算；MB 级的超大单章（「整本一章」导入）每个字都全文正则统计会卡，
  // 超过 20 万字符改成 400ms 防抖，多打几个字只算最后一次。
  let charCountTimer = null;
  const CHAR_COUNT_DEFER_ABOVE = 200000;
  function renderCharCount() {
    const el = $('char-count');
    if (!state.bookPath || state.index < 0) {
      clearTimeout(charCountTimer);
      el.textContent = '';
      return;
    }
    const text = editorEl.value;
    if (text.length <= CHAR_COUNT_DEFER_ABOVE) {
      clearTimeout(charCountTimer);
      el.textContent = `本章 ${formatChars(countChars(text))}`;
      return;
    }
    clearTimeout(charCountTimer);
    charCountTimer = setTimeout(() => {
      if (!state.bookPath || state.index < 0) return;
      el.textContent = `本章 ${formatChars(countChars(editorEl.value))}`;
    }, 400);
  }

  // ---------- 每日字数统计（提案 3.2） ----------
  // 只统计「保存动作」带来的新增字数：没保存的编辑不计数，删字也不会倒扣今天。
  // 日期 / 增量都在主进程算，渲染层只负责显示；统计文件在 userData，不碰书库。
  async function refreshStats() {
    try {
      state.stats = await call(api.getStats);
    } catch {
      /* 统计读不到不影响写作，保留上一次显示 */
    }
    renderStatsUi();
    return state.stats;
  }

  function statsTodayText(stats) {
    const today = Math.max(0, Math.round(Number(stats && stats.todayChars) || 0));
    return today > 0 ? `今天 +${formatChars(today)}` : '今天还没写字';
  }

  function renderStatsUi() {
    const stats = state.stats;
    const shelf = $('shelf-stats');
    const status = $('status-stats');
    const today = Math.max(0, Math.round(Number(stats && stats.todayChars) || 0));
    const goal = Math.max(0, Math.round(Number(stats && stats.goal) || 0));
    const percent = Math.max(0, Math.min(100, Math.floor(Number(stats && stats.goalPercent) || 0)));
    const met = Boolean(stats && stats.goalMet);
    const title =
      `只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。` +
      (goal > 0 ? `今日目标 ${goal} 字。` : '可在「设置 → 写作统计」里设每日目标。');

    if (shelf) {
      shelf.classList.toggle('hidden', !stats);
      if (stats) {
        $('shelf-stats-today').textContent = statsTodayText(stats);
        $('shelf-stats-goal').textContent = goal > 0 ? `目标 ${formatChars(goal)} · ${percent}%${met ? ' · 已达标' : ''}` : '';
        $('shelf-stats-goal').hidden = goal <= 0;
        $('shelf-goal-track').classList.toggle('hidden', goal <= 0);
        $('shelf-goal-fill').style.width = goal > 0 ? `${percent}%` : '0%';
        shelf.title = title;
      }
    }
    if (status) {
      status.classList.toggle('hidden', !stats);
      if (stats) {
        $('status-stats-text').textContent =
          goal > 0 ? `今日 ${formatChars(today)} / ${formatChars(goal)}` : `今日 ${formatChars(today)}`;
        $('status-goal-track').classList.toggle('hidden', goal <= 0);
        $('status-goal-fill').style.width = goal > 0 ? `${percent}%` : '0%';
        $('status-stats-text').title = title;
        status.title = title;
      }
    }
    renderStatsChart();
  }

  // 设置里的近 30 天柱状图：纯 CSS 高度，不引第三方库。今天那根高亮。
  function renderStatsChart() {
    const chart = $('settings-stats-chart');
    if (!chart) return;
    const stats = state.stats;
    const days = stats && Array.isArray(stats.days) ? stats.days : [];
    const goal = Math.max(0, Math.round(Number(stats && stats.goal) || 0));
    const values = days.map((item) => Math.max(0, Math.round(Number(item && item.chars) || 0)));
    const max = Math.max(goal, ...values, 1);
    chart.innerHTML = '';
    days.forEach((item, index) => {
      const value = values[index];
      const bar = document.createElement('div');
      bar.className = 'stats-bar' + (index === days.length - 1 ? ' today' : '');
      const fill = document.createElement('i');
      const height = value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
      fill.style.height = `${Math.min(100, height)}%`;
      bar.appendChild(fill);
      bar.title = `${item.day} · ${formatChars(value)}`;
      chart.appendChild(bar);
    });
    const summaryEl = $('settings-stats-summary');
    if (summaryEl) {
      summaryEl.textContent = stats
        ? `今天 ${formatChars(stats.todayChars)} · 近 30 天 ${formatChars(stats.recentTotal)}` +
          (goal > 0 ? ` · 目标 ${formatChars(goal)}（${Math.min(100, Math.floor(Number(stats.goalPercent) || 0))}%）` : ' · 未设目标')
        : '还没有统计数据（保存一次后开始记录）';
    }
    const goalState = $('settings-goal-state');
    if (goalState) {
      const percent = Math.max(0, Math.min(100, Math.floor(Number(stats && stats.goalPercent) || 0)));
      goalState.textContent = goal > 0 ? `今天完成 ${percent}%${stats && stats.goalMet ? ' · 已达标' : ''}` : '未设目标';
    }
  }

  function updateStatus() {
    const dot = $('status-dot');
    dot.className = 'dot';
    let text = '已保存';

    if (state.saveError) {
      dot.classList.add('error');
      text = `保存失败：${state.saveError}`;
    } else if (state.saving) {
      dot.classList.add('saving');
      text = '正在保存…';
    } else if (state.dirty) {
      dot.classList.add('dirty');
      text = `未保存${state.lastEditAt ? ` · ${formatClock(new Date(state.lastEditAt))} 最后编辑` : ''}`;
    } else {
      dot.classList.add('ok');
      text = state.savedAt ? `已保存 ${formatClock(state.savedAt)}` : '已保存';
    }

    $('status-text').textContent = text;
    renderCharCount();
    $('btn-save').disabled = !state.dirty || state.saving;
    // 把未保存状态同步给主进程，供 Windows 关机拦截使用
    if (state.dirty !== state.reportedDirty) {
      state.reportedDirty = state.dirty;
      try {
        api.reportDirty(state.dirty);
      } catch { /* 忽略 */ }
    }
    updateWindowTitle();
  }

  // ---------- 编辑区事件 ----------
  function onEditorInput() {
    state.lastEditAt = Date.now();
    const dirty = editorEl.value !== state.baseText;
    if (dirty !== state.dirty) state.dirty = dirty;
    if (state.dirty) state.saveError = null;
    const activeItem = $('chapter-list').querySelector('.chapter-item.active');
    if (activeItem) activeItem.classList.toggle('dirty', state.dirty);
    updateStatus();
  }

  async function loadChapterAt(index) {
    if (!state.bookPath || !state.chapters.length) return;
    const safeIndex = Math.max(0, Math.min(index, state.chapters.length - 1));
    const chapter = state.chapters[safeIndex];
    state.loading = true;
    try {
      const data = await call(api.loadChapter, state.bookPath, chapter.file);
      state.index = safeIndex;
      state.loadedMtimeMs = data.mtimeMs;
      state.baseText = data.text;
      state.dirty = false;
      state.saveError = null;
      editorEl.value = data.text;
      editorEl.scrollTop = 0;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      // 等主进程写完「上次打开章节」再返回，避免后续操作和它并发覆盖书目
      try {
        await api.setLastOpenChapter(state.bookPath, chapter.id);
      } catch { /* 记不住也无所谓 */ }
    } catch (err) {
      toast(`读取章节失败：${err.message}`, 'error');
    } finally {
      state.loading = false;
    }
  }

  async function saveCurrent({ silent = false } = {}) {
    if (!state.bookPath || state.index < 0) {
      return { ok: false, code: 'NO_CHAPTER', message: '当前没有可保存的章节' };
    }
    if (state.saving) {
      return { ok: false, code: 'BUSY', message: '正在保存中，请稍候再试' };
    }
    if (!state.dirty) {
      if (!silent) toast('当前章节没有改动');
      updateStatus();
      return { ok: true, skipped: true };
    }
    const chapter = state.chapters[state.index];
    if (!chapter) return { ok: false, message: '章节不存在' };
    state.saving = true;
    updateStatus();
    try {
      const data = await call(api.saveChapter, state.bookPath, chapter.id, editorEl.value);
      state.baseText = editorEl.value;
      state.loadedMtimeMs = data.mtimeMs;
      state.savedAt = new Date();
      state.saveError = null;
      state.dirty = false;
      // 主进程已经把「这次保存带来的新增字数」记进 stats.json，返回的摘要直接显示，
      // 不再多跑一次 IPC（统计失败时 data.stats 为 null，界面保留旧数字）。
      if (data.stats) {
        state.stats = data.stats;
        renderStatsUi();
      }
      updateStatus();
      // 「保存整本」语义：保存后顺带校验全书章节文件是否齐全
      try {
        const report = await call(api.verifyBook, state.bookPath);
        if (report.missing && report.missing.length) {
          toast(`已保存当前章，但全书有 ${report.missing.length} 个章节文件缺失`, 'warn');
        }
        if (!silent) {
          const snapshotNote = data.snapshot && data.snapshot.taken ? ' · 今日快照已留' : '';
          toast(`已保存：${report.chapterCount} 章 · 本章 ${formatChars(data.chars)}${snapshotNote}`);
        }
      } catch {
        if (!silent) toast('已保存当前章（全书校验失败）', 'warn');
      }
      return { ok: true, data };
    } catch (err) {
      state.saveError = err.message;
      updateStatus();
      if (!silent) toast(`保存失败：${err.message}`, 'error');
      return { ok: false, code: err.code, message: err.message };
    } finally {
      state.saving = false;
      updateStatus();
    }
  }

  // ---------- 切换 / 新建 / 重命名 / 删除 ----------
  function currentChapterLabel() {
    if (state.index < 0 || !state.chapters[state.index]) return '当前章节';
    return chapterTitle(state.index, state.chapters[state.index].name);
  }

  async function switchChapter(index, options = {}) {
    if (index === state.index) return { ok: true, same: true };
    if (index < 0 || index >= state.chapters.length) return { ok: false, message: '章节不存在' };
    if (state.dirty) {
      let action = options.dirtyAction;
      if (!action) {
        action = await askUnsaved({
          title: '切换章节前保存',
          message: `「${currentChapterLabel()}」有未保存的修改，切换会丢失这些内容。`
        });
      }
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      }
    }
    await loadChapterAt(index);
    return { ok: true };
  }

  // ---------- Ctrl+G 跳章 ----------
  // 匹配规则在主进程的 core/jump.js（单测覆盖）：输入纯章号按章号找，否则按章名关键词找。
  // 这里只负责对话框、结果列表和「跳过去」；切章仍走 switchChapter，未保存拦截照常生效。
  const JUMP_RESULT_LIMIT = 8;

  function jumpChapterPayload() {
    return (state.chapters || []).map((chapter) => ({
      id: chapter.id,
      name: chapter.name == null ? '' : String(chapter.name)
    }));
  }

  function renderJumpMatches(result) {
    const matches = (result && Array.isArray(result.matches)) ? result.matches : [];
    const summary = $('jump-summary');
    const list = $('jump-results');
    const query = String(state.jumpQuery || '').trim();
    const total = state.chapters.length;
    list.innerHTML = '';
    let text;
    let warn = false;
    if (!query) {
      text = `共 ${total} 章。输入章号（如 12、第12章）或章名的一部分；回车跳转。`;
    } else if (!matches.length) {
      warn = true;
      text = state.jumpOutOfRange
        ? `本书共 ${total} 章，没有第 ${Number(result && result.number) || '?'} 章（可输入 1–${total}）。`
        : `没有匹配「${query}」的章节。`;
    } else if (result && result.number != null) {
      text = `按章号跳转：${chapterTitle(matches[0].index, matches[0].name)}`;
    } else {
      const hitCount = Number(result && result.total) || matches.length;
      text = `找到 ${hitCount} 章匹配${hitCount > matches.length ? `（列出前 ${matches.length} 章）` : ''}；回车跳第一条，也可以点下面任意一条。`;
    }
    summary.textContent = text;
    summary.classList.toggle('warn', warn);

    for (const match of matches) {
      const chapter = state.chapters[match.index];
      if (!chapter) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'jump-result';
      row.dataset.index = String(match.index);
      const label = document.createElement('span');
      label.className = 'jump-chapter';
      label.textContent = chapterTitle(match.index, match.name);
      const status = document.createElement('span');
      status.className = 'jump-status';
      status.textContent = CHAPTER_STATUS_LABELS[chapterStatus(chapter)] || '';
      row.appendChild(label);
      row.appendChild(status);
      row.addEventListener('click', () => jumpToIndex(match.index));
      list.appendChild(row);
    }
    $('btn-jump-confirm').disabled = !matches.length;
  }

  async function refreshJumpMatches() {
    if (!state.bookPath || !state.chapters.length) return;
    const input = $('jump-input');
    const query = input ? input.value : '';
    state.jumpQuery = query;
    const token = (state.jumpToken += 1);
    if (!String(query).trim()) {
      state.jumpMatches = [];
      state.jumpOutOfRange = false;
      renderJumpMatches({ matches: [], total: 0 });
      return;
    }
    try {
      const result = await call(api.jumpMatch, jumpChapterPayload(), query, { limit: JUMP_RESULT_LIMIT });
      if (token !== state.jumpToken) return; // 输入已经又变了，旧结果丢掉
      state.jumpMatches = (result && Array.isArray(result.matches)) ? result.matches : [];
      state.jumpOutOfRange = Boolean(result && result.outOfRange);
      renderJumpMatches(result || {});
    } catch (err) {
      if (token !== state.jumpToken) return;
      state.jumpMatches = [];
      state.jumpOutOfRange = false;
      $('jump-summary').textContent = `查找章节失败：${err.message}`;
      $('jump-summary').classList.add('warn');
      $('jump-results').innerHTML = '';
      $('btn-jump-confirm').disabled = true;
    }
  }

  function scheduleJumpMatches(delay = 80) {
    clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(() => {
      state.jumpTimer = null;
      refreshJumpMatches();
    }, delay);
  }

  function openJumpDialog() {
    if (!state.bookPath || !state.chapters.length) return false;
    state.jumpToken += 1;
    clearTimeout(state.jumpTimer);
    state.jumpTimer = null;
    state.jumpMatches = [];
    state.jumpQuery = '';
    state.jumpOutOfRange = false;
    $('jump-input').value = '';
    $('jump-results').innerHTML = '';
    $('jump-summary').classList.remove('warn');
    renderJumpMatches({ matches: [], total: 0 });
    $('jump-backdrop').classList.remove('hidden');
    setTimeout(() => {
      const input = $('jump-input');
      if (!input || $('jump-backdrop').classList.contains('hidden')) return;
      input.focus();
      input.select();
    }, 20);
    return true;
  }

  function closeJumpDialog() {
    clearTimeout(state.jumpTimer);
    state.jumpTimer = null;
    state.jumpToken += 1;
    state.jumpMatches = [];
    state.jumpQuery = '';
    state.jumpOutOfRange = false;
    $('jump-backdrop').classList.add('hidden');
    $('jump-input').value = '';
    $('jump-results').innerHTML = '';
    $('jump-summary').textContent = '';
  }

  async function jumpToIndex(index) {
    if (!state.bookPath || index < 0 || index >= state.chapters.length) {
      return { ok: false, message: '章节不存在' };
    }
    // 先把对话框收起来，再走正常的切章流程（有未保存修改时由 switchChapter 弹窗拦截）
    closeJumpDialog();
    const res = await switchChapter(index);
    return res;
  }

  async function confirmJumpFromDialog() {
    if (!state.jumpMatches.length) {
      $('jump-summary').classList.add('warn');
      return { ok: false, message: '没有匹配的章节' };
    }
    return jumpToIndex(state.jumpMatches[0].index);
  }

  async function createChapterAt(insertIndex, nameOverride, volumeIdOverride) {
    if (!state.bookPath) return { ok: false };
    // 作者要求（2026-10-31）：新建 / 插入章节前，当前章有未保存修改就自动保存，不再弹窗
    if (state.dirty) {
      const saved = await saveCurrent();
      if (!saved.ok) return saved; // 保存失败会弹错误提示并停在这里，不建新章
    }
    const appending = insertIndex >= state.chapters.length;
    // 新章默认落在「当前章所在的卷」；从卷菜单进来时用指定的卷
    const currentChapter = state.chapters[state.index];
    const volumeId =
      volumeIdOverride !== undefined ? volumeIdOverride : chapterVolumeId(currentChapter);
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: appending ? '新建章节' : '插入章节',
        message:
          '输入章节名，可留空（显示为「未命名」）。章号由顺序自动生成，不用自己写。' +
          (volumeId ? `\n新章会放进「${volumeDisplayName(volumeId)}」。` : ''),
        placeholder: '例如：夜雨'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createChapter, state.bookPath, insertIndex, name, volumeId || null);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      await loadChapterAt(data.index);
      const where = volumeId ? `（${volumeDisplayName(volumeId)}）` : '';
      toast(`${appending ? '已新建' : '已插入'}：${chapterTitle(data.index, data.chapter.name)}${where}`);
      return { ok: true, index: data.index };
    } catch (err) {
      toast(`新建章节失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // ---------- 分卷操作 ----------
  async function createVolumeFlow(nameOverride) {
    if (!state.bookPath) return { ok: false };
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '新建卷',
        message: '输入卷名（原文自带「第N卷」的书照抄原文即可）。卷只影响侧栏分组和导出，不改章号。',
        placeholder: '例如：第1卷：单篇'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createVolume, state.bookPath, name);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      const index = state.chapters.findIndex((c) => c.id === (state.chapters[state.index] || {}).id);
      if (index >= 0) state.index = index;
      renderChapterList();
      updateStatus();
      toast(`已新建卷：${volumeDisplayName(data.volume.id)}`);
      return { ok: true, volume: data.volume };
    } catch (err) {
      toast(`新建卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function renameVolumeFlow(volumeId, nameOverride) {
    if (!state.bookPath || !volumeId) return { ok: false };
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '重命名卷',
        message: '只改卷名，不影响里面的章节。',
        value: volumeDisplayName(volumeId),
        placeholder: '卷名'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.renameVolume, state.bookPath, volumeId, name);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      renderChapterList();
      toast('已重命名卷');
      return { ok: true };
    } catch (err) {
      toast(`重命名卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 卷上下移动（只改卷序，章节跟着卷走）
  async function moveVolumeFlow(volumeId, delta) {
    if (!state.bookPath || !volumeId) return { ok: false };
    const volumes = volumeList();
    const from = volumes.findIndex((v) => v.id === volumeId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= volumes.length) return { ok: false };
    try {
      const data = await call(api.moveVolume, state.bookPath, volumeId, to);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      const currentId = (state.chapters[state.index] || {}).id;
      const at = currentId ? state.chapters.findIndex((c) => c.id === currentId) : -1;
      if (at >= 0) state.index = at;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已${delta < 0 ? '上移' : '下移'}卷：${volumeDisplayName(volumeId)}`);
      return { ok: true };
    } catch (err) {
      toast(`移动卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function deleteVolumeFlow(volumeId, skipConfirm = false) {
    if (!state.bookPath || !volumeId) return { ok: false };
    const count = state.chapters.filter((c) => chapterVolumeId(c) === volumeId).length;
    if (!skipConfirm) {
      const res = await openModal({
        title: '删除卷',
        message: `确定删除「${volumeDisplayName(volumeId)}」吗？\n卷里的 ${count} 章不会删，会回到「未分卷」，章节文件一个都不动。`,
        buttons: [
          { label: '删除卷', value: 'delete', kind: 'danger' },
          { label: '取消', value: 'cancel', kind: 'primary' }
        ]
      });
      if (res.action !== 'delete') return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.deleteVolume, state.bookPath, volumeId);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      const currentId = (state.chapters[state.index] || {}).id;
      const index = currentId ? state.chapters.findIndex((c) => c.id === currentId) : 0;
      state.index = index >= 0 ? index : 0;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已删除卷，${count} 章回到「未分卷」（章节文件未动）`);
      return { ok: true };
    } catch (err) {
      toast(`删除卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function moveChapterToVolumeFlow(index) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false };
    const volumes = volumeList();
    if (!volumes.length) {
      toast('这本书还没有卷，先新建一个卷', 'warn');
      return { ok: false };
    }
    const buttons = volumes.map((volume) => ({
      label: `移到「${volumeDisplayName(volume.id)}」`,
      value: volume.id
    }));
    buttons.push({ label: '移回「未分卷」', value: '__none__' });
    buttons.push({ label: '取消', value: 'cancel' });
    const res = await openModal({
      title: '移到卷',
      message: `把「${chapterTitle(index, chapter.name)}」移到：`,
      buttons,
      cancelValue: 'cancel'
    });
    if (!res.action || res.action === 'cancel') return { ok: false, canceled: true };
    return moveChapterToVolume(index, res.action === '__none__' ? null : res.action);
  }

  async function moveChapterToVolume(index, volumeId) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false };
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(api.moveChapterToVolume, state.bookPath, chapter.id, volumeId || null);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      if (currentId) {
        const at = state.chapters.findIndex((c) => c.id === currentId);
        if (at >= 0) state.index = at;
      }
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移到「${volumeDisplayName(volumeId)}」`);
      return { ok: true, index: data.index };
    } catch (err) {
      toast(`移动失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function renameChapterAt(index, nameOverride) {
    const chapter = state.chapters[index];
    if (!chapter) return;
    if (state.dirty && index === state.index) {
      toast('当前章节还有未保存的修改，先保存再改名（或切换前选择保存）', 'warn');
      return;
    }
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '重命名章节',
        message: '只改显示名，文件名不变（这样插入/删除永远不会因为改名失败而丢稿）。',
        value: chapter.name || '',
        placeholder: '章节名'
      });
      if (name === null) return;
    }
    try {
      const data = await call(api.renameChapter, state.bookPath, chapter.id, name);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      renderChapterList();
      if (index === state.index) renderEditorHeader();
      updateStatus();
      toast('已重命名（文件名未改）');
    } catch (err) {
      toast(`重命名失败：${err.message}`, 'error');
    }
  }

  async function deleteChapterAt(index, skipConfirm = false) {
    const chapter = state.chapters[index];
    if (!chapter) return;
    if (!skipConfirm) {
      const res = await openModal({
        title: '删除章节',
        message: `确定删除「${chapterTitle(index, chapter.name)}」吗？\n文件会被移到本书的 _trash 文件夹，不会真正删除。`,
        buttons: [
          { label: '删除', value: 'delete', kind: 'danger' },
          { label: '取消', value: 'cancel', kind: 'primary' }
        ],
        cancelValue: 'cancel'
      });
      if (res.action !== 'delete') return;
    }
    const wasCurrent = index === state.index;
    const currentId = wasCurrent ? null : (state.chapters[state.index] || {}).id;
    try {
      const data = await call(api.deleteChapter, state.bookPath, chapter.id);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      if (data.newChapter) toast('最后一章被删除，已自动补一个空章');
      else toast('已移入 _trash');
      if (wasCurrent) {
        state.dirty = false;
        await loadChapterAt(data.index);
      } else {
        const newIndex = state.chapters.findIndex((c) => c.id === currentId);
        state.index = newIndex >= 0 ? newIndex : Math.min(index, state.chapters.length - 1);
        renderChapterList();
        renderEditorHeader();
        updateStatus();
      }
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
    }
  }

  // 章节状态 / 备注：只写 书目.json 的可选字段，正文一个字都不动。
  async function updateChapterInfo(index, patch) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false, message: '没有打开的章节' };
    try {
      const data = await call(api.updateChapterMeta, state.bookPath, chapter.id, patch);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      renderChapterList();
      renderEditorHeader();
      return { ok: true, changed: Boolean(data.changed), chapter: data.chapter };
    } catch (err) {
      toast(`保存章节信息失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    }
  }

  async function setChapterStatusAt(index, status) {
    const label = CHAPTER_STATUS_LABELS[status];
    if (!label || !state.chapters[index]) return { ok: false };
    const res = await updateChapterInfo(index, { status });
    if (!res.ok) return res;
    if (res.changed) toast(`已标记为${label}（只改书目，正文没动）`);
    return { ok: true, status: chapterStatus(state.chapters[index]), changed: res.changed };
  }

  async function editChapterNoteAt(index) {
    const chapter = state.chapters[index];
    if (!chapter) return null;
    const value = await promptText({
      title: `章节备注：${chapterTitle(index, chapter.name)}`,
      message: '给自己记一句话（最多 200 字，只存进书目.json，不碰正文）。清空后确定 = 删除备注。',
      value: chapter.note || '',
      placeholder: '比如：这章结尾要重写'
    });
    if (value === null) return null;
    const res = await updateChapterInfo(index, { note: value });
    if (!res.ok) return null;
    const freshNote = chapterNote(state.chapters[index]);
    toast(freshNote ? '备注已保存' : '备注已清除');
    return freshNote;
  }

  // ---------- 导出 / 复制 ----------
  // 导出 / 复制以磁盘内容为准，但当前章如果还没保存，就把编辑区里的最新内容一起带上
  // （只参与这一次拼接，绝不写盘），这样「导出 = 你眼睛看到的」，保存仍然完全手动。
  function currentChapterOverride() {
    if (!state.dirty) return null;
    const chapter = state.chapters[state.index];
    if (!chapter) return null;
    return { chapterId: chapter.id, text: editorEl.value };
  }

  function outputSummary(data) {
    const parts = [];
    // 范围导出时先说是哪一段（全书不用重复说）
    if (data.rangeLabel && data.rangeLabel !== '全书') parts.push(data.rangeLabel);
    parts.push(`${data.chapterCount} 章`, `${Number(data.chars) || 0} 字`);
    if (data.includedUnsaved) parts.push('含当前章未保存内容');
    return `（${parts.join(' · ')}）`;
  }

  // ---------- 导出范围对话框 ----------
  // 默认「全书」和以前完全一样；也可以只导某一卷 / 第 X–Y 章。
  // 章数、字数、默认文件名都由主进程算（book:export-plan 只读），避免界面和导出两套规则。
  const EXPORT_UNVOLUMED = '__none__';
  let exportPlanTimer = null;
  let exportPlanToken = 0;
  let lastExportPlan = null;

  function readExportRange() {
    const checked = document.querySelector('input[name="export-scope"]:checked');
    const mode = checked ? checked.value : 'all';
    if (mode === 'volume') {
      const value = $('export-volume').value;
      return { mode: 'volume', volumeId: value === EXPORT_UNVOLUMED ? null : value };
    }
    if (mode === 'range') {
      return {
        mode: 'range',
        from: Number.parseInt($('export-from').value, 10),
        to: Number.parseInt($('export-to').value, 10)
      };
    }
    return { mode: 'all' };
  }

  // 返回空字符串 = 合法；否则是给作者看的中文提示
  function validateExportRange(range) {
    if (range.mode !== 'range') return '';
    const total = state.chapters.length;
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) return '请输入起始章和结束章';
    if (range.from < 1 || range.to < 1 || range.from > total || range.to > total) {
      return `章节范围要在第 1–${total} 章之间`;
    }
    if (range.from > range.to) return '起始章不能大于结束章';
    return '';
  }

  function fillExportVolumeOptions() {
    const row = $('export-volume-row');
    const select = $('export-volume');
    const volumes = volumeList();
    row.classList.toggle('hidden', volumes.length === 0);
    select.innerHTML = '';
    const addOption = (value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    const unvolumed = state.chapters.filter((chapter) => !chapterVolumeId(chapter)).length;
    if (unvolumed > 0) addOption(EXPORT_UNVOLUMED, `未分卷（${unvolumed} 章）`);
    volumes.forEach((volume) => {
      const count = state.chapters.filter((chapter) => chapterVolumeId(chapter) === volume.id).length;
      addOption(volume.id, `${String(volume.name || '未命名卷')}（${count} 章）`);
    });
    if (!select.options.length) addOption(EXPORT_UNVOLUMED, '未分卷（0 章）');
  }

  // 单选了哪种范围，就把另外两个范围的输入框灰掉，避免误以为能同时选
  function syncExportScopeInputs() {
    const range = readExportRange();
    $('export-volume').disabled = range.mode !== 'volume';
    $('export-from').disabled = range.mode !== 'range';
    $('export-to').disabled = range.mode !== 'range';
  }

  async function refreshExportSummary() {
    syncExportScopeInputs();
    const summaryEl = $('export-summary');
    const confirmBtn = $('btn-export-confirm');
    const range = readExportRange();
    const error = validateExportRange(range);
    if (error) {
      lastExportPlan = null;
      summaryEl.textContent = error;
      summaryEl.classList.add('warn');
      confirmBtn.disabled = true;
      return;
    }
    const token = ++exportPlanToken;
    let res;
    try {
      res = await call(api.exportPlan, state.bookPath, currentChapterOverride(), range);
    } catch (err) {
      if (token !== exportPlanToken) return;
      lastExportPlan = null;
      summaryEl.textContent = `无法读取导出信息：${err.message}`;
      summaryEl.classList.add('warn');
      confirmBtn.disabled = true;
      return;
    }
    if (token !== exportPlanToken) return;
    if (!res || res.empty) {
      lastExportPlan = null;
      summaryEl.textContent = '所选范围里没有章节，换个范围试试';
      summaryEl.classList.add('warn');
      confirmBtn.disabled = true;
      return;
    }
    lastExportPlan = res;
    const bits = [`将导出 ${res.chapterCount} 章`, `${res.chars} 字`];
    if (res.includedUnsaved) bits.push('含当前章未保存内容');
    summaryEl.textContent = `${bits.join(' · ')}；默认文件名：${res.fileName}`;
    summaryEl.classList.remove('warn');
    confirmBtn.disabled = false;
  }

  function scheduleExportSummary(delay = 0) {
    if (exportPlanTimer) clearTimeout(exportPlanTimer);
    exportPlanTimer = setTimeout(() => {
      exportPlanTimer = null;
      refreshExportSummary();
    }, delay);
  }

  function openExportDialog() {
    hideExportMenu();
    if (!state.bookPath) return;
    if (!state.chapters.length) {
      toast('这本书里还没有章节，没有可导出的内容', 'warn');
      return;
    }
    const total = state.chapters.length;
    fillExportVolumeOptions();
    const allRadio = document.querySelector('input[name="export-scope"][value="all"]');
    if (allRadio) allRadio.checked = true;
    $('export-all-count').textContent = `（${total} 章）`;
    $('export-from').value = '1';
    $('export-to').value = String(total);
    $('export-from').max = String(total);
    $('export-to').max = String(total);
    $('export-from').min = '1';
    $('export-to').min = '1';
    $('export-backdrop').classList.remove('hidden');
    refreshExportSummary();
  }

  function closeExportDialog() {
    $('export-backdrop').classList.add('hidden');
    exportPlanToken += 1; // 让还没回来的摘要失效
    if (exportPlanTimer) {
      clearTimeout(exportPlanTimer);
      exportPlanTimer = null;
    }
    lastExportPlan = null;
  }

  async function confirmExportDialog() {
    const range = readExportRange();
    const error = validateExportRange(range);
    if (error) {
      toast(error, 'warn');
      return;
    }
    if (!lastExportPlan || lastExportPlan.empty) {
      toast('所选范围里没有章节，换个范围试试', 'warn');
      return;
    }
    closeExportDialog();
    await exportBookFlow(range);
  }

  async function copyBookFlow() {
    if (!state.bookPath) return;
    try {
      const data = await call(api.copyBook, state.bookPath, currentChapterOverride());
      toast(`已复制整本${outputSummary(data)}`);
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
    }
  }

  // 复制本章（平台格式）：只复制正文（不含章名，平台后台的章名是单独一栏）。
  // 正文套「段首缩进 + 空一行（含缩进）」后进剪贴板，不写盘；
  // 当前章有未保存修改时，编辑区里的最新内容优先（和导出/复制整本一个惯例）。
  async function copyChapterPlatformFlow(index) {
    if (!state.bookPath) return null;
    const chapter = state.chapters[index];
    if (!chapter) return null;
    const ref = { chapterId: chapter.id };
    if (index === state.index && state.dirty) ref.text = editorEl.value;
    try {
      const data = await call(api.copyChapterPlatform, state.bookPath, ref);
      if (data.empty) {
        toast('本章还没有正文，没有可复制的内容（剪贴板没动）', 'warn');
        return data;
      }
      const parts = [`${data.paragraphs} 段`, `${data.chars} 字`];
      if (data.includedUnsaved) parts.push('含未保存内容');
      toast(`已复制「${data.title}」正文（段首缩进 + 段间空行：${parts.join(' · ')}）`);
      return data;
    } catch (err) {
      toast(`复制本章失败：${err.message}`, 'error');
      return null;
    }
  }

  // range 不传 = 全书；传 { mode:'volume'|'range' } 只导出选中的部分
  async function exportBookFlow(range) {
    if (!state.bookPath) return;
    try {
      const data = await call(api.exportBook, state.bookPath, currentChapterOverride(), range);
      if (data.canceled) return;
      toast(`已导出：${data.filePath}${outputSummary(data)}`);
    } catch (err) {
      toast(`导出失败：${err.message}`, 'error');
    }
  }

  // 导出 EPUB：整本书一本电子书（分卷 → 目录级、一章一个 XHTML、纯文字封面页）。
  // 和 TXT 导出一样带上当前章未保存的内容（只参与这次导出，不写盘）。
  async function exportEpubFlow() {
    if (!state.bookPath) return;
    try {
      const data = await call(api.exportEpub, state.bookPath, currentChapterOverride());
      if (data.canceled) return;
      const parts = [`${data.chapterCount} 章`];
      if (data.volumeCount) parts.push(`${data.volumeCount} 卷`);
      parts.push(`${Number(data.chars) || 0} 字`);
      if (data.includedUnsaved) parts.push('含当前章未保存内容');
      toast(`已导出 EPUB：${data.filePath}（${parts.join(' · ')}）`);
    } catch (err) {
      toast(`导出 EPUB 失败：${err.message}`, 'error');
    }
  }

  async function openBookFolderFlow() {
    if (!state.bookPath) return;
    try {
      await call(api.openBookFolder, state.bookPath);
    } catch (err) {
      toast(`打开文件夹失败：${err.message}`, 'error');
    }
  }

  // ---------- 导入 / 删除小说（书架级操作） ----------
  let importProgressEl = null;

  function setImportProgressText(text) {
    if (importProgressEl) importProgressEl.textContent = text;
  }

  function summarizeImport(imported, skipped, failed) {
    const messages = [];
    if (imported.length) {
      const titles = imported.map((b) => b.title);
      const shown = titles.slice(0, 3).join('、');
      messages.push(
        imported.length > 3
          ? `已导入 ${imported.length} 本：${shown} 等`
          : `已导入 ${imported.length} 本：${shown}`
      );
    }
    if (skipped.length) {
      const reasons = [...new Set(skipped.map((s) => s.reason))].slice(0, 2).join('；');
      messages.push(`跳过 ${skipped.length} 个（${reasons}）`);
    }
    if (failed.length) {
      const reasons = failed.map((f) => f.message).slice(0, 2).join('；');
      messages.push(`${failed.length} 个失败（${reasons}）`);
    }
    return messages.join('。') || '没有可导入的内容';
  }

  async function importBooksFlow(explicitPaths, mode = 'chapters') {
    if (state.importing) return { busy: true };
    state.importing = true;
    const importButton = $('btn-import');
    if (importButton) importButton.disabled = true;
    importProgressEl = document.createElement('div');
    importProgressEl.className = 'toast';
    importProgressEl.textContent = '正在分析要导入的内容…';
    $('toast-area').appendChild(importProgressEl);

    let data = null;
    let error = null;
    try {
      data = await call(api.importBooks, explicitPaths, { mode });
    } catch (err) {
      error = err;
    } finally {
      if (importProgressEl && importProgressEl.parentNode) importProgressEl.remove();
      importProgressEl = null;
      state.importing = false;
      if (importButton) importButton.disabled = false;
    }

    if (error) {
      toast(`导入失败：${error.message}`, 'error');
      return { error: error.message };
    }
    if (data.canceled) return { canceled: true };

    toast(
      summarizeImport(data.imported, data.skipped, data.failed),
      data.failed.length ? 'error' : data.skipped.length ? 'warn' : 'info'
    );
    await refreshShelf();
    return data;
  }

  // 点「导入小说」先问导入方式：默认按原文章节拆开，也可整本一章
  async function onImportClick() {
    if (state.importing) return;
    const res = await openModal({
      title: '导入小说',
      message:
        '请选择导入方式：\n\n' +
        '• 按原文章节导入（推荐）：按原文的「第X章 / 楔子」等标题拆成多章，章名照抄原文、正文一字不改\n' +
        '• 整本一章导入：不拆章，整本小说放在一章「全文」里（原样复制）',
      buttons: [
        { label: '按原文章节导入', value: 'chapters', kind: 'primary' },
        { label: '整本一章', value: 'raw' },
        { label: '取消', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    if (res.action !== 'chapters' && res.action !== 'raw') return;
    await importBooksFlow(undefined, res.action);
  }

  async function deleteBookFlow(book, { skipConfirm = false } = {}) {
    if (!book || !book.path) return;
    if (!skipConfirm) {
      const res = await openModal({
        title: '删除这本书',
        message: `确定删除「${book.title}」吗？\n\n整本书（${book.chapterCount} 章）会被移到 Windows 回收站，可以从回收站还原。`,
        buttons: [
          { label: '删除这本书', value: 'delete', kind: 'danger' },
          { label: '取消', value: 'cancel', kind: 'primary' }
        ],
        cancelValue: 'cancel'
      });
      if (res.action !== 'delete') return;
    }
    try {
      const data = await call(api.deleteBook, book.path);
      if (data.method === 'recycle') {
        toast(`已删除「${book.title}」，可在 Windows 回收站里还原`);
      } else {
        toast(`已删除「${book.title}」，已移到书架 _trash${data.note ? `（${data.note}）` : ''}`);
      }
      await refreshShelf();
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
    }
  }

  // ---------- 返回书架 ----------
  async function backToShelf() {
    if (state.dirty) {
      const action = await askUnsaved({
        title: '返回书架前保存',
        message: `「${currentChapterLabel()}」有未保存的修改。`
      });
      if (action === 'cancel') return;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return;
      }
    }
    state.view = 'shelf';
    state.bookPath = null;
    state.meta = null;
    state.bookId = null;
    state.bookDisplay = {};
    state.chapters = [];
    state.index = -1;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    editorEl.value = '';
    // 回到书架就切回全局显示设置
    state.config = effectiveConfig();
    applyEditorStyle();
    applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
    showView('shelf');
    await refreshShelf();
  }

  // ---------- 改名 ----------
  async function renameBookFlow() {
    if (!state.bookPath || !state.meta) return;
    const title = await promptText({
      title: '修改书名',
      message: '只改书目里的书名，文件夹名保持不变（与「不重命名文件」一致）。',
      value: state.meta.title || '',
      placeholder: '书名'
    });
    if (title === null) return;
    try {
      const meta = await call(api.renameBook, state.bookPath, title);
      state.meta = meta;
      $('book-title').textContent = meta.title;
      $('book-title').title = meta.title;
      updateWindowTitle();
      toast('书名已更新');
    } catch (err) {
      toast(`改名失败：${err.message}`, 'error');
    }
  }

  // ---------- 关闭拦截 ----------
  async function handleCloseRequest() {
    if (state.modal) {
      api.closeReady(false);
      return;
    }
    // 关窗前先把排版/设置/导出弹层收掉：否则「保存 / 不保存 / 取消」的询问会被它们压住
    hideFormatMenu();
    closeFormatDialog();
    if (!$('export-backdrop').classList.contains('hidden')) closeExportDialog();
    if (!$('jump-backdrop').classList.contains('hidden')) closeJumpDialog();
    if (!$('conflict-backdrop').classList.contains('hidden')) closeConflictDialog();
    if (!$('history-backdrop').classList.contains('hidden')) closeHistoryDialog();
    if (!$('settings-backdrop').classList.contains('hidden')) closeSettings();
    if (!state.dirty || !state.bookPath) {
      api.closeReady(true);
      return;
    }
    const action = await askUnsaved({
      title: '退出前保存',
      message: '当前章节有未保存的修改，退出会丢失这些内容。',
      saveLabel: '保存并退出',
      discardLabel: '不保存退出'
    });
    if (action === 'cancel') {
      api.closeReady(false);
      return;
    }
    if (action === 'discard') {
      api.closeReady(true);
      return;
    }
    const saved = await saveCurrent();
    if (!saved.ok) {
      const again = await openModal({
        title: '保存失败',
        message: `保存失败：${saved.message}\n仍要退出吗？`,
        buttons: [
          { label: '返回保存', value: 'cancel', kind: 'primary' },
          { label: '放弃修改退出', value: 'discard', kind: 'danger' }
        ],
        cancelValue: 'cancel'
      });
      if (again.action !== 'discard') {
        api.closeReady(false);
        return;
      }
    }
    api.closeReady(true);
  }

  // ---------- 外部修改检测 ----------
  let lastBlurAt = 0;
  window.addEventListener('blur', () => {
    lastBlurAt = Date.now();
  });
  window.addEventListener('focus', async () => {
    const since = Date.now() - lastBlurAt;
    lastBlurAt = 0;
    if (!state.bookPath || state.index < 0 || state.loading || state.saving || state.modal || since < 500) return;
    const chapter = state.chapters[state.index];
    if (!chapter) return;
    try {
      const stat = await call(api.statChapter, state.bookPath, chapter.file);
      if (stat.mtimeMs === state.loadedMtimeMs) return;
      if (state.dirty) {
        toast('本章在应用外被修改过；你还有未保存的修改，保存会覆盖外部内容', 'warn');
        return;
      }
      const res = await openModal({
        title: '检测到外部修改',
        message: '当前章节文件在应用外被修改过（可能是用记事本改的）。要重新加载磁盘上的内容吗？',
        buttons: [
          { label: '重新加载', value: 'reload', kind: 'primary' },
          { label: '保留当前', value: 'keep' }
        ]
      });
      if (res.action === 'reload') await loadChapterAt(state.index);
    } catch {
      /* 文件可能被删了，忽略 */
    }
  });

  // ---------- 右键菜单 / 导出菜单 ----------
  function showContextMenu(event, index) {
    state.contextIndex = index;
    const menu = $('context-menu');
    // 当前状态的那一项前面打勾，避免记不清这章标的是什么
    const currentStatus = chapterStatus(state.chapters[index]);
    menu.querySelectorAll('button[data-action^="status-"]').forEach((btn) => {
      const status = btn.dataset.action.slice('status-'.length);
      const label = CHAPTER_STATUS_LABELS[status];
      if (!label) return;
      btn.textContent = `${status === currentStatus ? '✓ ' : ''}标记为${label}`;
    });
    menu.classList.remove('hidden');
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    if (event.clientX > maxX) menu.style.left = `${Math.max(8, maxX)}px`;
    if (event.clientY > maxY) menu.style.top = `${Math.max(8, maxY)}px`;
  }

  function hideContextMenu() {
    $('context-menu').classList.add('hidden');
  }

  function showVolumeMenu(event, volumeId) {
    state.contextVolumeId = volumeId || null;
    const menu = $('volume-menu');
    const volumes = volumeList();
    const index = volumeId ? volumes.findIndex((v) => v.id === volumeId) : -1;
    // 「未分卷」组不是真正的卷：只能往里加章节
    menu.querySelectorAll('button[data-action="rename"], button[data-action="delete"]').forEach((btn) => {
      btn.classList.toggle('hidden', !volumeId);
    });
    const upBtn = menu.querySelector('button[data-action="move-up"]');
    const downBtn = menu.querySelector('button[data-action="move-down"]');
    if (upBtn) {
      upBtn.classList.toggle('hidden', !volumeId);
      upBtn.disabled = index <= 0;
    }
    if (downBtn) {
      downBtn.classList.toggle('hidden', !volumeId);
      downBtn.disabled = index < 0 || index >= volumes.length - 1;
    }
    const newChapterBtn = menu.querySelector('button[data-action="new-chapter"]');
    if (newChapterBtn) newChapterBtn.textContent = volumeId ? '在此卷末尾新建章节' : '在「未分卷」末尾新建章节';
    menu.classList.remove('hidden');
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    if (event.clientX > maxX) menu.style.left = `${Math.max(8, maxX)}px`;
    if (event.clientY > maxY) menu.style.top = `${Math.max(8, maxY)}px`;
  }

  function hideVolumeMenu() {
    $('volume-menu').classList.add('hidden');
    state.contextVolumeId = null;
  }

  function showBookMenu(book, x, y) {
    state.contextBook = book;
    const menu = $('book-menu');
    menu.classList.remove('hidden');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    if (x > maxX) menu.style.left = `${Math.max(8, maxX)}px`;
    if (y > maxY) menu.style.top = `${Math.max(8, maxY)}px`;
  }

  function hideBookMenu() {
    $('book-menu').classList.add('hidden');
    state.contextBook = null;
  }

  function toggleExportMenu() {
    $('export-menu').classList.toggle('hidden');
  }

  function hideExportMenu() {
    $('export-menu').classList.add('hidden');
  }

  // ---------- 查找替换（全书 / 当前章） ----------
  function openFindPanel() {
    if (!state.bookPath) {
      toast('先打开一本书再查找', 'warn');
      return;
    }
    hideFormatMenu();
    hideExportMenu();
    // 编辑器里选中了一段短文本时，直接带进查找框
    const selection = String(window.getSelection ? window.getSelection().toString() : '');
    if (selection && selection.length <= 60 && !selection.includes('\n')) {
      $('find-query').value = selection;
    }
    $('find-backdrop').classList.remove('hidden');
    $('find-query').focus();
    $('find-query').select();
    // 顺带看一眼这本书有没有「整本替换」的备份（有就显示「还原到替换前」入口）
    refreshReplaceBackups();
  }

  function closeFindPanel() {
    $('find-backdrop').classList.add('hidden');
  }

  function readFindOptions() {
    return {
      query: $('find-query').value,
      replacement: $('find-replace').value,
      scope: $('find-scope').value,
      caseSensitive: $('find-case').checked
    };
  }

  // ---------- 整本替换的备份还原 ----------
  // 备份都在书内 _trash/替换备份-时间戳/（storage 负责读写），这里只负责展示和确认。
  async function refreshReplaceBackups() {
    const row = $('find-backup-row');
    if (!state.bookPath) {
      state.replaceBackups = [];
      row.classList.add('hidden');
      return state.replaceBackups;
    }
    try {
      const backups = await call(api.listReplaceBackups, state.bookPath);
      state.replaceBackups = Array.isArray(backups) ? backups : [];
    } catch {
      state.replaceBackups = [];
    }
    if (!state.replaceBackups.length) {
      row.classList.add('hidden');
      return state.replaceBackups;
    }
    const latest = state.replaceBackups[0];
    $('find-backup-text').textContent =
      `最近一次整本替换的备份：${latest.name}（${latest.fileCount} 个文件，${formatBytes(latest.totalBytes)}）`;
    row.classList.remove('hidden');
    return state.replaceBackups;
  }

  // 「只替换这一处」：只改编辑区（未保存），替换完自动选中下一处，方便连续按。
  // 用 execCommand 替换当前选中文本，保住原生 Ctrl+Z 撤销链。
  async function runReplaceOne() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      return { ok: false };
    }
    if (options.scope !== 'current') {
      $('find-summary').textContent = '「替换这一处」只用于当前章；整本替换请用「全部替换」。';
      return { ok: false };
    }
    const text = editorEl.value;
    const from = editorEl.selectionStart || 0;
    let picked;
    try {
      picked = await call(api.findNext, text, options.query, from, {
        caseSensitive: options.caseSensitive
      });
    } catch (err) {
      $('find-summary').textContent = `查找失败：${err.message}`;
      return { ok: false };
    }
    if (!picked) {
      $('find-summary').textContent = `光标之后没有找到「${options.query}」了`;
      return { ok: false };
    }
    const match = picked.match;
    const replacement = options.replacement;
    editorEl.focus();
    editorEl.setSelectionRange(match.index, match.index + match.length);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, replacement);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      // 极端兜底：execCommand 不可用时手动拼接（会丢原生撤销链，但不会丢内容）
      const current = editorEl.value;
      editorEl.value =
        current.slice(0, match.index) + replacement + current.slice(match.index + match.length);
    }
    onEditorInput();

    // 选中下一处，方便连续替换
    let next = null;
    try {
      const after = match.index + replacement.length;
      next = await call(api.findNext, editorEl.value, options.query, after, {
        caseSensitive: options.caseSensitive
      });
    } catch { /* 找下一处失败不影响已经替换的内容 */ }
    if (next) {
      editorEl.setSelectionRange(next.match.index, next.match.index + next.match.length);
      scrollCaretIntoView(next.match.index);
    } else {
      const caret = match.index + replacement.length;
      editorEl.setSelectionRange(caret, caret);
      scrollCaretIntoView(caret);
    }
    const nextHint = next ? `；已选中下一处（第 ${next.index + 1} 处）` : '；本章后面没有下一处了';
    $('find-summary').textContent =
      `已替换第 ${picked.index + 1}/${picked.total} 处（未保存：Ctrl+S 写盘，Ctrl+Z 可撤销）${nextHint}`;
    return { ok: true, index: picked.index, total: picked.total, hasNext: Boolean(next) };
  }

  // 从最近的「整本替换」备份还原；还原前二次确认，并由 storage 把当前内容再备份一份。
  async function restoreReplaceBackupFlow(backupName) {
    if (!state.bookPath) {
      toast('还没有打开一本书', 'warn');
      return { ok: false };
    }
    await refreshReplaceBackups();
    const target =
      state.replaceBackups.find((item) => item.name === backupName) || state.replaceBackups[0];
    if (!target) {
      toast('这本书里没有可还原的替换备份', 'warn');
      return { ok: false };
    }
    if (state.dirty) {
      const action = await askUnsaved({
        title: '还原前先处理未保存的修改',
        message: '还原会用备份覆盖磁盘上的章节，并从磁盘重新载入正文；当前章的未保存修改会丢失。',
        saveLabel: '保存修改后再还原',
        discardLabel: '放弃修改并还原'
      });
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      }
    }
    const others = state.replaceBackups.length - 1;
    const confirmed = await openModal({
      title: '还原到替换前',
      message:
        `会用「${target.name}」里的 ${target.fileCount} 个章节文件覆盖书里的同名章节。\n\n` +
        '还原前会先把当前内容再备份到书内 _trash/还原前备份-时间戳/，所以这一步也能找回。\n' +
        (others > 0 ? `\n注意：这本书还有 ${others} 次更早的替换备份，这里只还原最近的一次。` : ''),
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '还原', value: 'ok', kind: 'danger' }
      ],
      cancelValue: 'cancel'
    });
    if (confirmed.action !== 'ok') return { ok: false, canceled: true };
    try {
      const data = await call(api.restoreReplaceBackup, state.bookPath, target.name);
      await reloadOpenBookFromDisk();
      await refreshShelf();
      await refreshReplaceBackups();
      toast(
        `已还原 ${data.restored} 个章节${
          data.skipped ? `（跳过 ${data.skipped} 个已不存在的章节）` : ''
        }，当前内容已备份到 _trash`
      );
      return { ok: true, data };
    } catch (err) {
      toast(`还原失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 还原 / 外部改动后从磁盘重载当前书（章节列表、字数、当前章）。
  // 章节 id 保持不变就回到原来那一章；章节被删/书目重建时回到第 1 章。
  async function reloadOpenBookFromDisk() {
    if (!state.bookPath) return null;
    const currentId = state.chapters[state.index] && state.chapters[state.index].id;
    const opened = await call(api.openBook, state.bookPath);
    state.meta = opened.meta;
    state.chapters = opened.meta.chapters;
    state.bookId = opened.meta.id;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    $('book-title').textContent = opened.meta.title;
    $('book-title').title = opened.meta.title;
    const index = Math.max(
      0,
      state.chapters.findIndex((chapter) => chapter.id === currentId)
    );
    await loadChapterAt(index);
    renderChapterList();
    renderEditorHeader();
    await applyBookDisplay(opened.meta.id);
    updateWindowTitle();
    return opened;
  }

  // ---------- 本书历史（统一查看 / 还原 _trash 备份） ----------
  // 备份来源由 core/history.js 扫描：替换 / 整理 / 还原前 / 快照 / 删章散文件 / 书目.json.bak。
  // 这里只负责展示、预览和二次确认；真正的写盘在 storage（先备份当前内容再原子写）。
  function sameBookPath(a, b) {
    return String(a == null ? '' : a).toLowerCase() === String(b == null ? '' : b).toLowerCase();
  }

  async function openHistoryForPath(bookPath, title) {
    if (!bookPath) return false;
    hideExportMenu();
    hideBookMenu();
    state.history = {
      path: bookPath,
      title: String(title == null ? '' : title),
      groups: [],
      fileCount: 0,
      totalBytes: 0,
      loading: true,
      error: '',
      preview: null,
      token: 0
    };
    $('history-backdrop').classList.remove('hidden');
    renderHistory();
    await refreshHistory();
    return true;
  }

  function openHistoryForCurrentBook() {
    if (!state.bookPath) {
      toast('先打开一本书再查看历史', 'warn');
      return Promise.resolve(false);
    }
    return openHistoryForPath(state.bookPath, state.meta ? state.meta.title : '');
  }

  async function refreshHistory() {
    const current = state.history;
    if (!current) return null;
    const token = current.token + 1;
    current.token = token;
    current.loading = true;
    current.error = '';
    renderHistory();
    let data;
    try {
      data = await call(api.listHistory, current.path);
    } catch (err) {
      if (state.history !== current || current.token !== token) return null;
      current.loading = false;
      current.error = err.message;
      renderHistory();
      return null;
    }
    if (state.history !== current || current.token !== token) return null;
    current.loading = false;
    current.title = data && data.title ? data.title : current.title;
    current.groups = Array.isArray(data && data.groups) ? data.groups : [];
    current.fileCount = Number(data && data.fileCount) || 0;
    current.totalBytes = Number(data && data.totalBytes) || 0;
    renderHistory();
    return data;
  }

  function closeHistoryDialog() {
    state.history = null;
    $('history-backdrop').classList.add('hidden');
    $('history-preview').classList.add('hidden');
  }

  function closeHistoryPreview() {
    if (state.history) state.history.preview = null;
    renderHistoryPreview();
  }

  function renderHistoryPreview() {
    const current = state.history;
    const pane = $('history-preview');
    if (!pane) return;
    if (!current || !current.preview) {
      pane.classList.add('hidden');
      return;
    }
    pane.classList.remove('hidden');
    $('history-preview-title').textContent =
      `${current.preview.sourceLabel} · ${current.preview.fileName}` +
      (current.preview.truncated ? '（文件较大，只预览开头）' : '');
    $('history-preview-text').textContent = current.preview.text || '（空文件）';
  }

  function historyFileTag(group, file) {
    if (group.source === 'delete') return { text: file.inBook ? '书里已有同名文件' : '已从书中删除', className: 'deleted' };
    if (group.source === 'bookmeta') return { text: '只供查看', className: '' };
    if (file.inBook && file.restorable) return { text: '当前章节', className: 'current' };
    if (group.source === 'other') return { text: '未识别备份', className: '' };
    if (!file.inBook) return { text: '已不在书里', className: '' };
    return { text: '只供查看', className: '' };
  }

  function buildHistoryGroup(group) {
    const card = document.createElement('div');
    card.className = 'history-group';
    card.dataset.groupId = group.id;
    card.dataset.source = group.source;

    const head = document.createElement('div');
    head.className = 'history-group-head';
    const source = document.createElement('span');
    source.className = 'history-source';
    source.textContent = group.sourceLabel;
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = group.timeText || '时间未知';
    const count = document.createElement('span');
    count.className = 'history-count';
    count.textContent = `${group.fileCount} 个文件 · ${formatBytes(group.totalBytes)}`;
    head.append(source, time, count);
    if (group.kind === 'dir' && group.restorableCount > 0) {
      const restoreGroupBtn = document.createElement('button');
      restoreGroupBtn.type = 'button';
      restoreGroupBtn.className = 'btn ghost tiny history-restore-group';
      restoreGroupBtn.textContent = `还原整组（${group.restorableCount}）`;
      restoreGroupBtn.title = '只还原现在仍在书里的章节；还原前先把当前内容备份一份';
      restoreGroupBtn.addEventListener('click', () => confirmHistoryRestore(group, null, true));
      head.appendChild(restoreGroupBtn);
    }
    card.appendChild(head);

    const note = document.createElement('div');
    note.className = 'history-note';
    note.textContent = group.note;
    card.appendChild(note);

    for (const file of group.files) {
      const row = document.createElement('div');
      row.className = 'history-file';
      row.dataset.fileName = file.name;

      const name = document.createElement('span');
      name.className = 'history-file-name';
      name.textContent = file.name;
      name.title = file.reason || file.name;

      const tagInfo = historyFileTag(group, file);
      const tag = document.createElement('span');
      tag.className = `history-file-tag ${tagInfo.className}`.trim();
      tag.textContent = tagInfo.text;

      const actions = document.createElement('span');
      actions.className = 'history-file-actions';
      if (file.previewable) {
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'btn ghost tiny';
        previewBtn.textContent = '预览';
        previewBtn.addEventListener('click', () => previewHistoryBackup(group.id, file.name));
        actions.appendChild(previewBtn);
      }
      if (file.restorable) {
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'btn ghost tiny';
        restoreBtn.textContent = group.source === 'delete' ? '放回书文件夹' : '还原';
        restoreBtn.title =
          group.source === 'delete'
            ? '只把 txt 放回书文件夹，不改章节列表；书里已有同名文件时不覆盖'
            : '用备份覆盖这一章；还原前会先把现在的内容备份一份';
        restoreBtn.addEventListener('click', () => confirmHistoryRestore(group, file, false));
        actions.appendChild(restoreBtn);
      }
      row.append(name, tag, actions);
      card.appendChild(row);
    }
    return card;
  }

  function renderHistory() {
    const current = state.history;
    if (!current) return;
    const titleEl = $('history-title');
    if (titleEl) {
      titleEl.textContent = current.title ? `本书历史 · 《${current.title}》` : '本书历史';
    }
    const summary = $('history-summary');
    const list = $('history-list');
    list.innerHTML = '';
    if (current.loading) {
      summary.textContent = '正在读取备份…';
    } else if (current.error) {
      summary.textContent = '读取失败';
      const empty = document.createElement('div');
      empty.className = 'history-empty warn';
      empty.textContent = `读取备份失败：${current.error}`;
      list.appendChild(empty);
    } else if (!current.groups.length) {
      summary.textContent = '没有历史备份';
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent =
        '这本书里还没有历史备份。做过替换、整本整理、删除章节或保存过书目后，备份会自动出现在这里。';
      list.appendChild(empty);
    } else {
      summary.textContent =
        `共 ${current.groups.length} 组备份 · ${current.fileCount} 个文件 · ` +
        `${formatBytes(current.totalBytes)}（新 → 旧）`;
      for (const group of current.groups) list.appendChild(buildHistoryGroup(group));
    }
    renderHistoryPreview();
  }

  async function previewHistoryBackup(groupId, fileName) {
    const current = state.history;
    if (!current) return null;
    try {
      const data = await call(api.previewHistoryFile, current.path, groupId, fileName);
      if (state.history !== current) return null;
      current.preview = data;
      renderHistoryPreview();
      return data;
    } catch (err) {
      toast(`预览失败：${err.message}`, 'error');
      return null;
    }
  }

  async function confirmHistoryRestore(group, file, wholeGroup) {
    const current = state.history;
    if (!current || !group) return { ok: false };
    if (state.dirty && sameBookPath(state.bookPath, current.path)) {
      const action = await askUnsaved({
        title: '还原前先处理未保存的修改',
        message: '还原会从磁盘重新载入这本书的正文；当前章未保存的修改会丢失。',
        saveLabel: '保存修改后再还原',
        discardLabel: '放弃修改并还原'
      });
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      }
    }
    const skippedHint =
      wholeGroup && group.files.length > group.restorableCount
        ? `\n\n另有 ${group.files.length - group.restorableCount} 个文件不是当前章节，会跳过（不会复活已删章节）。`
        : '';
    let title;
    let message;
    if (wholeGroup) {
      title = '还原整组备份';
      message =
        `会用「${group.sourceLabel}」这组备份里的 ${group.restorableCount} 个当前章节覆盖书里的同名章节。` +
        `${skippedHint}\n\n还原前会先把现在的内容备份到 _trash/还原前备份-时间戳/，这一步也能找回。`;
    } else if (group.source === 'delete') {
      title = '把删除的章节放回书文件夹';
      message =
        `会把「${file.name}」复制回书文件夹。\n\n` +
        '它不会自动加回章节列表（避免乱改章号和顺序）；需要的话可以用书卡的「修复 → 从目录重建」找回。' +
        '书里已有同名文件时不会覆盖。';
    } else {
      title = '还原这一章';
      message =
        `会用备份里的「${file.name}」覆盖书里这一章。\n\n` +
        '还原前会先把现在的内容备份到 _trash/还原前备份-时间戳/。';
    }
    const confirmed = await openModal({
      title,
      message,
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '还原', value: 'ok', kind: 'danger' }
      ],
      cancelValue: 'cancel'
    });
    if (confirmed.action !== 'ok') return { ok: false, canceled: true };
    try {
      const data = wholeGroup
        ? await call(api.restoreHistoryDir, current.path, group.id)
        : await call(api.restoreHistoryFile, current.path, group.id, file.name);
      const wasOpen = sameBookPath(state.bookPath, current.path);
      if (wasOpen && Number(data && data.restored) > 0 && group.source !== 'delete') {
        await reloadOpenBookFromDisk();
      }
      await refreshShelf();
      if (state.history === current) await refreshHistory();
      if (data && data.file && group.source === 'delete') {
        toast(`已把「${data.file}」放回书文件夹（章节列表未变，需要时可从目录重建找回）`);
      } else {
        toast(
          `已还原 ${Number(data && data.restored) || 0} 章` +
            `${data && data.skipped ? `（跳过 ${data.skipped} 个不是当前章节的文件）` : ''}，` +
            '还原前的内容已备份到 _trash'
        );
      }
      return { ok: true, data };
    } catch (err) {
      toast(`还原失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }


  function renderFindResults(payload) {
    const box = $('find-results');
    box.innerHTML = '';
    if (!payload.results.length) {
      const empty = document.createElement('div');
      empty.className = 'find-empty';
      empty.textContent = `没有找到「${payload.query}」`;
      box.appendChild(empty);
      return;
    }
    for (const result of payload.results) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'find-result';
      row.dataset.chapterId = result.chapterId;

      const head = document.createElement('div');
      const index = state.chapters.findIndex((chapter) => chapter.id === result.chapterId);
      const chapterName = document.createElement('span');
      chapterName.className = 'find-chapter';
      chapterName.textContent = index >= 0 ? chapterTitle(index, result.name) : String(result.name || '');
      const count = document.createElement('span');
      count.className = 'find-count';
      count.textContent = `${result.count} 处`;
      head.append(chapterName, count);

      const snippet = document.createElement('div');
      snippet.className = 'find-snippet';
      const first = result.matches[0];
      if (first) {
        snippet.appendChild(document.createTextNode(first.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = first.match;
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(first.after || ''));
      }
      row.append(head, snippet);
      row.addEventListener('click', () => jumpToFindResult(result));
      box.appendChild(row);
    }
  }

  async function jumpToFindResult(result) {
    const index = state.chapters.findIndex((chapter) => chapter.id === result.chapterId);
    if (index < 0) {
      toast('这一章已经不存在了', 'warn');
      return;
    }
    closeFindPanel();
    if (index !== state.index) {
      const switched = await switchChapter(index);
      if (!switched || switched.ok === false) return;
    }
    const match = result.matches && result.matches[0];
    if (!match) return;
    editorEl.focus();
    const start = Math.min(match.index, editorEl.value.length);
    editorEl.setSelectionRange(start, Math.min(start + match.length, editorEl.value.length));
    scrollCaretIntoView(start);
  }

  async function runFind() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      $('find-results').innerHTML = '';
      return;
    }
    $('find-summary').textContent = '查找中…';
    try {
      if (options.scope === 'book') {
        const payload = await call(api.searchBook, state.bookPath, {
          query: options.query,
          caseSensitive: options.caseSensitive
        });
        $('find-summary').textContent = payload.totalMatches
          ? `整本命中 ${payload.totalMatches} 处，分布在 ${payload.chapterCount} 章（点结果跳过去）`
          : `整本没有找到「${options.query}」`;
        renderFindResults(payload);
        return;
      }
      const res = await call(api.findInText, editorEl.value, options.query, {
        caseSensitive: options.caseSensitive
      });
      $('find-results').innerHTML = '';
      if (!res.count) {
        $('find-summary').textContent = `本章没有找到「${options.query}」`;
        return;
      }
      $('find-summary').textContent = `本章命中 ${res.count} 处（已选中第 1 处）`;
      const first = res.matches[0];
      editorEl.focus();
      const start = Math.min(first.index, editorEl.value.length);
      editorEl.setSelectionRange(start, Math.min(start + first.length, editorEl.value.length));
      scrollCaretIntoView(start);
    } catch (err) {
      $('find-summary').textContent = `查找失败：${err.message}`;
    }
  }

  // 当前章替换：走原生输入，保住 Ctrl+Z 撤销链；只改编辑区（未保存）
  function replaceEditorText(text) {
    editorEl.focus();
    editorEl.setSelectionRange(0, editorEl.value.length);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || editorEl.value !== text) editorEl.value = text;
    editorEl.setSelectionRange(0, 0);
    onEditorInput();
  }

  async function runReplaceAll() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      return;
    }
    if (options.scope === 'current') {
      try {
        const res = await call(api.replaceInText, editorEl.value, options.query, options.replacement, {
          caseSensitive: options.caseSensitive
        });
        if (!res.count) {
          $('find-summary').textContent = `本章没有找到「${options.query}」，未做替换`;
          return;
        }
        replaceEditorText(res.text);
        $('find-summary').textContent = `本章已替换 ${res.count} 处（还没保存：Ctrl+S 写盘，Ctrl+Z 可撤销）`;
        toast(`本章替换 ${res.count} 处（未保存）`);
      } catch (err) {
        toast(`替换失败：${err.message}`, 'error');
      }
      return;
    }

    // 整本替换：先处理未保存修改，再确认，替换前由主进程备份原章节
    if (state.dirty) {
      const action = await askUnsaved({
        title: '整本替换前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改；整本替换会直接写盘，建议先保存。`
      });
      if (action === 'cancel') return;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return;
      } else if (action === 'discard') {
        await loadChapterAt(state.index); // 用磁盘上的旧内容继续
      }
    }

    try {
      const preview = await call(api.searchBook, state.bookPath, {
        query: options.query,
        caseSensitive: options.caseSensitive
      });
      if (!preview.totalMatches) {
        $('find-summary').textContent = `整本没有找到「${options.query}」，未做替换`;
        return;
      }
      const confirmed = await openModal({
        title: '整本替换确认',
        message: `将在 ${preview.chapterCount} 章里替换 ${preview.totalMatches} 处：\n「${options.query}」→「${options.replacement}」\n\n替换前会把原章节备份到书内 _trash/替换备份-时间戳/，可以人工找回。`,
        buttons: [
          { label: '取消', value: 'cancel' },
          { label: '全部替换', value: 'ok', kind: 'primary' }
        ],
        cancelValue: 'cancel'
      });
      if (confirmed.action !== 'ok') return;
      closeFindPanel();
      const result = await call(api.replaceBook, state.bookPath, {
        query: options.query,
        replacement: options.replacement,
        caseSensitive: options.caseSensitive
      });
      await loadChapterAt(state.index);
      renderChapterList();
      refreshShelf(); // 字数变了，书架统计后台刷新即可
      toast(
        `整本替换完成：${result.chaptersChanged} 章 / ${result.occurrences} 处${
          result.backupDir ? ' · 原文已备份到 _trash' : ''
        }`
      );
    } catch (err) {
      toast(`整本替换失败：${err.message}`, 'error');
    }
  }

  // ---------- 排版 ----------
  // 「智能排版/一键整理」只改当前章正文，结果先落在编辑区（未保存），按 Ctrl+S 才写盘，可撤销。
  const DEFAULT_FORMAT_OPTIONS = {
    indent: '2',
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false,
    curlyQuotes: false,
    ellipsis: false
  };
  // 「撤销上次整理」的内存快照上限（只存内存，关掉应用就没了；50 步足够连续整理几十次）
  const MAX_FORMAT_UNDO = 50;

  const DISPLAY_PRESETS = {
    compact: { label: '紧凑', patch: { editorLineHeight: 1.6, editorLetterSpacing: 0, editorPaddingX: 24, editorPageWidth: 0 } },
    normal: { label: '标准', patch: { editorLineHeight: 1.95, editorLetterSpacing: 0.02, editorPaddingX: 56, editorPageWidth: 0 } },
    loose: { label: '宽松', patch: { editorLineHeight: 2.4, editorLetterSpacing: 0.05, editorPaddingX: 80, editorPageWidth: 800 } }
  };

  const displaySettingsIds = [
    'settings-size',
    'settings-line-height',
    'settings-letter-spacing',
    'settings-padding-x',
    'settings-page-width',
    'settings-paper'
  ];

  function readDisplayForm() {
    const draft = state.settingsFontDraft || { path: '', name: '' };
    return {
      editorFont: $('settings-font').value,
      editorCustomFontPath: draft.path,
      editorCustomFontName: draft.name,
      editorFontSize: Number($('settings-size').value),
      editorLineHeight: Number($('settings-line-height').value),
      editorLetterSpacing: Number($('settings-letter-spacing').value),
      editorPaddingX: Number($('settings-padding-x').value),
      editorPageWidth: Number($('settings-page-width').value),
      editorPaper: $('settings-paper').value
    };
  }

  function readFormatOptions() {
    return {
      indent: $('fmt-indent').value,
      blankLines: $('fmt-blank').value,
      trimTrailing: $('fmt-trailing').checked,
      normalizePunct: $('fmt-punct').checked,
      removeCjkSpaces: $('fmt-cjkspace').checked,
      curlyQuotes: $('fmt-quotes').checked,
      ellipsis: $('fmt-ellipsis').checked
    };
  }

  function writeFormatOptions(options) {
    const opts = { ...DEFAULT_FORMAT_OPTIONS, ...(options && typeof options === 'object' ? options : {}) };
    // 兼容旧配置里的布尔缩进
    const indent = opts.indent === true ? '2' : opts.indent === false ? 'none' : String(opts.indent);
    $('fmt-indent').value = ['none', '0', '2'].includes(indent) ? indent : '2';
    $('fmt-trailing').checked = opts.trimTrailing !== false;
    $('fmt-punct').checked = opts.normalizePunct !== false;
    $('fmt-quotes').checked = Boolean(opts.curlyQuotes);
    $('fmt-ellipsis').checked = Boolean(opts.ellipsis);
    $('fmt-cjkspace').checked = Boolean(opts.removeCjkSpaces);
    $('fmt-blank').value = ['keep', 'single', 'singleIndent', 'none'].includes(opts.blankLines)
      ? opts.blankLines
      : 'single';
  }

  function toggleFormatMenu() {
    const menu = $('format-menu');
    const willShow = menu.classList.contains('hidden');
    hideExportMenu();
    if (willShow) {
      const steps = formatUndoSteps();
      $('format-undo-item').disabled = steps === 0;
      $('format-undo-item').textContent =
        steps > 0 ? `撤销上次整理（可撤销 ${steps} 步）` : '撤销上次整理';
    }
    menu.classList.toggle('hidden');
  }

  function hideFormatMenu() {
    $('format-menu').classList.add('hidden');
  }

  let formatPreviewToken = 0;
  let formatPreviewTimer = null;

  function scheduleFormatPreview(delay = 140) {
    const token = formatPreviewToken + 1;
    formatPreviewToken = token;
    if (formatPreviewTimer) clearTimeout(formatPreviewTimer);
    formatPreviewTimer = setTimeout(() => {
      formatPreviewTimer = null;
      updateFormatPreview(token);
    }, delay);
  }

  function renderFormatPreview(res, raw) {
    if (!String(raw == null ? '' : raw).trim()) {
      $('fmt-summary').textContent = '本章还没有内容，没什么可整理的。';
      $('fmt-preview').textContent = '';
      $('btn-format-apply').disabled = true;
      return;
    }
    const s = res.stats;
    const parts = [
      `共 ${s.paragraphs} 段`,
      `缩进调整 ${s.indentFixed} 段`,
      `行尾空白 ${s.trailingTrimmed} 处`,
      `空行整理 ${s.blankCollapsed} 处`,
      `标点转全角 ${s.punctFixed} 处`
    ];
    if (s.cjkSpacesRemoved) parts.push(`中文间空格 ${s.cjkSpacesRemoved} 处`);
    if (s.quotesFixed) parts.push(`直引号转弯引号 ${s.quotesFixed} 处`);
    if (s.ellipsisFixed) parts.push(`省略号转中文 ${s.ellipsisFixed} 处`);
    $('fmt-summary').textContent = res.changed
      ? parts.join(' · ')
      : '本章已经是整理后的格式，没有可改的地方。';
    $('btn-format-apply').disabled = !res.changed;
    const preview = res.text.length > 700 ? `${res.text.slice(0, 700)}\n…` : res.text;
    $('fmt-preview').textContent = preview || '（整理后为空）';
  }

  async function updateFormatPreview(token) {
    try {
      const res = await call(api.formatText, editorEl.value, readFormatOptions());
      if (token !== formatPreviewToken) return; // 已经切到新的预览请求，丢弃旧结果
      renderFormatPreview(res, editorEl.value);
    } catch (err) {
      if (token !== formatPreviewToken) return;
      $('fmt-summary').textContent = `预览失败：${err.message}`;
      $('fmt-preview').textContent = '';
    }
  }

  function openFormatDialog() {
    hideFormatMenu();
    if (!state.bookPath || state.index < 0) {
      toast('先打开一本书的章节再排版', 'warn');
      return;
    }
    writeFormatOptions(state.config && state.config.formatOptions);
    $('fmt-summary').textContent = '正在预览…';
    $('fmt-preview').textContent = '';
    $('btn-format-apply').disabled = true;
    $('format-backdrop').classList.remove('hidden');
    scheduleFormatPreview(0);
  }

  function closeFormatDialog() {
    $('format-backdrop').classList.add('hidden');
    formatPreviewToken += 1; // 让还没回来的预览结果失效
    if (formatPreviewTimer) {
      clearTimeout(formatPreviewTimer);
      formatPreviewTimer = null;
    }
  }

  // 把整理结果写进编辑区：用 execCommand 走原生输入，保住 Ctrl+Z 的原生撤销链；
  // 失败再退回直接赋值。两条路都会触发 input → 标记未保存。
  // hint = { text: 整理前的正文, pos: 整理前光标位置 }，用来把光标映射回原来的位置。
  function insertFormattedText(text, hint) {
    const pos = hint && Number.isFinite(hint.pos) ? hint.pos : 0;
    const caret = hint && typeof hint.text === 'string'
      ? mapCaretPosition(hint.text, text, pos)
      : Math.min(pos, text.length);
    editorEl.focus();
    editorEl.setSelectionRange(0, editorEl.value.length);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || editorEl.value !== text) {
      editorEl.value = text;
      onEditorInput();
    }
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
  }

  // 整理只动空白/标点，正文有效字符的顺序不变：按「第 N 个非空白字符」把光标映射回去，
  // 避免整理/撤销后光标被拉回章首（长章里接着打字会插到全章最前面）。
  function mapCaretPosition(sourceText, targetText, sourcePos) {
    const contentBefore = String(sourceText).slice(0, Math.max(0, sourcePos));
    const wanted = contentBefore.replace(/\s/g, '').length;
    if (!wanted) return 0;
    let count = 0;
    for (let i = 0; i < targetText.length; i += 1) {
      if (!/\s/.test(targetText[i])) {
        count += 1;
        if (count >= wanted) return i + 1;
      }
    }
    return targetText.length;
  }

  function scrollCaretIntoView(pos) {
    const lineIndex = (editorEl.value.slice(0, pos).match(/\n/g) || []).length;
    const lineHeight = parseFloat(getComputedStyle(editorEl).lineHeight) || 32;
    const top = lineIndex * lineHeight;
    const viewBottom = editorEl.scrollTop + editorEl.clientHeight - lineHeight * 2;
    if (top < editorEl.scrollTop || top > viewBottom) {
      editorEl.scrollTop = Math.max(0, top - editorEl.clientHeight / 3);
    }
  }

  function pushFormatUndo(before, after) {
    const chapter = state.chapters[state.index];
    if (!chapter) return;
    state.formatUndo.push({ bookPath: state.bookPath, chapterId: chapter.id, before, after });
    while (state.formatUndo.length > MAX_FORMAT_UNDO) state.formatUndo.shift();
  }

  // 当前章还能连续撤销几步：从栈顶往下，只有当第 N 步的 after 正好等于第 N-1 步的 before
  // 时才真正连得上（中间如果手动改过字，链条就断了）。
  function formatUndoSteps() {
    const chapter = state.chapters[state.index];
    if (!chapter) return 0;
    let steps = 0;
    let expected = editorEl.value;
    for (let i = state.formatUndo.length - 1; i >= 0; i -= 1) {
      const snap = state.formatUndo[i];
      if (snap.bookPath !== state.bookPath || snap.chapterId !== chapter.id) break;
      if (snap.after !== expected) break;
      steps += 1;
      expected = snap.before;
    }
    return steps;
  }

  function canUndoFormat() {
    return formatUndoSteps() > 0;
  }

  function undoFormat() {
    if (!canUndoFormat()) return false;
    const top = state.formatUndo.pop();
    const caret = editorEl.selectionStart || 0;
    insertFormattedText(top.before, { text: top.after, pos: caret });
    toast('已撤销整理（仍在编辑区，未写盘）');
    return true;
  }

  async function applyFormatToEditor() {
    if (!state.bookPath || state.index < 0) return;
    const before = editorEl.value;
    const beforeCaret = editorEl.selectionStart || 0;
    if (!String(before == null ? '' : before).trim()) {
      toast('本章还没有内容', 'warn');
      return;
    }
    const options = readFormatOptions();
    $('btn-format-apply').disabled = true;
    try {
      const res = await call(api.formatText, before, options);
      // 记住这次勾选的规则，下次打开对话框沿用（只记规则，不碰正文）
      try {
        state.config = await call(api.setConfig, { formatOptions: options });
      } catch { /* 记不住规则不影响整理 */ }
      closeFormatDialog();
      if (!res.changed) {
        toast('本章已经是整理后的格式，没有改动');
        return;
      }
      insertFormattedText(res.text, { text: before, pos: beforeCaret });
      pushFormatUndo(before, res.text);
      toast(`已整理本章：${res.stats.paragraphs} 段 · Ctrl+S 保存 · Ctrl+Z 撤销`);
    } catch (err) {
      toast(`整理失败：${err.message}`, 'error');
    } finally {
      $('btn-format-apply').disabled = false;
    }
  }

  // ---------- 一键整理本书 ----------
  let formatBookProgressEl = null;

  function showFormatBookProgress(text) {
    if (!formatBookProgressEl) {
      formatBookProgressEl = document.createElement('div');
      formatBookProgressEl.className = 'toast';
      $('toast-area').appendChild(formatBookProgressEl);
    }
    formatBookProgressEl.textContent = text;
  }

  function hideFormatBookProgress() {
    if (formatBookProgressEl && formatBookProgressEl.parentNode) formatBookProgressEl.remove();
    formatBookProgressEl = null;
  }

  // 把排版规则讲成人话，放进确认框
  function describeFormatOptions(options) {
    const opts = { ...DEFAULT_FORMAT_OPTIONS, ...(options || {}) };
    const parts = [];
    if (opts.indent === '2') parts.push('段首缩进 2 字符');
    else if (opts.indent === '0') parts.push('段首缩进 0 字符');
    else parts.push('缩进不处理');
    const blankMap = {
      keep: '段间保持原样',
      single: '段间空一行',
      singleIndent: '段间空一行（含缩进）',
      none: '段间不空行'
    };
    parts.push(blankMap[opts.blankLines] || blankMap.single);
    if (opts.trimTrailing) parts.push('删行尾空白');
    if (opts.normalizePunct) parts.push('中文旁标点转全角');
    if (opts.curlyQuotes) parts.push('直引号转弯引号');
    if (opts.ellipsis) parts.push('省略号转中文');
    if (opts.removeCjkSpaces) parts.push('删中文间空格');
    return parts.join(' · ');
  }

  // 一键整理本书：复用上次「整理本章」的规则 → 预检查 → 确认 → 整本整理（写前备份）
  async function runFormatBook() {
    if (!state.bookPath || !state.meta) {
      toast('先打开一本书再整理', 'warn');
      return { ok: false };
    }
    if (state.formatBookRunning) {
      toast('正在整理这本书，请稍候', 'warn');
      return { ok: false, busy: true };
    }
    hideFormatMenu();
    if (state.dirty) {
      const action = await askUnsaved({
        title: '整理本书前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改；整本整理会直接写盘，建议先保存。`,
        saveLabel: '保存后整理',
        discardLabel: '不保存（按磁盘内容整理）'
      });
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      } else {
        await loadChapterAt(state.index); // 用磁盘上的旧内容继续
      }
    }

    const options = { ...DEFAULT_FORMAT_OPTIONS, ...((state.config && state.config.formatOptions) || {}) };
    let preview;
    try {
      preview = await call(api.formatPreviewBook, state.bookPath, options);
    } catch (err) {
      toast(`预检查失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
    if (!preview.chaptersChanged) {
      toast('这本书已经是整理后的格式，没有可改的地方');
      return { ok: true, changed: 0, data: preview };
    }

    const listText = preview.changed
      .slice(0, 6)
      .map((item) => chapterTitle(item.index, item.name))
      .join('、');
    const moreText =
      preview.chaptersChanged > 6
        ? ` 等共 ${preview.chaptersChanged} 章`
        : `（共 ${preview.chaptersChanged} 章）`;
    const confirmed = await openModal({
      title: '一键整理本书',
      message:
        `规则：${describeFormatOptions(options)}\n\n` +
        `会整理 ${preview.chapterCount} 章，其中 ${preview.chaptersChanged} 章有改动：\n${listText}${moreText}\n\n` +
        '写盘前会把要改动的原章节备份到书内 _trash/整理备份-时间戳/，可以人工找回。\n' +
        '整本整理会直接写盘（和「保存」一样是显式动作）；整理完当前章会从磁盘重新载入。',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '开始整理', value: 'ok', kind: 'primary' }
      ],
      cancelValue: 'cancel'
    });
    if (confirmed.action !== 'ok') return { ok: false, canceled: true };

    state.formatBookRunning = true;
    const currentId = state.chapters[state.index] && state.chapters[state.index].id;
    showFormatBookProgress(`正在整理整本书…（共 ${preview.chaptersChanged} 章要改）`);
    try {
      const result = await call(api.formatBook, state.bookPath, options);
      // 整理后重新载入书和当前章（正文、字数缓存都变了）
      const opened = await call(api.openBook, state.bookPath);
      state.meta = opened.meta;
      state.chapters = opened.meta.chapters;
      const index = Math.max(
        0,
        state.chapters.findIndex((chapter) => chapter.id === currentId)
      );
      await loadChapterAt(index);
      renderChapterList();
      renderEditorHeader();
      await refreshShelf();
      toast(
        `已整理全书：${result.chaptersChanged} 章${
          result.backupDir ? '，原文已备份到 _trash/整理备份' : ''
        }`
      );
      return { ok: true, changed: result.chaptersChanged, data: result };
    } catch (err) {
      toast(`整理本书失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    } finally {
      state.formatBookRunning = false;
      hideFormatBookProgress();
    }
  }

  async function setDisplayPreset(name) {
    const preset = DISPLAY_PRESETS[name];
    if (!preset) return;
    try {
      if (state.bookId) {
        const display = await call(api.setBookDisplay, state.bookId, preset.patch);
        state.bookDisplay = display || {};
        state.config = effectiveConfig();
        applyEditorStyle();
        toast(`本书正文显示已切换为「${preset.label}」（只影响这本书）`);
      } else {
        state.globalConfig = await call(api.setConfig, preset.patch);
        state.config = effectiveConfig();
        applyEditorStyle();
        toast(`正文显示已切换为「${preset.label}」（全局默认）`);
      }
    } catch (err) {
      toast(`切换显示失败：${err.message}`, 'error');
    }
  }

  // ---------- 设置 ----------
  function setSelectValue(id, value, fallback) {
    const el = $(id);
    const wanted = String(value == null ? fallback : value);
    el.value = wanted;
    if (el.value !== wanted) el.value = String(fallback); // 值不在选项里时回到默认
  }

  function settingsScopeForView() {
    return state.view === 'editor' && state.bookId ? 'book' : 'global';
  }

  // 设置弹层里各输入框按给定配置回填
  function fillSettingsFields(cfg) {
    state.settingsFontDraft = {
      path: cfg.editorCustomFontPath || '',
      name: cfg.editorCustomFontName || ''
    };
    $('settings-root').value = cfg.booksRoot || '';
    setSelectValue('settings-font', cfg.editorFont, 'serif');
    if ($('settings-font').value === 'custom' && !state.settingsFontDraft.path) {
      $('settings-font').value = 'serif';
    }
    $('settings-font-name').value = state.settingsFontDraft.name || state.settingsFontDraft.path || '';
    setSelectValue('settings-size', cfg.editorFontSize, 18);
    setSelectValue('settings-line-height', cfg.editorLineHeight, 1.95);
    setSelectValue('settings-letter-spacing', cfg.editorLetterSpacing, 0.02);
    setSelectValue('settings-padding-x', cfg.editorPaddingX, 56);
    setSelectValue('settings-page-width', cfg.editorPageWidth, 0);
    setSelectValue('settings-paper', cfg.editorPaper, 'paper');
    $('settings-snapshot-enabled').checked = cfg.snapshotEnabled === true;
    setSelectValue('settings-snapshot-days', cfg.snapshotKeepDays, 7);
    const goal = Math.max(0, Math.round(Number(cfg.dailyGoal) || 0));
    $('settings-daily-goal').value = String(goal);
    renderStatsChart();
  }

  function readSnapshotForm() {
    return {
      snapshotEnabled: $('settings-snapshot-enabled').checked === true,
      snapshotKeepDays: Number($('settings-snapshot-days').value)
    };
  }

  // 每日目标是全局设置（0 = 不设目标）；主进程/配置层还会再清洗一次范围。
  function readStatsForm() {
    const n = Number($('settings-daily-goal').value);
    return { dailyGoal: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 };
  }

  function updateSettingsScopeUi() {
    const isBook = state.settingsScope === 'book';
    const rootField = $('settings-root-field');
    if (rootField) rootField.classList.toggle('hidden', isBook);
    // 每日快照是全局设置：按书覆盖没有意义，写作页里不显示
    const snapshotField = $('settings-snapshot-field');
    if (snapshotField) snapshotField.classList.toggle('hidden', isBook);
    const snapshotDays = $('settings-snapshot-days-field');
    if (snapshotDays) snapshotDays.classList.toggle('hidden', isBook);
    // 写作统计 / 每日目标也是全局设置：按书覆盖没有意义，写作页里不显示
    for (const id of [
      'settings-stats-group',
      'settings-daily-goal-field',
      'settings-stats-chart-field',
      'settings-stats-hint'
    ]) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    const resetBtn = $('btn-reset-book-display');
    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !isBook || !Object.keys(state.bookDisplay || {}).length);
    }
    const hint = $('settings-scope-hint');
    if (!hint) return;
    hint.textContent = isBook
      ? `只影响「${state.meta ? state.meta.title : '这本书'}」的显示设置；书架 →「设置」里改的是全局默认（没单独设置过的书都用它）。`
      : '这里是全局默认设置：没有单独设置过的书都用这一份；在写作页里改设置只影响当前这本书。';
  }

  function previewSettings() {
    if (!state.settingsBackup) return;
    applyEditorStyle({ ...state.settingsBackup, ...readDisplayForm() });
  }

  async function openSettings() {
    state.settingsScope = settingsScopeForView();
    const cfg = state.config || {};
    state.settingsBackup = state.config ? { ...state.config } : null;
    // 打开时刷新一次今天 / 近 30 天，避免跨过午夜后还显示昨天的数字
    await refreshStats();
    fillSettingsFields(cfg);
    updateSettingsScopeUi();
    $('settings-backdrop').classList.remove('hidden');
  }

  function closeSettings({ restore = true } = {}) {
    $('settings-backdrop').classList.add('hidden');
    if (restore && state.settingsBackup) {
      state.config = state.settingsBackup;
      applyEditorStyle();
    }
    state.settingsBackup = null;
  }

  // 忘掉这本书的单独设置，恢复用全局默认
  async function resetBookDisplay() {
    if (state.settingsScope !== 'book' || !state.bookId) return false;
    try {
      await call(api.resetBookDisplay, state.bookId);
      state.bookDisplay = {};
      state.config = effectiveConfig();
      if (state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
        await loadCustomFont(state.config.editorCustomFontPath, { silent: true });
      }
      applyEditorStyle();
      applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
      fillSettingsFields(state.config);
      state.settingsBackup = { ...state.config };
      updateSettingsScopeUi();
      toast('已恢复为全局默认（这本书不再有单独设置）');
      return true;
    } catch (err) {
      toast(`恢复默认失败：${err.message}`, 'error');
      return false;
    }
  }

  async function saveSettings() {
    try {
      const form = readDisplayForm();
      if (state.settingsScope === 'book' && state.bookId) {
        const display = await call(api.setBookDisplay, state.bookId, form);
        state.bookDisplay = display || {};
        state.config = effectiveConfig();
        applyEditorStyle();
        applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
        closeSettings({ restore: false });
        toast('已保存：这本书的显示设置（只影响本书）');
        return;
      }
      const cfg = await call(api.setConfig, {
        booksRoot: $('settings-root').value.trim(),
        ...form,
        ...readSnapshotForm(),
        ...readStatsForm()
      });
      state.globalConfig = cfg;
      state.config = effectiveConfig();
      applyEditorStyle();
      closeSettings({ restore: false });
      toast('设置已保存（全局默认）');
      await refreshShelf();
    } catch (err) {
      toast(`保存设置失败：${err.message}`, 'error');
    }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-settings-cancel').addEventListener('click', closeSettings);
    $('btn-settings-save').addEventListener('click', saveSettings);
    $('btn-reset-book-display').addEventListener('click', resetBookDisplay);
    $('btn-pick-folder').addEventListener('click', async () => {
      try {
        const folder = await call(api.pickFolder);
        if (folder) $('settings-root').value = folder;
      } catch (err) {
        toast(`选择目录失败：${err.message}`, 'error');
      }
    });

    // 自定义字体：选择 → 主进程读文件 → FontFace 注册 → 实时预览（点「保存设置」才记住）
    $('btn-pick-font').addEventListener('click', async () => {
      try {
        const picked = await call(api.pickFont);
        if (!picked || picked.canceled || !picked.path) return;
        const ok = await loadCustomFont(picked.path);
        if (!ok) return;
        state.settingsFontDraft = { path: picked.path, name: picked.name };
        $('settings-font-name').value = picked.name;
        $('settings-font').value = 'custom';
        previewSettings();
        toast(`已选字体：${picked.name}（点「保存设置」后长期生效）`);
      } catch (err) {
        toast(`选择字体失败：${err.message}`, 'error');
      }
    });
    $('btn-reset-font').addEventListener('click', () => {
      state.settingsFontDraft = { path: '', name: '' };
      $('settings-font-name').value = '';
      $('settings-font').value = 'serif';
      previewSettings();
      toast('已恢复默认字体（宋体）');
    });
    $('settings-font').addEventListener('change', async () => {
      const draft = state.settingsFontDraft || {};
      if ($('settings-font').value === 'custom') {
        if (!draft.path) {
          toast('先点「选择…」挑一个 .ttf / .otf 字体文件', 'warn');
          $('settings-font').value = 'serif';
        } else {
          await loadCustomFont(draft.path, { silent: true });
        }
      }
      previewSettings();
    });

    $('btn-import').addEventListener('click', onImportClick);

    // 书架搜索：输入即过滤；Esc 清除；回车打开第一本匹配的书
    $('shelf-search').addEventListener('input', () => {
      state.shelfQuery = $('shelf-search').value;
      renderShelf();
    });
    $('shelf-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        state.shelfQuery = '';
        $('shelf-search').value = '';
        renderShelf();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const rows = shelfSearchResults();
        if (rows.length) openBookByPath(rows[0].book.path);
      }
    });
    $('btn-shelf-search-clear').addEventListener('click', () => {
      state.shelfQuery = '';
      $('shelf-search').value = '';
      renderShelf();
      $('shelf-search').focus();
    });

    $('book-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const book = state.contextBook;
      hideBookMenu();
      if (!book) return;
      if (btn.dataset.action === 'open') {
        await openBookByPath(book.path);
      } else if (btn.dataset.action === 'folder') {
        try {
          await call(api.openBookFolder, book.path);
        } catch (err) {
          toast(`打开文件夹失败：${err.message}`, 'error');
        }
      } else if (btn.dataset.action === 'delete') {
        await deleteBookFlow(book);
      } else if (btn.dataset.action === 'history') {
        await openHistoryForPath(book.path, book.title);
      }
    });

    $('btn-history-close').addEventListener('click', closeHistoryDialog);
    $('btn-history-refresh').addEventListener('click', () => refreshHistory());
    $('btn-history-preview-close').addEventListener('click', closeHistoryPreview);
    $('btn-history-open-folder').addEventListener('click', async () => {
      const target = state.history;
      if (!target) return;
      try {
        await call(api.openBookFolder, target.path);
        toast('已在资源管理器打开书文件夹（备份在 _trash 里）');
      } catch (err) {
        toast(`打开文件夹失败：${err.message}`, 'error');
      }
    });

    $('btn-continue-writing').addEventListener('click', () => openContinueBook());
    $('btn-conflict-close').addEventListener('click', closeConflictDialog);
    $('btn-conflict-open-folder').addEventListener('click', async () => {
      const book = state.conflictBook;
      if (!book) return;
      try {
        await call(api.openBookFolder, book.path);
        toast('已在资源管理器打开书文件夹');
      } catch (err) {
        toast(`打开文件夹失败：${err.message}`, 'error');
      }
    });
    $('btn-back').addEventListener('click', backToShelf);
    $('btn-rename-book').addEventListener('click', renameBookFlow);
    $('btn-new-chapter').addEventListener('click', () => createChapterAt(state.chapters.length));
    $('btn-new-volume').addEventListener('click', () => createVolumeFlow());
    $('btn-insert').addEventListener('click', () => createChapterAt(state.index + 1));
    $('btn-save').addEventListener('click', () => saveCurrent());
    $('btn-find').addEventListener('click', openFindPanel);
    $('btn-find-run').addEventListener('click', runFind);
    $('btn-find-replace-one').addEventListener('click', runReplaceOne);
    $('btn-find-replace').addEventListener('click', runReplaceAll);
    $('btn-find-close').addEventListener('click', closeFindPanel);
    $('btn-restore-replace').addEventListener('click', () => restoreReplaceBackupFlow());
    $('find-query').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runFind();
      }
    });
    $('find-replace').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runReplaceAll();
      }
    });
    setupChapterDrag();
    $('btn-export').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleExportMenu();
    });

    $('export-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      hideExportMenu();
      if (btn.dataset.action === 'copy') await copyBookFlow();
      else if (btn.dataset.action === 'txt') openExportDialog();
      else if (btn.dataset.action === 'epub') await exportEpubFlow();
      else if (btn.dataset.action === 'folder') await openBookFolderFlow();
      else if (btn.dataset.action === 'history') await openHistoryForCurrentBook();
    });

    // 导出范围对话框
    document.querySelectorAll('input[name="export-scope"]').forEach((radio) => {
      radio.addEventListener('change', () => refreshExportSummary());
    });
    $('export-volume').addEventListener('change', () => refreshExportSummary());
    $('export-from').addEventListener('input', () => scheduleExportSummary(120));
    $('export-to').addEventListener('input', () => scheduleExportSummary(120));
    $('btn-export-cancel').addEventListener('click', closeExportDialog);
    $('btn-export-confirm').addEventListener('click', () => confirmExportDialog());

    // 跳章（Ctrl+G）
    $('jump-input').addEventListener('input', () => scheduleJumpMatches());
    $('jump-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirmJumpFromDialog();
      }
    });
    $('btn-jump-cancel').addEventListener('click', closeJumpDialog);
    $('btn-jump-confirm').addEventListener('click', () => confirmJumpFromDialog());

    // 排版：写作页「排版 ▾」
    $('btn-format').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFormatMenu();
    });
    $('format-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'apply') {
        openFormatDialog();
        return;
      }
      hideFormatMenu();
      if (action === 'undo') {
        if (!undoFormat()) toast('没有可撤销的整理', 'warn');
      } else if (action === 'apply-book') await runFormatBook();
      else if (action === 'preset-compact') await setDisplayPreset('compact');
      else if (action === 'preset-normal') await setDisplayPreset('normal');
      else if (action === 'preset-loose') await setDisplayPreset('loose');
      else if (action === 'display-settings') openSettings();
    });

    // 整理对话框：勾选/切换规则时实时刷新预览
    for (const id of ['fmt-indent', 'fmt-trailing', 'fmt-punct', 'fmt-quotes', 'fmt-ellipsis', 'fmt-cjkspace']) {
      $(id).addEventListener('change', () => scheduleFormatPreview());
    }
    $('fmt-blank').addEventListener('change', () => scheduleFormatPreview());
    $('btn-format-apply').addEventListener('click', applyFormatToEditor);
    $('btn-format-cancel').addEventListener('click', closeFormatDialog);
    $('btn-format-reset').addEventListener('click', () => {
      writeFormatOptions(null);
      scheduleFormatPreview(0);
    });

    // 设置里改显示项时实时预览，点「取消」恢复原样
    for (const id of displaySettingsIds) {
      $(id).addEventListener('change', previewSettings);
    }

    $('context-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const index = state.contextIndex;
      hideContextMenu();
      const action = btn.dataset.action;
      if (action === 'rename') await renameChapterAt(index);
      else if (action === 'delete') await deleteChapterAt(index);
      else if (action === 'insert-before') await createChapterAt(index);
      else if (action === 'insert-after') await createChapterAt(index + 1);
      else if (action === 'move-volume') await moveChapterToVolumeFlow(index);
      else if (action === 'edit-note') await editChapterNoteAt(index);
      else if (action === 'copy-platform') await copyChapterPlatformFlow(index);
      else if (action.startsWith('status-')) await setChapterStatusAt(index, action.slice('status-'.length));
    });

    $('volume-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const volumeId = state.contextVolumeId;
      hideVolumeMenu();
      const action = btn.dataset.action;
      if (action === 'new-chapter') await createChapterAt(state.chapters.length, undefined, volumeId || null);
      else if (action === 'rename') await renameVolumeFlow(volumeId);
      else if (action === 'delete') await deleteVolumeFlow(volumeId);
      else if (action === 'move-up') await moveVolumeFlow(volumeId, -1);
      else if (action === 'move-down') await moveVolumeFlow(volumeId, 1);
    });

    editorEl.addEventListener('input', onEditorInput);

    setupSidebarResizer();

    // 导入进度（大书库导入可能要几十秒，分章/复制逐项汇报）
    api.onImportProgress((progress) => {
      if (!importProgressEl) return;
      if (!progress || !progress.total) {
        setImportProgressText('正在分析要导入的内容…');
        return;
      }
      if (progress.done >= progress.total) {
        setImportProgressText(`正在收尾（共 ${progress.total} 项）…`);
        return;
      }
      setImportProgressText(
        `正在导入 ${Math.min(progress.done + 1, progress.total)}/${progress.total}：${progress.current || ''}`
      );
    });

    // 主进程拦截到关窗/退出时，由这里决定「保存并退出 / 不保存退出 / 取消」
    api.onCloseRequested(handleCloseRequest);

    // 整本排版进度（主进程逐章汇报，显示在右下角进度条上）
    api.onFormatProgress((progress) => {
      if (!state.formatBookRunning) return;
      if (!progress || !progress.total) return;
      showFormatBookProgress(
        `正在整理整本书：${Math.min(progress.done, progress.total)}/${progress.total} 章`
      );
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#context-menu') && !event.target.closest('.chapter-item')) hideContextMenu();
      if (!event.target.closest('#volume-menu') && !event.target.closest('.volume-item')) hideVolumeMenu();
      if (!event.target.closest('#btn-export') && !event.target.closest('#export-menu')) hideExportMenu();
      if (!event.target.closest('#btn-format') && !event.target.closest('#format-menu')) hideFormatMenu();
      if (!event.target.closest('#book-menu') && !event.target.closest('.book-card-more')) hideBookMenu();
    });

    document.addEventListener('keydown', (event) => {
      // 通用询问框最优先（它可能是在排版/设置弹层开着时弹出的关窗询问）
      if (state.modal) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeModal({ action: state.modal.opts.cancelValue });
        } else if (event.key === 'Enter' && state.modal.opts.input) {
          event.preventDefault();
          const okButton = $('modal-buttons').querySelector('button[data-value="ok"]');
          if (okButton) okButton.click();
        }
        return;
      }
      if (!$('conflict-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeConflictDialog();
        }
        return;
      }
      if (!$('history-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (state.history && state.history.preview) closeHistoryPreview();
          else closeHistoryDialog();
        }
        return;
      }
      if (!$('format-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeFormatDialog();
        }
        return;
      }
      if (!$('export-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeExportDialog();
        }
        return;
      }
      if (!$('settings-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSettings();
        }
        return;
      }
      if (!$('jump-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeJumpDialog();
        }
        return;
      }
      // 查找面板：Esc 关、回车查找；其他按键继续往下走（Ctrl+S 仍可保存）
      if (!$('find-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeFindPanel();
          return;
        }
        if (event.key === 'Enter' && document.activeElement === $('find-query')) {
          event.preventDefault();
          runFind();
          return;
        }
      }
      // 复制本章（平台格式）：Ctrl+Shift+C；不抢 Ctrl+C 的普通复制
      if (event.ctrlKey && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'c') {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          copyChapterPlatformFlow(state.index);
        }
        return;
      }
      const ctrl = event.ctrlKey && !event.altKey && !event.shiftKey;
      if (ctrl && String(event.key).toLowerCase() === 'g') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) openJumpDialog();
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'f') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) {
          openFindPanel();
        } else if (state.view === 'shelf') {
          $('shelf-search').focus();
          $('shelf-search').select();
        }
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'z') {
        // 「整理本章」留下的快照优先撤销；没有快照就让原生 Ctrl+Z 照常工作
        if (state.view === 'editor' && state.bookPath && undoFormat()) {
          event.preventDefault();
          return;
        }
      }
      if (ctrl && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) saveCurrent();
      } else if (ctrl && String(event.key).toLowerCase() === 'n') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) createChapterAt(state.chapters.length);
      } else if (event.key === 'Escape') {
        hideContextMenu();
        hideExportMenu();
        hideFormatMenu();
        hideBookMenu();
      }
    });

    window.addEventListener('resize', () => {
      hideContextMenu();
      hideExportMenu();
      hideFormatMenu();
      hideBookMenu();
      applySidebarWidth(state.sidebarWidth);
    });
  }

  // ---------- 测试钩子（仅 ?test=1 时暴露，正常使用不存在） ----------
  function createTestHooks() {
    return {
      ready: false,
      state,
      async newBook(title) {
        await createBookWithTitle(title);
      },
      async openBookPath(bookPath) {
        await openBookByPath(bookPath);
      },
      async newChapter(name) {
        await createChapterAt(state.chapters.length, name);
      },
      async insertAfter(index, name) {
        await createChapterAt(index + 1, name);
      },
      async renameChapterAt(index, name) {
        await renameChapterAt(index, name);
      },
      async deleteChapterAt(index, options) {
        await deleteChapterAt(index, options && options.skipConfirm);
      },
      async switchTo(index, dirtyAction) {
        return switchChapter(index, { dirtyAction });
      },
      setText(text) {
        editorEl.value = String(text == null ? '' : text);
        onEditorInput();
      },
      text: () => editorEl.value,
      async save() {
        return saveCurrent({ silent: true });
      },
      chapterTitles: () => state.chapters.map((c, i) => chapterTitle(i, c.name)),
      chapterNames: () => state.chapters.map((c) => c.name),
      chapterFiles: () => state.chapters.map((c) => c.file),
      // 章节状态 / 备注
      chapterStatuses: () => state.chapters.map((c) => chapterStatus(c)),
      chapterNotes: () => state.chapters.map((c) => chapterNote(c)),
      chapterStatusDots: () =>
        Array.from(document.querySelectorAll('#chapter-list .chapter-item')).map(
          (el) => el.dataset.status || ''
        ),
      chapterItemTitles: () =>
        Array.from(document.querySelectorAll('#chapter-list .chapter-item')).map((el) => el.title),
      chapterNoteMarks: () =>
        Array.from(document.querySelectorAll('#chapter-list .chapter-note-mark')).map((el) => el.title),
      bookCardMetaTexts: () =>
        Array.from(document.querySelectorAll('.book-card[data-path] .book-card-meta')).map(
          (el) => el.textContent
        ),
      async setChapterStatusAt(index, status) {
        return setChapterStatusAt(index, status);
      },
      async editChapterNoteAt(index) {
        return editChapterNoteAt(index);
      },
      async copyChapterPlatformAt(index) {
        return copyChapterPlatformFlow(index == null ? state.index : index);
      },
      // 导出范围对话框
      exportDialogOpen: () => !$('export-backdrop').classList.contains('hidden'),
      exportSummary: () => $('export-summary').textContent,
      exportConfirmDisabled: () => $('btn-export-confirm').disabled,
      readExportRange: () => readExportRange(),
      contextMenuItems: () =>
        Array.from(document.querySelectorAll('#context-menu button')).map((el) => el.textContent),
      // 分卷
      volumeNames: () => volumeList().map((v) => v.name),
      volumeIds: () => volumeList().map((v) => v.id),
      chapterVolumeIds: () => state.chapters.map((c) => chapterVolumeId(c)),
      volumeHeaders: () =>
        Array.from(document.querySelectorAll('.volume-item .volume-name')).map((el) => el.textContent),
      collapsedVolumes: () => Array.from(state.collapsedVolumes),
      collapseVolume: (volumeId) => {
        toggleVolumeCollapse(volumeId);
        return true;
      },
      async newVolume(name) {
        return createVolumeFlow(name);
      },
      async renameVolumeAt(index, name) {
        const volume = volumeList()[index];
        if (!volume) return { ok: false };
        return renameVolumeFlow(volume.id, name);
      },
      async deleteVolumeAt(index, skipConfirm) {
        const volume = volumeList()[index];
        if (!volume) return { ok: false };
        return deleteVolumeFlow(volume.id, skipConfirm);
      },
      async moveChapterToVolumeAt(chapterIndex, volumeIndex) {
        const volume = volumeIndex === null ? null : volumeList()[volumeIndex];
        if (volumeIndex !== null && !volume) return { ok: false };
        return moveChapterToVolume(chapterIndex, volume ? volume.id : null);
      },
      async newChapterInVolume(volumeIndex, name) {
        const volume = volumeIndex === null ? null : volumeList()[volumeIndex];
        if (volumeIndex !== null && !volume) return { ok: false };
        return createChapterAt(state.chapters.length, name, volume ? volume.id : null);
      },
      async moveVolumeAt(index, toIndex) {
        const volume = volumeList()[index];
        if (!volume) return { ok: false };
        return moveVolumeFlow(volume.id, toIndex - index);
      },
      // 模拟拖拽落点（走和真实拖拽同一条代码路径）
      async dragChapterTo(chapterIndex, volumeIndex, beforeChapterIndex) {
        const chapter = state.chapters[chapterIndex];
        if (!chapter) return { ok: false };
        const volume = volumeIndex === null ? null : volumeList()[volumeIndex];
        if (volumeIndex !== null && !volume) return { ok: false };
        const before = beforeChapterIndex === null || beforeChapterIndex === undefined ? null : state.chapters[beforeChapterIndex];
        return moveChapterByDrop(chapter, {
          volumeId: volume ? volume.id : null,
          beforeChapterId: before ? before.id : null
        });
      },
      async chapterTextAt(index) {
        const chapter = state.chapters[index];
        if (!chapter) return null;
        const res = await api.loadChapter(state.bookPath, chapter.file);
        return res && res.ok ? res.data.text : null;
      },
      currentIndex: () => state.index,
      currentChapterId: () => (state.chapters[state.index] ? state.chapters[state.index].id : null),
      bookPathValue: () => state.bookPath,
      currentTitle: () => $('chapter-title').textContent || '',
      dirty: () => state.dirty,
      title: () => document.title,
      versionText: () => ($('app-version') ? $('app-version').textContent : ''),
      statusText: () => $('status-text').textContent,
      view: () => state.view,
      modalOpen: () => Boolean(state.modal),
      dialog: () => (state.modal ? state.modal.opts.title : null),
      modalMessage: () => $('modal-message').textContent,
      modalButtons: () => (state.modal ? state.modal.opts.buttons.map((b) => b.value) : []),
      answerModal: (value) => answerModalValue(value),
      async importPaths(paths, mode) {
        return importBooksFlow(paths, mode || 'chapters');
      },
      async deleteBookByFolder(folder, options) {
        const book = (state.books || []).find((b) => b.folder === folder || b.title === folder);
        if (!book) throw new Error(`书架上找不到：${folder}`);
        await deleteBookFlow(book, { skipConfirm: Boolean(options && options.skipConfirm) });
      },
      async backToShelf() {
        await backToShelf();
      },
      // 继续上次写作 / Ctrl+G 跳章
      recentBook: () => ({ ...(state.recentBook || {}) }),
      continueVisible: () => !$('shelf-continue').classList.contains('hidden'),
      continueText: () => ($('continue-title') ? $('continue-title').textContent : ''),
      continueMeta: () => ($('continue-meta') ? $('continue-meta').textContent : ''),
      async clickContinue() {
        return openContinueBook();
      },
      openJumpDialog: () => openJumpDialog(),
      closeJumpDialog: () => closeJumpDialog(),
      jumpDialogOpen: () => !$('jump-backdrop').classList.contains('hidden'),
      jumpQuery: () => $('jump-input').value,
      async setJumpQuery(query) {
        $('jump-input').value = String(query == null ? '' : query);
        state.jumpQuery = $('jump-input').value;
        return refreshJumpMatches();
      },
      jumpSummary: () => $('jump-summary').textContent,
      jumpResultTexts: () =>
        Array.from(document.querySelectorAll('#jump-results .jump-result')).map((el) => el.textContent),
      jumpMatches: () => state.jumpMatches.map((match) => ({ ...match })),
      jumpConfirmDisabled: () => $('btn-jump-confirm').disabled,
      async runJump() {
        return confirmJumpFromDialog();
      },
      async clickJumpResult(index) {
        const rows = document.querySelectorAll('#jump-results .jump-result');
        if (!rows[index]) return false;
        rows[index].click();
        return true;
      },
      async refreshRecentBook() {
        state.recentBook = await call(api.getRecentBook);
        renderContinueWriting();
        return state.recentBook;
      },
      async refreshShelf() {
        await refreshShelf();
      },
      // 同步冲突副本提示
      shelfConflictBadgeText(folder) {
        const card = Array.from(document.querySelectorAll('.book-card[data-folder]')).find(
          (el) => el.dataset.folder === folder
        );
        const badge = card ? card.querySelector('.book-conflict-badge') : null;
        return badge ? badge.textContent : '';
      },
      conflictCardHasClass(folder, className) {
        const card = Array.from(document.querySelectorAll('.book-card[data-folder]')).find(
          (el) => el.dataset.folder === folder
        );
        return Boolean(card && card.classList.contains(className));
      },
      openConflictDialogFor(folder) {
        const book = (state.books || []).find((item) => item.folder === folder || item.title === folder);
        if (!book) return false;
        openConflictDialog(book);
        return true;
      },
      closeConflictDialog: () => closeConflictDialog(),
      conflictDialogOpen: () => !$('conflict-backdrop').classList.contains('hidden'),
      conflictBookText: () => $('conflict-book').textContent,
      conflictSummary: () => $('conflict-summary').textContent,
      conflictFileTexts: () =>
        Array.from(document.querySelectorAll('#conflict-files .conflict-file')).map((el) => el.textContent),
      firstConflictBookFolder: () => {
        const book = (state.books || []).find(
          (item) => Array.isArray(item.conflicts) && item.conflicts.length
        );
        return book ? book.folder : '';
      },
      shelfTitles: () => state.books.map((b) => b.title),
      shelfQuery: () => state.shelfQuery,
      shelfSearchSummary: () => $('shelf-search-summary').textContent,
      shelfFilteredTitles: () =>
        Array.from(document.querySelectorAll('.book-card[data-path] .book-card-title')).map(
          (el) => el.textContent
        ),
      shelfCardMatches: () =>
        Array.from(document.querySelectorAll('.book-card-match')).map((el) => el.textContent),
      setShelfQuery(q) {
        state.shelfQuery = String(q == null ? '' : q);
        const input = $('shelf-search');
        if (input) input.value = state.shelfQuery;
        renderShelf();
      },
      sidebarWidth: () => state.sidebarWidth,
      setSidebarWidth: (width) => applySidebarWidth(width),
      persistSidebarWidth: (width) => {
        applySidebarWidth(width);
        return persistSidebarWidth(state.sidebarWidth);
      },
      bookId: () => state.bookId,
      bookDisplay: () => ({ ...(state.bookDisplay || {}) }),
      globalConfig: () => ({ ...(state.globalConfig || {}) }),
      settingsScope: () => state.settingsScope,
      resetBookDisplay: () => resetBookDisplay(),
      caret: () => editorEl.selectionStart,
      setCaret(pos) {
        editorEl.focus();
        const at = Math.max(0, Number(pos) || 0);
        editorEl.setSelectionRange(at, at);
      },
      // 排版
      openFormatMenu: () => toggleFormatMenu(),
      formatMenuOpen: () => !$('format-menu').classList.contains('hidden'),
      openFormatDialog: () => openFormatDialog(),
      formatDialogOpen: () => !$('format-backdrop').classList.contains('hidden'),
      formatSummary: () => $('fmt-summary').textContent,
      formatPreview: () => $('fmt-preview').textContent,
      readFormatOptions: () => readFormatOptions(),
      writeFormatOptions: (options) => writeFormatOptions(options),
      async applyFormat() {
        return applyFormatToEditor();
      },
      async runFormatBook() {
        return runFormatBook();
      },
      formatBookProgressText: () => (formatBookProgressEl ? formatBookProgressEl.textContent : ''),
      async setFormatOptions(options) {
        state.globalConfig = await call(api.setConfig, { formatOptions: options || {} });
        state.config = effectiveConfig();
        return true;
      },
      canUndoFormat: () => canUndoFormat(),
      undoFormat: () => undoFormat(),
      formatUndoDepth: () => state.formatUndo.length,
      formatUndoSteps: () => formatUndoSteps(),
      formatUndoItemText: () => $('format-undo-item').textContent,
      applyDisplayPreset: (name) => setDisplayPreset(name),
      // 查找替换 / 拖拽排序
      openFindPanel: () => openFindPanel(),
      closeFindPanel: () => closeFindPanel(),
      findPanelOpen: () => !$('find-backdrop').classList.contains('hidden'),
      setFindFields(fields) {
        const f = fields || {};
        if (typeof f.query === 'string') $('find-query').value = f.query;
        if (typeof f.replacement === 'string') $('find-replace').value = f.replacement;
        if (typeof f.scope === 'string') $('find-scope').value = f.scope;
        if (typeof f.caseSensitive === 'boolean') $('find-case').checked = f.caseSensitive;
      },
      async findRun() {
        return runFind();
      },
      async findReplaceAll() {
        return runReplaceAll();
      },
      async findReplaceOne() {
        return runReplaceOne();
      },
      selection: () => ({ start: editorEl.selectionStart || 0, end: editorEl.selectionEnd || 0 }),
      async refreshReplaceBackups() {
        return refreshReplaceBackups();
      },
      replaceBackups: () => state.replaceBackups.map((item) => ({ ...item })),
      async restoreReplaceBackupFlow(backupName) {
        return restoreReplaceBackupFlow(backupName);
      },
      // 本书历史
      async openHistoryForCurrentBook() {
        return openHistoryForCurrentBook();
      },
      async openHistoryForPath(bookPath, title) {
        return openHistoryForPath(bookPath, title);
      },
      async openHistoryForFirstBook() {
        const book = (state.books || [])[0];
        return book ? openHistoryForPath(book.path, book.title) : false;
      },
      historyOpen: () => !$('history-backdrop').classList.contains('hidden'),
      historyTitle: () => $('history-title').textContent,
      historySummary: () => $('history-summary').textContent,
      historyGroupCount: () => (state.history ? state.history.groups.length : 0),
      historyGroups: () =>
        (state.history ? state.history.groups : []).map((group) => ({
          id: group.id,
          source: group.source,
          sourceLabel: group.sourceLabel,
          timeText: group.timeText,
          fileCount: group.fileCount,
          restorableCount: group.restorableCount,
          files: group.files.map((file) => ({
            name: file.name,
            inBook: file.inBook,
            restorable: file.restorable,
            previewable: file.previewable,
            reason: file.reason
          }))
        })),
      historyGroupIndexBySource: (source) =>
        state.history ? state.history.groups.findIndex((group) => group.source === source) : -1,
      historyGroupTexts: () =>
        Array.from(document.querySelectorAll('#history-list .history-group')).map((el) => el.textContent),
      historyFileTexts: () =>
        Array.from(document.querySelectorAll('#history-list .history-file')).map((el) => el.textContent),
      async previewHistoryAt(groupIndex, fileIndex) {
        const group = state.history && state.history.groups[groupIndex];
        const file = group && group.files[fileIndex];
        if (!file) return null;
        return previewHistoryBackup(group.id, file.name);
      },
      historyPreviewVisible: () => !$('history-preview').classList.contains('hidden'),
      historyPreviewTitle: () => $('history-preview-title').textContent,
      historyPreviewText: () => $('history-preview-text').textContent,
      closeHistoryPreview: () => closeHistoryPreview(),
      async restoreHistoryFileAt(groupIndex, fileIndex) {
        const group = state.history && state.history.groups[groupIndex];
        const file = group && group.files[fileIndex];
        if (!file) return { ok: false, message: '没有这个备份文件' };
        return confirmHistoryRestore(group, file, false);
      },
      async restoreHistoryGroupAt(groupIndex) {
        const group = state.history && state.history.groups[groupIndex];
        if (!group) return { ok: false, message: '没有这个备份组' };
        return confirmHistoryRestore(group, null, true);
      },
      clickHistoryFileButton(groupIndex, fileIndex, label) {
        const cards = document.querySelectorAll('#history-list .history-group');
        const card = cards[groupIndex];
        if (!card) return false;
        const rows = card.querySelectorAll('.history-file');
        const row = rows[fileIndex];
        if (!row) return false;
        const button = Array.from(row.querySelectorAll('.history-file-actions button')).find((el) =>
          el.textContent.includes(label)
        );
        if (!button) return false;
        button.click();
        return true;
      },
      clickHistoryGroupRestore(groupIndex) {
        const cards = document.querySelectorAll('#history-list .history-group');
        const card = cards[groupIndex];
        const button = card ? card.querySelector('.history-restore-group') : null;
        if (!button) return false;
        button.click();
        return true;
      },
      async refreshHistory() {
        return refreshHistory();
      },
      closeHistory: () => closeHistoryDialog(),
      bookMenuTexts: () => Array.from(document.querySelectorAll('#book-menu button')).map((el) => el.textContent),
      exportMenuTexts: () =>
        Array.from(document.querySelectorAll('#export-menu button')).map((el) => el.textContent),
      findSummary: () => $('find-summary').textContent,
      findResultCount: () => $('find-results').querySelectorAll('.find-result').length,
      clickFindResult(index) {
        const rows = $('find-results').querySelectorAll('.find-result');
        if (rows[index]) rows[index].click();
      },
      async moveChapterByDrag(from, to) {
        return moveChapterByDrag(from, to);
      },
      loadCustomFont: (fontPath) => loadCustomFont(fontPath, { silent: true }),
      customFontLoaded: () => ({ ...loadedCustomFont }),
      // 测试用：等价于「设置里选好字体文件 + 保存设置」的落库路径
      async setCustomFont(fontPath, name) {
        const ok = await loadCustomFont(fontPath, { silent: true });
        if (!ok) return false;
        const patch = {
          editorFont: 'custom',
          editorCustomFontPath: fontPath,
          editorCustomFontName: name || ''
        };
        if (state.bookId) {
          state.bookDisplay = (await call(api.setBookDisplay, state.bookId, patch)) || {};
          state.config = effectiveConfig();
        } else {
          state.globalConfig = await call(api.setConfig, patch);
          state.config = effectiveConfig();
        }
        applyEditorStyle();
        return true;
      },
      displayStyle: () => {
        const styles = getComputedStyle(editorEl);
        return {
          lineHeight: styles.lineHeight,
          letterSpacing: styles.letterSpacing,
          maxWidth: styles.maxWidth,
          fontSize: styles.fontSize,
          fontFamily: styles.fontFamily,
          paddingLeft: styles.paddingLeft,
          paddingRight: styles.paddingRight,
          backgroundImage: styles.backgroundImage,
          backgroundColor: styles.backgroundColor,
          paperClass: document.body.className,
          paperBg: getComputedStyle(document.body).backgroundColor
        };
      },
      openSettings: () => openSettings(),
      settingsOpen: () => !$('settings-backdrop').classList.contains('hidden'),
      closeSettings: () => closeSettings(),
      async saveSettings() {
        return saveSettings();
      },
      setCheck(id, checked) {
        const el = $(id);
        el.checked = Boolean(checked);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      snapshotSettings: () => ({
        enabled: $('settings-snapshot-enabled').checked === true,
        keepDays: Number($('settings-snapshot-days').value)
      }),
      // 每日字数统计 / 目标（v0.6-3）
      async refreshStats() {
        return refreshStats();
      },
      statsSummary: () => (state.stats ? JSON.parse(JSON.stringify(state.stats)) : null),
      shelfStatsVisible: () => !$('shelf-stats').classList.contains('hidden'),
      shelfStatsText: () => $('shelf-stats').textContent.replace(/\s+/g, ' ').trim(),
      shelfGoalWidth: () => $('shelf-goal-fill').style.width,
      statusStatsVisible: () => !$('status-stats').classList.contains('hidden'),
      statusStatsText: () => $('status-stats-text').textContent,
      statusGoalWidth: () => $('status-goal-fill').style.width,
      dailyGoalSettings: () => Number($('settings-daily-goal').value),
      statsSettingsVisible: () => !$('settings-daily-goal-field').classList.contains('hidden'),
      statsChartBarCount: () => document.querySelectorAll('#settings-stats-chart .stats-bar').length,
      statsChartBarHeights: () =>
        Array.from(document.querySelectorAll('#settings-stats-chart .stats-bar > i')).map((el) => el.style.height),
      statsChartSummary: () => $('settings-stats-summary').textContent,
      setInput(id, value) {
        const el = $(id);
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      },
      setSelect(id, value) {
        const el = $(id);
        el.value = String(value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      async handleCloseRequest() {
        await handleCloseRequest();
      }
    };
  }

  // ---------- 初始化 ----------
  async function init() {
    bindEvents();
    try {
      state.globalConfig = await call(api.getConfig);
      state.config = { ...state.globalConfig };
    } catch (err) {
      toast(`读取配置失败：${err.message}`, 'error');
    }
    // 版本号以 package.json 为准（发版只改一处，界面跟着变）
    try {
      const appInfo = await call(api.appVersion);
      const versionEl = $('app-version');
      if (versionEl && appInfo && appInfo.version) versionEl.textContent = `v${appInfo.version}`;
    } catch {
      /* 拿不到就保留 index.html 里的静态版本号 */
    }
    // 启动时取一次主进程攒下的提示（例如配置文件损坏已归档）
    try {
      const warning = await call(api.appWarning);
      if (warning && warning.message) toast(warning.message, 'warn');
    } catch {
      /* 拿不到提示不影响启动 */
    }
    applyEditorStyle();
    applySidebarWidth((state.config && state.config.editorSidebarWidth) || 250);
    // 上次用的自定义字体：启动时异步加载（失败就退回内置字体，不影响写作）
    if (state.config && state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
      loadCustomFont(state.config.editorCustomFontPath, { silent: true }).then(() => applyEditorStyle());
    }
    showView('shelf');
    await refreshShelf();
    if (state.testMode) {
      window.__cwTest = createTestHooks();
      window.__cwTest.ready = true;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
