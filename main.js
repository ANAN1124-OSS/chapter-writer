// 章节写作器 v0.1 —— Electron 主进程
// 职责：窗口与生命周期、关闭拦截、所有文件读写（渲染层零文件系统权限）。
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, screen } = require('electron');

// ---------- 启动参数（自动化/隔离用，正常用户启动不受影响） ----------
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const userDataArg = argValue('user-data');
if (userDataArg) {
  fsSync.mkdirSync(userDataArg, { recursive: true });
  app.setPath('userData', userDataArg);
}

const isE2E = process.argv.includes('--e2e');
const booksRootOverride = argValue('books-root');
const screenshotPath = argValue('screenshot');
const screenshotBook = argValue('book');
const screenshotChapter = argValue('chapter');
const screenshotDialog = argValue('dialog');
const automation = isE2E || Boolean(screenshotPath);

const { createConfigStore } = require('./core/config');
const { atomicWriteFile } = require('./core/atomic');
const storage = require('./core/storage');
const repair = require('./core/repair');
const importer = require('./core/importer');
const exporter = require('./core/exporter');

let win = null;
let configStore = null;
let config = null;
let forceClose = false;
let closePending = false;
let closeTimer = null;
let e2eCloseReady = undefined;
let rendererDirty = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(data) {
  return { ok: true, data };
}

function fail(err) {
  const code = (err && err.code) || 'ERROR';
  const message = (err && err.message) || String(err);
  console.error('[ipc-fail]', code, message);
  return { ok: false, code, message };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return fail(err);
    }
  });
}

async function getConfig() {
  if (!config) {
    configStore = createConfigStore(app.getPath('userData'));
    config = await configStore.get();
    if (booksRootOverride) config = { ...config, booksRoot: booksRootOverride };
  }
  return config;
}

function clampBounds(bounds) {
  try {
    if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height))) {
      return null;
    }
    const display = screen.getDisplayMatching({
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width),
      height: Number(bounds.height)
    });
    const area = display.workArea;
    const width = Math.min(Number(bounds.width), area.width);
    const height = Math.min(Number(bounds.height), area.height);
    const x = Math.max(area.x, Math.min(Number(bounds.x) || 0, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(Number(bounds.y) || 0, area.y + area.height - height));
    return { x, y, width, height };
  } catch {
    return null;
  }
}

// ---------- 关闭流程（保存失败不静默退出） ----------
function setupCloseFlow() {
  win.on('close', (event) => {
    if (forceClose) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    try {
      win.webContents.send('app:close-requested');
    } catch {
      return;
    }
    clearTimeout(closeTimer);
    closeTimer = setTimeout(async () => {
      if (!closePending || !win || win.isDestroyed()) return;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '编辑器无响应',
        message: '保存流程没有在 3 秒内完成。',
        detail: '继续等待通常更安全；强制退出可能丢失未保存的内容。',
        buttons: ['继续等待', '强制退出'],
        defaultId: 0,
        cancelId: 0
      });
      if (response === 1) {
        closePending = false;
        forceClose = true;
        if (win && !win.isDestroyed()) win.destroy();
      } else {
        closePending = false;
      }
    }, 3000);
  });

  ipcMain.on('app:close-ready', async (event, allowed) => {
    if (!win || event.sender !== win.webContents) return;
    closePending = false;
    clearTimeout(closeTimer);
    if (isE2E) {
      e2eCloseReady = Boolean(allowed);
      return;
    }
    if (!allowed) return;
    try {
      await configStore.set({ windowBounds: win.getBounds() });
    } catch { /* 保存窗口位置失败不影响退出 */ }
    forceClose = true;
    if (win && !win.isDestroyed()) win.close();
  });

  // 渲染层上报「是否有未保存修改」，供 Windows 关机拦截判断
  ipcMain.on('app:dirty', (event, dirty) => {
    if (win && event.sender === win.webContents) rendererDirty = Boolean(dirty);
  });
}

// ---------- IPC ----------
function registerIpc() {
  handle('config:get', async () => getConfig());

  handle('config:set', async (patch) => {
    await getConfig();
    const next = await configStore.set(patch || {});
    config = booksRootOverride ? { ...next, booksRoot: booksRootOverride } : next;
    await fs.mkdir(config.booksRoot, { recursive: true });
    return config;
  });

  handle('books:list', async () => {
    const cfg = await getConfig();
    return storage.listBooks(cfg.booksRoot);
  });

  handle('book:create', async (title) => {
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    return storage.createBook(cfg.booksRoot, title);
  });

  handle('book:open', async (bookPath) => storage.openBook(bookPath));
  handle('book:verify', async (bookPath) => storage.verifyBook(bookPath));
  handle('book:rename', async (bookPath, title) => storage.renameBook(bookPath, title));
  handle('book:set-last', async (bookPath, chapterId) => storage.setLastOpenChapter(bookPath, chapterId));

  handle('chapter:load', async (bookPath, file) => storage.loadChapterText(bookPath, file));
  handle('chapter:stat', async (bookPath, file) => storage.statChapter(bookPath, file));

  handle('chapter:save', async (bookPath, chapterId, text) => {
    return storage.withBookLock(bookPath, async () => {
      const meta = await storage.readBookMeta(bookPath);
      const chapter = meta.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new storage.StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
      const result = await storage.saveChapterText(bookPath, chapter.file, String(text == null ? '' : text));
      // 同步章节字数缓存，书架就不用为了算字数去重读整本书
      chapter.chars = result.chars;
      await storage.writeBookMeta(bookPath, meta);
      return { ...result, file: chapter.file };
    });
  });

  handle('chapter:create', async (bookPath, insertIndex, name) =>
    storage.createChapter(bookPath, insertIndex, name)
  );
  handle('chapter:rename', async (bookPath, chapterId, name) =>
    storage.renameChapter(bookPath, chapterId, name)
  );
  handle('chapter:delete', async (bookPath, chapterId) => storage.deleteChapter(bookPath, chapterId));

  handle('book:export', async (bookPath) => {
    const meta = await storage.readBookMeta(bookPath);
    const texts = [];
    for (const chapter of meta.chapters) {
      const loaded = await storage.loadChapterText(bookPath, chapter.file);
      texts.push(loaded.text);
    }
    const defaultName = `${require('./core/chapters').safeName(meta.title)}.txt`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 TXT',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    const buffer = exporter.exportBuffer(meta, texts);
    await atomicWriteFile(filePath, buffer);
    return {
      canceled: false,
      filePath,
      chapterCount: meta.chapters.length,
      chars: exporter.composeBook(meta, texts).length
    };
  });

  handle('book:copy', async (bookPath) => {
    const meta = await storage.readBookMeta(bookPath);
    const texts = [];
    for (const chapter of meta.chapters) {
      const loaded = await storage.loadChapterText(bookPath, chapter.file);
      texts.push(loaded.text);
    }
    const text = exporter.composeBook(meta, texts);
    await clipboard.writeText(text);
    return { chapterCount: meta.chapters.length, chars: text.length };
  });

  handle('book:repair', async (bookPath, mode) => {
    if (mode === 'bak') return repair.restoreFromBak(bookPath);
    if (mode === 'rebuild') return repair.rebuildFromFiles(bookPath);
    throw new storage.StorageError('BAD_MODE', `未知的修复方式：${mode}`);
  });

  handle('book:import', async (explicitPaths) => {
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    let dirs = Array.isArray(explicitPaths)
      ? explicitPaths.filter((p) => typeof p === 'string' && p.trim())
      : [];
    if (!dirs.length) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入小说（选择一个或多个书文件夹）',
        buttonLabel: '导入',
        properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
      });
      if (canceled || !filePaths || !filePaths.length) {
        return { canceled: true, imported: [], skipped: [], failed: [] };
      }
      dirs = filePaths;
    }
    return importer.importFolders(cfg.booksRoot, dirs, {
      onProgress: (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('import:progress', progress);
      }
    });
  });

  handle('book:delete', async (bookPath) => {
    const cfg = await getConfig();
    const root = path.resolve(cfg.booksRoot);
    const target = path.resolve(String(bookPath || ''));
    if (path.dirname(target).toLowerCase() !== root.toLowerCase()) {
      throw new storage.StorageError('BAD_PATH', '只能删除书架目录下的书');
    }
    if (!(await storage.exists(target))) {
      throw new storage.StorageError('NOT_FOUND', '这本书的文件夹已经不存在了');
    }
    // 测试环境用固定兜底路径，避免把测试数据丢进你的回收站
    if (isE2E) {
      const trashPath = await storage.trashBook(cfg.booksRoot, target);
      return { method: 'move', folder: path.basename(target), trashPath };
    }
    try {
      await shell.trashItem(target);
      return { method: 'recycle', folder: path.basename(target) };
    } catch (err) {
      const trashPath = await storage.trashBook(cfg.booksRoot, target);
      return {
        method: 'move',
        folder: path.basename(target),
        trashPath,
        note: `回收站不可用（${err.message}），已移到书架的 _trash`
      };
    }
  });

  handle('shell:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择书架目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    return filePaths[0];
  });

  handle('shell:open-book-folder', async (bookPath) => {
    const err = await shell.openPath(bookPath);
    if (err) throw new storage.StorageError('OPEN_FAILED', err);
    return true;
  });
}

// ---------- 窗口 ----------
async function createWindow() {
  const cfg = await getConfig();
  const bounds = clampBounds(cfg.windowBounds);

  win = new BrowserWindow({
    ...(bounds || { width: 1200, height: 760 }),
    minWidth: 960,
    minHeight: 620,
    title: '章节写作器',
    backgroundColor: '#f6f4ef',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
  win.on('closed', () => { win = null; });
  setupCloseFlow();

  // Windows 关机/注销：尽力而为地拦住一次，提示先保存（系统不强等应用，不能保证）
  win.on('query-session-end', (event) => {
    if (rendererDirty) {
      event.preventDefault();
      win.focus();
      win.webContents.send('app:close-requested');
    }
  });

  const loadOptions = automation || isE2E ? { query: { test: '1' } } : undefined;
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'), loadOptions);

  // 窗口位置保存（防抖，避免每次拖动都写盘）
  let boundsTimer = null;
  const scheduleSaveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(async () => {
      try {
        if (!win || win.isDestroyed()) return;
        await configStore.set({ windowBounds: win.getBounds() });
      } catch { /* 忽略 */ }
    }, 900);
  };
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);

  if (automation) await runAutomation();
}

async function waitForRenderer(expr, timeout = 12000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const value = await win.webContents.executeJavaScript(expr, true);
      if (value) return value;
    } catch { /* 页面还没加载完，继续等 */ }
    if (Date.now() - startedAt > timeout) throw new Error(`等待超时：${expr}`);
    await sleep(120);
  }
}

async function runAutomation() {
  try {
    await waitForRenderer('Boolean(window.__cwTest && window.__cwTest.ready)', 15000);
    if (screenshotPath) {
      if (screenshotBook) {
        await win.webContents.executeJavaScript(
          `window.__cwTest.openBookPath(${JSON.stringify(screenshotBook)})`,
          true
        );
        await sleep(500);
        if (screenshotChapter != null) {
          await win.webContents.executeJavaScript(
            `window.__cwTest.switchTo(${Number(screenshotChapter)}, 'discard')`,
            true
          );
          await sleep(350);
        }
      }
      if (screenshotDialog === 'unsaved') {
        await win.webContents.executeJavaScript(
          `window.__cwTest.setText('（这是一段还没有保存的正文，演示关窗拦截）'); void window.__cwTest.handleCloseRequest();`,
          true
        );
        await sleep(500);
      } else if (screenshotDialog === 'settings') {
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-settings').click();`,
          true
        );
        await sleep(500);
      } else if (screenshotDialog === 'bookmenu') {
        await win.webContents.executeJavaScript(
          `const more = document.querySelector('.book-card-more'); if (more) more.click();`,
          true
        );
        await sleep(500);
      }
      await sleep(500);
      const image = await win.webContents.capturePage();
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fs.writeFile(screenshotPath, image.toPNG());
      console.log(`[screenshot] ${screenshotPath}`);
    }
    if (isE2E) {
      const scenario = require('./scripts/e2e-scenario.js');
      const result = await scenario({
        win,
        app,
        clipboard,
        config: await getConfig(),
        storage,
        repair,
        exporter,
        sleep,
        exec: (code) => win.webContents.executeJavaScript(code, true),
        getCloseReady: () => e2eCloseReady,
        resetCloseReady: () => { e2eCloseReady = undefined; }
      });
      console.log(`E2E_RESULT ${JSON.stringify(result)}`);
      app.exit(result && result.ok ? 0 : 1);
      return;
    }
    if (screenshotPath) app.exit(0);
  } catch (err) {
    console.error('[automation] 失败:', err && err.stack ? err.stack : err);
    console.log(`E2E_RESULT ${JSON.stringify({ ok: false, error: String((err && err.stack) || err) })}`);
    app.exit(1);
  }
}

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    try {
      await getConfig();
    } catch (err) {
      console.error('[config] 读取失败:', err);
    }
    try {
      await createWindow();
    } catch (err) {
      console.error('[window] 创建失败:', err && err.stack ? err.stack : err);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
