/* 章节写作器 v0.1 —— 渲染层
 * 规则：这里的任何东西都不能直接访问文件系统；所有读写都通过 window.api（白名单 IPC）。
 * 保存策略：完全手动。只有按 Ctrl+S / 点保存才写正文；切章、关窗、导出前只提醒，不偷偷写。
 */
(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const editorEl = $('editor');
  // 编辑器小件的纯逻辑（选中字数 / 段落导航 / 超长段落 / 不可见字符 / 章节字数对比），
  // 在 editor-logic.js 里、Node 单测覆盖；这里只负责显示和事件。
  const editorLogic = window.CWEditorLogic;
  const LONG_PARAGRAPH_THRESHOLD = editorLogic.LONG_PARAGRAPH_DEFAULT;
  // 专注模式的纯逻辑（打字机滚动的换算），在 focus-logic.js 里、Node 单测覆盖
  const focusLogic = window.CWFocusLogic;
  // 书籍信息（作者 / 简介 / 分组 / 标签）的清洗与匹配，core/bookinfo.js 里、Node 单测覆盖
  const bookInfoLib = window.CWBookInfo;
  // 书架正文搜索：输入停顿多久后才查（避免每敲一个字都查一次）；正文最少 2 个字
  const CONTENT_SEARCH_DEBOUNCE = 320;
  const CONTENT_SEARCH_MIN_CHARS = 2;
  const CONTENT_PAGE_SIZE = 8;
  const CONTENT_RESULT_LIMIT = 40;
  // 写作计时（v0.8-2）：每 30 秒把整秒上报一次；不足 1 秒的零头留在内存里下次一起算。
  const WRITE_TIMER_FLUSH_MS = 30000;

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

  // 写作时长显示（纯格式换算在 editor-logic.js，Node 单测覆盖；这里只做转发）
  function formatDuration(n) {
    return editorLogic.formatDuration(n);
  }

  function formatStopwatch(n) {
    return editorLogic.formatStopwatch(n);
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
    bookInfoBook: null, // 正在编辑「书籍信息」的那本书
    history: null, // 正在看的「本书历史」：{ path, title, groups, preview, loading, error, token }
    shelfQuery: '', // 书架搜索词（书名 / 作者 / 分组 / 标签 / 章节名 / 正文）
    shelfGroup: '', // 书架分组筛选：'' = 全部分组；'__none__' = 未分组；其它 = 分组名（只记内存）
    // 书架「正文命中」结果（提案 7.3）：搜索走主进程索引，这里只存展示用的结果
    shelfContent: {
      query: '', // 这批结果对应的查询词
      token: 0, // 丢弃过期结果（快速改词时）
      loading: false, // 正在查正文
      timer: null, // 输入防抖
      results: [], // [{ bookPath, bookTitle, chapterIndex, chapterName, matchIndex, snippet }]
      meta: null, // 主进程回报的统计：candidateBooks / scannedBooks / truncated / 索引状态
      error: null, // 搜索失败的原因（只影响正文结果，不影响书名过滤）
      shown: CONTENT_PAGE_SIZE, // 已经展示几条（「显示更多」每次 +8）
      indexStatus: null // 索引状态 / 建索引进度（只用于提示，不落盘）
    },
    stats: null, // 每日字数摘要：{ day, todayChars, goal, goalPercent, goalMet, recentTotal, days[], streak }
    calendar: null, // 设置里显示的码字日历月视图（只读；翻月时由 stats:calendar 换）
    streak: null, // 连续写作天数：{ current, best, todayWritten, lastWritten, writtenDays }
    // 写作时长（v0.8-2，提案 N2）：默认关，只有设置里开启后才出现计时按钮。
    // 只按实际经过的时间累计秒数，不读正文、不记按键；秒数按天存进 userData/stats.json。
    writeTimer: {
      running: false, // 现在是否在计时
      segmentStart: 0, // 这一段开始计时的 Date.now()（暂停 = 0）
      sessionMs: 0, // 本次打开这本书累计的毫秒（只用于界面秒表）
      unsentMs: 0, // 还没上报给主进程的毫秒（保留不足 1 秒的零头）
      flushTimer: null, // 每 30 秒上报一次
      tickTimer: null // 每秒刷新一下按钮上的秒表（纯显示，不写盘）
    },
    jumpMatches: [], // Ctrl+G 跳章的当前匹配结果
    jumpQuery: '', // 跳章输入框里的词
    jumpOutOfRange: false, // 输入的是章号但超出本书章数
    jumpToken: 0, // 丢弃过期的异步匹配结果
    jumpTimer: null, // 输入防抖
    formatBookRunning: false, // 「一键整理本书」进行中（防重复触发）
    proofread: null, // 校对结果：{ scope, issues, chapters, total, byRule, truncated, ... }
    proofreadScope: 'current', // 校对范围：current = 当前章；book = 整本
    proofreadBusy: false, // 校对进行中（防重复触发）
    sensitive: null, // 敏感词预检结果：{ ok, scope, total, matches, byWord, chapters, ... }
    sensitiveScope: 'current', // 预检范围：current = 当前章；book = 整本
    sensitiveBusy: false, // 预检进行中（防重复触发）
    sensitiveWordList: null, // 当前词表状态：{ ok, path, name, count, code, message, stats }
    sensitiveWordsDraft: '', // 设置里刚选的词表路径（点「保存设置」才落配置）
    sensitiveWordsInfo: null, // 设置弹层里显示的词表状态（读取当前草稿对应的词表）
    logInfo: null, // 设置弹层「诊断日志」显示的日志目录清单（只读；不含正文）
    lastInternalError: null, // 主进程最近一次内部错误的固定提示（只用于提示 + 自检断言）
    appVersion: '', // package.json 的版本号（主进程回报；设置 →「检查更新」显示用）
    // 检查更新（提案 7.1）：只在点按钮时联网；不下载、不安装、不写配置，结果只记在内存里
    update: {
      busy: false, // 正在检查
      result: null // 主进程回报：{ status: 'update'|'latest'|'error', currentVersion, latestVersion, ... }
    },
    tts: {
      open: false, // 朗读小条是否显示
      status: 'idle', // idle | playing | paused | done | error
      chunks: [], // 主进程切好的段落：[{ start, end, text, paragraph, line }]
      index: 0, // 当前朗读 / 选中的段落下标（0 基）
      rate: 1, // 语速（0.5–2）
      voiceURI: '', // 选中的系统语音（'' = 系统默认）
      follow: false, // 跟随高亮：把编辑区选区移到正在读的段落（只改选区，不改文字）
      error: '', // 朗读失败 / 没有正文等错误信息
      loading: false, // 正在准备正文（切分中）
      requestId: 0 // 丢弃过期的异步切分结果
    },
    fragments: [], // 灵感箱列表（_碎片 顶层的 txt，最新在前）
    fragmentSelected: null, // 插入面板里当前选中的碎片 { name, text, chars }
    fragmentBusy: false, // 正在保存碎片（防重复写）
    insertFragmentRange: null, // 打开「插入碎片…」前编辑区的光标 / 选区（插入时按这个位置）
    marks: {
      invisibles: false, // 显示不可见字符（全角空格 ␣ / 行尾空白）
      longParagraphs: false, // 超长段落提示（>500 字左侧淡黄竖线）
      composing: false, // 中文输入法拼字中：先不重画标记层，免得闪
      timer: null, // 重画防抖
      longItems: [], // 本章超长段落（给状态栏小标签用；只读缓存）
      longCount: 0,
      longTruncated: false,
      markCounts: { fullwidth: 0, trailing: 0 },
      markTruncated: false,
      marksTooLarge: false, // 正文太长（>30 万字）时不再逐字画标记
      barBaseScrollTop: 0, // 左侧黄线的基准滚动位置（滚动时只改 top，不重新量行框）
      resizeObserver: null
    },
    focus: {
      on: false, // 专注模式是否开着（只在写作页有效；只记内存，不写配置）
      typewriter: false, // 打字机模式：光标行保持在正文区上方约 1/3 处
      savedScrollTop: 0, // 进入专注模式前的滚动位置（退出时按光标相对位置还原）
      savedCaret: 0, // 进入专注模式前的光标位置
      savedCaretOffset: null, // 进入时「光标行顶端 - 滚动位置」，退出时用它把视线放回原处
      timer: null // 打字机对齐的防抖定时器
    },
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
    if (view !== 'editor') closeTtsBar();
    // 离开写作页就退出专注模式（不还原滚动位置：书已经关了）
    if (view !== 'editor' && state.focus.on) setFocusMode(false, { restore: false });
    state.view = view;
    $('shelf-view').classList.toggle('hidden', view !== 'shelf');
    $('editor-view').classList.toggle('hidden', view !== 'editor');
    updateWindowTitle();
    renderStatsUi();
    // 离开写作页就停表（先把没上报的整秒记下）：回书架 / 关书不会把闲逛时间算成写作
    if (view !== 'editor' && (state.writeTimer.running || state.writeTimer.sessionMs > 0 || state.writeTimer.unsentMs > 0)) {
      void resetWriteTimer({ flush: true });
    }
    // 标记层只在写作页显示；切回书架就收起（开关状态保留，回来还在）
    if (view === 'editor') scheduleMarksRender(0);
    else hideEditorMarks();
    renderSelectionStats();
    updateFocusBar();
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
    // 字体 / 字号 / 行距变了，标记层要重新对齐
    scheduleMarksRender(30);
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
    // 正文索引：回书架时顺手让主进程校验 / 增量更新（后台，不 await、不挡书架显示）。
    // 第一次打开大书架会建索引，进度通过 search:progress 回到这里显示。
    void ensureSearchIndex();
    if (shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS) scheduleContentSearch();
  }

  // ---------- 书架搜索（书名 / 作者 / 分组 / 标签 + 章节名 + 正文） ----------
  // 书名 / 作者 / 分组 / 标签 / 章节名是内存过滤（输入即出）；正文走主进程的搜索索引，防抖后异步查。
  function shelfQueryText() {
    return String(state.shelfQuery || '').trim();
  }

  function bookGroupOf(book) {
    return bookInfoLib.sanitizeGroup(book && book.group);
  }

  // 书架分组筛选（v0.8-3）：只影响书架视图，不改书文件夹、不写配置。
  function shelfGroupList() {
    const groups = new Set();
    for (const book of state.books) {
      const group = bookGroupOf(book);
      if (group) groups.add(group);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  function shelfGroupMatches(book) {
    if (!state.shelfGroup) return true;
    const group = bookGroupOf(book);
    if (state.shelfGroup === '__none__') return !group;
    return group === state.shelfGroup;
  }

  function matchBookForSearch(book, queryLower) {
    if (!queryLower) return { visible: true, titleMatch: false, infoMatch: false, chapterHits: [] };
    const title = String(book.title || '').toLowerCase();
    const folder = String(book.folder || '').toLowerCase();
    const titleMatch = title.includes(queryLower) || folder.includes(queryLower);
    // 作者 / 分组 / 标签（v0.8-3）：和书名一样是内存里的字面量匹配
    const infoMatch = bookInfoLib.bookInfoMatches(book, queryLower);
    if (titleMatch) {
      return { visible: true, titleMatch: true, infoMatch, chapterHits: [] };
    }
    const names = Array.isArray(book.chapterNames) ? book.chapterNames : [];
    const chapterHits = [];
    for (let i = 0; i < names.length && chapterHits.length < 3; i += 1) {
      const name = String(names[i] || '');
      if (name && name.toLowerCase().includes(queryLower)) chapterHits.push({ index: i, name });
    }
    return { visible: infoMatch || chapterHits.length > 0, titleMatch: false, infoMatch, chapterHits };
  }

  function shelfSearchResults() {
    const queryLower = shelfQueryText().toLowerCase();
    const rows = [];
    for (const book of state.books) {
      if (!shelfGroupMatches(book)) continue;
      const info = matchBookForSearch(book, queryLower);
      if (info.visible) rows.push({ book, info });
    }
    return rows;
  }

  function shelfContentActive() {
    return state.view === 'shelf' && shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS;
  }

  function renderShelfContent() {
    const wrap = $('shelf-content');
    if (!wrap) return;
    const content = state.shelfContent;
    if (!shelfContentActive()) {
      wrap.classList.add('hidden');
      wrap.setAttribute('aria-busy', 'false');
      return;
    }
    wrap.classList.remove('hidden');
    wrap.setAttribute('aria-busy', content.loading ? 'true' : 'false');
    const status = $('shelf-content-summary');
    const list = $('shelf-content-list');
    const more = $('btn-shelf-content-more');
    if (!status || !list || !more) return;

    const meta = content.meta;
    const parts = [];
    if (content.loading) {
      parts.push('正在正文里查找…');
    } else if (content.error) {
      parts.push(`正文搜索暂时不可用：${content.error}`);
    } else if (meta && meta.tooShort) {
      parts.push(`正文搜索至少 ${CONTENT_SEARCH_MIN_CHARS} 个字`);
    } else if (meta && meta.results && meta.results.length) {
      const shown = Math.min(content.shown, meta.results.length);
      parts.push(
        `正文命中 ${meta.results.length} 处（显示 ${shown} 条）` +
          (meta.truncated ? ' · 只查了最近的一部分书' : '') +
          ` · 已查 ${meta.scannedBooks}/${meta.candidateBooks} 本`
      );
    } else if (meta) {
      parts.push(
        `正文没有找到「${content.query}」` + (meta.truncated ? '（只查了最近的一部分书）' : '')
      );
    }
    const idx = content.indexStatus;
    if (idx && (idx.building || idx.ready === false)) {
      const progress = idx.progress && idx.progress.total
        ? `（${idx.progress.book || ''} ${idx.progress.books || 0}/${idx.progress.total} 本）`
        : '';
      parts.push(`正在为书架建正文索引${progress}，建好后自动更新结果`);
    }
    status.textContent = parts.join(' · ');

    list.innerHTML = '';
    const results = Array.isArray(content.results) ? content.results : [];
    const visible = results.slice(0, content.shown);
    for (let i = 0; i < visible.length; i += 1) {
      const row = visible[i];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shelf-content-row';
      item.dataset.index = String(i);
      const head = document.createElement('span');
      head.className = 'shelf-content-title';
      const bookName = document.createElement('span');
      bookName.className = 'shelf-content-book';
      bookName.textContent = row.bookTitle || '';
      const chapterName = document.createElement('span');
      chapterName.className = 'shelf-content-chapter';
      chapterName.textContent = chapterTitle(Number(row.chapterIndex) || 0, row.chapterName || '');
      head.appendChild(bookName);
      head.appendChild(chapterName);
      const snippet = document.createElement('span');
      snippet.className = 'shelf-content-snippet';
      const snip = row.snippet || {};
      if (snip.cutBefore) snippet.appendChild(document.createTextNode('…'));
      snippet.appendChild(document.createTextNode(snip.before || ''));
      const mark = document.createElement('mark');
      mark.textContent = snip.match || '';
      snippet.appendChild(mark);
      snippet.appendChild(document.createTextNode(snip.after || ''));
      if (snip.cutAfter) snippet.appendChild(document.createTextNode('…'));
      item.appendChild(head);
      item.appendChild(snippet);
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openContentResult(row);
      });
      list.appendChild(item);
    }

    if (visible.length && results.length > content.shown) {
      more.classList.remove('hidden');
      more.textContent = `显示更多（还有 ${results.length - content.shown} 条）`;
    } else {
      more.classList.add('hidden');
    }
    if (!visible.length && !content.loading && !content.error && (!meta || !meta.results || !meta.results.length)) {
      const empty = document.createElement('div');
      empty.className = 'shelf-content-empty muted small';
      empty.textContent =
        meta && meta.truncated
          ? '最近的一部分书里没有找到；试试更具体一点的词。'
          : '书名、章节名和正文里都没找到。';
      list.appendChild(empty);
    }
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
    const content = state.shelfContent;
    const contentNote = content.loading
      ? ' · 正在搜正文…'
      : content.meta && content.meta.results && content.meta.results.length
        ? ` · 正文命中 ${content.meta.results.length} 处`
        : '';
    const groupNote = state.shelfGroup ? '（已按分组筛选）' : '';
    summary.textContent =
      matchedCount > 0
        ? `搜索「${query}」：${matchedCount} / ${state.books.length} 本书名 / 作者 / 分组 / 标签 / 章节名命中${groupNote}${contentNote}（回车打开第一本，Esc 清除）`
        : `搜索「${query}」：没有匹配的书名 / 作者 / 分组 / 标签 / 章节名${groupNote}${contentNote || '，正文也没有找到'}（Esc 清除）`;
  }

  // ---------- 书架正文搜索（提案 7.3：索引在主进程，绝不读正文到界面） ----------
  function resetShelfContent(keepQuery = false) {
    const content = state.shelfContent;
    content.token += 1;
    if (content.timer) {
      clearTimeout(content.timer);
      content.timer = null;
    }
    content.loading = false;
    content.results = [];
    content.meta = null;
    content.error = null;
    content.shown = CONTENT_PAGE_SIZE;
    if (!keepQuery) content.query = '';
    renderShelfContent();
  }

  function scheduleContentSearch() {
    const content = state.shelfContent;
    if (content.timer) {
      clearTimeout(content.timer);
      content.timer = null;
    }
    content.token += 1;
    const token = content.token;
    const query = shelfQueryText();
    if (!shelfContentActive()) {
      resetShelfContent(true);
      return;
    }
    content.query = query;
    content.loading = true;
    content.results = [];
    content.meta = null;
    content.error = null;
    content.shown = CONTENT_PAGE_SIZE;
    renderShelfContent();
    content.timer = setTimeout(() => {
      content.timer = null;
      void runContentSearch(query, token);
    }, CONTENT_SEARCH_DEBOUNCE);
  }

  async function runContentSearch(query, token) {
    const content = state.shelfContent;
    try {
      const data = await call(api.searchContent, query, { limit: CONTENT_RESULT_LIMIT });
      if (token !== content.token || state.view !== 'shelf') return;
      content.loading = false;
      content.results = Array.isArray(data.results) ? data.results : [];
      content.meta = data;
      content.error = null;
      content.indexStatus = data.index || content.indexStatus;
      renderShelf();
    } catch (err) {
      if (token !== content.token) return;
      content.loading = false;
      content.error = err.message;
      content.meta = null;
      renderShelf();
    }
  }

  async function ensureSearchIndex(options = {}) {
    try {
      const status = await call(api.ensureSearchIndex, {
        force: Boolean(options.force),
        deep: options.deep !== false
      });
      state.shelfContent.indexStatus = status;
      if (state.view === 'shelf') renderShelfContent();
      return status;
    } catch {
      return null; // 索引不可用不影响书架和搜索（正文结果会显示为空 / 提示）
    }
  }

  async function openContentResult(row) {
    if (!row || !row.bookPath) return;
    await openBookByPath(row.bookPath, {
      chapterId: row.chapterId,
      matchIndex: row.matchIndex,
      matchLength: row.matchLength
    });
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

  // ---------- 书籍信息（作者 / 简介 / 分组 / 标签，v0.8-3） ----------
  // 只写 书目.json 的可选字段：书文件夹名、章节文件名、正文 txt 都不动。
  // 书目损坏的书先走「修复」，这里直接拒绝（读不出 meta 就没法安全改）。
  function openBookInfoDialog(book) {
    if (!book || !book.path) return false;
    if (book.status === 'corrupt') {
      toast('这本书的书目损坏，先点「修复」再改书籍信息', 'warn');
      return false;
    }
    state.bookInfoBook = book;
    const info = bookInfoLib.readBookInfo(book);
    $('bookinfo-book').textContent = `《${book.title || book.folder || ''}》`;
    $('bookinfo-book').title = book.path || '';
    $('bookinfo-author').value = info.author;
    $('bookinfo-group').value = info.group;
    $('bookinfo-tags').value = info.tags.join('、');
    $('bookinfo-brief').value = info.brief;
    $('bookinfo-error').textContent = '';
    const suggestions = $('bookinfo-group-list');
    suggestions.innerHTML = '';
    for (const group of shelfGroupList()) {
      const option = document.createElement('option');
      option.value = group;
      suggestions.appendChild(option);
    }
    $('bookinfo-backdrop').classList.remove('hidden');
    $('bookinfo-author').focus();
    return true;
  }

  function closeBookInfoDialog() {
    state.bookInfoBook = null;
    $('bookinfo-backdrop').classList.add('hidden');
    $('bookinfo-error').textContent = '';
  }

  function readBookInfoForm() {
    return {
      author: $('bookinfo-author').value,
      group: $('bookinfo-group').value,
      tags: $('bookinfo-tags').value,
      brief: $('bookinfo-brief').value
    };
  }

  async function saveBookInfoDialog() {
    const book = state.bookInfoBook;
    if (!book) return { ok: false };
    const form = readBookInfoForm();
    // 标签先按应用规则清洗（去空 / 去重 / 最多 10 个），免得作者以为自己存了 15 个
    const tags = bookInfoLib.sanitizeTags(form.tags);
    try {
      const result = await call(api.updateBookInfo, book.path, {
        author: form.author,
        brief: form.brief,
        group: form.group,
        tags
      });
      closeBookInfoDialog();
      toast(result.changed ? '书籍信息已保存（只改书目，不改正文和文件名）' : '书籍信息没有变化');
      await refreshShelf();
      return { ok: true, changed: Boolean(result.changed) };
    } catch (err) {
      $('bookinfo-error').textContent = `保存失败：${err.message}`;
      return { ok: false, message: err.message };
    }
  }

  // 书架分组筛选（v0.8-3）：分组来自 书目.json 的可选 group 字段；
  // 一组的书都没有时收起筛选条；分组名改了 / 书删了就回到「全部分组」。
  function renderShelfGroupBar() {
    const bar = $('shelf-group-bar');
    const select = $('shelf-group-filter');
    if (!bar || !select) return;
    const groups = shelfGroupList();
    if (!groups.length) {
      state.shelfGroup = '';
      bar.classList.add('hidden');
      select.innerHTML = '';
      return;
    }
    if (state.shelfGroup && state.shelfGroup !== '__none__' && !groups.includes(state.shelfGroup)) {
      state.shelfGroup = '';
    }
    const options = [{ value: '', label: '全部分组' }];
    if (state.books.some((book) => !bookGroupOf(book))) {
      options.push({ value: '__none__', label: '未分组' });
    }
    for (const group of groups) options.push({ value: group, label: group });
    select.innerHTML = '';
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.value = state.shelfGroup;
    bar.classList.remove('hidden');
  }

  function renderShelf() {
    $('books-root-label').textContent = state.config ? `书架：${state.config.booksRoot}` : '';
    $('books-root-label').title = state.config ? state.config.booksRoot : '';
    const grid = $('book-grid');
    grid.innerHTML = '';
    renderContinueWriting();
    renderShelfGroupBar();

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
      const content = state.shelfContent;
      const contentHits = content.meta && content.meta.results ? content.meta.results.length : 0;
      if (!query && state.shelfGroup) {
        empty.textContent =
          state.shelfGroup === '__none__' ? '「未分组」里还没有书。' : '这个分组里还没有书。';
      } else {
        const contentNote = content.loading
          ? '书名 / 作者 / 章节名没有匹配，正在正文里找…'
          : contentHits > 0
            ? `书名 / 作者 / 章节名没有匹配；正文找到 ${contentHits} 处，见上方「正文命中」。`
            : `没有找到匹配「${query}」的书（书名 / 作者 / 分组 / 标签 / 章节名 / 正文都没有）。`;
        empty.textContent = contentNote;
      }
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

      // 书籍信息（v0.8-3）：作者 / 分组 / 标签 / 简介。旧书没有这些字段就什么都不多显示。
      const bookInfo = bookInfoLib.readBookInfo(book);
      if (book.status !== 'corrupt') {
        if (bookInfo.author) {
          const author = document.createElement('div');
          author.className = 'book-card-author';
          author.textContent = `作者：${bookInfo.author}`;
          author.title = author.textContent;
          card.appendChild(author);
        }
        if (bookInfo.group || bookInfo.tags.length) {
          const chips = document.createElement('div');
          chips.className = 'book-card-tags';
          const parts = [];
          if (bookInfo.group) parts.push(`分组：${bookInfo.group}`);
          for (const tag of bookInfo.tags) parts.push(`#${tag}`);
          chips.textContent = parts.join(' · ');
          chips.title = chips.textContent;
          card.appendChild(chips);
        }
        if (bookInfo.brief) {
          const brief = document.createElement('div');
          brief.className = 'book-card-brief';
          brief.textContent = bookInfo.brief.replace(/\s*\n+\s*/g, ' ');
          brief.title = bookInfo.brief;
          card.appendChild(brief);
        }
      }

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
    renderShelfContent();
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
  // target 可选：{ chapterId, matchIndex, matchLength } —— 从书架「正文命中」点进来时
  // 直接打开那一章并选中命中位置（只移动光标 / 选区 + 滚动，不改正文、不写盘）
  // 书卡右键「在新窗口打开」：主进程负责「同一本书只开一个窗口」；
  // 书已经开在别的窗口时就聚焦那个窗口，本窗口不变。
  async function openBookInNewWindow(book) {
    if (!book || !book.path) return { ok: false };
    try {
      const result = await call(api.openBookInNewWindow, book.path);
      if (result && result.focused) {
        toast(result.message || '这本书已经在另一个窗口打开，已切换到那个窗口', 'warn');
      } else {
        toast(`已在新窗口打开「${book.title || '这本书'}」`);
      }
      return { ok: true, ...(result || {}) };
    } catch (err) {
      toast(`新窗口打开失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function openBookByPath(bookPath, target = null) {
    let data;
    try {
      data = await call(api.openBook, bookPath);
    } catch (err) {
      if (err.code === 'BOOK_OPEN_IN_OTHER_WINDOW') {
        // 同一本书只允许一个窗口：主进程已经聚焦了那个窗口
        toast(err.message || '这本书已经在另一个窗口打开，已切换到那个窗口', 'warn');
        return;
      }
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

    // 换书前先停掉上一本的写作计时：把没上报的整秒记下，新书从 0 开始
    await resetWriteTimer({ flush: true });
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

    let startIndex = Math.max(
      0,
      state.chapters.findIndex((c) => c.id === data.meta.lastOpenChapterId)
    );
    if (target && target.chapterId) {
      const targetIndex = state.chapters.findIndex((c) => c.id === target.chapterId);
      if (targetIndex >= 0) startIndex = targetIndex;
    }
    await loadChapterAt(startIndex);
    if (target && Number.isFinite(Number(target.matchIndex))) {
      selectEditorRange(Number(target.matchIndex), Number(target.matchLength) || 0);
    }
  }

  // 把编辑区选区放到命中位置（正文命中点进来用）：只改光标 / 选区与滚动，不改内容
  function selectEditorRange(index, length) {
    const size = editorEl.value.length;
    const pos = Math.max(0, Math.min(Math.round(Number(index) || 0), size));
    const end = Math.max(pos, Math.min(pos + Math.max(1, Math.round(Number(length) || 0)), size));
    editorEl.focus();
    editorEl.setSelectionRange(pos, end);
    scrollCaretIntoView(pos);
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
    const chars = chapterCharsOf(chapter);
    const previousChars = index > 0 ? chapterCharsOf(state.chapters[index - 1]) : null;
    const comparison = chars != null ? editorLogic.compareChapterChars(chars, previousChars) : null;
    const item = document.createElement('div');
    item.className = `chapter-item status-${status}` + (index === state.index ? ' active' : '');
    if (index === state.index && state.dirty) item.classList.add('dirty');
    item.dataset.index = String(index);
    item.dataset.status = status;
    const tip = [
      `状态：${CHAPTER_STATUS_LABELS[status]}`,
      note ? `备注：${note}` : '',
      chars != null ? `本章 ${chars} 字` : '',
      comparison && comparison.direction === 'shorter' ? comparison.message : ''
    ]
      .filter(Boolean)
      .join('\n');
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
    // 章节列表每项显示字数（书目缓存，紧凑显示）；保存后自动更新
    if (chars != null) {
      const charsEl = document.createElement('span');
      charsEl.className = 'chapter-chars';
      charsEl.textContent = editorLogic.formatCharsShort(chars);
      charsEl.title = `本章 ${chars} 字（书目缓存；保存后更新）`;
      item.appendChild(charsEl);
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
      updateFocusBar();
      return;
    }
    $('chapter-title').textContent = chapterTitle(state.index, state.chapters[state.index].name);
    // 专注模式下顶栏是隐藏的，章名显示在极简退出条上
    updateFocusBar();
  }

  // ---------- 状态栏 ----------
  // 本章字数：正常章节即时算；MB 级的超大单章（「整本一章」导入）每个字都全文正则统计会卡，
  // 超过 20 万字符改成 400ms 防抖，多打几个字只算最后一次。
  let charCountTimer = null;
  const CHAR_COUNT_DEFER_ABOVE = 200000;

  // 章节字数：书目里的 chars 缓存（打开书 / 保存后由主进程补齐）；没有就是 null
  function chapterCharsOf(chapter) {
    if (!chapter) return null;
    const n = Number(chapter.chars);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  // 本章字数 + 「比上章短」软提示（提案 4.1：章节字数对比）。
  // 当前章按编辑区实时算（未保存也算），上一章按书目缓存；只提示，不改任何东西。
  function updateCharCountText() {
    const el = $('char-count');
    if (!el) return;
    if (!state.bookPath || state.index < 0) {
      el.textContent = '';
      el.classList.remove('count-short');
      el.title = '';
      return;
    }
    const liveChars = countChars(editorEl.value);
    let text = `本章 ${formatChars(liveChars)}`;
    el.classList.remove('count-short');
    el.title = '本章字数（不含空白）；未保存的编辑也算。';
    const previousChars = state.index > 0 ? chapterCharsOf(state.chapters[state.index - 1]) : null;
    const compared = editorLogic.compareChapterChars(liveChars, previousChars);
    if (compared.direction === 'shorter') {
      text += ` · ${compared.message}`;
      el.classList.add('count-short');
      el.title =
        `本章 ${liveChars} 字，上一章 ${previousChars} 字（短了 ${Math.abs(compared.percent)}%）。` +
        '只是提醒，不改任何东西；如果这一章还没写完，可能是漏了内容。';
    }
    el.textContent = text;
  }

  function renderCharCount() {
    if (!state.bookPath || state.index < 0) {
      clearTimeout(charCountTimer);
      updateCharCountText();
      return;
    }
    const text = editorEl.value;
    if (text.length <= CHAR_COUNT_DEFER_ABOVE) {
      clearTimeout(charCountTimer);
      updateCharCountText();
      return;
    }
    clearTimeout(charCountTimer);
    charCountTimer = setTimeout(() => {
      if (!state.bookPath || state.index < 0) return;
      updateCharCountText();
    }, 400);
  }

  // 选中字数：只在真选了文字时显示；和「本章字数」同口径（不含空白），段数按触及的非空行算。
  function renderSelectionStats() {
    const el = $('status-selection');
    if (!el) return;
    if (state.view !== 'editor' || !state.bookPath || state.index < 0) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const stats = editorLogic.selectionStats(editorEl.value, editorEl.selectionStart, editorEl.selectionEnd);
    if (stats.collapsed || (stats.chars === 0 && stats.paragraphs === 0)) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('hidden');
    el.textContent = `选中 ${formatChars(stats.chars)} / ${stats.paragraphs} 段`;
    el.title = '选中的字数（不含空白，和「本章字数」同口径）与触及的自然段数';
  }

  // ---------- 编辑器小件（提案 4.1）----------
  // 全部只读、可开关：选中字数 / 超长段落提示 / 不可见字符 / Alt+↑↓ 段落导航 / 章节列表字数对比。
  // 「超长段落」和「不可见字符」画在一层绝对定位的影子层（#editor-marks）上：字体、行高、字距、宽高都从
  // 编辑区实测值同步，文字本身透明，只画底色和 ␣ / · 标记 —— 正文一个字节都不动，也不写盘。
  // 两个开关都关时这一层一直是 hidden，没有任何额外开销。
  function marksEnabled() {
    return Boolean(state.marks.invisibles || state.marks.longParagraphs);
  }

  function scheduleMarksRender(delay = 80) {
    if (state.marks.timer) clearTimeout(state.marks.timer);
    state.marks.timer = setTimeout(() => {
      state.marks.timer = null;
      renderEditorMarks();
    }, Math.max(0, Number(delay) || 0));
  }

  function hideEditorMarks() {
    const overlay = $('editor-marks');
    const gutter = $('editor-marks-gutter');
    if (gutter) {
      gutter.classList.add('hidden');
      gutter.textContent = '';
    }
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.textContent = '';
    state.marks.longItems = [];
    state.marks.longCount = 0;
    state.marks.markCounts = { fullwidth: 0, trailing: 0 };
    renderLongParaChip();
  }

  // 把影子层改成和编辑区正文框完全一样的位置、大小、字体度量；返回实测值（测试钩子也用）
  function syncMarksLayout() {
    const overlay = $('editor-marks');
    if (!overlay || overlay.classList.contains('hidden')) return null;
    const styles = getComputedStyle(editorEl);
    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const padding = {
      top: px(styles.paddingTop),
      bottom: px(styles.paddingBottom),
      left: px(styles.paddingLeft),
      right: px(styles.paddingRight)
    };
    const width = Math.max(0, editorEl.clientWidth - padding.left - padding.right);
    const height = Math.max(0, editorEl.clientHeight - padding.top - padding.bottom);
    overlay.style.left = `${editorEl.offsetLeft + padding.left}px`;
    overlay.style.top = `${editorEl.offsetTop + padding.top}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    // 正文显示设置（字体 / 字号 / 行距 / 字距 / 页宽 / 边距）随时会变：每次都用实测值，别写死
    overlay.style.fontFamily = styles.fontFamily;
    overlay.style.fontSize = styles.fontSize;
    overlay.style.fontWeight = styles.fontWeight;
    overlay.style.fontStyle = styles.fontStyle;
    overlay.style.lineHeight = styles.lineHeight;
    overlay.style.letterSpacing = styles.letterSpacing;
    overlay.scrollTop = editorEl.scrollTop;
    overlay.scrollLeft = editorEl.scrollLeft;
    return { width, height, padding };
  }

  function syncMarksScroll() {
    const overlay = $('editor-marks');
    if (!overlay || overlay.classList.contains('hidden')) return;
    overlay.scrollTop = editorEl.scrollTop;
    overlay.scrollLeft = editorEl.scrollLeft;
    syncLongParaBars();
  }

  // 超长段落的左侧黄线：画在正文左边距里（不压字），逐行按 .long-para 的实测行框定位；
  // 滚动时只改 top（行位置本身不变），所以不用每帧重新量。
  function renderLongParagraphBars() {
    const gutter = $('editor-marks-gutter');
    const overlay = $('editor-marks');
    if (!gutter) return;
    gutter.textContent = '';
    gutter.classList.add('hidden');
    if (!overlay || overlay.classList.contains('hidden') || !state.marks.longParagraphs) return;
    const nodes = overlay.querySelectorAll('.long-para');
    if (!nodes.length) return;
    const styles = getComputedStyle(editorEl);
    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const padLeft = px(styles.paddingLeft);
    const mainRect = gutter.parentElement.getBoundingClientRect();
    const editorRect = editorEl.getBoundingClientRect();
    // 默认放在正文左边 9px（正文左右边距 56px 时很宽裕）；边距很小时贴着正文左缘，不跑到窗口外
    const barLeft = Math.max(
      editorRect.left - mainRect.left + 2,
      editorRect.left - mainRect.left + padLeft - 9
    );
    const baseScrollTop = editorEl.scrollTop || 0;
    for (const node of nodes) {
      const rects = node.getClientRects();
      for (const rect of rects) {
        if (rect.width < 1 || rect.height < 1) continue;
        const bar = document.createElement('div');
        bar.className = 'long-para-bar';
        bar.style.left = `${Math.round(barLeft * 100) / 100}px`;
        bar.style.top = `${Math.round((rect.top - mainRect.top) * 100) / 100}px`;
        bar.style.height = `${Math.round(rect.height * 100) / 100}px`;
        bar.dataset.baseTop = String(rect.top - mainRect.top);
        gutter.appendChild(bar);
      }
    }
    state.marks.barBaseScrollTop = baseScrollTop;
    gutter.classList.remove('hidden');
    syncLongParaBars();
  }

  function syncLongParaBars() {
    const gutter = $('editor-marks-gutter');
    if (!gutter || gutter.classList.contains('hidden')) return;
    const delta = (editorEl.scrollTop || 0) - (state.marks.barBaseScrollTop || 0);
    for (const bar of gutter.children) {
      const base = Number(bar.dataset.baseTop);
      if (!Number.isFinite(base)) continue;
      bar.style.top = `${Math.round((base - delta) * 100) / 100}px`;
    }
  }

  function renderEditorMarks() {
    const overlay = $('editor-marks');
    if (!overlay) return;
    if (state.view !== 'editor' || !state.bookPath || state.index < 0 || !marksEnabled()) {
      hideEditorMarks();
      return;
    }
    const text = editorEl.value;
    const longResult = state.marks.longParagraphs
      ? editorLogic.longParagraphs(text, LONG_PARAGRAPH_THRESHOLD)
      : { items: [], count: 0, truncated: false, tooLarge: false };
    const invisibleResult = state.marks.invisibles
      ? editorLogic.invisibleMarks(text)
      : { items: [], counts: { fullwidth: 0, trailing: 0 }, truncated: false, tooLarge: false };
    state.marks.longItems = longResult.items;
    state.marks.longCount = longResult.count;
    state.marks.longTruncated = longResult.truncated;
    state.marks.markCounts = invisibleResult.counts;
    state.marks.markTruncated = invisibleResult.truncated;
    state.marks.marksTooLarge = Boolean(invisibleResult.tooLarge);

    overlay.classList.remove('hidden');
    syncMarksLayout();
    overlay.textContent = '';
    const longLines = new Set(longResult.items.map((item) => item.line));
    const marks = invisibleResult.items;
    const fragment = document.createDocumentFragment();
    const lines = text.split('\n');
    let lineStart = 0;
    let markIndex = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const lineEnd = lineStart + raw.length;
      if (raw.length) {
        const lineEl = document.createElement('span');
        lineEl.className = 'marks-line';
        if (longLines.has(i + 1)) lineEl.classList.add('long-para');
        let cursor = lineStart;
        while (cursor < lineEnd) {
          while (markIndex < marks.length && marks[markIndex].end <= cursor) markIndex += 1;
          const mark = markIndex < marks.length && marks[markIndex].start < lineEnd ? marks[markIndex] : null;
          if (!mark) {
            lineEl.appendChild(document.createTextNode(text.slice(cursor, lineEnd)));
            cursor = lineEnd;
            break;
          }
          if (mark.start > cursor) {
            lineEl.appendChild(document.createTextNode(text.slice(cursor, mark.start)));
            cursor = mark.start;
            continue;
          }
          const markEl = document.createElement('span');
          const rawMark = text.slice(mark.start, Math.min(mark.end, lineEnd));
          if (mark.type === 'trailing') {
            markEl.className = 'mark-trail';
            markEl.appendChild(document.createTextNode(rawMark));
            const dot = document.createElement('i');
            dot.textContent = '·';
            markEl.appendChild(dot);
          } else {
            markEl.className = 'mark-fw';
            markEl.appendChild(document.createTextNode(rawMark));
            const glyph = document.createElement('i');
            glyph.textContent = '␣';
            markEl.appendChild(glyph);
          }
          lineEl.appendChild(markEl);
          cursor = Math.min(mark.end, lineEnd);
          markIndex += 1;
        }
        fragment.appendChild(lineEl);
      }
      if (i < lines.length - 1) fragment.appendChild(document.createTextNode('\n'));
      lineStart = lineEnd + 1;
    }
    overlay.appendChild(fragment);
    syncMarksScroll();
    renderLongParagraphBars();
    renderLongParaChip();
  }

  function longParagraphsTitle() {
    const items = state.marks.longItems || [];
    const count = state.marks.longCount || 0;
    const lines = [`超过 ${LONG_PARAGRAPH_THRESHOLD} 字的段落：`];
    for (const item of items.slice(0, 6)) lines.push(`第 ${item.line} 行 · ${item.chars} 字`);
    if (count > Math.min(items.length, 6)) {
      lines.push(`…还有 ${count - Math.min(items.length, 6)} 段`);
    }
    lines.push('单击跳到下一段（只移动光标，不改字）');
    return lines.join('\n');
  }

  function renderLongParaChip() {
    const chip = $('status-long-para');
    if (!chip) return;
    const show =
      state.marks.longParagraphs && state.marks.longCount > 0 && state.bookPath && state.index >= 0 && state.view === 'editor';
    chip.classList.toggle('hidden', !show);
    if (!show) {
      chip.textContent = '超长段落';
      chip.title = '';
      return;
    }
    chip.textContent = `超长段落 ${state.marks.longCount} 段`;
    chip.title = longParagraphsTitle();
  }

  function jumpToNextLongParagraph() {
    if (!state.marks.longParagraphs) return false;
    const item = editorLogic.nextLongParagraph(state.marks.longItems, editorEl.selectionStart || 0);
    if (!item) return false;
    editorEl.focus();
    editorEl.setSelectionRange(item.start, item.start);
    scrollCaretIntoView(item.start);
    syncMarksScroll();
    renderSelectionStats();
    return true;
  }

  // Alt+↑ / Alt+↓：在自然段开头之间跳（只移动光标，不改字）
  function jumpParagraph(direction) {
    if (state.view !== 'editor' || !state.bookPath || state.index < 0) return false;
    const target = editorLogic.paragraphJumpTarget(
      editorEl.value,
      editorEl.selectionStart || 0,
      Number(direction) < 0 ? -1 : 1
    );
    if (target == null) return false;
    editorEl.focus();
    editorEl.setSelectionRange(target, target);
    scrollCaretIntoView(target);
    syncMarksScroll();
    renderSelectionStats();
    return true;
  }

  function renderMarksMenu() {
    const invisibles = $('format-invisibles');
    const long = $('format-long-para');
    if (invisibles) {
      invisibles.textContent = `${state.marks.invisibles ? '✓ ' : ''}显示不可见字符（␣ / 行尾空白）`;
      invisibles.dataset.on = state.marks.invisibles ? '1' : '0';
      invisibles.title =
        '只在正文上面画标记：全角空格标成 ␣、行尾空白标成浅红底。正文一个字都不会改，也不写盘。';
    }
    if (long) {
      long.textContent = `${state.marks.longParagraphs ? '✓ ' : ''}超长段落提示（>${LONG_PARAGRAPH_THRESHOLD} 字左侧黄线）`;
      long.dataset.on = state.marks.longParagraphs ? '1' : '0';
      long.title = `超过 ${LONG_PARAGRAPH_THRESHOLD} 字的段落，左侧画一条淡黄竖线（为手机阅读排版着想）。只显示，不改正文。`;
    }
  }

  function setMarksToggle(name, on) {
    if (name !== 'invisibles' && name !== 'longParagraphs') return false;
    state.marks[name] = Boolean(on);
    renderMarksMenu();
    renderEditorMarks();
    if (name === 'invisibles' && state.marks.invisibles && state.marks.marksTooLarge) {
      toast('正文超过 30 万字，暂时不逐字标不可见字符（超长段落提示仍然可用）', 'warn');
    }
    return state.marks[name];
  }

  function toggleMarks(name) {
    return setMarksToggle(name, !state.marks[name]);
  }

  function setupEditorMarks() {
    editorEl.addEventListener('scroll', syncMarksScroll, { passive: true });
    editorEl.addEventListener('compositionstart', () => {
      state.marks.composing = true;
    });
    editorEl.addEventListener('compositionend', () => {
      state.marks.composing = false;
      scheduleMarksRender(0);
    });
    for (const type of ['keyup', 'mouseup', 'select']) {
      editorEl.addEventListener(type, () => {
        renderSelectionStats();
        syncMarksScroll();
        // 键盘 / 鼠标移动光标后，打字机模式跟着把光标行放回 1/3 处
        if (focusActive() && state.focus.typewriter) scheduleTypewriterAlign(20);
      });
    }
    document.addEventListener('selectionchange', () => renderSelectionStats());
    if (typeof ResizeObserver === 'function') {
      state.marks.resizeObserver = new ResizeObserver(() => scheduleMarksRender(40));
      state.marks.resizeObserver.observe(editorEl);
    }
    $('status-long-para').addEventListener('click', () => jumpToNextLongParagraph());
    renderMarksMenu();
  }

  // ---------- 专注模式（提案 3.5）----------
  // 隐藏左栏与顶栏，只留正文与一条极简退出条：F11 / 顶栏「专注」进出，Esc 退出。
  // 可选「打字机模式」：光标所在行保持在正文区上方约 1/3 处，只调 textarea.scrollTop。
  // 全部只改显示（DOM class / 滚动位置），不碰正文、不写盘、不写配置。
  function focusActive() {
    return Boolean(state.focus.on && state.view === 'editor' && state.bookPath);
  }

  function updateFocusBar() {
    const bar = $('focus-bar');
    if (bar) bar.classList.toggle('hidden', !focusActive());
    const title = $('focus-chapter');
    if (title) title.textContent = focusActive() ? $('chapter-title').textContent || '' : '';
    const typewriter = $('btn-focus-typewriter');
    if (typewriter) {
      typewriter.textContent = `${state.focus.typewriter ? '✓ ' : ''}打字机`;
      typewriter.dataset.on = state.focus.typewriter ? '1' : '0';
      typewriter.title = state.focus.typewriter
        ? '打字机模式已开：光标所在行保持在正文上方约 1/3 处（只调滚动，不改正文、不写盘）'
        : '打字机模式：光标所在行保持在正文上方约 1/3 处（只调滚动，不改正文、不写盘）';
    }
  }

  // 打字机模式的光标测量层：和正文同样的字体 / 行高 / 宽度，绝对定位在屏幕外。
  // 往里面放「光标前的正文 + 一个零宽标记」，量标记的 offsetTop 就知道光标行在哪。
  function ensureFocusMirror() {
    let mirror = $('focus-mirror');
    if (mirror) return mirror;
    mirror = document.createElement('div');
    mirror.id = 'focus-mirror';
    mirror.className = 'focus-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    const main = document.querySelector('.editor-main');
    (main || document.body).appendChild(mirror);
    return mirror;
  }

  // 光标所在行的顶端（相对正文内容顶部、含 padding，px）；量不出来返回 null（就这次不对齐）
  function measureCaretTop(position) {
    const text = editorEl.value;
    if (text.length > focusLogic.MAX_TYPEWRITER_CHARS) return null;
    const styles = getComputedStyle(editorEl);
    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const width = Math.max(0, editorEl.clientWidth - px(styles.paddingLeft) - px(styles.paddingRight));
    if (width <= 0) return null;
    const mirror = ensureFocusMirror();
    mirror.style.width = `${width}px`;
    mirror.style.fontFamily = styles.fontFamily;
    mirror.style.fontSize = styles.fontSize;
    mirror.style.fontWeight = styles.fontWeight;
    mirror.style.fontStyle = styles.fontStyle;
    mirror.style.lineHeight = styles.lineHeight;
    mirror.style.letterSpacing = styles.letterSpacing;
    const pos = Math.max(0, Math.min(Math.floor(Number(position) || 0), text.length));
    mirror.textContent = text.slice(0, pos);
    const marker = document.createElement('span');
    marker.className = 'focus-mirror-caret';
    marker.textContent = '\u200b'; // 零宽空格：不占宽度、不影响换行，只用来定位
    mirror.appendChild(marker);
    const offsetTop = marker.offsetTop - mirror.offsetTop;
    mirror.textContent = '';
    if (!Number.isFinite(offsetTop)) return null;
    return Math.round((px(styles.paddingTop) + offsetTop) * 100) / 100;
  }

  // 打字机模式：把光标行放到正文区上方约 1/3 处（死区内不动，免得每打一个字都抖）
  function alignTypewriter() {
    if (!focusActive() || !state.focus.typewriter) return false;
    const caretTop = measureCaretTop(editorEl.selectionStart || 0);
    if (caretTop == null) return false;
    const plan = focusLogic.planTypewriterScroll({
      caretTop,
      currentScrollTop: editorEl.scrollTop,
      viewportHeight: editorEl.clientHeight,
      maxScrollTop: editorEl.scrollHeight - editorEl.clientHeight,
      ratio: focusLogic.TYPEWRITER_RATIO_DEFAULT
    });
    if (!plan.adjust) return false;
    editorEl.scrollTop = plan.scrollTop;
    syncMarksScroll();
    return true;
  }

  function scheduleTypewriterAlign(delay = 30) {
    if (state.focus.timer) clearTimeout(state.focus.timer);
    state.focus.timer = setTimeout(() => {
      state.focus.timer = null;
      alignTypewriter();
    }, Math.max(0, Number(delay) || 0));
  }

  // 退出专注模式后把「你刚才看的那一段」放回原处：
  // 专注模式下正文变宽、换行会变，死记 scrollTop 会偏；所以按「光标行顶端 - 滚动位置」
  // 这个相对位置还原来，宽度变了也能把光标那一行放回原来的屏幕高度。
  function restoreFocusScroll() {
    if (state.view !== 'editor' || !state.bookPath) return false;
    const savedScrollTop = Math.max(0, Number(state.focus.savedScrollTop) || 0);
    const caret = Math.max(0, Number(state.focus.savedCaret) || 0);
    let top = savedScrollTop;
    if (state.focus.savedCaretOffset != null) {
      const caretTop = measureCaretTop(caret);
      if (caretTop != null) top = caretTop - state.focus.savedCaretOffset;
    }
    editorEl.scrollTop = focusLogic.clampScrollTop(top, editorEl.scrollHeight - editorEl.clientHeight);
    try {
      editorEl.focus();
      editorEl.setSelectionRange(caret, caret);
    } catch { /* 光标对不上不影响正文 */ }
    syncMarksScroll();
    return true;
  }

  function setFocusMode(on, options = {}) {
    const want = Boolean(on);
    if (want === state.focus.on) {
      updateFocusBar();
      return state.focus.on;
    }
    if (want && !(state.view === 'editor' && state.bookPath)) return false;
    const view = $('editor-view');
    const restore = options.restore !== false;
    if (want) {
      // 记下进入前的滚动位置与「光标在视口里的位置」，退出时还回去
      state.focus.savedScrollTop = Math.max(0, Number(editorEl.scrollTop) || 0);
      state.focus.savedCaret = Math.max(0, Number(editorEl.selectionStart) || 0);
      const caretTop = measureCaretTop(state.focus.savedCaret);
      state.focus.savedCaretOffset =
        caretTop == null ? null : Math.round((caretTop - state.focus.savedScrollTop) * 100) / 100;
      hideContextMenu();
      hideFormatMenu();
      hideExportMenu();
      hideBookMenu();
      hideVolumeMenu();
      state.focus.on = true;
      if (view) view.classList.add('focus-mode');
      document.body.classList.add('focus-mode');
      updateFocusBar();
      scheduleMarksRender(0);
      // 打字机模式：进来就先把光标行放到 1/3 处
      if (state.focus.typewriter) scheduleTypewriterAlign(0);
      try {
        editorEl.focus();
        editorEl.setSelectionRange(state.focus.savedCaret, state.focus.savedCaret);
      } catch { /* 光标对不上不影响正文 */ }
    } else {
      state.focus.on = false;
      if (state.focus.timer) {
        clearTimeout(state.focus.timer);
        state.focus.timer = null;
      }
      if (view) view.classList.remove('focus-mode');
      document.body.classList.remove('focus-mode');
      updateFocusBar();
      if (restore) restoreFocusScroll();
      scheduleMarksRender(0);
    }
    return state.focus.on;
  }

  function toggleFocusMode() {
    return setFocusMode(!state.focus.on);
  }

  function setFocusTypewriter(on) {
    state.focus.typewriter = Boolean(on);
    updateFocusBar();
    if (state.focus.typewriter) alignTypewriter();
    return state.focus.typewriter;
  }

  // ---------- 每日字数统计（提案 3.2） ----------
  // 只统计「保存动作」带来的新增字数：没保存的编辑不计数，删字也不会倒扣今天。
  // 日期 / 增量都在主进程算，渲染层只负责显示；统计文件在 userData，不碰书库。
  async function refreshStats() {
    try {
      const payload = await call(api.getStats);
      state.stats = payload;
      state.streak = payload && payload.streak ? payload.streak : null;
      state.calendar = payload && payload.calendar ? payload.calendar : null;
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
        const streakEl = $('shelf-stats-streak');
        const currentStreak = Math.max(0, Math.round(Number(state.streak && state.streak.current) || 0));
        const bestStreak = Math.max(0, Math.round(Number(state.streak && state.streak.best) || 0));
        if (streakEl) {
          streakEl.textContent = currentStreak > 0 ? `连续 ${currentStreak} 天` : '';
          streakEl.hidden = currentStreak <= 0;
          streakEl.title =
            currentStreak > 0 ? `已连续写作 ${currentStreak} 天 · 最长连续 ${bestStreak} 天` : '';
        }
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
    renderStatsCalendar();
    renderDurationSettings();
    renderWriteTimer();
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
      const durationText =
        stats && (writeDurationEnabled() || Number(stats.todaySeconds) > 0)
          ? ` · 今日写作 ${formatDuration(stats.todaySeconds)}`
          : '';
      summaryEl.textContent = stats
        ? `今天 ${formatChars(stats.todayChars)} · 近 30 天 ${formatChars(stats.recentTotal)}` +
          (goal > 0 ? ` · 目标 ${formatChars(goal)}（${Math.min(100, Math.floor(Number(stats.goalPercent) || 0))}%）` : ' · 未设目标') +
          durationText
        : '还没有统计数据（保存一次后开始记录）';
    }
    const goalState = $('settings-goal-state');
    if (goalState) {
      const percent = Math.max(0, Math.min(100, Math.floor(Number(stats && stats.goalPercent) || 0)));
      goalState.textContent = goal > 0 ? `今天完成 ${percent}%${stats && stats.goalMet ? ' · 已达标' : ''}` : '未设目标';
    }
  }

  // ---------- 码字日历 / 连续写作天数 / 月度汇总（v0.8-1，提案 N1） ----------
  // 月视图由主进程从 stats.json 现算（只读，不另存文件）；渲染层只负责显示和翻月。
  // 连续天数与「今天是哪个月」都以主进程 / 本机本地日期为准，不在这里重算。
  function currentYearMonth() {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  function statsCalendarCursor() {
    const view = state.calendar;
    if (view && Number.isInteger(view.year) && Number.isInteger(view.month)) {
      return { year: view.year, month: view.month };
    }
    return currentYearMonth();
  }

  function compareYearMonth(a, b) {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  }

  function shiftYearMonth(cursor, delta) {
    const date = new Date(cursor.year, cursor.month - 1 + Math.trunc(delta), 1, 12, 0, 0, 0);
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }

  function calendarStreakLabel(streak) {
    const current = Math.max(0, Math.round(Number(streak && streak.current) || 0));
    const best = Math.max(0, Math.round(Number(streak && streak.best) || 0));
    if (best <= 0) return '还没有写作记录';
    if (current > 0) return `已连续写作 ${current} 天 · 最长 ${best} 天`;
    return `连续写作中断 · 最长 ${best} 天`;
  }

  function calendarSummaryText(view) {
    if (!view) return '';
    const durationText = view.totalSeconds > 0 ? ` · 用时 ${formatDuration(view.totalSeconds)}` : '';
    if (!view.writtenDays) {
      const base = view.isCurrentMonth ? '本月还没有保存记录（保存一次后开始记录）' : '这个月没有保存记录';
      return view.totalSeconds > 0 ? `${base}（计时 ${formatDuration(view.totalSeconds)}）` : base;
    }
    const goalText = view.goal > 0 ? ` · 达标 ${view.goalDays} 天` : '';
    const bestText = view.bestDay
      ? ` · 最高 ${view.bestDay.day.slice(5)}（${formatChars(view.bestDay.chars)}）`
      : '';
    const prefix = view.isCurrentMonth ? '本月' : `${view.month}月`;
    return `${prefix} ${formatChars(view.total)} · 写了 ${view.writtenDays} 天 · 日均 ${formatChars(view.average)}${goalText}${bestText}${durationText}`;
  }

  async function loadStatsCalendar(year, month) {
    try {
      const data = await call(api.getStatsCalendar, { year, month });
      if (data && data.calendar) state.calendar = data.calendar;
      if (data && data.streak) state.streak = data.streak;
      renderStatsCalendar();
      return state.calendar;
    } catch (err) {
      const summaryEl = $('calendar-summary');
      if (summaryEl) summaryEl.textContent = `读取码字日历失败：${err.message}`;
      return null;
    }
  }

  // 只允许往前 / 回到本月，不翻到未来（未来月份没有码字记录，翻过去只会看到空格子）。
  async function shiftStatsCalendar(delta) {
    const step = Math.trunc(Number(delta));
    if (!Number.isFinite(step) || step === 0) return false;
    const next = shiftYearMonth(statsCalendarCursor(), step);
    const now = currentYearMonth();
    if (compareYearMonth(next, now) > 0) return false;
    if (next.year < 1970) return false;
    return loadStatsCalendar(next.year, next.month);
  }

  async function goToCurrentCalendarMonth() {
    const now = currentYearMonth();
    return loadStatsCalendar(now.year, now.month);
  }

  function appendCalendarBlank(grid) {
    const blank = document.createElement('div');
    blank.className = 'cal-day empty';
    grid.appendChild(blank);
  }

  function renderStatsCalendar() {
    const grid = $('calendar-grid');
    if (!grid) return;
    const view = state.calendar;
    const weekdaysEl = $('calendar-weekdays');
    const labelEl = $('calendar-label');
    const summaryEl = $('calendar-summary');
    const streakEl = $('calendar-streak');
    const prevBtn = $('calendar-prev');
    const nextBtn = $('calendar-next');
    const todayBtn = $('calendar-today');

    if (weekdaysEl && weekdaysEl.childElementCount === 0) {
      const labels = (view && Array.isArray(view.weekdayLabels) && view.weekdayLabels.length === 7)
        ? view.weekdayLabels
        : ['一', '二', '三', '四', '五', '六', '日'];
      for (const text of labels) {
        const cell = document.createElement('span');
        cell.textContent = text;
        weekdaysEl.appendChild(cell);
      }
    }

    if (!view) {
      if (labelEl) labelEl.textContent = '';
      grid.innerHTML = '';
      if (summaryEl) summaryEl.textContent = '还没有统计数据（保存一次后开始记录）';
      if (streakEl) streakEl.textContent = '';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (todayBtn) todayBtn.disabled = true;
      return;
    }

    if (labelEl) labelEl.textContent = view.label;
    const current = currentYearMonth();
    const isCurrent = view.year === current.year && view.month === current.month;
    if (prevBtn) prevBtn.disabled = view.year <= 1970 && view.month <= 1;
    if (nextBtn) nextBtn.disabled = isCurrent;
    if (todayBtn) todayBtn.disabled = isCurrent;

    grid.innerHTML = '';
    for (let i = 0; i < view.firstWeekday; i += 1) appendCalendarBlank(grid);
    for (const item of view.days) {
      const cell = document.createElement('div');
      cell.className = 'cal-day';
      if (item.written) cell.classList.add('written', `lv${item.level}`);
      if (item.goalMet) cell.classList.add('goal-met');
      if (item.today) cell.classList.add('today');
      if (item.future) cell.classList.add('future');
      cell.dataset.day = item.day;
      cell.dataset.chars = String(item.chars);
      cell.dataset.seconds = String(item.seconds || 0);
      cell.dataset.level = String(item.level);
      cell.dataset.goalMet = item.goalMet ? '1' : '0';
      const num = document.createElement('span');
      num.textContent = String(item.dayOfMonth);
      cell.appendChild(num);
      cell.title =
        `${item.day} · ${item.chars > 0 ? formatChars(item.chars) : '没写'}` +
        (item.seconds > 0 ? ` · 用时 ${formatDuration(item.seconds)}` : '') +
        (item.goalMet ? ' · 已达标' : '') +
        (item.today ? ' · 今天' : '') +
        (item.future ? ' · 还没到' : '');
      grid.appendChild(cell);
    }
    const filled = view.firstWeekday + view.days.length;
    const tail = (7 - (filled % 7)) % 7;
    for (let i = 0; i < tail; i += 1) appendCalendarBlank(grid);

    if (summaryEl) summaryEl.textContent = calendarSummaryText(view);
    if (streakEl) {
      streakEl.textContent = calendarStreakLabel(state.streak);
      streakEl.classList.toggle('off', !(state.streak && state.streak.current > 0));
    }
  }

  // ---------- 写作时长（v0.8-2，提案 N2，参考口袋写作 tb_stat.writeDuration） ----------
  // 默认关：设置里打开后才在状态栏出现「写作计时」按钮。
  // 语义 = 秒表：只在你手动点开始时按实际经过时间累计秒数，暂停 / 回书架 / 关窗时停；
  // 不读正文、不记按键、不做番茄钟倒计时；秒数按天存 userData/stats.json（和字数同一份）。
  function writeDurationEnabled() {
    return Boolean(state.config && state.config.writeDurationEnabled === true);
  }

  function writeTimerTodaySeconds() {
    const stats = state.stats || {};
    return Math.max(0, Math.round(Number(stats.todaySeconds) || 0));
  }

  // 只用于界面显示：已上报的今天秒数 + 还在内存里没上报的整秒
  function writeTimerTodaySecondsLive() {
    return writeTimerTodaySeconds() + Math.floor(writeTimerUnsentMs() / 1000);
  }

  function writeTimerSegmentMs() {
    const t = state.writeTimer;
    return t.running ? Math.max(0, Date.now() - t.segmentStart) : 0;
  }

  function writeTimerSessionMs() {
    return Math.max(0, state.writeTimer.sessionMs + writeTimerSegmentMs());
  }

  function writeTimerSessionSeconds() {
    return Math.floor(writeTimerSessionMs() / 1000);
  }

  function writeTimerUnsentMs() {
    return Math.max(0, state.writeTimer.unsentMs + writeTimerSegmentMs());
  }

  function renderWriteTimer() {
    const btn = $('btn-write-timer');
    if (!btn) return;
    const visible = state.view === 'editor' && Boolean(state.bookPath) && writeDurationEnabled();
    btn.classList.toggle('hidden', !visible);
    if (!visible) return;
    const t = state.writeTimer;
    const seconds = writeTimerSessionSeconds();
    const label = $('write-timer-text');
    if (label) {
      if (t.running) label.textContent = `计时 ${formatStopwatch(seconds)}`;
      else if (seconds > 0) label.textContent = `已暂停 ${formatStopwatch(seconds)}`;
      else label.textContent = '写作计时';
    }
    btn.classList.toggle('running', t.running === true);
    btn.classList.toggle('paused', !t.running && seconds > 0);
    const todayText = formatDuration(writeTimerTodaySecondsLive());
    btn.title =
      (t.running ? '正在计时：点一下暂停（只记时长，不记内容）' : '点击开始写作计时（只记时长，不记内容）') +
      `。今天已写 ${writeTimerTodaySecondsLive() > 0 ? todayText : '0 秒'}` +
      (t.running || seconds > 0 ? ` · 本次 ${formatStopwatch(seconds)}` : '');
  }

  // 设置 →「写作统计」里的时长状态（未开启 / 今天 / 近 30 天）
  // 注意：这里只更新状态文字，不回填 checkbox（否则会把用户还没保存的勾选改掉）。
  function renderDurationSettings() {
    const summary = $('settings-duration-summary');
    if (!summary) return;
    if (!writeDurationEnabled()) {
      summary.textContent = '未开启（默认关；开启后只在写作页点「写作计时」时累计，不记录任何内容）';
      summary.className = 'muted small';
      return;
    }
    const stats = state.stats || {};
    const recent = Math.max(0, Math.round(Number(stats.recentSeconds) || 0));
    const today = writeTimerTodaySecondsLive();
    summary.textContent =
      `今天写作 ${formatDuration(today)} · 近 30 天 ${formatDuration(recent)}` +
      (state.writeTimer.running ? ' · 正在计时' : '');
    summary.className = 'muted small';
  }

  function stopWriteTimerTicker() {
    const t = state.writeTimer;
    if (t.flushTimer) clearInterval(t.flushTimer);
    if (t.tickTimer) clearInterval(t.tickTimer);
    t.flushTimer = null;
    t.tickTimer = null;
  }

  function startWriteTimerTicker() {
    const t = state.writeTimer;
    stopWriteTimerTicker();
    t.flushTimer = setInterval(() => {
      void flushWriteTimer();
    }, WRITE_TIMER_FLUSH_MS);
    // 只刷新按钮上的秒表文字，不写盘、不碰正文
    t.tickTimer = setInterval(() => renderWriteTimer(), 1000);
  }

  function startWriteTimer() {
    if (!writeDurationEnabled() || state.view !== 'editor' || !state.bookPath) return false;
    const t = state.writeTimer;
    if (t.running) return true;
    t.running = true;
    t.segmentStart = Date.now();
    startWriteTimerTicker();
    renderWriteTimer();
    renderDurationSettings();
    return true;
  }

  // 上报串行化：暂停 / 保存 / 30 秒定时 可能同时触发，排队执行才不会重复扣零头
  let writeTimerQueue = Promise.resolve();

  function flushWriteTimer() {
    const run = writeTimerQueue.then(
      () => flushWriteTimerNow(),
      () => flushWriteTimerNow()
    );
    writeTimerQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function flushWriteTimerNow() {
    const t = state.writeTimer;
    if (t.running) {
      const now = Date.now();
      const delta = Math.max(0, now - t.segmentStart);
      t.segmentStart = now;
      t.sessionMs += delta;
      t.unsentMs += delta;
    }
    const seconds = Math.floor(t.unsentMs / 1000);
    // 关掉记录时不写盘：配置切换前会先 flush 一次，这里只是兜底。
    if (seconds <= 0 || !writeDurationEnabled()) {
      renderWriteTimer();
      return 0;
    }
    t.unsentMs -= seconds * 1000;
    try {
      const res = await call(api.addStatsDuration, { seconds });
      if (res && res.stats) {
        state.stats = res.stats;
        if (res.stats.streak) state.streak = res.stats.streak;
        renderStatsUi();
      }
      return (res && res.recorded) || 0;
    } catch {
      // 统计写失败不能影响写作：把秒数放回去，下次暂停 / 保存 / 定时再试
      t.unsentMs += seconds * 1000;
      return 0;
    }
  }

  async function pauseWriteTimer() {
    const t = state.writeTimer;
    await flushWriteTimer();
    t.running = false;
    t.segmentStart = 0;
    stopWriteTimerTicker();
    renderWriteTimer();
    renderDurationSettings();
    return true;
  }

  // 离开这本书 / 回书架 / 关窗：先把没上报的整秒发出去，再清空本次秒表。
  async function resetWriteTimer({ flush = true } = {}) {
    if (flush) await flushWriteTimer();
    const t = state.writeTimer;
    t.running = false;
    t.segmentStart = 0;
    t.sessionMs = 0;
    t.unsentMs = 0;
    stopWriteTimerTicker();
    renderWriteTimer();
    renderDurationSettings();
  }

  // 设置保存后调用：关掉时立刻停表并隐藏按钮；开启时按钮跟着出现。
  function applyWriteTimerConfig() {
    if (!writeDurationEnabled()) {
      void resetWriteTimer({ flush: false });
    } else {
      renderWriteTimer();
      renderDurationSettings();
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
    // 朗读读的是「打开那一刻」的正文：改了字就停，别让进度 / 跟随高亮对不上新正文
    if (state.tts.open) {
      closeTtsBar();
      toast('正文已修改，朗读已停止');
    }
    state.lastEditAt = Date.now();
    const dirty = editorEl.value !== state.baseText;
    if (dirty !== state.dirty) state.dirty = dirty;
    if (state.dirty) state.saveError = null;
    const activeItem = $('chapter-list').querySelector('.chapter-item.active');
    if (activeItem) activeItem.classList.toggle('dirty', state.dirty);
    updateStatus();
    renderSelectionStats();
    // 输入法拼字中先不重画标记层（I 键过程中的中间态会闪），拼完 compositionend 再画
    if (!state.marks.composing) scheduleMarksRender();
    // 打字机模式：打完字把光标行放回上方约 1/3 处（只调滚动，不改字）
    if (focusActive() && state.focus.typewriter) scheduleTypewriterAlign(30);
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
      // 专注模式下切了章：退出的还原点改到新章开头，不要把上一章的光标 / 滚动套过来
      if (state.focus.on) {
        state.focus.savedScrollTop = 0;
        state.focus.savedCaret = 0;
        state.focus.savedCaretOffset = 0;
      }
      // 切章后正在念的已经不是眼前这一章了，立刻停
      stopTtsForChapterChange();
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      renderSelectionStats();
      scheduleMarksRender(0);
      if (state.focus.typewriter) scheduleTypewriterAlign(0);
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
        if (data.stats.streak) state.streak = data.stats.streak;
        renderStatsUi();
      }
      // 写作时长：保存时顺手把还没上报的整秒记下（只影响统计，失败不影响保存结果）
      if (state.writeTimer.running || state.writeTimer.unsentMs > 0) void flushWriteTimer();
      // 保存后同步本章字数缓存：章节列表的字数 / 「比上章短」提示跟着更新
      if (Number.isFinite(Number(data.chars))) {
        chapter.chars = Number(data.chars);
        renderChapterList();
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
    // 释放「打开中的书」登记：关掉这个窗口 / 回书架后，别的窗口就能打开这本书
    try {
      await api.releaseBook();
    } catch {
      /* 释放失败由主进程在窗口销毁时兜底 */
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
    // 关窗前先把写作计时里没上报的整秒记下（异步：统计写失败也不影响关窗判断）
    await flushWriteTimer();
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
    // 书目损坏的书读不出元数据，先修复；不让「书籍信息…」点进去报错
    const infoBtn = menu.querySelector('button[data-action="info"]');
    if (infoBtn) infoBtn.classList.toggle('hidden', Boolean(book && book.status === 'corrupt'));
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
    if (!$('proofread-backdrop').classList.contains('hidden')) closeProofreadPanel();
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

  // ---------- 灵感箱（碎片速记；提案 3.4） ----------
  // 碎片是书架根目录 _碎片 里的普通 txt：文件名 / 原子写 / 防覆盖都在主进程 core/fragments.js（有单测）。
  // 这里只做两个弹层：书架「＋ 碎片」记一条；写作页「插入碎片…」把选中的一条插到光标处。
  // 插入只改编辑区、不写盘，原碎片文件永远保留（不提供「用后删除」，删除只走回收站 / _trash 的规矩）。
  function updateFragmentCounter() {
    $('fragment-counter').textContent = `${countChars($('fragment-text').value)} 字`;
  }

  function setFragmentSaveState(text, kind = '') {
    const el = $('fragment-save-state');
    el.textContent = text || '';
    el.classList.toggle('fragment-error', kind === 'error');
  }

  function openFragmentDialog() {
    hideFormatMenu();
    hideExportMenu();
    $('fragment-text').value = '';
    setFragmentSaveState('');
    updateFragmentCounter();
    $('fragment-backdrop').classList.remove('hidden');
    setTimeout(() => {
      const el = $('fragment-text');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 30);
    return true;
  }

  function closeFragmentDialog() {
    $('fragment-backdrop').classList.add('hidden');
  }

  async function saveFragment() {
    if (state.fragmentBusy) return { ok: false, message: '正在保存…' };
    const text = $('fragment-text').value;
    if (!countChars(text)) {
      setFragmentSaveState('碎片内容是空的，写点什么再保存吧', 'error');
      $('fragment-text').focus();
      return { ok: false, message: '碎片内容是空的' };
    }
    state.fragmentBusy = true;
    $('btn-fragment-save').disabled = true;
    setFragmentSaveState('正在保存…');
    try {
      const data = await call(api.createFragment, text);
      closeFragmentDialog();
      toast(`碎片已保存：_碎片\\${data.name}（${data.chars} 字）`);
      // 插入面板如果正开着（理论上不会，但别让列表和磁盘对不上）
      if (!$('fragments-backdrop').classList.contains('hidden')) await refreshFragments();
      return { ok: true, name: data.name, path: data.path, chars: data.chars, bytes: data.bytes };
    } catch (err) {
      setFragmentSaveState(`保存失败：${err.message}`, 'error');
      toast(`保存碎片失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    } finally {
      state.fragmentBusy = false;
      $('btn-fragment-save').disabled = false;
    }
  }

  function fragmentSizeText(size) {
    const bytes = Math.max(0, Number(size) || 0);
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function fragmentMetaText(fragment) {
    const time = formatRelativeTime(fragment.mtimeMs);
    if (fragment.date) return `${fragment.date} · 第 ${fragment.seq} 条 · ${time}`;
    return `手工放入的 txt · ${time}`;
  }

  function openInsertFragmentDialog() {
    if (!state.bookPath) {
      toast('先打开一本书再插入碎片', 'warn');
      return false;
    }
    hideFormatMenu();
    hideExportMenu();
    // 记下打开面板前的位置：弹层期间点列表/预览不会把光标位置弄丢
    state.insertFragmentRange = {
      start: editorEl.selectionStart || 0,
      end: editorEl.selectionEnd || 0
    };
    state.fragmentSelected = null;
    $('fragment-preview').textContent = '';
    $('fragment-preview-name').textContent = '选一条碎片看内容';
    $('btn-fragment-insert').disabled = true;
    const range = state.insertFragmentRange;
    $('fragment-hint').textContent =
      range.end > range.start
        ? `将替换打开面板前选中的第 ${range.start + 1}–${range.end} 字；只改编辑区、不写盘，原碎片文件保留。`
        : `将插在打开面板前的光标处（第 ${range.start + 1} 字）；只改编辑区、不写盘，原碎片文件保留。`;
    $('fragments-backdrop').classList.remove('hidden');
    refreshFragments();
    return true;
  }

  function closeInsertFragmentDialog() {
    $('fragments-backdrop').classList.add('hidden');
  }

  function highlightSelectedFragment(name) {
    const items = document.querySelectorAll('#fragments-list .fragment-item');
    items.forEach((item) => item.classList.toggle('selected', item.dataset.name === name));
  }

  function renderFragments(data) {
    const list = $('fragments-list');
    const summary = $('fragments-summary');
    list.innerHTML = '';
    if (!data.fragments.length) {
      const empty = document.createElement('div');
      empty.className = 'fragment-empty';
      empty.textContent = '还没有碎片。回书架点「＋ 碎片」记一条；直接放进 _碎片 文件夹的 txt 也会出现在这里。';
      list.appendChild(empty);
      summary.textContent = '共 0 条碎片';
      return;
    }
    summary.textContent = `共 ${data.total} 条碎片（最新在前）${
      data.truncated ? `，只列出前 ${data.fragments.length} 条` : ''
    }`;
    for (const fragment of data.fragments) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'fragment-item';
      item.dataset.name = fragment.name;
      const name = document.createElement('div');
      name.className = 'fragment-item-name';
      name.textContent = fragment.name;
      name.title = fragment.name;
      item.appendChild(name);
      const meta = document.createElement('div');
      meta.className = 'fragment-item-meta';
      meta.textContent = `${fragmentMetaText(fragment)} · ${fragmentSizeText(fragment.size)}`;
      item.appendChild(meta);
      const preview = document.createElement('div');
      preview.className = 'fragment-item-preview';
      preview.textContent = fragment.preview || '（空文件）';
      item.appendChild(preview);
      item.addEventListener('click', () => {
        selectFragmentByName(fragment.name);
      });
      list.appendChild(item);
    }
  }

  async function refreshFragments() {
    const summary = $('fragments-summary');
    summary.textContent = '正在读取 _碎片…';
    let data;
    try {
      data = await call(api.listFragments);
    } catch (err) {
      summary.textContent = `读取碎片失败：${err.message}`;
      $('fragments-list').innerHTML = '';
      state.fragments = [];
      state.fragmentSelected = null;
      $('btn-fragment-insert').disabled = true;
      return { ok: false, message: err.message };
    }
    state.fragments = data.fragments;
    renderFragments(data);
    // 打开 / 刷新后默认选中第一条（只读预览，不会自动插进正文）
    if (data.fragments.length) await selectFragmentByName(data.fragments[0].name);
    return { ok: true, total: data.total, truncated: data.truncated, fragments: data.fragments };
  }

  async function selectFragmentByName(name) {
    const fragment = (state.fragments || []).find((item) => item.name === name);
    if (!fragment) return { ok: false, message: '这条碎片已经不在列表里了' };
    state.fragmentSelected = null;
    $('btn-fragment-insert').disabled = true;
    try {
      const data = await call(api.readFragment, name);
      state.fragmentSelected = data;
      $('fragment-preview-name').textContent = `${data.name} · ${data.chars} 字 · ${fragmentSizeText(data.size)}`;
      // 预览只塞前 2 万字进 DOM（几十万字的碎片也不卡界面）；插入时仍然是完整内容。
      const previewLimit = 20000;
      $('fragment-preview').textContent =
        data.text.length > previewLimit
          ? `${data.text.slice(0, previewLimit)}\n…（预览只显示前 ${previewLimit} 字，插入的是完整内容）`
          : data.text;
      $('btn-fragment-insert').disabled = false;
      highlightSelectedFragment(name);
      return { ok: true, name: data.name, chars: data.chars, size: data.size };
    } catch (err) {
      $('fragment-preview-name').textContent = '读取碎片失败';
      $('fragment-preview').textContent = err.message;
      toast(`读取碎片失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    }
  }

  // 插入：用 execCommand('insertText') 走原生输入，保住 Ctrl+Z；失败时手动拼接兜底。
  // 只改编辑区（onEditorInput 会标未保存），绝不自动保存、绝不删除原碎片。
  function insertSelectedFragment() {
    const fragment = state.fragmentSelected;
    if (!fragment) return { ok: false, message: '先选一条碎片' };
    if (!state.bookPath) return { ok: false, message: '先打开一本书' };
    const length = editorEl.value.length;
    const range = state.insertFragmentRange || { start: editorEl.selectionStart || 0, end: editorEl.selectionEnd || 0 };
    const start = Math.max(0, Math.min(Number(range.start) || 0, length));
    const end = Math.max(start, Math.min(Number(range.end) || start, length));
    const before = editorEl.value;
    editorEl.focus();
    editorEl.setSelectionRange(start, end);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, fragment.text);
    } catch {
      inserted = false;
    }
    const expectedLength = before.length - (end - start) + fragment.text.length;
    if (!inserted || editorEl.value.length !== expectedLength) {
      // 极端兜底：execCommand 不可用时手动拼接（会丢原生撤销链，但不会丢内容）
      editorEl.value = before.slice(0, start) + fragment.text + before.slice(end);
      editorEl.setSelectionRange(start + fragment.text.length, start + fragment.text.length);
    }
    onEditorInput();
    scrollCaretIntoView(editorEl.selectionStart || 0);
    closeInsertFragmentDialog();
    toast(`已插入碎片 ${fragment.name}（${fragment.chars} 字）· 仍是未保存，Ctrl+S 写盘`);
    return {
      ok: true,
      name: fragment.name,
      chars: fragment.chars,
      start,
      end,
      dirty: state.dirty,
      textLength: editorEl.value.length
    };
  }

  // ---------- 校对（只报告，不改动；提案 5.1） ----------
  // 规则 / 阈值都在主进程 core/proofread.js（单测覆盖）；这里只负责面板、结果列表和「点一条跳过去」。
  // 和查找一样：当前章用编辑区里的内容（未保存也算，只参与检查）；整本由主进程逐章只读磁盘。
  const PROOFREAD_ROW_LIMIT = 300;
  const PROOFREAD_RULE_ORDER = ['halfwidth-punct', 'long-paragraph', 'repeat-word', 'punct-run', 'blank-lines'];
  const PROOFREAD_RULE_LABELS = {
    'halfwidth-punct': '半角标点',
    'long-paragraph': '超长段落',
    'repeat-word': '重复用词',
    'punct-run': '连续标点',
    'blank-lines': '多余空行'
  };

  function openProofreadPanel() {
    if (!state.bookPath) {
      toast('先打开一本书再校对', 'warn');
      return false;
    }
    hideFormatMenu();
    hideExportMenu();
    if (!$('find-backdrop').classList.contains('hidden')) closeFindPanel();
    $('proofread-scope').value = state.proofreadScope === 'book' ? 'book' : 'current';
    $('proofread-backdrop').classList.remove('hidden');
    // 打开就先检查一遍当前章，不用再点一次；整本要作者自己点「开始校对」
    runProofread();
    return true;
  }

  function closeProofreadPanel() {
    $('proofread-backdrop').classList.add('hidden');
  }

  function proofreadScope() {
    return $('proofread-scope').value === 'book' ? 'book' : 'current';
  }

  // 当前章的最新内容（未保存也算；只用于这一次检查，不写盘）
  function currentChapterRef() {
    const chapter = state.chapters[state.index];
    if (!chapter) return null;
    return { chapterId: chapter.id, chapterFile: chapter.file, text: editorEl.value };
  }

  function proofreadRuleSummary(counts) {
    return PROOFREAD_RULE_ORDER.filter((rule) => counts && counts[rule])
      .map((rule) => `${PROOFREAD_RULE_LABELS[rule]} ${counts[rule]}`)
      .join(' · ');
  }

  function setProofreadBusy(busy) {
    state.proofreadBusy = Boolean(busy);
    $('proofread-busy').classList.toggle('hidden', !busy);
    $('btn-proofread-run').disabled = Boolean(busy);
  }

  function proofreadChapterTitle(issue) {
    let index = Number(issue.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === issue.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === issue.chapterId);
    if (index < 0) return String(issue.chapterName || '').trim() || '（已删除的章节）';
    return chapterTitle(index, issue.chapterName);
  }

  function proofreadPositionText(issue) {
    const line = Number(issue.line);
    const column = Number(issue.column);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return '';
    return `第 ${line} 行 · 第 ${column} 字`;
  }

  function renderProofreadSummary() {
    const payload = state.proofread;
    const summary = $('proofread-summary');
    if (!payload) {
      summary.textContent = '';
      return;
    }
    const rules = proofreadRuleSummary(payload.byRule);
    const truncatedNote = payload.truncated ? '（明细只列出一部分，总数照实统计）' : '';
    if (payload.scope === 'book') {
      const hit = Number(payload.chapterHitCount) || 0;
      const skipped = Number(payload.skippedChapters) || 0;
      summary.textContent = payload.total
        ? `全书 ${payload.chapterCount} 章共 ${payload.total} 处可疑，涉及 ${hit} 章：${rules}${truncatedNote}`
        : `全书 ${payload.chapterCount} 章没有发现可疑的地方${
            skipped ? `（跳过 ${skipped} 个缺文件的章节）` : ''
          }`;
      return;
    }
    summary.textContent = payload.total
      ? `本章共 ${payload.total} 处可疑：${rules}${truncatedNote}`
      : '本章没有发现可疑的地方（只检查空白、标点、段落长度和重复用词，不判断文字好坏）';
  }

  function renderProofreadResults() {
    const box = $('proofread-results');
    box.innerHTML = '';
    const payload = state.proofread;
    if (!payload) return;
    if (!payload.issues.length) {
      const empty = document.createElement('div');
      empty.className = 'proofread-empty';
      empty.textContent = payload.scope === 'book' ? '整本书没有发现可疑的地方' : '这一章没有发现可疑的地方';
      box.appendChild(empty);
      return;
    }
    const rows = payload.issues.slice(0, PROOFREAD_ROW_LIMIT);
    for (const issue of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proofread-result';
      row.dataset.rule = issue.rule;
      row.dataset.chapterId = issue.chapterId == null ? '' : issue.chapterId;
      row.dataset.index = String(issue.index);

      const head = document.createElement('div');
      head.className = 'proofread-head';
      const rule = document.createElement('span');
      rule.className = `proofread-rule rule-${issue.rule}`;
      rule.textContent = PROOFREAD_RULE_LABELS[issue.rule] || '可疑';
      head.appendChild(rule);
      if (payload.scope === 'book') {
        const chapter = document.createElement('span');
        chapter.className = 'proofread-chapter';
        chapter.textContent = proofreadChapterTitle(issue);
        head.appendChild(chapter);
      }
      const pos = document.createElement('span');
      pos.className = 'proofread-pos';
      pos.textContent = proofreadPositionText(issue);
      head.appendChild(pos);

      const message = document.createElement('div');
      message.className = 'proofread-message';
      message.textContent = issue.message || '';

      const snippet = document.createElement('div');
      snippet.className = 'proofread-snippet';
      if (issue.snippet) {
        if (issue.snippet.ellipsisStart) snippet.appendChild(document.createTextNode('…'));
        snippet.appendChild(document.createTextNode(issue.snippet.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = issue.snippet.match || '';
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(issue.snippet.after || ''));
        if (issue.snippet.ellipsisEnd) snippet.appendChild(document.createTextNode('…'));
      }
      row.append(head, message, snippet);
      row.addEventListener('click', () => jumpToProofreadIssue(issue));
      box.appendChild(row);
    }
    if (payload.issues.length > rows.length) {
      const more = document.createElement('div');
      more.className = 'proofread-more';
      more.textContent = `还有 ${payload.issues.length - rows.length} 条没有显示（一次最多列 ${PROOFREAD_ROW_LIMIT} 条；可以先只校对当前章）`;
      box.appendChild(more);
    }
  }

  // 正文可能在上次检查之后被改过：先按位置核对，对不上就在附近再找一次，找不到就落回原位置
  // （校对 / 敏感词预检共用：都是「按 index + 命中的文字」在编辑区里定位）
  function matchRangeAt(text, issue) {
    const source = String(text == null ? '' : text);
    const match = String(issue.match || '');
    const fallbackStart = Math.min(Math.max(0, Number(issue.index) || 0), source.length);
    if (!match) {
      const length = Math.max(1, Math.min(Number(issue.length) || 1, source.length - fallbackStart));
      return { start: fallbackStart, end: fallbackStart + length };
    }
    if (source.slice(fallbackStart, fallbackStart + match.length) === match) {
      return { start: fallbackStart, end: fallbackStart + match.length };
    }
    const near = source.indexOf(match, Math.max(0, fallbackStart - 500));
    if (near >= 0) return { start: near, end: near + match.length };
    return {
      start: fallbackStart,
      end: Math.min(source.length, fallbackStart + Math.max(match.length, 1))
    };
  }

  async function jumpToProofreadIssue(issue) {
    if (!state.bookPath) return { ok: false };
    let index = Number(issue.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === issue.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === issue.chapterId);
    // 兜底：当前章的结果万一没带章信息，就落在正在看的这一章
    if (index < 0 && issue.chapterId == null) index = state.index;
    if (index < 0) {
      toast('这一章已经不存在了', 'warn');
      return { ok: false };
    }
    closeProofreadPanel();
    if (index !== state.index) {
      const switched = await switchChapter(index);
      if (!switched || switched.ok === false) {
        return { ok: false, canceled: Boolean(switched && switched.canceled) };
      }
    }
    const range = matchRangeAt(editorEl.value, issue);
    editorEl.focus();
    editorEl.setSelectionRange(range.start, range.end);
    scrollCaretIntoView(range.start);
    return { ok: true, start: range.start, end: range.end };
  }

  async function runProofread() {
    if (!state.bookPath || !state.chapters.length) {
      $('proofread-summary').textContent = '这本书里还没有章节';
      return { ok: false, message: '没有章节' };
    }
    if (state.proofreadBusy) return { ok: false, message: '正在校对中' };
    const scope = proofreadScope();
    state.proofreadScope = scope;
    setProofreadBusy(true);
    $('proofread-summary').textContent =
      scope === 'book' ? '正在通读全书（只读，不改正文）…' : '正在检查当前章…';
    $('proofread-results').innerHTML = '';
    try {
      let payload;
      if (scope === 'book') {
        const override = currentChapterRef();
        payload = await call(api.proofreadBook, state.bookPath, {}, override);
        payload.scope = 'book';
      } else {
        const res = await call(api.proofreadText, editorEl.value, {});
        const chapter = state.chapters[state.index];
        // 当前章的结果也带上章信息，点结果时才能定位（和整本结果结构保持一致）
        payload = {
          ...res,
          issues: res.issues.map((issue) => ({
            ...issue,
            chapterId: chapter ? chapter.id : null,
            chapterIndex: state.index,
            chapterName: chapter ? chapter.name : ''
          })),
          scope: 'current',
          chapterId: chapter ? chapter.id : null,
          chapterIndex: state.index,
          chapterName: chapter ? chapter.name : '',
          chapters: res.total
            ? [
                {
                  chapterId: chapter ? chapter.id : null,
                  chapterIndex: state.index,
                  name: chapter ? chapter.name : '',
                  total: res.total,
                  byRule: res.byRule,
                  truncated: res.truncated
                }
              ]
            : []
        };
      }
      state.proofread = payload;
      renderProofreadSummary();
      renderProofreadResults();
      return { ok: true, total: payload.total, scope: payload.scope };
    } catch (err) {
      state.proofread = null;
      $('proofread-summary').textContent = `校对失败：${err.message}`;
      $('proofread-results').innerHTML = '';
      return { ok: false, message: err.message };
    } finally {
      setProofreadBusy(false);
    }
  }

  // ---------- 敏感词预检（只报告，不改动；提案 5.2） ----------
  // 词表完全由作者管理：应用不内置任何词表，只按作者在设置里选的 txt（每行一个词）报告命中。
  // 当前章用编辑区内容（未保存也算，只参与检查）；整本由主进程逐章只读磁盘，全程不写盘。
  const SENSITIVE_ROW_LIMIT = 300;

  // 词表状态文案（面板 / 设置共用）：未设置、文件没了、编码坏了都直说
  function sensitiveWordListText(info) {
    if (!info) return '正在读取词表…';
    if (!info.ok) {
      if (info.code === 'WORD_LIST_NOT_CONFIGURED') {
        return '还没有指定词表（应用不内置词表，请选一个自己的 txt）';
      }
      return info.message || '词表读取失败';
    }
    let text = `词表：${info.name}（${info.count} 个词）`;
    const skipped = [];
    if (info.stats && info.stats.duplicates) skipped.push(`${info.stats.duplicates} 个重复`);
    if (info.stats && info.stats.tooLong) skipped.push(`${info.stats.tooLong} 行超长`);
    if (info.stats && info.stats.truncated) skipped.push('超过 5000 个只取前 5000 个');
    if (skipped.length) text += `（已跳过 ${skipped.join('、')}）`;
    return text;
  }

  function renderSensitiveWordList() {
    const el = $('sensitive-wordlist-text');
    if (!el) return;
    const info = state.sensitiveWordList;
    el.textContent = sensitiveWordListText(info);
    el.classList.toggle('warn', Boolean(info && info.ok === false));
  }

  // 只读：取当前配置里的词表状态（不把词表内容带到渲染层）
  async function refreshSensitiveWordList() {
    try {
      state.sensitiveWordList = await call(api.sensitiveWordsInfo);
    } catch (err) {
      state.sensitiveWordList = { ok: false, code: 'ERROR', message: `读取词表失败：${err.message}` };
    }
    renderSensitiveWordList();
    return state.sensitiveWordList;
  }

  async function openSensitivePanel() {
    if (!state.bookPath) {
      toast('先打开一本书再预检', 'warn');
      return false;
    }
    hideFormatMenu();
    hideExportMenu();
    if (!$('find-backdrop').classList.contains('hidden')) closeFindPanel();
    if (!$('proofread-backdrop').classList.contains('hidden')) closeProofreadPanel();
    $('sensitive-scope').value = state.sensitiveScope === 'book' ? 'book' : 'current';
    $('sensitive-backdrop').classList.remove('hidden');
    await refreshSensitiveWordList();
    // 词表可用就先检查一遍当前章，不用再点一次；词表有问题只显示提示
    if (state.sensitiveWordList && state.sensitiveWordList.ok) {
      await runSensitiveCheck();
    } else {
      state.sensitive = null;
      renderSensitiveSummary();
      renderSensitiveResults();
    }
    return true;
  }

  function closeSensitivePanel() {
    $('sensitive-backdrop').classList.add('hidden');
  }

  function sensitiveScope() {
    return $('sensitive-scope').value === 'book' ? 'book' : 'current';
  }

  function setSensitiveBusy(busy) {
    state.sensitiveBusy = Boolean(busy);
    $('sensitive-busy').classList.toggle('hidden', !busy);
    $('btn-sensitive-run').disabled = Boolean(busy);
  }

  function sensitiveChapterTitle(match) {
    let index = Number(match.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === match.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === match.chapterId);
    if (index < 0) return String(match.chapterName || '').trim() || '（已删除的章节）';
    return chapterTitle(index, match.chapterName);
  }

  function sensitivePositionText(match) {
    const line = Number(match.line);
    const column = Number(match.column);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return '';
    return `第 ${line} 行 · 第 ${column} 字`;
  }

  function sensitiveWordSummary(payload) {
    if (!payload.byWord || !payload.byWord.length) return '';
    return (
      '：' +
      payload.byWord
        .slice(0, 6)
        .map((item) => `${item.word} ${item.count}`)
        .join(' · ')
    );
  }

  function renderSensitiveSummary() {
    const summary = $('sensitive-summary');
    if (!summary) return;
    const payload = state.sensitive;
    const info = state.sensitiveWordList;
    if (!payload) {
      if (info && info.ok) {
        summary.textContent = '点「开始预检」检查当前章；切成整本后点一次会通读全书。';
      } else if (info) {
        summary.textContent = info.message || '词表不可用';
      } else {
        summary.textContent = '';
      }
      return;
    }
    if (payload.ok === false) {
      summary.textContent = payload.message || '词表不可用';
      return;
    }
    const truncatedNote = payload.truncated ? '（明细只列出一部分）' : '';
    const words = sensitiveWordSummary(payload);
    if (payload.scope === 'book') {
      const skipped = Number(payload.skippedChapters) || 0;
      summary.textContent = payload.total
        ? `全书 ${payload.chapterCount} 章命中 ${payload.total} 处，涉及 ${payload.chapterHitCount} 章、${payload.wordHitCount} 个词${words}${truncatedNote}`
        : `全书 ${payload.chapterCount} 章没有命中词表里的词${
            skipped ? `（跳过 ${skipped} 个缺文件的章节）` : ''
          }`;
      return;
    }
    summary.textContent = payload.total
      ? `本章命中 ${payload.total} 处，涉及 ${payload.wordHitCount} 个词${words}${truncatedNote}`
      : '本章没有命中词表里的词（只按你的词表做字面匹配，不判断文字好坏）';
  }

  function renderSensitiveResults() {
    const box = $('sensitive-results');
    if (!box) return;
    box.innerHTML = '';
    const payload = state.sensitive;
    if (!payload || payload.ok === false) return;
    if (!payload.matches.length) {
      const empty = document.createElement('div');
      empty.className = 'proofread-empty';
      empty.textContent = payload.scope === 'book' ? '整本书没有命中词表里的词' : '这一章没有命中词表里的词';
      box.appendChild(empty);
      return;
    }
    const rows = payload.matches.slice(0, SENSITIVE_ROW_LIMIT);
    for (const match of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proofread-result sensitive-result';
      row.dataset.word = match.word;
      row.dataset.chapterId = match.chapterId == null ? '' : match.chapterId;
      row.dataset.index = String(match.index);

      const head = document.createElement('div');
      head.className = 'proofread-head';
      const word = document.createElement('span');
      word.className = 'proofread-rule sensitive-word';
      word.textContent = `「${match.word}」`;
      head.appendChild(word);
      if (payload.scope === 'book') {
        const chapter = document.createElement('span');
        chapter.className = 'proofread-chapter';
        chapter.textContent = sensitiveChapterTitle(match);
        head.appendChild(chapter);
      }
      const pos = document.createElement('span');
      pos.className = 'proofread-pos';
      pos.textContent = sensitivePositionText(match);
      head.appendChild(pos);

      const snippet = document.createElement('div');
      snippet.className = 'proofread-snippet';
      if (match.snippet) {
        if (match.snippet.ellipsisStart) snippet.appendChild(document.createTextNode('…'));
        snippet.appendChild(document.createTextNode(match.snippet.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = match.snippet.match || '';
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(match.snippet.after || ''));
        if (match.snippet.ellipsisEnd) snippet.appendChild(document.createTextNode('…'));
      }
      row.append(head, snippet);
      row.addEventListener('click', () => jumpToSensitiveMatch(match));
      box.appendChild(row);
    }
    if (payload.matches.length > rows.length) {
      const more = document.createElement('div');
      more.className = 'proofread-more';
      more.textContent = `还有 ${payload.matches.length - rows.length} 条没有显示（一次最多列 ${SENSITIVE_ROW_LIMIT} 条；可以先只预检当前章）`;
      box.appendChild(more);
    }
  }

  async function jumpToSensitiveMatch(match) {
    if (!state.bookPath) return { ok: false };
    let index = Number(match.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === match.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === match.chapterId);
    if (index < 0 && match.chapterId == null) index = state.index;
    if (index < 0) {
      toast('这一章已经不存在了', 'warn');
      return { ok: false };
    }
    closeSensitivePanel();
    if (index !== state.index) {
      const switched = await switchChapter(index);
      if (!switched || switched.ok === false) {
        return { ok: false, canceled: Boolean(switched && switched.canceled) };
      }
    }
    const range = matchRangeAt(editorEl.value, match);
    editorEl.focus();
    editorEl.setSelectionRange(range.start, range.end);
    scrollCaretIntoView(range.start);
    return { ok: true, start: range.start, end: range.end };
  }

  async function runSensitiveCheck() {
    if (!state.bookPath || !state.chapters.length) {
      $('sensitive-summary').textContent = '这本书里还没有章节';
      return { ok: false, message: '没有章节' };
    }
    if (state.sensitiveBusy) return { ok: false, message: '正在预检中' };
    const scope = sensitiveScope();
    state.sensitiveScope = scope;
    setSensitiveBusy(true);
    $('sensitive-summary').textContent =
      scope === 'book' ? '正在通读全书（只读，不改正文）…' : '正在检查当前章…';
    $('sensitive-results').innerHTML = '';
    try {
      let payload;
      if (scope === 'book') {
        const override = currentChapterRef();
        payload = await call(api.sensitiveCheckBook, state.bookPath, {}, override);
        payload.scope = 'book';
      } else {
        const chapter = state.chapters[state.index];
        const res = await call(api.sensitiveCheckText, editorEl.value, {});
        payload = res.ok === false
          ? {
              ...res,
              scope: 'current',
              total: 0,
              matches: [],
              byWord: [],
              wordHitCount: 0,
              chapterId: chapter ? chapter.id : null,
              chapterIndex: state.index,
              chapterName: chapter ? chapter.name : ''
            }
          : {
              ...res,
              // 当前章的结果也带上章信息，点结果时才能定位（和整本结果结构保持一致）
              matches: res.issues.map((issue) => ({
                ...issue,
                chapterId: chapter ? chapter.id : null,
                chapterIndex: state.index,
                chapterName: chapter ? chapter.name : ''
              })),
              scope: 'current',
              chapterId: chapter ? chapter.id : null,
              chapterIndex: state.index,
              chapterName: chapter ? chapter.name : ''
            };
      }
      state.sensitive = payload;
      if (payload.wordList) state.sensitiveWordList = payload.wordList;
      renderSensitiveWordList();
      renderSensitiveSummary();
      renderSensitiveResults();
      return { ok: payload.ok !== false, total: payload.total, scope: payload.scope };
    } catch (err) {
      state.sensitive = null;
      $('sensitive-summary').textContent = `预检失败：${err.message}`;
      $('sensitive-results').innerHTML = '';
      return { ok: false, message: err.message };
    } finally {
      setSensitiveBusy(false);
    }
  }

  // 选词表：persist=false 只放进设置草稿（点「保存设置」才落配置）；
  // persist=true 用于预检面板里直接选，选完立刻写配置并重跑一次预检。
  async function pickSensitiveWords({ persist = false } = {}) {
    try {
      const picked = await call(api.pickSensitiveWords);
      if (!picked || picked.canceled) return { canceled: true };
      if (!picked.ok) {
        toast(`这个词表不能用：${picked.message}`, 'error');
        return picked;
      }
      if (persist) {
        const cfg = await call(api.setConfig, { sensitiveWordsPath: picked.path });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        state.sensitiveWordsDraft = cfg.sensitiveWordsPath || '';
      } else {
        state.sensitiveWordsDraft = picked.path;
      }
      state.sensitiveWordsInfo = picked;
      state.sensitiveWordList = picked;
      renderSensitiveWordList();
      renderSensitiveSettings();
      toast(`已选择词表：${picked.name}（${picked.count} 个词）`);
      if (persist && !$('sensitive-backdrop').classList.contains('hidden')) {
        await runSensitiveCheck();
      }
      return picked;
    } catch (err) {
      toast(`选择词表失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // ---------- 朗读（提案 5.3） ----------
  // 用 Electron 自带的 speechSynthesis（Windows 上走本地 SAPI 语音）朗读当前章正文。
  // 原则：只说不动 —— 不修改编辑区、不写盘、不切章、不改 dirty；改字 / 切章 / 收起朗读条立刻停止。
  // 正文怎么切成「一段一段」由主进程 core/tts.js 算（单测覆盖），这里只管按顺序念。
  const realSpeechEngine = {
    available: () =>
      typeof window.speechSynthesis !== 'undefined' &&
      typeof window.SpeechSynthesisUtterance !== 'undefined',
    voices: () => {
      try {
        return window.speechSynthesis.getVoices() || [];
      } catch {
        return [];
      }
    },
    speak({ text, rate, voiceURI }, handlers) {
      const utter = new window.SpeechSynthesisUtterance(text);
      utter.lang = 'zh-CN';
      utter.rate = ttsClampRate(rate);
      const voice = voiceURI
        ? Array.from(realSpeechEngine.voices()).find((item) => (item.voiceURI || item.name) === voiceURI)
        : null;
      if (voice) {
        utter.voice = voice;
        utter.lang = voice.lang || utter.lang;
      }
      utter.onstart = () => handlers.start && handlers.start();
      utter.onend = () => handlers.end && handlers.end();
      utter.onerror = (event) => handlers.error && handlers.error(event);
      window.speechSynthesis.speak(utter);
      return utter;
    },
    pause() {
      try {
        window.speechSynthesis.pause();
      } catch { /* 没有语音就当已暂停 */ }
    },
    resume() {
      try {
        window.speechSynthesis.resume();
      } catch { /* 没有语音就当已继续 */ }
    },
    cancel() {
      try {
        window.speechSynthesis.cancel();
      } catch { /* 没有语音就当已停止 */ }
    }
  };

  // 测试模式可以把引擎换成假的：E2E 不依赖机器上装没装语音，也绝不会真的出声。
  // 正常使用（没有 ?test=1 的钩子调用）永远是 realSpeechEngine。
  let fakeSpeechEngine = null;
  let fakeSpeechState = { spoken: [], last: null, pending: null, speaking: false, paused: false };
  const speechEngine = () => fakeSpeechEngine || realSpeechEngine;
  let ttsToken = 0; // 每次发声 +1：cancel 之后迟到的回调一律忽略
  let ttsWatchdog = null;

  function ttsClampRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(2, Math.max(0.5, n));
  }

  function currentTtsChunk() {
    return state.tts.chunks[state.tts.index] || null;
  }

  function ttsSummaryText() {
    const tts = state.tts;
    const total = tts.chunks.length;
    if (tts.error) return { text: tts.error, error: true };
    if (tts.loading) return { text: '正在准备正文…', error: false };
    if (!total) return { text: '本章没有可朗读的正文', error: true };
    const position = `第 ${tts.index + 1}/${total} 段`;
    if (tts.status === 'playing') {
      const percent = Math.round(((tts.index + 1) / total) * 100);
      return { text: `正在朗读 ${position} · ${percent}%`, error: false };
    }
    if (tts.status === 'paused') return { text: `已暂停 · ${position}`, error: false };
    if (tts.status === 'done') return { text: `已读完（共 ${total} 段）`, error: false };
    return { text: `已停止 · ${position}`, error: false };
  }

  function renderTtsBar() {
    const bar = $('tts-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', !state.tts.open);
    if (!state.tts.open) return;
    const hasChunks = state.tts.chunks.length > 0;
    const playing = state.tts.status === 'playing';
    $('btn-tts-play').textContent = playing ? '⏸ 暂停' : '▶ 播放';
    $('btn-tts-play').disabled = state.tts.loading || !hasChunks;
    $('btn-tts-stop').disabled = !hasChunks;
    $('btn-tts-prev').disabled = !hasChunks || state.tts.index <= 0;
    $('btn-tts-next').disabled = !hasChunks || state.tts.index >= state.tts.chunks.length - 1;
    $('tts-rate').disabled = !hasChunks;
    $('tts-rate').value = String(state.tts.rate);
    $('tts-follow').checked = state.tts.follow;
    const summary = ttsSummaryText();
    const statusEl = $('tts-status');
    statusEl.textContent = summary.text;
    statusEl.classList.toggle('error', Boolean(summary.error));
    const chunk = currentTtsChunk();
    const preview = $('tts-preview');
    preview.textContent = chunk ? chunk.text.slice(0, 60) + (chunk.text.length > 60 ? '…' : '') : '';
    preview.title = chunk ? chunk.text : '';
  }

  function renderTtsVoices() {
    const select = $('tts-voice');
    if (!select) return;
    const voices = Array.from(speechEngine().voices() || []);
    const wanted = state.tts.voiceURI;
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = voices.length ? '系统默认' : '（系统没有报告语音）';
    select.appendChild(def);
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.voiceURI || voice.name || '';
      option.textContent = `${voice.name || '语音'}${voice.lang ? `（${voice.lang}）` : ''}`;
      select.appendChild(option);
    }
    if (wanted && voices.some((voice) => (voice.voiceURI || voice.name) === wanted)) {
      select.value = wanted;
    } else {
      select.value = '';
      state.tts.voiceURI = '';
    }
    select.disabled = !voices.length;
  }

  // 跟随高亮：只改编辑区选区，不 focus、不改文字；编辑区有焦点时才看得见高亮
  function selectTtsChunk(index) {
    const chunk = state.tts.chunks[index];
    if (!chunk) return false;
    editorEl.setSelectionRange(chunk.start, chunk.end);
    scrollCaretIntoView(chunk.start);
    return true;
  }

  function clearTtsWatchdog() {
    if (ttsWatchdog) {
      clearTimeout(ttsWatchdog);
      ttsWatchdog = null;
    }
  }

  function stopTtsEngine() {
    clearTtsWatchdog();
    ttsToken += 1;
    try {
      speechEngine().cancel();
    } catch { /* 停不下来也不影响界面状态 */ }
  }

  function stopTts({ error = '', keepOpen = true } = {}) {
    stopTtsEngine();
    state.tts.status = error ? 'error' : 'idle';
    state.tts.error = error;
    if (!keepOpen) state.tts.open = false;
    renderTtsBar();
  }

  function closeTtsBar() {
    if (!state.tts.open && !state.tts.chunks.length) return;
    stopTts({ keepOpen: false });
  }

  function failTts(message) {
    stopTts({ error: message });
    toast(`朗读失败：${message}`, 'error');
  }

  async function openTtsBar({ autoplay = true } = {}) {
    if (!state.bookPath || !state.chapters.length) {
      toast('先打开一本书再朗读', 'warn');
      return { ok: false, message: '没有打开的书' };
    }
    if (!speechEngine().available()) {
      toast('这个运行环境不支持语音朗读（没有系统语音）', 'warn');
      return { ok: false, message: '没有系统语音' };
    }
    // 「从光标处开始念」：刚打开章节时光标停在全文末尾（textarea 的默认行为），
    // 这时按「从头念」处理，免得点开朗读直接从最后一段开始；用户自己把光标放到中间 / 末尾就按光标算。
    const selectionStart = editorEl.selectionStart || 0;
    const collapsed = selectionStart === (editorEl.selectionEnd || 0);
    const atVeryEnd = collapsed && selectionStart >= editorEl.value.length;
    const caret = atVeryEnd ? 0 : selectionStart;
    const requestId = state.tts.requestId + 1;
    state.tts.requestId = requestId;
    stopTtsEngine();
    state.tts.open = true;
    state.tts.loading = true;
    state.tts.status = 'idle';
    state.tts.error = '';
    state.tts.chunks = [];
    state.tts.index = 0;
    renderTtsBar();
    renderTtsVoices();
    let result;
    try {
      result = await call(api.ttsChunks, editorEl.value, { caret });
    } catch (err) {
      if (requestId !== state.tts.requestId) return { ok: false, stale: true };
      state.tts.loading = false;
      state.tts.error = `切分正文失败：${err.message}`;
      renderTtsBar();
      toast(`切分正文失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
    // 等主进程期间可能已经切章 / 收起：结果作废
    if (requestId !== state.tts.requestId || !state.tts.open) return { ok: false, stale: true };
    state.tts.loading = false;
    state.tts.chunks = result.chunks || [];
    state.tts.index = result.startIndex >= 0 ? result.startIndex : 0;
    if (!state.tts.chunks.length) {
      state.tts.status = 'error';
      state.tts.error = '本章没有可朗读的正文';
      renderTtsBar();
      toast('本章没有可朗读的正文', 'warn');
      return { ok: false, message: '没有正文' };
    }
    renderTtsBar();
    if (autoplay) speakTtsChunk();
    return { ok: true, chunks: state.tts.chunks.length, index: state.tts.index };
  }

  function speakTtsChunk() {
    const chunk = currentTtsChunk();
    if (!chunk) return;
    stopTtsEngine(); // 先取消上一段，并让它的回调失效
    state.tts.status = 'playing';
    state.tts.error = '';
    renderTtsBar();
    if (state.tts.follow) selectTtsChunk(state.tts.index);
    const token = ttsToken;
    try {
      speechEngine().speak(
        { text: chunk.text, rate: state.tts.rate, voiceURI: state.tts.voiceURI },
        {
          start: () => {
            if (token !== ttsToken) return;
            clearTtsWatchdog();
          },
          end: () => {
            if (token !== ttsToken) return;
            clearTtsWatchdog();
            advanceTts(token);
          },
          error: (event) => {
            if (token !== ttsToken) return;
            clearTtsWatchdog();
            const code = event && event.error ? String(event.error) : '';
            if (code === 'canceled' || code === 'interrupted') return; // 自己 cancel 的不算失败
            failTts(`系统语音出错（${code || '未知原因'}）`);
          }
        }
      );
    } catch (err) {
      failTts(err.message || '系统语音不可用');
      return;
    }
    if (!fakeSpeechEngine) {
      // 真实语音没有反应（没装语音 / 音频设备不可用）时，别一直显示「朗读中」
      ttsWatchdog = setTimeout(() => {
        if (token !== ttsToken || state.tts.status !== 'playing') return;
        const synth = window.speechSynthesis;
        if (synth && (synth.speaking || synth.pending || synth.paused)) return;
        failTts('系统语音没有响应（可能没有安装语音或音频设备不可用）');
      }, 12000);
    }
  }

  function advanceTts(token) {
    if (token !== ttsToken) return;
    if (state.tts.status !== 'playing') return;
    const next = state.tts.index + 1;
    if (next < state.tts.chunks.length) {
      state.tts.index = next;
      speakTtsChunk();
      return;
    }
    ttsToken += 1;
    state.tts.status = 'done';
    renderTtsBar();
  }

  function toggleTtsPlay() {
    if (!state.tts.open) return { ok: false };
    const status = state.tts.status;
    if (status === 'playing') {
      try {
        speechEngine().pause();
      } catch { /* 当已暂停 */ }
      state.tts.status = 'paused';
      renderTtsBar();
      return { ok: true, action: 'pause' };
    }
    if (status === 'paused') {
      try {
        speechEngine().resume();
      } catch { /* 当已继续 */ }
      state.tts.status = 'playing';
      renderTtsBar();
      return { ok: true, action: 'resume' };
    }
    if (!state.tts.chunks.length) return { ok: false };
    if (status === 'done') state.tts.index = 0;
    speakTtsChunk();
    return { ok: true, action: 'play' };
  }

  function ttsStep(delta) {
    if (!state.tts.open || !state.tts.chunks.length) return { ok: false };
    const next = Math.min(Math.max(0, state.tts.index + delta), state.tts.chunks.length - 1);
    const active = state.tts.status === 'playing' || state.tts.status === 'paused';
    state.tts.index = next;
    if (active) {
      speakTtsChunk();
    } else {
      state.tts.status = 'idle';
      state.tts.error = '';
      renderTtsBar();
      if (state.tts.follow) selectTtsChunk(next);
    }
    return { ok: true, index: next };
  }

  // 语速 / 语音只对「之后发声」的 utterance 生效：正在读的这一段重念一遍
  function setTtsRate(rate) {
    state.tts.rate = ttsClampRate(rate);
    renderTtsBar();
    if (state.tts.status === 'playing' || state.tts.status === 'paused') speakTtsChunk();
    return state.tts.rate;
  }

  function setTtsVoice(voiceURI) {
    state.tts.voiceURI = String(voiceURI || '');
    renderTtsBar();
    if (state.tts.status === 'playing' || state.tts.status === 'paused') speakTtsChunk();
    return state.tts.voiceURI;
  }

  function setTtsFollow(follow) {
    state.tts.follow = Boolean(follow);
    $('tts-follow').checked = state.tts.follow;
    if (state.tts.follow) selectTtsChunk(state.tts.index);
    return state.tts.follow;
  }

  // 切章 / 回书架：正在读的内容已经不是眼前这一章了，立刻停
  function stopTtsForChapterChange() {
    if (!state.tts.open && !state.tts.chunks.length) return;
    closeTtsBar();
    toast('已切换章节，朗读已停止');
  }

  // 测试专用：装一个假语音引擎（只在 ?test=1 的钩子里调用），E2E 用它验证播放状态机。
  function installFakeSpeech() {
    fakeSpeechState = { spoken: [], last: null, pending: null, speaking: false, paused: false };
    fakeSpeechEngine = {
      available: () => true,
      voices: () => [
        { name: '测试语音 A', lang: 'zh-CN', voiceURI: 'fake-voice-a' },
        { name: '测试语音 B', lang: 'zh-CN', voiceURI: 'fake-voice-b' }
      ],
      speak(request, handlers) {
        fakeSpeechState.spoken.push({ ...request });
        fakeSpeechState.last = { ...request };
        fakeSpeechState.pending = handlers;
        fakeSpeechState.speaking = true;
        setTimeout(() => {
          if (fakeSpeechState.pending === handlers && handlers.start) handlers.start();
        }, 0);
        return true;
      },
      pause() {
        fakeSpeechState.paused = true;
      },
      resume() {
        fakeSpeechState.paused = false;
      },
      cancel() {
        fakeSpeechState.pending = null;
        fakeSpeechState.speaking = false;
      }
    };
    if (state.tts.open) renderTtsVoices();
    return true;
  }

  // 测试专用：让假引擎报「这一段念完了」/「出错」
  function fakeFinishSpeech() {
    const handlers = fakeSpeechState.pending;
    fakeSpeechState.pending = null;
    fakeSpeechState.speaking = false;
    if (!handlers || !handlers.end) return false;
    handlers.end();
    return true;
  }

  function fakeErrorSpeech(code) {
    const handlers = fakeSpeechState.pending;
    fakeSpeechState.pending = null;
    fakeSpeechState.speaking = false;
    if (!handlers || !handlers.error) return false;
    handlers.error({ error: String(code || 'synthesis-failed') });
    return true;
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
      renderMarksMenu();
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
    // 写作时长：默认关，只认真正的 true（旧配置没有这个键 = 关）
    $('settings-write-duration').checked = cfg.writeDurationEnabled === true;
    renderDurationSettings();
    // 敏感词表：只记路径，词表本身只读；具体状态在 openSettings 里异步读一次
    state.sensitiveWordsDraft = typeof cfg.sensitiveWordsPath === 'string' ? cfg.sensitiveWordsPath : '';
    state.sensitiveWordsInfo = null;
    renderSensitiveSettings();
    renderStatsChart();
  }

  // 设置弹层里的词表状态（未设置 / 词表 N 个词 / 文件不存在 / 编码异常都直说）
  function renderSensitiveSettings() {
    const pathEl = $('settings-sensitive-path');
    if (pathEl) pathEl.value = state.sensitiveWordsDraft || '';
    const status = $('settings-sensitive-status');
    if (!status) return;
    if (!state.sensitiveWordsDraft) {
      status.textContent = '未设置：预检前需要先选一个自己的词表 txt（应用不内置任何词表）';
      status.className = 'muted small';
      return;
    }
    const info = state.sensitiveWordsInfo;
    if (!info) {
      status.textContent = '正在读取词表…';
      status.className = 'muted small';
      return;
    }
    status.textContent = sensitiveWordListText(info);
    status.className = info.ok ? 'muted small' : 'muted small warn';
  }

  // 打开设置时按已保存的路径读一次词表状态（刚选的草稿直接用 pick 返回的信息，不重读）
  async function refreshSensitiveSettingsInfo() {
    if (!state.sensitiveWordsDraft) {
      state.sensitiveWordsInfo = null;
      renderSensitiveSettings();
      return null;
    }
    try {
      state.sensitiveWordsInfo = await call(api.sensitiveWordsInfo);
    } catch (err) {
      state.sensitiveWordsInfo = { ok: false, message: `读取词表失败：${err.message}` };
    }
    renderSensitiveSettings();
    return state.sensitiveWordsInfo;
  }

  // 设置弹层「诊断日志」：只显示日志目录里有几份、多大；正文永远不进日志
  function renderLogSettings() {
    const status = $('settings-logs-status');
    if (!status) return;
    const info = state.logInfo;
    if (!info) {
      status.textContent = '正在读取日志目录…';
      status.className = 'muted small';
      return;
    }
    if (info.error) {
      status.textContent = `读取日志目录失败：${info.error}`;
      status.className = 'muted small warn';
      return;
    }
    const files = Array.isArray(info.files) ? info.files : [];
    const bytes = files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
    status.textContent = files.length
      ? `已有 ${files.length} 个日志文件，共 ${formatBytes(bytes)}（不含正文）`
      : '还没有日志文件（应用没有出错时不会写日志）';
    status.className = 'muted small';
  }

  // 打开设置弹层时读一次日志目录（只读；写作页的按书设置里不显示这一组）
  async function refreshLogInfo() {
    try {
      state.logInfo = await call(api.logInfo);
    } catch (err) {
      state.logInfo = { error: err.message };
    }
    renderLogSettings();
    return state.logInfo;
  }

  // 检查更新（提案 7.1）：只在作者点「检查更新」时访问 GitHub；不下载、不安装、不写配置。
  // 网络失败 / 超时 / 限流都只显示一句提示，设置弹层照常能用，写作不受影响。
  function formatUpdateDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function renderUpdateSettings() {
    const versionEl = $('settings-update-version');
    if (versionEl) versionEl.textContent = state.appVersion ? `v${state.appVersion}` : '未知';
    const statusEl = $('settings-update-status');
    const checkBtn = $('btn-check-update');
    const openBtn = $('btn-open-update');
    const update = state.update || {};
    const result = update.result;
    if (checkBtn) {
      checkBtn.disabled = update.busy === true;
      checkBtn.textContent = update.busy ? '正在检查…' : '检查更新';
    }
    let text = '尚未检查（只在点按钮时联网，不会自动检查）';
    let tone = 'muted small';
    if (update.busy) {
      text = '正在检查…（只读版本号，不会下载或安装任何东西）';
    } else if (result && result.status === 'update') {
      const date = formatUpdateDate(result.publishedAt);
      text = `发现新版本 v${result.latestVersion}（当前 v${result.currentVersion}）${date ? ` · 发布于 ${date}` : ''}`;
    } else if (result && result.status === 'latest') {
      text = `已是最新版本（v${result.currentVersion || state.appVersion || '?'}）`;
    } else if (result && result.status === 'error') {
      text = `检查失败：${result.message || '未知错误'}`;
      tone = 'muted small warn';
    }
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.className = tone;
    }
    if (openBtn) openBtn.classList.toggle('hidden', !(result && result.status === 'update'));
  }

  async function checkUpdate() {
    if (state.update.busy) return state.update.result;
    state.update.busy = true;
    state.update.result = null;
    renderUpdateSettings();
    let result;
    try {
      result = await call(api.checkUpdate);
    } catch (err) {
      result = {
        status: 'error',
        code: 'IPC_ERROR',
        message: `检查更新失败：${err.message}（不影响写作）`,
        currentVersion: state.appVersion || ''
      };
    }
    state.update.busy = false;
    state.update.result = result;
    renderUpdateSettings();
    if (result && result.status === 'update') {
      toast(`发现新版本 v${result.latestVersion}（当前 v${result.currentVersion}）`);
    }
    return result;
  }

  async function openUpdateDownload() {
    try {
      const data = await call(api.openUpdateDownload);
      if (data && data.opened) {
        toast('已用浏览器打开 GitHub 下载页（应用不会自动下载或安装）');
      } else if (data && data.url) {
        // 自检 / 截图环境不打开浏览器，只回报地址
        toast(`下载页：${data.url}`);
      } else {
        toast((data && data.message) || '还没有可用的下载页，请先点「检查更新」', 'warn');
      }
      return data;
    } catch (err) {
      toast(`打开下载页失败：${err.message}`, 'error');
      return null;
    }
  }

  function readSnapshotForm() {
    return {
      snapshotEnabled: $('settings-snapshot-enabled').checked === true,
      snapshotKeepDays: Number($('settings-snapshot-days').value)
    };
  }

  // 每日目标是全局设置（0 = 不设目标）；写作时长开关同样是全局的（默认关）。
  // 主进程/配置层还会再清洗一次范围与布尔值。
  function readStatsForm() {
    const n = Number($('settings-daily-goal').value);
    return {
      dailyGoal: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0,
      writeDurationEnabled: $('settings-write-duration').checked === true
    };
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
    // 写作统计 / 每日目标 / 写作时长也是全局设置：按书覆盖没有意义，写作页里不显示
    for (const id of [
      'settings-stats-group',
      'settings-daily-goal-field',
      'settings-duration-field',
      'settings-stats-chart-field',
      'settings-calendar-field',
      'settings-stats-hint'
    ]) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 敏感词表同样是全局设置（所有书共用一份词表），写作页的按书设置里不显示
    for (const id of ['settings-sensitive-group', 'settings-sensitive-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 诊断日志也是全局的（一个应用一份日志），写作页的按书设置里不显示
    for (const id of ['settings-logs-group', 'settings-logs-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 检查更新也是全局的（一个应用一个版本），写作页的按书设置里不显示
    for (const id of ['settings-update-group', 'settings-update-field']) {
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
    // 全局设置里顺手读一次词表状态（只读；写作页的按书设置里不显示这一组）
    if (state.settingsScope === 'global') await refreshSensitiveSettingsInfo();
    // 诊断日志也只在全局设置里显示：顺手读一次日志目录（只读，不写任何文件）
    if (state.settingsScope === 'global') await refreshLogInfo();
    // 检查更新：只显示当前版本和上次检查结果（不自动联网；点按钮才检查）
    if (state.settingsScope === 'global') renderUpdateSettings();
  }

  function closeSettings({ restore = true } = {}) {
    $('settings-backdrop').classList.add('hidden');
    if (restore && state.settingsBackup) {
      state.config = state.settingsBackup;
      applyEditorStyle();
      renderWriteTimer();
      renderDurationSettings();
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
      // 关掉「写作时长」前，先把计时器里还没上报的整秒记下来（配置一改主进程就不再接收）
      if (writeDurationEnabled() && $('settings-write-duration').checked !== true) {
        await flushWriteTimer();
      }
      const cfg = await call(api.setConfig, {
        booksRoot: $('settings-root').value.trim(),
        ...form,
        ...readSnapshotForm(),
        ...readStatsForm(),
        sensitiveWordsPath: (state.sensitiveWordsDraft || '').trim()
      });
      state.globalConfig = cfg;
      state.config = effectiveConfig();
      applyEditorStyle();
      applyWriteTimerConfig();
      closeSettings({ restore: false });
      toast('设置已保存（全局默认）');
      await refreshShelf();
      // 词表路径可能刚改过：刷新一下状态，下次打开预检面板直接可用
      await refreshSensitiveWordList();
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
    // 写作计时（v0.8-2）：手动开始 / 暂停；只记时长不记内容，不做番茄钟
    const writeTimerBtn = $('btn-write-timer');
    if (writeTimerBtn) {
      writeTimerBtn.addEventListener('click', () => {
        if (state.writeTimer.running) void pauseWriteTimer();
        else startWriteTimer();
      });
    }
    // 码字日历：翻月 / 回到本月（只读；点击不会写 stats.json）
    $('calendar-prev').addEventListener('click', () => {
      void shiftStatsCalendar(-1);
    });
    $('calendar-next').addEventListener('click', () => {
      void shiftStatsCalendar(1);
    });
    $('calendar-today').addEventListener('click', () => {
      void goToCurrentCalendarMonth();
    });
    $('btn-pick-folder').addEventListener('click', async () => {
      try {
        const folder = await call(api.pickFolder);
        if (folder) $('settings-root').value = folder;
      } catch (err) {
        toast(`选择目录失败：${err.message}`, 'error');
      }
    });

    // 敏感词预检：词表归作者管理，应用不内置任何词表；设置里只记路径（点「保存设置」才落配置）
    $('btn-pick-sensitive').addEventListener('click', () => pickSensitiveWords({ persist: false }));
    $('btn-clear-sensitive').addEventListener('click', () => {
      state.sensitiveWordsDraft = '';
      state.sensitiveWordsInfo = null;
      renderSensitiveSettings();
      toast('已清除敏感词表（点「保存设置」后生效）');
    });

    // 诊断日志：只让主进程打开日志文件夹（渲染层没有 fs 权限）；日志内容从不进界面
    const openLogsBtn = $('btn-open-logs');
    if (openLogsBtn) {
      openLogsBtn.addEventListener('click', async () => {
        try {
          const data = await call(api.openLogFolder);
          const dir = (data && data.dir) || '';
          if (dir) $('settings-logs-status').textContent = `日志文件夹：${dir}`;
          toast(
            data && data.opened
              ? '已在资源管理器中打开日志文件夹'
              : `日志文件夹：${dir}${data && data.note ? `（${data.note}）` : ''}`
          );
        } catch (err) {
          toast(`打开日志文件夹失败：${err.message}`, 'error');
        }
      });
    }

    // 自动更新轻量版：检查更新只读版本号；「打开下载页」交给系统浏览器，应用不下载、不安装
    const checkUpdateBtn = $('btn-check-update');
    if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', () => checkUpdate());
    const openUpdateBtn = $('btn-open-update');
    if (openUpdateBtn) openUpdateBtn.addEventListener('click', () => openUpdateDownload());

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

    // 灵感箱：书架「＋ 碎片」记一条；写作页「插入碎片…」把碎片插到光标处（不写盘）
    $('btn-add-fragment').addEventListener('click', openFragmentDialog);
    $('btn-fragment-cancel').addEventListener('click', closeFragmentDialog);
    $('btn-fragment-save').addEventListener('click', () => saveFragment());
    $('fragment-text').addEventListener('input', updateFragmentCounter);
    $('fragment-text').addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        saveFragment();
      }
    });
    $('btn-insert-fragment').addEventListener('click', openInsertFragmentDialog);
    $('btn-fragments-close').addEventListener('click', closeInsertFragmentDialog);
    $('btn-fragment-insert').addEventListener('click', () => insertSelectedFragment());
    $('btn-fragments-refresh').addEventListener('click', () => refreshFragments());

    // 书架搜索：书名 / 章节名输入即过滤；正文防抖后异步查；Esc 清除；回车打开第一本匹配的书
    $('shelf-search').addEventListener('input', () => {
      state.shelfQuery = $('shelf-search').value;
      renderShelf();
      scheduleContentSearch();
    });
    $('shelf-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        state.shelfQuery = '';
        $('shelf-search').value = '';
        resetShelfContent();
        renderShelf();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const rows = shelfSearchResults();
        if (rows.length) {
          openBookByPath(rows[0].book.path);
          return;
        }
        // 书名 / 章名没有命中时，回车的含义就是「打开第一条正文命中」
        const content = state.shelfContent;
        const first = content.meta && content.meta.results ? content.meta.results[0] : null;
        if (first) void openContentResult(first);
      }
    });
    $('btn-shelf-search-clear').addEventListener('click', () => {
      state.shelfQuery = '';
      $('shelf-search').value = '';
      resetShelfContent();
      renderShelf();
      $('shelf-search').focus();
    });
    $('btn-shelf-content-more').addEventListener('click', () => {
      state.shelfContent.shown += CONTENT_PAGE_SIZE;
      renderShelfContent();
    });

    $('book-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const book = state.contextBook;
      hideBookMenu();
      if (!book) return;
      if (btn.dataset.action === 'open') {
        await openBookByPath(book.path);
      } else if (btn.dataset.action === 'open-new-window') {
        await openBookInNewWindow(book);
      } else if (btn.dataset.action === 'folder') {
        try {
          await call(api.openBookFolder, book.path);
        } catch (err) {
          toast(`打开文件夹失败：${err.message}`, 'error');
        }
      } else if (btn.dataset.action === 'info') {
        openBookInfoDialog(book);
      } else if (btn.dataset.action === 'delete') {
        await deleteBookFlow(book);
      } else if (btn.dataset.action === 'history') {
        await openHistoryForPath(book.path, book.title);
      }
    });

    $('bookinfo-backdrop').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target && event.target.id !== 'bookinfo-brief') {
        event.preventDefault();
        void saveBookInfoDialog();
      }
    });
    $('btn-bookinfo-cancel').addEventListener('click', closeBookInfoDialog);
    $('btn-bookinfo-save').addEventListener('click', () => void saveBookInfoDialog());
    $('shelf-group-filter').addEventListener('change', (event) => {
      state.shelfGroup = String(event.target.value || '');
      renderShelf();
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
    // 专注模式（提案 3.5）：顶栏「专注」进出 + 极简退出条上的「打字机 / 退出专注」
    $('btn-focus').addEventListener('click', () => toggleFocusMode());
    $('btn-focus-exit').addEventListener('click', () => setFocusMode(false));
    $('btn-focus-typewriter').addEventListener('click', () => setFocusTypewriter(!state.focus.typewriter));
    $('btn-find-run').addEventListener('click', runFind);
    $('btn-find-replace-one').addEventListener('click', runReplaceOne);
    $('btn-find-replace').addEventListener('click', runReplaceAll);
    $('btn-find-close').addEventListener('click', closeFindPanel);
    // 校对（只报告，不改动）
    $('btn-proofread').addEventListener('click', openProofreadPanel);
    $('btn-proofread-run').addEventListener('click', runProofread);
    $('btn-proofread-close').addEventListener('click', closeProofreadPanel);
    // 朗读本章（只读正文；悬浮小条：播放 / 暂停 / 停止 / 上一段 / 下一段 / 语速 / 语音 / 跟随高亮）
    $('btn-tts').addEventListener('click', () => {
      if (state.tts.open) closeTtsBar();
      else openTtsBar();
    });
    $('btn-tts-play').addEventListener('click', () => toggleTtsPlay());
    $('btn-tts-stop').addEventListener('click', () => {
      if (state.tts.open && state.tts.chunks.length) stopTts();
    });
    $('btn-tts-prev').addEventListener('click', () => ttsStep(-1));
    $('btn-tts-next').addEventListener('click', () => ttsStep(1));
    $('btn-tts-close').addEventListener('click', closeTtsBar);
    $('tts-rate').addEventListener('change', () => setTtsRate($('tts-rate').value));
    $('tts-voice').addEventListener('change', () => setTtsVoice($('tts-voice').value));
    $('tts-follow').addEventListener('change', () => setTtsFollow($('tts-follow').checked));
    // 系统语音列表是异步加载的：加载完刷新一下下拉框（只在朗读条开着的时候）
    if (typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        if (state.tts.open) renderTtsVoices();
      });
    }
    $('proofread-scope').addEventListener('change', () => {
      state.proofreadScope = proofreadScope();
      // 换了范围就先收起旧结果，免得摘要写着「整本」、列表还是上一章的内容
      state.proofread = null;
      $('proofread-results').innerHTML = '';
      $('proofread-summary').textContent =
        state.proofreadScope === 'book'
          ? '已切到整本书：点「开始校对」通读全书（只读，缺文件的章节会跳过）。'
          : '已切到当前这一章：点「开始校对」检查编辑区里的最新内容。';
    });
    $('btn-restore-replace').addEventListener('click', () => restoreReplaceBackupFlow());
    // 敏感词预检（只报告，不改动；词表由作者管理）
    $('btn-sensitive-run').addEventListener('click', runSensitiveCheck);
    $('btn-sensitive-close').addEventListener('click', closeSensitivePanel);
    $('btn-sensitive-pick').addEventListener('click', () => pickSensitiveWords({ persist: true }));
    $('sensitive-scope').addEventListener('change', () => {
      state.sensitiveScope = sensitiveScope();
      // 换了范围就先收起旧结果，免得摘要写着「整本」、列表还是上一章的内容
      state.sensitive = null;
      $('sensitive-results').innerHTML = '';
      $('sensitive-summary').textContent =
        state.sensitiveScope === 'book'
          ? '已切到整本书：点「开始预检」按词表通读全书（只读，缺文件的章节会跳过）。'
          : '已切到当前这一章：点「开始预检」检查编辑区里的最新内容。';
    });
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
      else if (btn.dataset.action === 'sensitive') await openSensitivePanel();
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
      else if (action === 'toggle-invisibles') toggleMarks('invisibles');
      else if (action === 'toggle-long-para') toggleMarks('longParagraphs');
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
    setupEditorMarks();

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
  // 别的窗口改了书架数据（新建 / 删除 / 保存 / 导入 / 整理）：停在书架就刷新；
  // 写作页里的窗口不打断作者，回书架时会统一刷新（backToShelf 里本来就会刷新）。
  api.onShelfChanged(() => {
    if (state.view === 'shelf' && !state.importing && !state.formatBookRunning) {
      refreshShelf().catch(() => {});
    }
  });

    // 主进程内部错误（崩溃 / 未处理的 Promise）：只弹一句固定提示，细节留在日志里。
    // 应用不退出，作者可以先 Ctrl+S 保存再重启。
    api.onInternalError((info) => {
      state.lastInternalError = info || null;
      toast((info && info.message) || '程序遇到一个内部错误，已写进日志。', 'error');
    });

    // 整本排版进度（主进程逐章汇报，显示在右下角进度条上）
    api.onFormatProgress((progress) => {
      if (!state.formatBookRunning) return;
      if (!progress || !progress.total) return;
      showFormatBookProgress(
        `正在整理整本书：${Math.min(progress.done, progress.total)}/${progress.total} 章`
      );
    });

    // 正文搜索索引的建 / 校验进度：只更新书架搜索提示（不阻塞任何操作）
    api.onSearchProgress((info) => {
      if (!info) return;
      const content = state.shelfContent;
      content.indexStatus = {
        ...(content.indexStatus || {}),
        building: info.phase !== 'done',
        books: Number.isFinite(info.books) ? info.books : (content.indexStatus && content.indexStatus.books) || 0,
        chapters: Number.isFinite(info.chapters)
          ? info.chapters
          : (content.indexStatus && content.indexStatus.chapters) || 0,
        ready: Boolean(content.indexStatus && content.indexStatus.ready),
        progress: info
      };
      if (state.view === 'shelf' && shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS) {
        renderShelfContent();
      }
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
      if (!$('bookinfo-backdrop').classList.contains('hidden')) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeBookInfoDialog();
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
      // 灵感箱：Esc 关闭弹层；输入框里的 Ctrl+Enter 自己在 textarea 上处理
      if (!$('fragment-backdrop').classList.contains('hidden') && event.key === 'Escape') {
        event.preventDefault();
        closeFragmentDialog();
        return;
      }
      if (!$('fragments-backdrop').classList.contains('hidden') && event.key === 'Escape') {
        event.preventDefault();
        closeInsertFragmentDialog();
        return;
      }
      // 校对面板：Esc 关闭；其他按键继续往下走（Ctrl+S 仍可保存）
      if (!$('proofread-backdrop').classList.contains('hidden') && event.key === 'Escape') {
        event.preventDefault();
        closeProofreadPanel();
        return;
      }
      // 敏感词预检面板：Esc 关闭
      if (!$('sensitive-backdrop').classList.contains('hidden') && event.key === 'Escape') {
        event.preventDefault();
        closeSensitivePanel();
        return;
      }
      // 朗读小条：Esc 停止并收起（它不是弹层，放在所有弹层之后，不抢弹层的 Esc）
      if (state.tts.open && event.key === 'Escape') {
        event.preventDefault();
        closeTtsBar();
        return;
      }
      // 专注模式（提案 3.5）：F11 来回切换（只在写作页；不写配置、不写盘）
      if (event.key === 'F11') {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          toggleFocusMode();
        }
        return;
      }
      // 专注模式下 Esc 退出（弹层 / 朗读条的 Esc 已经在上面处理，不抢它们的）
      if (state.focus.on && event.key === 'Escape') {
        event.preventDefault();
        setFocusMode(false);
        return;
      }
      // 段落导航（提案 4.1）：Alt+↑/↓ 在自然段开头之间跳，只移动光标、不改字
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          jumpParagraph(event.key === 'ArrowDown' ? 1 : -1);
        }
        return;
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
      scheduleMarksRender(40);
      if (focusActive() && state.focus.typewriter) scheduleTypewriterAlign(60);
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
      // 多窗口测试钩子：在新窗口打开 / 释放登记 / 这个窗口的会话信息
      async openBookInNewWindow(bookPath) {
        const book = (state.books || []).find((item) => item.path === bookPath) || { path: bookPath, title: '' };
        return openBookInNewWindow(book);
      },
      async releaseBook() {
        try {
          return await call(api.releaseBook);
        } catch (err) {
          return { released: false, message: err.message };
        }
      },
      async windowInfo() {
        try {
          return await call(api.windowInfo);
        } catch (err) {
          return { error: err.message };
        }
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
        scheduleContentSearch();
      },
      // 书籍信息 / 分组筛选（v0.8-3）
      shelfGroupBarVisible: () => !$('shelf-group-bar').classList.contains('hidden'),
      shelfGroupOptions: () =>
        Array.from($('shelf-group-filter').querySelectorAll('option')).map((el) => ({
          value: el.value,
          label: el.textContent
        })),
      shelfGroupValue: () => $('shelf-group-filter').value,
      setShelfGroup(value) {
        state.shelfGroup = String(value == null ? '' : value);
        renderShelf();
        return state.shelfGroup;
      },
      shelfBookInfo(folder) {
        const book = (state.books || []).find((item) => item.folder === folder || item.title === folder);
        return book
          ? { author: book.author, brief: book.brief, group: book.group, tags: book.tags }
          : null;
      },
      bookCardInfo(folder) {
        const card = Array.from(document.querySelectorAll('.book-card[data-folder]')).find(
          (el) => el.dataset.folder === folder
        );
        if (!card) return null;
        const text = (selector) => {
          const el = card.querySelector(selector);
          return el ? el.textContent : '';
        };
        return {
          author: text('.book-card-author'),
          tags: text('.book-card-tags'),
          brief: text('.book-card-brief')
        };
      },
      openBookInfoForPath(bookPath) {
        const book = (state.books || []).find((item) => item.path === bookPath);
        if (!book) return false;
        return openBookInfoDialog(book);
      },
      bookInfoDialogOpen: () => !$('bookinfo-backdrop').classList.contains('hidden'),
      bookInfoBookText: () => $('bookinfo-book').textContent,
      bookInfoValues: () => readBookInfoForm(),
      bookInfoGroupSuggestions: () =>
        Array.from($('bookinfo-group-list').querySelectorAll('option')).map((el) => el.value),
      setBookInfoField(field, value) {
        const map = {
          author: 'bookinfo-author',
          group: 'bookinfo-group',
          tags: 'bookinfo-tags',
          brief: 'bookinfo-brief'
        };
        const el = map[field] ? $(map[field]) : null;
        if (!el) return false;
        el.value = String(value == null ? '' : value);
        return true;
      },
      saveBookInfoDialog: () => saveBookInfoDialog(),
      closeBookInfoDialog: () => closeBookInfoDialog(),
      bookInfoError: () => $('bookinfo-error').textContent,
      // 书架正文搜索（提案 7.3）：自检只看得到「结果 + 状态」，正文本身仍只在主进程里读
      shelfContentState: () => {
        const content = state.shelfContent;
        const meta = content.meta;
        return {
          query: content.query,
          loading: content.loading,
          error: content.error,
          shown: content.shown,
          results: Array.isArray(content.results) ? content.results.map((row) => ({ ...row })) : [],
          tooShort: Boolean(meta && meta.tooShort),
          truncated: Boolean(meta && meta.truncated),
          candidateBooks: meta ? meta.candidateBooks : 0,
          scannedBooks: meta ? meta.scannedBooks : 0,
          elapsedMs: meta ? meta.elapsedMs : 0,
          indexReady: Boolean(content.indexStatus && content.indexStatus.ready),
          indexBuilding: Boolean(content.indexStatus && content.indexStatus.building),
          summary: $('shelf-content-summary').textContent,
          visible: !$('shelf-content').classList.contains('hidden'),
          rowCount: $('shelf-content-list').querySelectorAll('.shelf-content-row').length,
          moreVisible: !$('btn-shelf-content-more').classList.contains('hidden'),
          indexFile: content.indexStatus && content.indexStatus.file ? content.indexStatus.file : ''
        };
      },
      shelfContentRowTexts: () =>
        Array.from($('shelf-content-list').querySelectorAll('.shelf-content-row')).map((el) =>
          el.textContent
        ),
      clickShelfContentResult(index) {
        const rows = $('shelf-content-list').querySelectorAll('.shelf-content-row');
        const row = rows[index];
        if (!row) return false;
        row.click();
        return true;
      },
      clickShelfContentMore: () => {
        $('btn-shelf-content-more').click();
        return state.shelfContent.shown;
      },
      async searchIndexStatus() {
        return call(api.searchIndexStatus);
      },
      async ensureSearchIndex(options) {
        return ensureSearchIndex(options || {});
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
      // 校对（只报告，不改动）
      openProofreadPanel: () => openProofreadPanel(),
      closeProofreadPanel: () => closeProofreadPanel(),
      proofreadPanelOpen: () => !$('proofread-backdrop').classList.contains('hidden'),
      setProofreadScope(scope) {
        $('proofread-scope').value = scope === 'book' ? 'book' : 'current';
        state.proofreadScope = proofreadScope();
        return state.proofreadScope;
      },
      async proofreadRun() {
        return runProofread();
      },
      proofreadSummary: () => $('proofread-summary').textContent,
      proofreadRowCount: () => $('proofread-results').querySelectorAll('.proofread-result').length,
      proofreadRuleTexts: () =>
        Array.from($('proofread-results').querySelectorAll('.proofread-rule')).map((el) => el.textContent),
      proofreadRowTexts: () =>
        Array.from($('proofread-results').querySelectorAll('.proofread-result')).map((el) => el.textContent),
      proofreadPayload: () =>
        state.proofread
          ? {
              scope: state.proofread.scope,
              total: state.proofread.total,
              byRule: { ...state.proofread.byRule },
              truncated: state.proofread.truncated,
              chapterCount: state.proofread.chapterCount,
              chapterHitCount: state.proofread.chapterHitCount,
              issues: state.proofread.issues.map((issue) => ({
                rule: issue.rule,
                index: issue.index,
                length: issue.length,
                line: issue.line,
                column: issue.column,
                message: issue.message,
                chapterId: issue.chapterId,
                chapterIndex: issue.chapterIndex
              }))
            }
          : null,
      clickProofreadRow(index) {
        const rows = $('proofread-results').querySelectorAll('.proofread-result');
        const row = rows[index];
        if (!row) return false;
        row.click();
        return true;
      },
      // 敏感词预检（只报告，不改动）
      openSensitivePanel: () => openSensitivePanel(),
      closeSensitivePanel: () => closeSensitivePanel(),
      sensitivePanelOpen: () => !$('sensitive-backdrop').classList.contains('hidden'),
      setSensitiveScope(scope) {
        $('sensitive-scope').value = scope === 'book' ? 'book' : 'current';
        state.sensitiveScope = sensitiveScope();
        return state.sensitiveScope;
      },
      async sensitiveRun() {
        return runSensitiveCheck();
      },
      sensitiveSummary: () => $('sensitive-summary').textContent,
      sensitiveWordListText: () => $('sensitive-wordlist-text').textContent,
      sensitiveRowCount: () => $('sensitive-results').querySelectorAll('.sensitive-result').length,
      sensitiveWordTexts: () =>
        Array.from($('sensitive-results').querySelectorAll('.sensitive-word')).map((el) => el.textContent),
      sensitiveRowTexts: () =>
        Array.from($('sensitive-results').querySelectorAll('.sensitive-result')).map((el) => el.textContent),
      sensitivePayload: () =>
        state.sensitive
          ? {
              ok: state.sensitive.ok !== false,
              code: state.sensitive.code,
              scope: state.sensitive.scope,
              total: state.sensitive.total,
              wordHitCount: state.sensitive.wordHitCount,
              byWord: (state.sensitive.byWord || []).map((item) => ({ ...item })),
              truncated: state.sensitive.truncated,
              chapterCount: state.sensitive.chapterCount,
              chapterHitCount: state.sensitive.chapterHitCount,
              skippedChapters: state.sensitive.skippedChapters,
              wordList: state.sensitive.wordList ? { ...state.sensitive.wordList } : null,
              matches: (state.sensitive.matches || []).map((match) => ({
                word: match.word,
                index: match.index,
                length: match.length,
                line: match.line,
                column: match.column,
                chapterId: match.chapterId,
                chapterIndex: match.chapterIndex
              }))
            }
          : null,
      clickSensitiveRow(index) {
        const rows = $('sensitive-results').querySelectorAll('.sensitive-result');
        const row = rows[index];
        if (!row) return false;
        row.click();
        return true;
      },
      // 测试用：直接把词表路径写进配置（正常流程走系统对话框选文件，E2E 没法点原生对话框）
      async setSensitiveWordsPath(wordPath) {
        const cfg = await call(api.setConfig, {
          sensitiveWordsPath: String(wordPath == null ? '' : wordPath)
        });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        state.sensitiveWordsDraft = cfg.sensitiveWordsPath || '';
        state.sensitiveWordsInfo = await refreshSensitiveWordList();
        renderSensitiveSettings();
        return cfg.sensitiveWordsPath;
      },
      sensitiveSettingsPath: () => $('settings-sensitive-path').value,
      sensitiveSettingsStatus: () => $('settings-sensitive-status').textContent,
      sensitiveSettingsVisible: () => !$('settings-sensitive-field').classList.contains('hidden'),
      // 朗读（提案 5.3；只读正文。E2E 换假语音引擎，不依赖系统装没装语音，也不会真的出声）
      ttsInstallFakeSpeech: () => installFakeSpeech(),
      ttsFakeFinish: () => fakeFinishSpeech(),
      ttsFakeError: (code) => fakeErrorSpeech(code),
      ttsFakeState: () => ({
        spoken: fakeSpeechState.spoken.map((item) => ({ ...item })),
        last: fakeSpeechState.last ? { ...fakeSpeechState.last } : null,
        paused: fakeSpeechState.paused,
        speaking: fakeSpeechState.speaking,
        hasPending: Boolean(fakeSpeechState.pending)
      }),
      ttsSupported: () => speechEngine().available(),
      async ttsOpen(options) {
        return openTtsBar({ autoplay: !options || options.autoplay !== false });
      },
      ttsClose: () => closeTtsBar(),
      ttsBarOpen: () => !$('tts-bar').classList.contains('hidden'),
      ttsStatus: () => state.tts.status,
      ttsStatusText: () => $('tts-status').textContent,
      ttsStatusError: () => $('tts-status').classList.contains('error'),
      ttsPreviewText: () => $('tts-preview').textContent,
      ttsPreviewTitle: () => $('tts-preview').title,
      ttsChunks: () =>
        state.tts.chunks.map((chunk) => ({
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
          paragraph: chunk.paragraph,
          line: chunk.line
        })),
      ttsIndex: () => state.tts.index,
      ttsRate: () => state.tts.rate,
      ttsVoice: () => state.tts.voiceURI,
      ttsFollowState: () => state.tts.follow,
      ttsPlayLabel: () => $('btn-tts-play').textContent,
      ttsDisabled: (id) => Boolean($(id).disabled),
      ttsVoiceOptions: () => Array.from($('tts-voice').options).map((option) => option.textContent),
      ttsVoiceValue: () => $('tts-voice').value,
      ttsPlay: () => toggleTtsPlay(),
      ttsStop: () => {
        stopTts();
        return true;
      },
      ttsPrev: () => ttsStep(-1),
      ttsNext: () => ttsStep(1),
      ttsSetRate: (rate) => setTtsRate(rate),
      ttsSetVoice: (voiceURI) => {
        $('tts-voice').value = String(voiceURI == null ? '' : voiceURI);
        return setTtsVoice($('tts-voice').value);
      },
      ttsSetFollow: (follow) => setTtsFollow(follow),
      ttsSetCaret(position) {
        const pos = Math.max(0, Math.min(Number(position) || 0, editorEl.value.length));
        editorEl.focus();
        editorEl.setSelectionRange(pos, pos);
        return editorEl.selectionStart;
      },
      selection: () => ({ start: editorEl.selectionStart || 0, end: editorEl.selectionEnd || 0 }),
      selectionText: () =>
        editorEl.value.slice(editorEl.selectionStart || 0, editorEl.selectionEnd || 0),
      // 编辑器小件（v0.7-4，提案 4.1）：选中字数 / 超长段落 / 不可见字符 / 段落导航 / 章节字数对比。
      // 全部只读，开关只影响显示层（#editor-marks），不碰正文、不写盘。
      marksFlags: () => ({ invisibles: state.marks.invisibles, longParagraphs: state.marks.longParagraphs }),
      setMarksToggle: (name, on) => setMarksToggle(name, on),
      toggleMarks: (name) => toggleMarks(name),
      marksOverlayVisible: () => !$('editor-marks').classList.contains('hidden'),
      marksLineCount: () => $('editor-marks').querySelectorAll('.marks-line').length,
      marksLongParaCount: () => $('editor-marks').querySelectorAll('.long-para').length,
      marksFullwidthCount: () => $('editor-marks').querySelectorAll('.mark-fw').length,
      marksTrailingCount: () => $('editor-marks').querySelectorAll('.mark-trail').length,
      marksText: () => $('editor-marks').textContent,
      marksPayload: () => ({
        longItems: state.marks.longItems.map((item) => ({ ...item })),
        longCount: state.marks.longCount,
        longTruncated: state.marks.longTruncated,
        markCounts: { ...state.marks.markCounts },
        markTruncated: state.marks.markTruncated,
        tooLarge: state.marks.marksTooLarge
      }),
      marksMetrics() {
        const overlay = $('editor-marks');
        const styles = getComputedStyle(editorEl);
        const overlayStyles = getComputedStyle(overlay);
        const px = (value) => {
          const n = parseFloat(value);
          return Number.isFinite(n) ? n : 0;
        };
        const editorRect = editorEl.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return {
          visible: !overlay.classList.contains('hidden'),
          overlayScrollHeight: overlay.scrollHeight,
          overlayClientHeight: overlay.clientHeight,
          overlayWidth: Math.round(overlayRect.width * 100) / 100,
          overlayHeight: Math.round(overlayRect.height * 100) / 100,
          overlayLeft: Math.round(overlayRect.left * 100) / 100,
          overlayTop: Math.round(overlayRect.top * 100) / 100,
          editorLeft: Math.round(editorRect.left * 100) / 100,
          editorTop: Math.round(editorRect.top * 100) / 100,
          contentWidth: editorEl.clientWidth - px(styles.paddingLeft) - px(styles.paddingRight),
          contentHeight: editorEl.scrollHeight - px(styles.paddingTop) - px(styles.paddingBottom),
          paddingTop: px(styles.paddingTop),
          paddingLeft: px(styles.paddingLeft),
          editorFontFamily: styles.fontFamily,
          editorFontSize: styles.fontSize,
          editorLineHeight: styles.lineHeight,
          overlayFontFamily: overlayStyles.fontFamily,
          overlayFontSize: overlayStyles.fontSize,
          overlayLineHeight: overlayStyles.lineHeight,
          overlayScrollTop: overlay.scrollTop,
          editorScrollTop: editorEl.scrollTop,
          scrollLocked: Math.abs(overlay.scrollTop - editorEl.scrollTop) < 0.5
        };
      },
      longParaRects: () =>
        Array.from($('editor-marks').querySelectorAll('.long-para')).map((el) =>
          Array.from(el.getClientRects()).map((rect) => ({
            top: Math.round(rect.top * 100) / 100,
            left: Math.round(rect.left * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100
          }))
        ),
      longParaBarCount: () => document.querySelectorAll('#editor-marks-gutter .long-para-bar').length,
      longParaBarRects: () =>
        Array.from(document.querySelectorAll('#editor-marks-gutter .long-para-bar')).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            top: Math.round(rect.top * 100) / 100,
            left: Math.round(rect.left * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100
          };
        }),
      longParaGutterVisible: () => !$('editor-marks-gutter').classList.contains('hidden'),
      setEditorScroll(top) {
        editorEl.scrollTop = Math.max(0, Number(top) || 0);
        syncMarksScroll();
        return editorEl.scrollTop;
      },
      longParaChipText: () => $('status-long-para').textContent,
      longParaChipVisible: () => !$('status-long-para').classList.contains('hidden'),
      longParaChipTitle: () => $('status-long-para').title,
      clickLongParaChip() {
        return jumpToNextLongParagraph();
      },
      selectionStatsText: () => $('status-selection').textContent,
      selectionStatsVisible: () => !$('status-selection').classList.contains('hidden'),
      selectRange(start, end) {
        editorEl.focus();
        const length = editorEl.value.length;
        const from = Math.max(0, Math.min(Number(start) || 0, length));
        const to = Math.max(0, Math.min(Number(end) || 0, length));
        editorEl.setSelectionRange(from, to);
        renderSelectionStats();
        return { start: editorEl.selectionStart, end: editorEl.selectionEnd };
      },
      charCountText: () => $('char-count').textContent,
      charCountWarn: () => $('char-count').classList.contains('count-short'),
      chapterCharsTexts: () =>
        Array.from(document.querySelectorAll('#chapter-list .chapter-chars')).map((el) => el.textContent),
      jumpParagraph: (direction) => jumpParagraph(direction),
      // 专注模式（提案 3.5）：F11 / Esc 走真实键盘路径，这里给界面状态和测量工具
      focusState: () => {
        const sidebar = $('sidebar');
        const resizer = $('sidebar-resizer');
        const header = document.querySelector('.editor-header');
        const statusbar = document.querySelector('.statusbar');
        return {
          on: state.focus.on,
          typewriter: state.focus.typewriter,
          active: focusActive(),
          savedScrollTop: state.focus.savedScrollTop,
          savedCaret: state.focus.savedCaret,
          savedCaretOffset: state.focus.savedCaretOffset,
          barVisible: !$('focus-bar').classList.contains('hidden'),
          viewHasClass: $('editor-view').classList.contains('focus-mode'),
          bodyHasClass: document.body.classList.contains('focus-mode'),
          sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : '',
          sidebarWidth: sidebar ? sidebar.offsetWidth : 0,
          resizerDisplay: resizer ? getComputedStyle(resizer).display : '',
          headerDisplay: header ? getComputedStyle(header).display : '',
          headerHeight: header ? header.offsetHeight : 0,
          statusbarDisplay: statusbar ? getComputedStyle(statusbar).display : '',
          editorWidth: editorEl.offsetWidth,
          editorClientHeight: editorEl.clientHeight,
          editorScrollTop: editorEl.scrollTop,
          focusTitle: $('focus-chapter').textContent,
          chapterTitle: $('chapter-title').textContent,
          typewriterLabel: $('btn-focus-typewriter').textContent,
          typewriterDataOn: $('btn-focus-typewriter').dataset.on,
          exitLabel: $('btn-focus-exit').textContent.replace(/\s+/g, ' ').trim(),
          title: document.title
        };
      },
      focusToggle: (on) => setFocusMode(on == null ? !state.focus.on : Boolean(on)),
      focusTypewriter: (on) => setFocusTypewriter(on),
      focusAlign: () => alignTypewriter(),
      focusMeasure: (pos) => measureCaretTop(pos),
      focusMetrics() {
        const styles = getComputedStyle(editorEl);
        const px = (value) => {
          const n = parseFloat(value);
          return Number.isFinite(n) ? n : 0;
        };
        return {
          paddingTop: px(styles.paddingTop),
          lineHeight: px(styles.lineHeight),
          clientHeight: editorEl.clientHeight,
          scrollHeight: editorEl.scrollHeight,
          scrollTop: editorEl.scrollTop,
          maxScrollTop: editorEl.scrollHeight - editorEl.clientHeight,
          caret: editorEl.selectionStart || 0,
          caretTop: measureCaretTop(editorEl.selectionStart || 0),
          mirrorExists: Boolean($('focus-mirror'))
        };
      },
      focusSetCaret(position) {
        editorEl.focus();
        const at = Math.max(0, Math.min(Number(position) || 0, editorEl.value.length));
        editorEl.setSelectionRange(at, at);
        renderSelectionStats();
        return at;
      },
      focusDispatchKey(key) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        return true;
      },
      // 灵感箱（碎片速记）
      openFragmentDialog: () => openFragmentDialog(),
      closeFragmentDialog: () => closeFragmentDialog(),
      fragmentDialogOpen: () => !$('fragment-backdrop').classList.contains('hidden'),
      setFragmentText(text) {
        $('fragment-text').value = String(text == null ? '' : text);
        updateFragmentCounter();
        return $('fragment-text').value;
      },
      fragmentCounterText: () => $('fragment-counter').textContent,
      fragmentSaveState: () => $('fragment-save-state').textContent,
      async saveFragment() {
        return saveFragment();
      },
      openInsertFragmentDialog: () => openInsertFragmentDialog(),
      closeInsertFragmentDialog: () => closeInsertFragmentDialog(),
      insertFragmentDialogOpen: () => !$('fragments-backdrop').classList.contains('hidden'),
      async refreshFragments() {
        return refreshFragments();
      },
      fragmentSummary: () => $('fragments-summary').textContent,
      fragmentRowCount: () => $('fragments-list').querySelectorAll('.fragment-item').length,
      fragmentRowTexts: () =>
        Array.from($('fragments-list').querySelectorAll('.fragment-item')).map((el) => el.textContent),
      fragmentList: () =>
        (state.fragments || []).map((item) => ({
          name: item.name,
          date: item.date,
          seq: item.seq,
          size: item.size,
          preview: item.preview
        })),
      fragmentSelectedName: () => (state.fragmentSelected ? state.fragmentSelected.name : ''),
      fragmentPreviewName: () => $('fragment-preview-name').textContent,
      fragmentPreviewText: () => $('fragment-preview').textContent,
      fragmentInsertDisabled: () => $('btn-fragment-insert').disabled,
      fragmentHint: () => $('fragment-hint').textContent,
      async clickFragmentRow(index) {
        const rows = $('fragments-list').querySelectorAll('.fragment-item');
        const row = rows[index];
        if (!row) return { ok: false, message: '没有这一条' };
        row.click();
        // 点击只负责发起异步读取；测试里直接等这个 Promise 更稳
        for (let i = 0; i < 60; i += 1) {
          if (state.fragmentSelected) return { ok: true, name: state.fragmentSelected.name };
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { ok: false, message: '读取碎片超时' };
      },
      async selectFragmentByName(name) {
        return selectFragmentByName(name);
      },
      insertSelectedFragment: () => insertSelectedFragment(),
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
      // 多窗口用例：真的走「书卡右键 → 在新窗口打开」这条界面路径
      openBookMenuForPath(bookPath) {
        const book = (state.books || []).find((item) => item.path === bookPath);
        if (!book) return false;
        showBookMenu(book, 120, 120);
        return true;
      },
      bookMenuOpen: () => !$('book-menu').classList.contains('hidden'),
      clickBookMenuAction(action) {
        const btn = $('book-menu').querySelector(`button[data-action="${String(action)}"]`);
        if (!btn) return false;
        btn.click();
        return true;
      },
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
      // 诊断日志（提案 7.4）：设置里的分组是否显示、状态文案、最近一次内部错误提示
      logSettingsVisible: () => !$('settings-logs-field').classList.contains('hidden'),
      logSettingsStatus: () => $('settings-logs-status').textContent,
      logInfo: () => (state.logInfo ? JSON.parse(JSON.stringify(state.logInfo)) : null),
      lastInternalError: () =>
        state.lastInternalError ? JSON.parse(JSON.stringify(state.lastInternalError)) : null,
      // 检查更新（提案 7.1）：设置里的分组 / 状态文案 / 下载页按钮 / 当前版本
      updateGroupVisible: () => !$('settings-update-group').classList.contains('hidden'),
      updateStatus: () => ({
        status: state.update.busy ? 'checking' : state.update.result ? state.update.result.status : 'idle',
        busy: state.update.busy,
        text: $('settings-update-status').textContent,
        downloadVisible: !$('btn-open-update').classList.contains('hidden'),
        version: $('settings-update-version').textContent,
        result: state.update.result ? JSON.parse(JSON.stringify(state.update.result)) : null
      }),
      setUpdateMock: (mock) => api.setUpdateMock(mock),
      checkUpdateNow: () => checkUpdate(),
      openUpdateDownload: () => openUpdateDownload(),
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
      // 码字日历 / 连续天数（v0.8-1）
      statsCalendar: () => (state.calendar ? JSON.parse(JSON.stringify(state.calendar)) : null),
      statsStreak: () => (state.streak ? JSON.parse(JSON.stringify(state.streak)) : null),
      calendarShift: (delta) => shiftStatsCalendar(delta),
      calendarGoToday: () => goToCurrentCalendarMonth(),
      calendarVisible: () => !$('settings-calendar-field').classList.contains('hidden'),
      calendarLabel: () => $('calendar-label').textContent,
      calendarSummaryText: () => $('calendar-summary').textContent,
      calendarStreakText: () => $('calendar-streak').textContent,
      calendarCellCount: () => document.querySelectorAll('#calendar-grid .cal-day[data-day]').length,
      calendarDayInfo: (day) => {
        const el = document.querySelector(`#calendar-grid .cal-day[data-day="${day}"]`);
        if (!el) return null;
        return {
          day: el.dataset.day,
          chars: Number(el.dataset.chars),
          level: Number(el.dataset.level),
          goalMet: el.dataset.goalMet === '1',
          seconds: Number(el.dataset.seconds),
          today: el.classList.contains('today'),
          future: el.classList.contains('future')
        };
      },
      calendarNextDisabled: () => $('calendar-next').disabled,
      calendarPrevDisabled: () => $('calendar-prev').disabled,
      calendarTodayDisabled: () => $('calendar-today').disabled,
      shelfStreakText: () => $('shelf-stats-streak').textContent,
      // 写作时长（v0.8-2，提案 N2）
      timerVisible: () => !$('btn-write-timer').classList.contains('hidden'),
      timerRunning: () => state.writeTimer.running === true,
      timerText: () => $('write-timer-text').textContent,
      timerTitle: () => $('btn-write-timer').title,
      timerStart: () => startWriteTimer(),
      timerPause: () => pauseWriteTimer(),
      timerFlush: () => flushWriteTimer(),
      timerReset: () => resetWriteTimer({ flush: true }),
      timerSessionSeconds: () => writeTimerSessionSeconds(),
      timerTodaySeconds: () => writeTimerTodaySeconds(),
      timerUnsentSeconds: () => Math.floor(writeTimerUnsentMs() / 1000),
      durationEnabled: () => writeDurationEnabled(),
      durationSettingsVisible: () => !$('settings-duration-field').classList.contains('hidden'),
      durationSettingsSummary: () => $('settings-duration-summary').textContent,
      durationSettingsChecked: () => $('settings-write-duration').checked === true,
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
      state.appVersion = (appInfo && appInfo.version) || '';
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
    // 字体真正加载完可能会改变换行：加载好以后把标记层重新对齐一次
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => scheduleMarksRender(0)).catch(() => {});
    }
    // 上次用的自定义字体：启动时异步加载（失败就退回内置字体，不影响写作）
    if (state.config && state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
      loadCustomFont(state.config.editorCustomFontPath, { silent: true }).then(() => applyEditorStyle());
    }
    showView('shelf');
    await refreshShelf();
    // 从「在新窗口打开」进来的窗口：启动后直接打开指定的书（由主进程在 URL 里传路径）
    const openAtStart = new URLSearchParams(location.search).get('open');
    if (openAtStart) await openBookByPath(openAtStart);
    if (state.testMode) {
      window.__cwTest = createTestHooks();
      window.__cwTest.ready = true;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
