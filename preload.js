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
  createChapter: (bookPath, insertIndex, name) => invoke('chapter:create', bookPath, insertIndex, name),
  renameChapter: (bookPath, chapterId, name) => invoke('chapter:rename', bookPath, chapterId, name),
  deleteChapter: (bookPath, chapterId) => invoke('chapter:delete', bookPath, chapterId),

  exportBook: (bookPath) => invoke('book:export', bookPath),
  copyBook: (bookPath) => invoke('book:copy', bookPath),
  repairBook: (bookPath, mode) => invoke('book:repair', bookPath, mode),

  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
  pickFolder: () => invoke('shell:pick-folder'),
  openBookFolder: (bookPath) => invoke('shell:open-book-folder', bookPath),

  onCloseRequested: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('app:close-requested', () => cb());
  },
  reportDirty: (dirty) => ipcRenderer.send('app:dirty', Boolean(dirty)),
  closeReady: (allowed) => ipcRenderer.send('app:close-ready', Boolean(allowed))
});
