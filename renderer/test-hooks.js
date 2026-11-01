/* 测试钩子（E2E / 截图自动化用）——从 renderer.js 拆出来的（v0.9 B-2，代码审计 F5）
 *
 * 为什么单独一个文件：这一千多行只在 ?test=1 时有用，却一直跟产品代码同文件，
 * 每次启动都要解析。现在 renderer.js 在测试模式下才会动态插入
 * <script src="test-hooks.js">，**正常使用（作者自己开软件）根本不加载这个文件**；
 * index.html 里没有它的静态 <script>（单测钉住这一点）。
 *
 * 怎么拿到产品内部状态：钩子用的全是渲染层 IIFE 里的闭包（函数、状态、DOM 引用），
 * 外文件引用不到，所以由 renderer.js 的 testHooksScope() 把需要的东西作为 host 传进来：
 *   - 稳定的函数 / 常量：create() 时一次性解构（与原实现等价）；
 *   - 活绑定（模块级 let：fakeSpeechState / exportFormat / lastFontDecodeMode /
 *     formatBookProgressEl / testVerifyBook）：走 host.x 每次读最新值，
 *     **不能解构**，否则拿到的是加载时的旧快照。
 * 新增钩子如果用到别的模块级变量，记得同时更新 renderer.js 的 testHooksScope()
 * 与 tests/test-hooks.test.js 的静态闸门。
 *
 * 浏览器里挂 window.CWTestHooks；Node 里可 require（单测拿它做静态闸门 + 直接 create 冒烟）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CWTestHooks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(host) {
    // 稳定的函数 / 常量：一次性解构（与原实现等价；都是渲染层 IIFE 里的闭包）
    // 活绑定（模块级 let）不在这里，走 host.x 每次读最新值，见上面头注释
    const {
      $, alignTypewriter, answerModalValue, api, applyCaretColor, applyEditorStyle, applyFormatToEditor,
      applySidebarWidth, backToShelf, calendarSummaryText, call, canUndoFormat, caretColorLib,
      caretColorValue, chapterNote, chapterStatus, chapterTitle, chapterVolumeId, checkUpdate,
      clearFindSession, closeBookInfoDialog, closeConflictDialog, closeFindPanel, closeFragmentDialog,
      closeHistoryDialog, closeHistoryPreview, closeInsertFragmentDialog, closeJumpDialog,
      closeProofreadPanel, closeSensitivePanel, closeSettings, closeTtsBar, confirmHistoryRestore,
      confirmJumpFromDialog, copyChapterPlatformFlow, createBookWithTitle, createChapterAt,
      createVolumeFlow, deleteBookFlow, deleteChapterAt, deleteFindBookmark, deleteVolumeFlow,
      displayMenuOpen, editChapterNoteAt, editorEl, effectiveConfig, ensureSearchIndex, exitReadingMode,
      fakeErrorSpeech, fakeFinishSpeech, findPanelOpen, findSessionActive, flushWriteTimer, focusActive,
      formatCardOpen, formatCurrentChapterFromConfig, formatUndoSteps, goToCurrentCalendarMonth,
      handleCloseRequest, hideDisplayMenu, hideFormatMenu, importBooksFlow, insertSelectedFragment,
      installFakeSpeech, jumpParagraph, jumpToFindBookmark, jumpToNextLongParagraph, loadCustomFont,
      loadedCustomFont, measureCaretTop, moveChapterByDrag, moveChapterByDrop, moveChapterToVolume,
      moveVolumeFlow, onEditorInput, openBookByPath, openBookInNewWindow, openBookInfoDialog,
      openConflictDialog, openContinueBook, openFindPanel, openFormatDialog, openFragmentDialog,
      openHistoryForCurrentBook, openHistoryForPath, openInsertFragmentDialog, openJumpDialog,
      openProofreadPanel, openReadingMode, openSensitivePanel, openSettings, openTtsBar,
      openUpdateDownload, pauseWriteTimer, persistSidebarWidth, previewHistoryBackup, previewSettings,
      proofreadScope, proofreadWordListText, readBookInfoForm, readExportRange, readFormatOptions,
      readingBlockElements, readingBlockIndexAt, readingCurrentIndex, readingGo, readingJumpTo,
      readingLoadedIndexes, readingMeasureBlocks, readingNearBottom, readingScrollEl,
      readingScrollToBlock, readingVisibleIndex, refreshFragments, refreshHistory, refreshJumpMatches,
      refreshProofreadWordList, refreshReplaceBackups, refreshSensitiveWordList, refreshShelf,
      refreshStats, renameChapterAt, renameVolumeFlow, renderCaretColorRow,
      renderChapterTemplatePreview, renderContinueWriting, renderProofreadSettings,
      renderSelectionStats, renderSensitiveSettings, renderSettingsCaretColors, renderShelf,
      resetBookDisplay, resetWriteTimer, restoreFindBookmarkForCurrentChapter, restoreReplaceBackupFlow,
      runFind, runFormatBook, runProofread, runReplaceAll, runReplaceOne, runSensitiveCheck, s2tLib,
      saveBookInfoDialog, saveCurrent, saveFindBookmark, saveFragment, saveSettings,
      scheduleContentSearch, scheduleReadingScrollCheck, selectFindMatch, selectFragmentByName,
      sensitiveScope, sensitiveWordListText, setCaretColorPersisted, setCaretParagraphPersisted,
      setChapterStatusAt, setDisplayPreset, setFocusMode, setFocusTypewriter, setMarksToggle,
      setReadingPref, setSelectValue, setTtsFollow, setTtsRate, setTtsVoice, shiftStatsCalendar,
      showBookMenu, showDisplayMenu, showFormatCard, speechEngine, startWriteTimer, state, stepFind,
      stopTts, switchChapter, syncFindOverlayScroll, syncMarksScroll, toggleMarks, toggleTtsPlay,
      toggleVolumeCollapse, ttsStep, undoFormat, updateCaretParagraph, updateFragmentCounter,
      updateReadingUi, updateStatus, volumeList, writeDurationEnabled, writeFormatOptions,
      writeTimerSessionSeconds, writeTimerTodaySeconds, writeTimerUnsentMs,
    } = host;


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
      // 自检 / 基准用：不碰正文，只跑一次「输入事件处理」，用来量渲染层每次输入的同步开销
      // （字数统计 / 状态栏 / 窗口标题 / 标记层排期）。A-3 的输入延迟拆账靠它。
      inputTick() {
        onEditorInput();
      },
      text: () => editorEl.value,
      async save() {
        return saveCurrent({ silent: true });
      },
      // 保存热路径（审计 F2）：非 silent 保存 = 真的会出提示，E2E 用它验证提示时序
      async saveVisible() {
        return saveCurrent({ silent: false });
      },
      // 最近几条提示（只在 ?test=1 里记录）：E2E 用它断言「已保存先出、缺章警告后到」
      toasts: () => state.toastLog.map((item) => ({ message: item.message, kind: item.kind })),
      clearToasts() {
        state.toastLog.length = 0;
      },
      // 替换后台全会校验（E2E 验证「保存不等校验」「后台失败不误报」）
      setTestVerifyBook(fn) {
        host.testVerifyBook = typeof fn === 'function' ? fn : null;
      },
      chapterTitles: () => state.chapters.map((c, i) => chapterTitle(i, c.name)),
      // 章节列表 DOM 里真正显示的两格拼起来（序号格 + 章名格），E2E 用它对照 core.formatTitle
      chapterListLabels: () =>
        Array.from(document.querySelectorAll('#chapter-list .chapter-item')).map((item) => {
          const num = item.querySelector('.chapter-num');
          const name = item.querySelector('.chapter-name');
          return `${num ? num.textContent : ''}${name ? name.textContent : ''}`;
        }),
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
      exportFormat: () => host.exportFormat,
      exportTitle: () => $('export-title').textContent,
      // 导出简繁转换（v0.8 P0 N7）：设置里的档位 + 导出对话框里那行只读提示
      exportConversionValue: () => $('settings-export-conversion').value,
      exportConversionSettingsVisible: () => !$('settings-export-field').classList.contains('hidden'),
      exportConversionNote: () => $('export-conversion-note').textContent,
      // 测试用：直接把档位写进配置（正常流程走设置弹层里的下拉框 + 保存设置）
      async setExportConversion(mode) {
        const cfg = await call(api.setConfig, { exportConversion: String(mode == null ? '' : mode) });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        setSelectValue('settings-export-conversion', s2tLib.normalizeMode(cfg.exportConversion), '');
        return cfg.exportConversion;
      },
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
      // 章节模板（v0.8-5）：设置里的输入框 / 预览，以及把展开结果填进当前空章（自检用）
      chapterTemplateField: () => $('settings-chapter-template').value,
      chapterTemplatePreview: () => $('settings-template-preview').textContent,
      setChapterTemplateField(value) {
        $('settings-chapter-template').value = String(value == null ? '' : value);
        renderChapterTemplatePreview();
        return $('settings-chapter-template').value;
      },
      async saveTemplateOnly(value) {
        // 自检 / 截图用：只写 chapterTemplate，不碰其它设置
        state.globalConfig = await call(api.setConfig, { chapterTemplate: value });
        state.config = effectiveConfig();
        return state.globalConfig.chapterTemplate;
      },
      undoEditor() {
        // 自检用：模拟 Ctrl+Z（原生 undo），用来验证模板可撤销
        editorEl.focus();
        let ok = false;
        try {
          ok = document.execCommand('undo');
        } catch {
          ok = false;
        }
        onEditorInput();
        return { ok, text: editorEl.value, dirty: state.dirty };
      },
      caret: () => editorEl.selectionStart,
      setCaret(pos) {
        editorEl.focus();
        const at = Math.max(0, Number(pos) || 0);
        editorEl.setSelectionRange(at, at);
        updateCaretParagraph();
      },
      // 排版
      // openFormatMenu / closeFormatMenu 是「悬浮选择卡」：点按钮不再开菜单，而是直接整理本章。
      openFormatMenu: () => showFormatCard(),
      closeFormatMenu: () => hideFormatMenu(),
      formatMenuOpen: () => formatCardOpen(),
      formatCardOpen: () => formatCardOpen(),
      formatCardNote: () => $('format-card-note').textContent,
      formatCardItems: () =>
        Array.from(document.querySelectorAll('#format-menu button[data-action]')).map((el) => ({
          action: el.dataset.action,
          label: el.textContent,
          disabled: el.disabled === true
        })),
      displayMenuOpen: () => displayMenuOpen(),
      openDisplayMenu: () => showDisplayMenu(),
      closeDisplayMenu: () => hideDisplayMenu(),
      displayMenuItems: () =>
        Array.from(document.querySelectorAll('#display-menu button[data-action]')).map((el) => el.dataset.action),
      // 点「整理」的等价入口（直接按 config.formatOptions 整理当前章）
      formatCurrentChapter() {
        return formatCurrentChapterFromConfig();
      },
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
      formatBookProgressText: () => (host.formatBookProgressEl ? host.formatBookProgressEl.textContent : ''),
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
      // 查找增强（v0.8-11，提案 N11）：当前章上一处 / 下一处 + 结果持续高亮
      findSession: () => {
        if (!state.find.total) return null;
        return {
          active: findSessionActive(),
          query: state.find.query,
          caseSensitive: state.find.caseSensitive,
          index: state.find.index,
          total: state.find.total,
          windowStart: state.find.windowStart,
          windowEnd: state.find.windowEnd,
          highlighted: state.find.highlighted,
          truncated: state.find.truncated,
          fromBookmark: state.find.fromBookmark
        };
      },
      findMatchIndexes: () => state.find.matches.map((match) => match.index),
      findFromBookmark: () => state.find.fromBookmark,
      findQueryField: () => $('find-query').value,
      findCaseField: () => $('find-case').checked,
      // 查找书签（v0.8-11b，提案 N11b）：面板列表 / 存 / 删 / 跳（正常流程走真实按钮点击）
      findBookmarks: () => state.findBookmarks.map((item) => ({ ...item })),
      findBookmarkCount: () => state.findBookmarks.length,
      findBookmarksCountText: () => $('find-bookmarks-count').textContent,
      findBookmarkButtonText: () => $('btn-find-bookmark').textContent,
      findBookmarkRows: () =>
        Array.from(document.querySelectorAll('#find-bookmark-list .find-bookmark')).map((el) => ({
          text: el.textContent,
          current: el.classList.contains('current'),
          bookId: el.dataset.bookId || '',
          chapterId: el.dataset.chapterId || ''
        })),
      async findBookmarkSave() {
        return saveFindBookmark();
      },
      async findBookmarkDelete(index) {
        const bookmark = state.findBookmarks[Number(index) || 0];
        return bookmark ? deleteFindBookmark(bookmark) : { ok: false };
      },
      async findBookmarkJump(index) {
        const bookmark = state.findBookmarks[Number(index) || 0];
        return bookmark ? jumpToFindBookmark(bookmark) : { ok: false };
      },
      async findBookmarkRestore() {
        return restoreFindBookmarkForCurrentChapter({ force: true });
      },
      async findStep(direction) {
        return stepFind(Number(direction) < 0 ? -1 : 1);
      },
      async findGoTo(index) {
        return selectFindMatch(index);
      },
      findHighlightCount: () => document.querySelectorAll('#editor-find-marks .find-hit').length,
      findCurrentOrdinal: () => {
        const el = document.querySelector('#editor-find-marks .find-hit-current');
        return el && el.dataset.ordinal != null ? Number(el.dataset.ordinal) : -1;
      },
      findOverlayVisible: () => !$('editor-find-marks').classList.contains('hidden'),
      findOverlayScroll: () => {
        const overlay = $('editor-find-marks');
        return {
          top: overlay.scrollTop,
          left: overlay.scrollLeft,
          editorTop: editorEl.scrollTop,
          editorLeft: editorEl.scrollLeft
        };
      },
      findHitRects(ordinal) {
        const el = $('editor-find-marks').querySelector(
          `.find-hit[data-ordinal="${Number(ordinal)}"]`
        );
        if (!el) return [];
        return Array.from(el.getClientRects()).map((rect) => ({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height
        }));
      },
      findHitStyle(ordinal) {
        const el =
          ordinal == null
            ? $('editor-find-marks').querySelector('.find-hit-current')
            : $('editor-find-marks').querySelector(
                `.find-hit[data-ordinal="${Number(ordinal)}"]`
              );
        if (!el) return null;
        const styles = getComputedStyle(el);
        return {
          background: styles.backgroundColor,
          boxShadow: styles.boxShadow,
          color: styles.color
        };
      },
      findNavCount: () => $('find-nav-count').textContent,
      findChipText: () => $('status-find').textContent,
      findChipVisible: () => !$('status-find').classList.contains('hidden'),
      // 测试用：真的触发一次 input 事件（模拟作者改查找框里的词）
      findTypeQuery(value) {
        const input = $('find-query');
        input.value = String(value == null ? '' : value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value;
      },
      findClear() {
        clearFindSession();
        return true;
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
      proofreadWordListText: () => $('proofread-wordlist-text').textContent,
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
              customWordCount: state.proofread.customWordCount,
              wordList: state.proofread.wordList
                ? { count: state.proofread.wordList.count, ok: state.proofread.wordList.ok }
                : null,
              chapterCount: state.proofread.chapterCount,
              chapterHitCount: state.proofread.chapterHitCount,
              skippedChapters: state.proofread.skippedChapters,
              issues: state.proofread.issues.map((issue) => ({
                rule: issue.rule,
                index: issue.index,
                length: issue.length,
                line: issue.line,
                column: issue.column,
                message: issue.message,
                suggestion: issue.suggestion,
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
      // 测试用：直接把词表路径写进配置（正常流程走系统对话框选文件，E2E 没法点原生对话框）。
      // v0.9 C-2b：config:set 只认「对话框刚选中的值」，所以先让主进程记一次「模拟选中」，
      // 再照常保存 —— 这样 E2E 走的是生产同一条校验链，而不是绕过它。
      async setSensitiveWordsPath(wordPath) {
        const target = String(wordPath == null ? '' : wordPath);
        if (api.testPickConfigPath) {
          await call(api.testPickConfigPath, target, 'sensitiveWordsPath').catch(() => null);
        }
        const cfg = await call(api.setConfig, {
          sensitiveWordsPath: target
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
      // 测试用：直接把校对词表路径写进配置（正常流程走系统对话框选文件）
      // 同 setSensitiveWordsPath：先让主进程记一次「模拟对话框选中」，再照常保存。
      async setProofreadWordsPath(wordPath) {
        const target = String(wordPath == null ? '' : wordPath);
        if (api.testPickConfigPath) {
          await call(api.testPickConfigPath, target, 'proofreadWordsPath').catch(() => null);
        }
        const cfg = await call(api.setConfig, {
          proofreadWordsPath: target
        });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        state.proofreadWordsDraft = cfg.proofreadWordsPath || '';
        state.proofreadWordsInfo = await refreshProofreadWordList();
        renderProofreadSettings();
        return cfg.proofreadWordsPath;
      },
      proofreadSettingsPath: () => $('settings-proofread-path').value,
      proofreadSettingsStatus: () => $('settings-proofread-status').textContent,
      proofreadSettingsVisible: () => !$('settings-proofread-field').classList.contains('hidden'),
      // 朗读（提案 5.3；只读正文。E2E 换假语音引擎，不依赖系统装没装语音，也不会真的出声）
      ttsInstallFakeSpeech: () => installFakeSpeech(),
      ttsFakeFinish: () => fakeFinishSpeech(),
      ttsFakeError: (code) => fakeErrorSpeech(code),
      ttsFakeState: () => ({
        spoken: host.fakeSpeechState.spoken.map((item) => ({ ...item })),
        last: host.fakeSpeechState.last ? { ...host.fakeSpeechState.last } : null,
        paused: host.fakeSpeechState.paused,
        speaking: host.fakeSpeechState.speaking,
        hasPending: Boolean(host.fakeSpeechState.pending)
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
      marksFlags: () => ({
        invisibles: state.marks.invisibles,
        longParagraphs: state.marks.longParagraphs,
        caretParagraph: state.marks.caretParagraph
      }),
      setMarksToggle: (name, on) => setMarksToggle(name, on),
      toggleMarks: (name) => toggleMarks(name),
      marksOverlayVisible: () => !$('editor-marks').classList.contains('hidden'),
      marksLineCount: () => $('editor-marks').querySelectorAll('.marks-line').length,
      marksLongParaCount: () => $('editor-marks').querySelectorAll('.long-para').length,
      marksFullwidthCount: () => $('editor-marks').querySelectorAll('.mark-fw').length,
      marksTrailingCount: () => $('editor-marks').querySelectorAll('.mark-trail').length,
      // 当前段落高亮（v0.8-10，提案 N10）：只读测量，供 E2E 校验「高亮的是光标那一段」
      marksCaretEnabled: () => Boolean(state.marks.caretParagraph),
      marksCaretLine: () => state.marks.caretLine || 0,
      marksCaretTooLarge: () => Boolean(state.marks.caretTooLarge),
      marksCaretParaCount: () => $('editor-marks').querySelectorAll('.caret-para').length,
      marksCaretParaInfo() {
        const el = $('editor-marks').querySelector('.caret-para');
        if (!el) return null;
        const styles = getComputedStyle(el);
        return {
          line: Number(el.dataset.line) || 0,
          text: el.textContent,
          background: styles.backgroundColor,
          boxShadow: styles.boxShadow,
          rects: Array.from(el.getClientRects()).map((rect) => ({
            top: Math.round(rect.top * 100) / 100,
            left: Math.round(rect.left * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100
          }))
        };
      },
      editorCaretColor: () => getComputedStyle(editorEl).caretColor,
      // 当前段落高亮按书记忆 + 自定义颜色（v0.8-10b，提案 N10b）
      setCaretParagraphPersist: (on) => setCaretParagraphPersisted(on, { quiet: true }),
      setCaretColor: (color) => setCaretColorPersisted(color),
      previewCaretColor(color) {
        applyCaretColor({ caretParagraphColor: caretColorLib.normalizeColor(color) });
        renderCaretColorRow();
        return caretColorLib.normalizeColor(color);
      },
      caretSettings() {
        return {
          enabled: Boolean(state.marks.caretParagraph),
          scope: state.bookId ? 'book' : 'global',
          bookId: state.bookId || '',
          configEnabled: Boolean(state.config && state.config.caretParagraph === true),
          globalEnabled: Boolean(state.globalConfig && state.globalConfig.caretParagraph === true),
          color: caretColorValue(state.config),
          globalColor: caretColorLib.normalizeColor(
            state.globalConfig && state.globalConfig.caretParagraphColor
          ),
          bookDisplay: { ...(state.bookDisplay || {}) }
        };
      },
      caretColorInfo() {
        const bodyStyle = getComputedStyle(document.body);
        const value = caretColorValue(state.config);
        return {
          value,
          presetIndex: caretColorLib.presetIndex(value),
          tint: bodyStyle.getPropertyValue('--caret-para-tint').trim(),
          edge: bodyStyle.getPropertyValue('--caret-para-edge').trim(),
          inlineTint: document.body.style.getPropertyValue('--caret-para-tint').trim(),
          inlineEdge: document.body.style.getPropertyValue('--caret-para-edge').trim()
        };
      },
      caretMenuColor() {
        const active = document.querySelector('#format-caret-colors [data-active="1"]');
        const picker = $('format-caret-color');
        return {
          active: active ? active.dataset.caretColor || '' : null,
          picker: picker ? picker.value : '',
          swatchCount: document.querySelectorAll('#format-caret-colors [data-caret-color]').length
        };
      },
      setSettingsCaretColor(color) {
        state.settingsCaretColorDraft = caretColorLib.normalizeColor(color);
        renderSettingsCaretColors();
        previewSettings();
        return state.settingsCaretColorDraft;
      },
      settingsCaretState() {
        const active = document.querySelector('#settings-caret-colors [data-active="1"]');
        const picker = $('settings-caret-color');
        return {
          checked: $('settings-caret-paragraph').checked === true,
          draft: caretColorLib.normalizeColor(state.settingsCaretColorDraft),
          active: active ? active.dataset.settingsCaretColor || '' : null,
          picker: picker ? picker.value : '',
          hint: $('settings-caret-hint').textContent,
          visible: !$('settings-caret-field').classList.contains('hidden')
        };
      },
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
        syncFindOverlayScroll();
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
        updateCaretParagraph();
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
      // 阅读模式（v0.8-4，提案 N4）：入口 / 状态 / 导航 / 显示档位；只读，不写盘
      readingButtonText: () => $('btn-reading').textContent,
      async openReading() {
        return openReadingMode();
      },
      closeReading: () => exitReadingMode(),
      readingOpen: () => state.reading.open,
      readingViewVisible: () => !$('reading-view').classList.contains('hidden'),
      readingState() {
        const total = state.chapters.length;
        const current = readingCurrentIndex();
        const loaded = readingLoadedIndexes();
        const note = $('reading-note');
        return {
          open: state.reading.open,
          view: state.view,
          bookTitle: $('reading-book-title').textContent,
          current,
          total,
          loaded,
          progress: $('reading-progress').textContent,
          summary: $('reading-summary').textContent,
          fontLevel: state.readingPrefs.fontLevel,
          lineLevel: state.readingPrefs.lineLevel,
          prevDisabled: $('btn-reading-prev').disabled,
          nextDisabled: $('btn-reading-next').disabled,
          endVisible: !$('reading-end').classList.contains('hidden'),
          note: note.textContent,
          noteVisible: !note.classList.contains('hidden'),
          loading: state.reading.loading,
          errorBlocks: $('reading-content').querySelectorAll('.reading-chapter-error').length,
          blockCount: loaded.length,
          tocCount: $('reading-toc').options.length,
          tocValue: $('reading-toc').value,
          dirty: state.dirty,
          editorText: editorEl.value,
          title: document.title
        };
      },
      readingBlocks() {
        return readingBlockElements().map((el) => {
          const titleEl = el.querySelector('.reading-chapter-title');
          const textEl = el.querySelector('.reading-chapter-text');
          const emptyEl = el.querySelector('.reading-chapter-empty');
          const errorEl = el.querySelector('.reading-chapter-error');
          return {
            index: readingBlockIndexAt(el),
            title: titleEl ? titleEl.textContent : '',
            text: textEl ? textEl.textContent : '',
            empty: Boolean(emptyEl),
            error: errorEl ? errorEl.textContent : ''
          };
        });
      },
      async readingNext() {
        return readingGo(1);
      },
      async readingPrev() {
        return readingGo(-1);
      },
      async readingJump(index) {
        return readingJumpTo(index);
      },
      readingSetFontLevel(level) {
        return setReadingPref('font', level);
      },
      readingSetLineLevel(level) {
        return setReadingPref('line', level);
      },
      readingScrollToBottom() {
        const scroll = readingScrollEl();
        if (!scroll) return 0;
        scroll.scrollTop = scroll.scrollHeight;
        state.reading.index = readingVisibleIndex();
        updateReadingUi();
        scheduleReadingScrollCheck(0);
        return scroll.scrollTop;
      },
      readingScrollToTop() {
        const scroll = readingScrollEl();
        if (!scroll) return 0;
        scroll.scrollTop = 0;
        state.reading.index = readingVisibleIndex();
        updateReadingUi();
        scheduleReadingScrollCheck(0);
        return 0;
      },
      readingJumpToBlock(index) {
        const ok = readingScrollToBlock(Number(index));
        updateReadingUi();
        scheduleReadingScrollCheck(0);
        return ok;
      },
      readingMetrics() {
        const scroll = readingScrollEl();
        const sample = $('reading-content').querySelector('.reading-chapter-text');
        const styles = sample ? getComputedStyle(sample) : null;
        return {
          fontSize: styles ? styles.fontSize : '',
          lineHeight: styles ? parseFloat(styles.lineHeight) : 0,
          fontFamily: styles ? styles.fontFamily : '',
          userSelect: styles ? styles.userSelect : '',
          scrollTop: scroll ? scroll.scrollTop : 0,
          scrollHeight: scroll ? scroll.scrollHeight : 0,
          clientHeight: scroll ? scroll.clientHeight : 0,
          nearBottom: readingNearBottom(),
          chapterCount: readingBlockElements().length
        };
      },
      readingScrollInfo() {
        const scroll = readingScrollEl();
        return {
          scrollTop: scroll ? scroll.scrollTop : null,
          scrollHeight: scroll ? scroll.scrollHeight : null,
          clientHeight: scroll ? scroll.clientHeight : null,
          current: readingCurrentIndex(),
          blocks: readingMeasureBlocks()
        };
      },
      readingSelectToc(index) {
        const toc = $('reading-toc');
        toc.value = String(index);
        toc.dispatchEvent(new Event('change', { bubbles: true }));
        return toc.value;
      },
      readingClick(id) {
        const el = $(id);
        if (!el) return false;
        el.click();
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
      // 最近一次字体解码走的是原生 fetch（data: URL）还是 atob 回退——F11 的自检断言用
      fontDecodeMode: () => host.lastFontDecodeMode,
      // 清掉「已加载字体」的渲染层缓存（只给自检用：模拟重新加载页面后第一次读字体）
      resetLoadedFont() {
        loadedCustomFont.path = '';
        loadedCustomFont.name = '';
        loadedCustomFont.ok = false;
        return true;
      },
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
      chapterTemplateSettingsVisible: () =>
        !$('settings-template-field').classList.contains('hidden'),
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

  return { create };
});
