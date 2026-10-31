// 渲染层唯一可用的主进程能力：白名单 IPC，不暴露 Node。
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    return { ok: false, code: 'IPC_ERROR', message: (err && err.message) || String(err) };
  }
}

contextBridge.exposeInMainWorld('api', {
  appVersion: () => invoke('app:version'),
  appWarning: () => invoke('app:warning'),
  getRecentBook: () => invoke('app:recent-book'),
  listBooks: () => invoke('books:list'),
  createBook: (title) => invoke('book:create', title),
  openBook: (bookPath) => invoke('book:open', bookPath),
  verifyBook: (bookPath) => invoke('book:verify', bookPath),
  renameBook: (bookPath, title) => invoke('book:rename', bookPath, title),
  setLastOpenChapter: (bookPath, chapterId) => invoke('book:set-last', bookPath, chapterId),

  loadChapter: (bookPath, file) => invoke('chapter:load', bookPath, file),
  statChapter: (bookPath, file) => invoke('chapter:stat', bookPath, file),
  saveChapter: (bookPath, chapterId, text) => invoke('chapter:save', bookPath, chapterId, text),
  formatText: (text, options) => invoke('text:format', text, options),
  findInText: (text, query, options) => invoke('text:find', text, query, options),
  findNext: (text, query, fromIndex, options) =>
    invoke('text:find-next', text, query, fromIndex, options),
  replaceInText: (text, query, replacement, options) =>
    invoke('text:replace', text, query, replacement, options),
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
  formatPreviewBook: (bookPath, options) => invoke('book:format-preview', bookPath, options),
  formatBook: (bookPath, options) => invoke('book:format', bookPath, options),

  exportPlan: (bookPath, override, range) => invoke('book:export-plan', bookPath, override, range),
  exportBook: (bookPath, override, range) => invoke('book:export', bookPath, override, range),
  copyBook: (bookPath, override) => invoke('book:copy', bookPath, override),
  copyChapterPlatform: (bookPath, ref) => invoke('chapter:copy-platform', bookPath, ref),
  repairBook: (bookPath, mode) => invoke('book:repair', bookPath, mode),
  importBooks: (paths, options) => invoke('book:import', paths, options),
  deleteBook: (bookPath) => invoke('book:delete', bookPath),

  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
  getBookDisplay: (bookId) => invoke('book:get-display', bookId),
  setBookDisplay: (bookId, patch) => invoke('book:set-display', bookId, patch),
  resetBookDisplay: (bookId) => invoke('book:reset-display', bookId),
  pickFont: () => invoke('font:pick'),
  readFont: (fontPath) => invoke('font:read', fontPath),
  pickFolder: () => invoke('shell:pick-folder'),
  openBookFolder: (bookPath) => invoke('shell:open-book-folder', bookPath),

  onCloseRequested: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('app:close-requested', () => cb());
  },
  onImportProgress: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('import:progress', (_event, progress) => cb(progress));
  },
  onFormatProgress: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('format:progress', (_event, progress) => cb(progress));
  },
  reportDirty: (dirty) => ipcRenderer.send('app:dirty', Boolean(dirty)),
  closeReady: (allowed) => ipcRenderer.send('app:close-ready', Boolean(allowed))
});
