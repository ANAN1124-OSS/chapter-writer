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
    /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷集篇部]|楔子|序章|序言|引子|前言|尾声|后记|番外|终章|大结局|开篇|Chapter\s+\d+)/i;

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

  function applyEditorStyle() {
    const fonts = {
      serif: '"SimSun", "Songti SC", "Source Han Serif SC", serif',
      sans: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      kai: '"KaiTi", "STKaiti", "Kaiti SC", serif'
    };
    const cfg = state.config || {};
    document.documentElement.style.setProperty(
      '--editor-font-family',
      fonts[cfg.editorFont] || fonts.serif
    );
    document.documentElement.style.setProperty('--editor-font-size', `${cfg.editorFontSize || 18}px`);
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
      item.addEventListener('click', () => switchChapter(index));
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

  // ---------- 设置 ----------
  function openSettings() {
    const cfg = state.config || {};
    $('settings-root').value = cfg.booksRoot || '';
    $('settings-font').value = cfg.editorFont || 'serif';
    $('settings-size').value = String(cfg.editorFontSize || 18);
    $('settings-backdrop').classList.remove('hidden');
  }

  function closeSettings() {
    $('settings-backdrop').classList.add('hidden');
  }

  async function saveSettings() {
    try {
      const cfg = await call(api.setConfig, {
        booksRoot: $('settings-root').value.trim(),
        editorFont: $('settings-font').value,
        editorFontSize: Number($('settings-size').value)
      });
      state.config = cfg;
      applyEditorStyle();
      closeSettings();
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
      if (!event.target.closest('#book-menu') && !event.target.closest('.book-card-more')) hideBookMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (!$('settings-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSettings();
        }
        return;
      }
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
      const ctrl = event.ctrlKey && !event.altKey && !event.shiftKey;
      if (ctrl && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) saveCurrent();
      } else if (ctrl && String(event.key).toLowerCase() === 'n') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) createChapterAt(state.chapters.length);
      } else if (event.key === 'Escape') {
        hideContextMenu();
        hideExportMenu();
        hideBookMenu();
      }
    });

    window.addEventListener('resize', () => {
      hideContextMenu();
      hideExportMenu();
      hideBookMenu();
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
    showView('shelf');
    await refreshShelf();
    if (state.testMode) {
      window.__cwTest = createTestHooks();
      window.__cwTest.ready = true;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
