// 章节写作器 v0.1 —— M0 骨架（空窗口）
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    title: '章节写作器',
    backgroundColor: '#f6f4ef',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });
