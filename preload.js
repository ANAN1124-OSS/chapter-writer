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
  createChapter: (bookPath, insertIndex, name) => invoke('chapter:create', bookPath, insertIndex, name),
  renameChapter: (bookPath, chapterId, name) => invoke('chapter:rename', bookPath, chapterId, name),
  deleteChapter: (bookPath, chapterId) => invoke('chapter:delete', bookPath, chapterId),
  moveChapter: (bookPath, chapterId, toIndex) => invoke('chapter:move', bookPath, chapterId, toIndex),
  searchBook: (bookPath, options) => invoke('book:search', bookPath, options),
  replaceBook: (bookPath, options) => invoke('book:replace', bookPath, options),
  listReplaceBackups: (bookPath) => invoke('book:list-replace-backups', bookPath),
  restoreReplaceBackup: (bookPath, backupName) =>
    invoke('book:restore-replace-backup', bookPath, backupName),

  exportBook: (bookPath) => invoke('book:export', bookPath),
  copyBook: (bookPath) => invoke('book:copy', bookPath),
  repairBook: (bookPath, mode) => invoke('book:repair', bookPath, mode),
  importBooks: (paths, options) => invoke('book:import', paths, options),
  deleteBook: (bookPath) => invoke('book:delete', bookPath),

  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
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
  reportDirty: (dirty) => ipcRenderer.send('app:dirty', Boolean(dirty)),
  closeReady: (allowed) => ipcRenderer.send('app:close-ready', Boolean(allowed))
});
