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
    config: null,
    books: [],
    view: 'shelf',
    bookPath: null,
    meta: null,
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
    importing: false,
    sidebarWidth: 250,
    sidebarDragging: false,
    formatUndo: [], // 「整理本章」的快照栈（只存在内存里，关掉应用就没了）
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
      try {
        state.config = await call(api.setConfig, { editorSidebarWidth: state.sidebarWidth });
      } catch { /* 记不住宽度不影响使用 */ }
    });

    // 双击恢复默认宽度
    resizer.addEventListener('dblclick', async () => {
      applySidebarWidth(250);
      try {
        state.config = await call(api.setConfig, { editorSidebarWidth: 250 });
      } catch { /* 忽略 */ }
    });
  }

  // ---------- 书架 ----------
  async function refreshShelf() {
    try {
      state.books = await call(api.listBooks);
    } catch (err) {
      state.books = [];
      toast(`读取书架失败：${err.message}`, 'error');
    }
    renderShelf();
  }

  function renderShelf() {
    $('books-root-label').textContent = state.config ? `书架：${state.config.booksRoot}` : '';
    $('books-root-label').title = state.config ? state.config.booksRoot : '';
    const grid = $('book-grid');
    grid.innerHTML = '';

    if (!state.books.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      empty.textContent = '这里还没有书。点右边（或下面）的「新建一本书」开始，或者把已有的书文件夹放进书架目录。';
      grid.appendChild(empty);
    }

    for (const book of state.books) {
      const card = document.createElement('div');
      card.className = 'book-card' + (book.status === 'corrupt' ? ' corrupt' : '');
      card.dataset.path = book.path;

      const title = document.createElement('div');
      title.className = 'book-card-title';
      title.textContent = book.status === 'corrupt' ? `⚠ ${book.title}` : book.title;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'book-card-meta';
      meta.textContent =
        book.status === 'corrupt'
          ? `书目损坏：${book.reason || '无法读取'}`
          : `${book.chapterCount} 章 · ${formatChars(book.totalChars)}`;
      card.appendChild(meta);

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
    state.chapters = data.meta.chapters;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    $('book-title').textContent = data.meta.title;
    $('book-title').title = data.meta.title;
    showView('editor');
    renderChapterList();

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
        toast(`已重建书目：${data.count} 章`);
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
      startY: event.clientY,
      active: false,
      targetIndex: index,
      item: event.currentTarget
    };
  }

  function clearDragMarks() {
    const list = $('chapter-list');
    if (!list) return;
    list.querySelectorAll('.chapter-item.dragging, .chapter-item.drop-before, .chapter-item.drop-after')
      .forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
    document.body.classList.remove('chapter-dragging');
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
    const items = Array.from(list.querySelectorAll('.chapter-item'));
    items.forEach((el) => el.classList.remove('drop-before', 'drop-after'));

    // 计算插入槽位：指针落在哪个条目上半部分 = 插到它前面
    let slot = items.length;
    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        slot = i;
        break;
      }
    }
    const targetIndex = slot > chapterDrag.index ? slot - 1 : slot;
    chapterDrag.targetIndex = targetIndex;
    if (targetIndex < chapterDrag.index) items[targetIndex].classList.add('drop-before');
    else if (targetIndex > chapterDrag.index) items[targetIndex].classList.add('drop-after');

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
    if (drag.targetIndex === drag.index) return;
    await moveChapterByDrag(drag.index, drag.targetIndex);
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
  function renderChapterList() {
    const list = $('chapter-list');
    list.innerHTML = '';
    state.chapters.forEach((chapter, index) => {
      const item = document.createElement('div');
      item.className = 'chapter-item' + (index === state.index ? ' active' : '');
      if (index === state.index && state.dirty) item.classList.add('dirty');
      item.dataset.index = String(index);
      item.title = '单击切换；双击重命名；右键更多';

      const num = document.createElement('span');
      num.className = 'chapter-num';
      num.textContent = `第${index + 1}章`;

      const name = document.createElement('span');
      name.className = 'chapter-name';
      name.textContent = String(chapter.name || '').trim() || '未命名';

      item.appendChild(num);
      item.appendChild(name);
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
      list.appendChild(item);
    });
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
    $('char-count').textContent =
      state.bookPath && state.index >= 0 ? `本章 ${formatChars(countChars(editorEl.value))}` : '';
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
    if (!state.bookPath || state.index < 0 || state.saving) {
      return { ok: false, code: 'BUSY', message: '当前没有可保存的章节' };
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
      updateStatus();
      // 「保存整本」语义：保存后顺带校验全书章节文件是否齐全
      try {
        const report = await call(api.verifyBook, state.bookPath);
        if (report.missing && report.missing.length) {
          toast(`已保存当前章，但全书有 ${report.missing.length} 个章节文件缺失`, 'warn');
        }
        if (!silent) toast(`已保存：${report.chapterCount} 章 · 本章 ${formatChars(data.chars)}`);
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

  async function createChapterAt(insertIndex, nameOverride) {
    if (!state.bookPath) return { ok: false };
    if (state.dirty) {
      const action = await askUnsaved({
        title: '新建章节前保存',
        message: `「${currentChapterLabel()}」有未保存的修改。`
      });
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      }
    }
    const appending = insertIndex >= state.chapters.length;
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: appending ? '新建章节' : '插入章节',
        message: '输入章节名，可留空（显示为「未命名」）。章号由顺序自动生成，不用自己写。',
        placeholder: '例如：夜雨'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createChapter, state.bookPath, insertIndex, name);
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      await loadChapterAt(data.index);
      toast(`${appending ? '已新建' : '已插入'}：${chapterTitle(data.index, data.chapter.name)}`);
      return { ok: true, index: data.index };
    } catch (err) {
      toast(`新建章节失败：${err.message}`, 'error');
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

  // ---------- 导出 / 复制 ----------
  async function ensureSavedForOutput() {
    if (!state.dirty) return true;
    const action = await askUnsaved({
      title: '先保存再导出',
      message: '当前章节有未保存的修改。导出/复制读的是磁盘上的内容，建议先保存。',
      saveLabel: '保存并导出',
      discardLabel: '用磁盘上的旧内容导出'
    });
    if (action === 'cancel') return false;
    if (action === 'save') {
      const saved = await saveCurrent();
      if (!saved.ok) return false;
    }
    return true;
  }

  async function copyBookFlow() {
    if (!state.bookPath) return;
    if (!(await ensureSavedForOutput())) return;
    try {
      const data = await call(api.copyBook, state.bookPath);
      toast(`已复制整本：${data.chapterCount} 章`);
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
    }
  }

  async function exportBookFlow() {
    if (!state.bookPath) return;
    if (!(await ensureSavedForOutput())) return;
    try {
      const data = await call(api.exportBook, state.bookPath);
      if (data.canceled) return;
      toast(`已导出：${data.filePath}`);
    } catch (err) {
      toast(`导出失败：${err.message}`, 'error');
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
    state.chapters = [];
    state.index = -1;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    editorEl.value = '';
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
    // 关窗前先把排版/设置弹层收掉：否则「保存 / 不保存 / 取消」的询问会被它们压住
    hideFormatMenu();
    closeFormatDialog();
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
    removeCjkSpaces: false
  };

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
      removeCjkSpaces: $('fmt-cjkspace').checked
    };
  }

  function writeFormatOptions(options) {
    const opts = { ...DEFAULT_FORMAT_OPTIONS, ...(options && typeof options === 'object' ? options : {}) };
    // 兼容旧配置里的布尔缩进
    const indent = opts.indent === true ? '2' : opts.indent === false ? 'none' : String(opts.indent);
    $('fmt-indent').value = ['none', '0', '2'].includes(indent) ? indent : '2';
    $('fmt-trailing').checked = opts.trimTrailing !== false;
    $('fmt-punct').checked = opts.normalizePunct !== false;
    $('fmt-cjkspace').checked = Boolean(opts.removeCjkSpaces);
    $('fmt-blank').value = ['keep', 'single', 'singleIndent', 'none'].includes(opts.blankLines)
      ? opts.blankLines
      : 'single';
  }

  function toggleFormatMenu() {
    const menu = $('format-menu');
    const willShow = menu.classList.contains('hidden');
    hideExportMenu();
    if (willShow) $('format-undo-item').disabled = !canUndoFormat();
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
    while (state.formatUndo.length > 10) state.formatUndo.shift();
  }

  function canUndoFormat() {
    const top = state.formatUndo[state.formatUndo.length - 1];
    const chapter = state.chapters[state.index];
    return Boolean(
      top &&
        chapter &&
        top.bookPath === state.bookPath &&
        top.chapterId === chapter.id &&
        editorEl.value === top.after
    );
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

  async function setDisplayPreset(name) {
    const preset = DISPLAY_PRESETS[name];
    if (!preset) return;
    try {
      state.config = await call(api.setConfig, preset.patch);
      applyEditorStyle();
      toast(`正文显示已切换为「${preset.label}」（正文没动）`);
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

  function previewSettings() {
    if (!state.settingsBackup) return;
    applyEditorStyle({ ...state.settingsBackup, ...readDisplayForm() });
  }

  function openSettings() {
    const cfg = state.config || {};
    state.settingsBackup = state.config ? { ...state.config } : null;
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

  async function saveSettings() {
    try {
      const cfg = await call(api.setConfig, {
        booksRoot: $('settings-root').value.trim(),
        ...readDisplayForm()
      });
      state.config = cfg;
      applyEditorStyle();
      closeSettings({ restore: false });
      toast('设置已保存');
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
      }
    });

    $('btn-back').addEventListener('click', backToShelf);
    $('btn-rename-book').addEventListener('click', renameBookFlow);
    $('btn-new-chapter').addEventListener('click', () => createChapterAt(state.chapters.length));
    $('btn-insert').addEventListener('click', () => createChapterAt(state.index + 1));
    $('btn-save').addEventListener('click', () => saveCurrent());
    $('btn-find').addEventListener('click', openFindPanel);
    $('btn-find-run').addEventListener('click', runFind);
    $('btn-find-replace').addEventListener('click', runReplaceAll);
    $('btn-find-close').addEventListener('click', closeFindPanel);
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
      else if (btn.dataset.action === 'txt') await exportBookFlow();
      else if (btn.dataset.action === 'folder') await openBookFolderFlow();
    });

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
      } else if (action === 'preset-compact') await setDisplayPreset('compact');
      else if (action === 'preset-normal') await setDisplayPreset('normal');
      else if (action === 'preset-loose') await setDisplayPreset('loose');
      else if (action === 'display-settings') openSettings();
    });

    // 整理对话框：勾选/切换规则时实时刷新预览
    for (const id of ['fmt-indent', 'fmt-trailing', 'fmt-punct', 'fmt-cjkspace']) {
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

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#context-menu') && !event.target.closest('.chapter-item')) hideContextMenu();
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
      if (!$('format-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeFormatDialog();
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
      const ctrl = event.ctrlKey && !event.altKey && !event.shiftKey;
      if (ctrl && String(event.key).toLowerCase() === 'f') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) openFindPanel();
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
      async chapterTextAt(index) {
        const chapter = state.chapters[index];
        if (!chapter) return null;
        const res = await api.loadChapter(state.bookPath, chapter.file);
        return res && res.ok ? res.data.text : null;
      },
      currentIndex: () => state.index,
      currentTitle: () => $('chapter-title').textContent || '',
      dirty: () => state.dirty,
      title: () => document.title,
      statusText: () => $('status-text').textContent,
      view: () => state.view,
      modalOpen: () => Boolean(state.modal),
      dialog: () => (state.modal ? state.modal.opts.title : null),
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
      shelfTitles: () => state.books.map((b) => b.title),
      sidebarWidth: () => state.sidebarWidth,
      setSidebarWidth: (width) => applySidebarWidth(width),
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
      canUndoFormat: () => canUndoFormat(),
      undoFormat: () => undoFormat(),
      formatUndoDepth: () => state.formatUndo.length,
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
        state.config = await call(api.setConfig, {
          editorFont: 'custom',
          editorCustomFontPath: fontPath,
          editorCustomFontName: name || ''
        });
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
      state.config = await call(api.getConfig);
    } catch (err) {
      toast(`读取配置失败：${err.message}`, 'error');
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
