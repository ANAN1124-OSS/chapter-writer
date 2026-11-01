// 渲染层唯一可用的主进程能力：白名单 IPC，不暴露 Node。
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    return { ok: false, code: 'IPC_ERROR', message: (err && err.message) || String(err) };
  }
}

// 主进程 → 渲染层的单向通知：只注册函数类型的回调，忽略事件对象本身（和以前每个频道手写一遍等价）。
function on(channel, cb) {
  if (typeof cb !== 'function') return;
  ipcRenderer.on(channel, (_event, ...args) => cb(...args));
}

contextBridge.exposeInMainWorld('api', {
  appVersion: () => invoke('app:version'),
  appWarning: () => invoke('app:warning'),
  getRecentBook: () => invoke('app:recent-book'),
  // 多窗口：这个窗口的会话信息 / 在新窗口打开书 / 回书架时释放「打开中的书」登记
  windowInfo: () => invoke('window:info'),
  openBookInNewWindow: (bookPath) => invoke('window:open-book', bookPath),
  releaseBook: () => invoke('window:release-book'),
  listBooks: () => invoke('books:list'),
  createBook: (title) => invoke('book:create', title),
  openBook: (bookPath) => invoke('book:open', bookPath),
  verifyBook: (bookPath) => invoke('book:verify', bookPath),
  renameBook: (bookPath, title) => invoke('book:rename', bookPath, title),
  updateBookInfo: (bookPath, patch) => invoke('book:update-info', bookPath, patch),
  setLastOpenChapter: (bookPath, chapterId) => invoke('book:set-last', bookPath, chapterId),

  loadChapter: (bookPath, file) => invoke('chapter:load', bookPath, file),
  statChapter: (bookPath, file) => invoke('chapter:stat', bookPath, file),
  saveChapter: (bookPath, chapterId, text) => invoke('chapter:save', bookPath, chapterId, text),
  formatText: (text, options) => invoke('text:format', text, options),
  findInText: (text, query, options) => invoke('text:find', text, query, options),
  // 当前章全部命中（v0.8-11，提案 N11）：上一处 / 下一处 + 结果持续高亮用；只算文本、不写盘
  findAll: (text, query, options) => invoke('text:find-all', text, query, options),
  findNext: (text, query, fromIndex, options) =>
    invoke('text:find-next', text, query, fromIndex, options),
  replaceInText: (text, query, replacement, options) =>
    invoke('text:replace', text, query, replacement, options),
  // 校对（只报告、不改动）：当前章纯文本检查 / 整本逐章只读检查
  proofreadText: (text, options) => invoke('text:proofread', text, options),
  proofreadBook: (bookPath, options, override) =>
    invoke('book:proofread', bookPath, options, override),
  // 校对词表（v0.8-6）：作者自己的错别字 / 禁用词；主进程只读，渲染层只拿数量与状态
  proofreadWordsInfo: () => invoke('proofread:words-info'),
  pickProofreadWords: () => invoke('proofread:pick-words'),
  // 敏感词预检（只报告、不改动）：词表由作者指定，主进程只读词表；渲染层拿不到词表内容
  sensitiveWordsInfo: () => invoke('sensitive:words-info'),
  pickSensitiveWords: () => invoke('sensitive:pick-words'),
  sensitiveCheckText: (text, options) => invoke('text:sensitive-check', text, options),
  sensitiveCheckBook: (bookPath, options, override) =>
    invoke('book:sensitive-check', bookPath, options, override),
  // 朗读（提案 5.3）：只切分正文，发声在渲染层用系统语音；不读盘、不写盘
  ttsChunks: (text, options) => invoke('text:tts-chunks', text, options),
  // Ctrl+G 跳章：章号 / 章名关键词的纯匹配（主进程只算不读盘）
  jumpMatch: (chapters, query, options) => invoke('jump:match', chapters, query, options),
  createChapter: (bookPath, insertIndex, name, volumeId) =>
    invoke('chapter:create', bookPath, insertIndex, name, volumeId),
  renameChapter: (bookPath, chapterId, name) => invoke('chapter:rename', bookPath, chapterId, name),
  updateChapterMeta: (bookPath, chapterId, patch) =>
    invoke('chapter:update-meta', bookPath, chapterId, patch),
  deleteChapter: (bookPath, chapterId) => invoke('chapter:delete', bookPath, chapterId),
  moveChapter: (bookPath, chapterId, toIndex) => invoke('chapter:move', bookPath, chapterId, toIndex),
  createVolume: (bookPath, name) => invoke('volume:create', bookPath, name),
  renameVolume: (bookPath, volumeId, name) => invoke('volume:rename', bookPath, volumeId, name),
  deleteVolume: (bookPath, volumeId) => invoke('volume:delete', bookPath, volumeId),
  moveChapterToVolume: (bookPath, chapterId, volumeId) =>
    invoke('chapter:move-to-volume', bookPath, chapterId, volumeId),
  moveVolume: (bookPath, volumeId, toIndex) => invoke('volume:move', bookPath, volumeId, toIndex),
  moveChapterTo: (bookPath, chapterId, volumeId, beforeChapterId) =>
    invoke('chapter:move-to', bookPath, chapterId, volumeId, beforeChapterId),
  searchBook: (bookPath, options) => invoke('book:search', bookPath, options),
  replaceBook: (bookPath, options) => invoke('book:replace', bookPath, options),
  listReplaceBackups: (bookPath) => invoke('book:list-replace-backups', bookPath),
  restoreReplaceBackup: (bookPath, backupName) =>
    invoke('book:restore-replace-backup', bookPath, backupName),
  listHistory: (bookPath) => invoke('book:list-history', bookPath),
  previewHistoryFile: (bookPath, groupId, fileName) =>
    invoke('book:preview-history-file', bookPath, groupId, fileName),
  restoreHistoryFile: (bookPath, groupId, fileName) =>
    invoke('book:restore-history-file', bookPath, groupId, fileName),
  restoreHistoryDir: (bookPath, groupId) =>
    invoke('book:restore-history-dir', bookPath, groupId),
  formatPreviewBook: (bookPath, options) => invoke('book:format-preview', bookPath, options),
  formatBook: (bookPath, options) => invoke('book:format', bookPath, options),

  exportPlan: (bookPath, override, range) => invoke('book:export-plan', bookPath, override, range),
  exportBook: (bookPath, override, range) => invoke('book:export', bookPath, override, range),
  exportEpub: (bookPath, override, range) => invoke('book:export-epub', bookPath, override, range),
  exportDocx: (bookPath, override, range) => invoke('book:export-docx', bookPath, override, range),
  copyBook: (bookPath, override) => invoke('book:copy', bookPath, override),
  copyChapterPlatform: (bookPath, ref) => invoke('chapter:copy-platform', bookPath, ref),
  repairBook: (bookPath, mode) => invoke('book:repair', bookPath, mode),
  importBooks: (paths, options) => invoke('book:import', paths, options),
  deleteBook: (bookPath) => invoke('book:delete', bookPath),

  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
  // 仅自检：模拟「在系统对话框里选中了书架目录 / 词表路径」，生产环境主进程不会注册这个频道。
  // 参数顺序与主进程一致：路径在前、字段名在后（静态闸门盯第一参数）。
  testPickConfigPath: (pickedPath, field) => invoke('config:test-pick', pickedPath, field),
  getStats: () => invoke('stats:get'),
  // 码字日历：只读某个月的每日字数（year/month 由渲染层传，主进程清洗），不写盘
  getStatsCalendar: (calendar) => invoke('stats:calendar', calendar),
  // 写作时长（v0.8-2）：只上报「整秒数」，主进程按配置决定记不记；不传正文/按键
  addStatsDuration: (payload) => invoke('stats:duration', payload),
  // 灵感箱（碎片速记）：书架根目录 _碎片 里的普通 txt，不写 书目.json、不碰章节
  listFragments: () => invoke('fragments:list'),
  createFragment: (text) => invoke('fragments:create', text),
  readFragment: (name) => invoke('fragments:read', name),
  getBookDisplay: (bookId) => invoke('book:get-display', bookId),
  setBookDisplay: (bookId, patch) => invoke('book:set-display', bookId, patch),
  resetBookDisplay: (bookId) => invoke('book:reset-display', bookId),
  // 查找书签（v0.8-11b，提案 N11b）：只存查询词与大小写到 userData/config.json。
  // 主进程按「书 + 章」原子增删，渲染层拿不到 fs，也不会整份覆盖别人的书签。
  listFindBookmarks: () => invoke('find:bookmark-list'),
  saveFindBookmark: (entry) => invoke('find:bookmark-save', entry),
  removeFindBookmark: (bookId, chapterId) => invoke('find:bookmark-remove', bookId, chapterId),
  pickFont: () => invoke('font:pick'),
  // 自定义字体（代码审计 F1）：渲染层不再传路径——主进程只读「刚在对话框里选的 / 当前书 / 全局配置」的字体
  readFont: () => invoke('font:read'),
  // 仅自检：模拟「在系统字体对话框里选中某个文件」，生产环境主进程不会注册这个频道
  testPickFont: (fontPath) => invoke('font:test-pick', fontPath),
  pickFolder: () => invoke('shell:pick-folder'),
  openBookFolder: (bookPath) => invoke('shell:open-book-folder', bookPath),
  // 诊断日志（提案 7.4）：只读目录清单 + 让主进程打开日志文件夹；渲染层仍然没有 fs 权限
  logInfo: () => invoke('logs:info'),
  openLogFolder: () => invoke('logs:open-folder'),
  // 正文全文搜索（提案 7.3）：索引在 userData，渲染层只拿状态和搜索结果（拿不到正文文件）
  searchIndexStatus: () => invoke('search:index-status'),
  ensureSearchIndex: (options) => invoke('search:ensure-index', options),
  searchContent: (query, options) => invoke('search:content', query, options),
  // 自动更新轻量版（提案 7.1）：只检查版本 + 打开 GitHub Release 下载页；不下载、不安装、不写配置
  checkUpdate: () => invoke('update:check'),
  openUpdateDownload: () => invoke('update:open-download'),
  // 仅自检 / 截图用：注入假网络，生产环境主进程不会注册这个频道
  setUpdateMock: (mock) => invoke('update:test-mock', mock),

  onCloseRequested: (cb) => on('app:close-requested', cb),
  // 书架数据变了（别的窗口新建 / 删除 / 保存 / 整理）：停在书架的窗口跟着刷新
  onShelfChanged: (cb) => on('shelf:changed', cb),
  onImportProgress: (cb) => on('import:progress', cb),
  onFormatProgress: (cb) => on('format:progress', cb),
  // 主进程内部错误（崩溃 / 未处理的 Promise）：界面只弹一句固定提示，错误细节只在日志里
  onInternalError: (cb) => on('app:internal-error', cb),
  // 正文索引的建 / 校验进度（只用于书架搜索提示）
  onSearchProgress: (cb) => on('search:progress', cb),
  reportDirty: (dirty) => ipcRenderer.send('app:dirty', Boolean(dirty)),
  closeReady: (allowed) => ipcRenderer.send('app:close-ready', Boolean(allowed))
});
