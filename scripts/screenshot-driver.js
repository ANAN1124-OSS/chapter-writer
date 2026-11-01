// 章节写作器 · 截图 / E2E 驱动（开发自检专用）
// v0.9 B-1（代码审计 F7）：这段代码原来整块长在 main.js 里（约 620 行），只有 --screenshot / --e2e
// 才会执行；现在挪到 scripts/ 下，由 main.js 的 runAutomation() 在自动化模式下「用到才 require」。
// 为什么放在 scripts/ 而不是 core/：打包配置 build.files 只含 main.js / preload.js / core / renderer /
// package.json，安装版里没有 scripts/ —— 只用于开发截图与自检的代码不该进用户安装包。
// 约束：本文件不 require electron（窗口 / app / 剪贴板 / 文件系统全部由 host 传入），
// 因此单元测试可以直接 require 它（tests/screenshot-driver.test.js）。

// sleep 用 core/common.js 的同一份实现（纯逻辑、不 require electron），本文件仍能脱离主进程单独 require。
const { sleep } = require('../core/common');

async function waitForRenderer(win, expr, timeout = 12000) {
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

// E2E 专用：工作站锁屏 / 没有交互桌面时，Windows 会拒绝所有进程的剪贴板读写
// （OpenClipboard 返回 ACCESS_DENIED，clipboard.readText() 恒为空）。这跟应用代码无关，
// 但会让「复制整本 / 复制本章」的校验半途中断。此时改用进程内剪贴板继续验证
// 「拼出来的文本对不对」，并明确报告真实剪贴板集成未被验证；生产运行永远用系统剪贴板。
async function createE2EClipboard(clipboard) {
  let systemOk = false;
  try {
    const probe = `cw-clip-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await clipboard.writeText(probe);
    const read = await clipboard.readText();
    systemOk = typeof read === 'string' && read === probe;
  } catch {
    systemOk = false;
  }
  if (systemOk) return { clipboard, synthetic: false };
  let text = '';
  console.warn(
    '[e2e] 系统剪贴板不可用（工作站可能锁屏/无交互桌面），改用进程内剪贴板校验复制逻辑；真实剪贴板集成未被验证。'
  );
  return {
    synthetic: true,
    clipboard: {
      writeText: async (value) => {
        text = String(value == null ? '' : value);
      },
      readText: async () => text
    }
  };
}

// 开发截图（--dialog=…）共用的注入脚本片段：只在临时 userData / 演示书库里跑，用来把界面摆到
// 「能截图」的状态；和真实功能无关，不写盘、不写配置。抽出来避免同一段脚本复制三遍。
const SCREENSHOT_PICK_CHAR_JS = `
        const text = window.__cwTest.text();
        const counts = new Map();
        for (const ch of text) {
          if (/[\\u4e00-\\u9fa5]/.test(ch)) counts.set(ch, (counts.get(ch) || 0) + 1);
        }
        let best = '';
        let bestCount = 0;
        for (const [ch, n] of counts) {
          if (n > bestCount) { best = ch; bestCount = n; }
        }`;

// 「把光标放进第一段超过 20 字的正文」——当前段落高亮 / 查找类截图共用；extra 是额外执行的脚本。
function screenshotCaretLongLineScript(extra = '') {
  return `(() => {
        const text = window.__cwTest.text();
        const lines = text.split('\\n');
        let offset = 0;
        let line = 0;
        let target = 0;
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].trim().length > 20) {
            line = i;
            target = offset + Math.min(lines[i].length - 1, 20);
            break;
          }
          offset += lines[i].length + 1;
        }
        window.__cwTest.setCaret(target);
        const height = parseFloat(getComputedStyle(document.getElementById('editor')).lineHeight) || 32;
        window.__cwTest.setEditorScroll(Math.max(0, (line - 2) * height));
        ${extra}
      })()`;
}

// 导出 EPUB / DOCX 截图共用：在范围对话框里选「按卷导出」并挑第一个卷
const SCREENSHOT_PICK_VOLUME_JS = `(() => {
        const radio = document.querySelector('input[name="export-scope"][value="volume"]');
        if (radio) radio.click();
        const select = document.getElementById('export-volume');
        if (select && select.options.length > 1) {
          select.selectedIndex = 1;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`;

async function run(host) {
  const fs = host.fs;
  const path = host.path;
  const app = host.app;
  const storage = host.storage;
  const repair = host.repair;
  const exporter = host.exporter;
  const isE2E = Boolean(host.isE2E);
  const getConfig = host.getConfig;
  const argValue = host.argValue;
  const permissionHandlers = host.getPermissionHandlers();
  const shot = host.screenshot || {};
  const screenshotPath = shot.path || null;
  const screenshotBook = shot.book || null;
  const screenshotChapter = shot.chapter == null ? null : shot.chapter;
  const screenshotDialog = shot.dialog || null;
  try {
    const win = host.getWin();
    await waitForRenderer(win, 'Boolean(window.__cwTest && window.__cwTest.ready)', 15000);
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
      } else if (
        screenshotDialog === 'settings' ||
        screenshotDialog === 'settings-snapshot' ||
        screenshotDialog === 'settings-stats' ||
        screenshotDialog === 'settings-calendar' ||
        screenshotDialog === 'settings-template' ||
        screenshotDialog === 'settings-sensitive' ||
        screenshotDialog === 'settings-proofread' ||
        screenshotDialog === 'settings-export' ||
        screenshotDialog === 'settings-caret' ||
        screenshotDialog === 'settings-logs' ||
        screenshotDialog === 'settings-update'
      ) {
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-settings').click();`,
          true
        );
        if (screenshotDialog === 'settings-snapshot') {
          // 开发截图用：设置弹层很长，滚到底展示「数据安全 / 每日快照」
          await sleep(300);
          await win.webContents.executeJavaScript(
            `const sc = document.querySelector('.settings-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;`,
            true
          );
        } else if (screenshotDialog === 'settings-stats') {
          // 开发截图用：滚到「写作统计 / 近 30 天柱状图」
          await sleep(600);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-stats-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-calendar') {
          // 开发截图用：滚到「码字日历 / 连续写作天数 / 月度汇总」
          await sleep(700);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-calendar-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-template') {
          // 开发截图用：填一条示例模板（只改界面、不保存），展示展开预览
          await sleep(500);
          await win.webContents.executeJavaScript(
            `window.__cwTest.setChapterTemplateField(${JSON.stringify('第{n}章：{title}\n\n')});` +
              `const el = document.getElementById('settings-template-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-sensitive') {
          // 开发截图用：滚到「敏感词预检」词表设置
          await sleep(600);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-sensitive-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-proofread') {
          // 开发截图用：滚到「校对词表」设置（只读状态，不保存）
          await sleep(700);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-proofread-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-export') {
          // 开发截图用：滚到「导出」简繁转换设置（只改界面、不保存）
          await sleep(600);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-export-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-caret') {
          // 开发截图用：滚到「当前段落高亮」分组，勾上开关并选一个色板色（只改界面、不保存）
          await sleep(600);
          await win.webContents.executeJavaScript(
            `window.__cwTest.setCheck('settings-caret-paragraph', true);` +
              `window.__cwTest.setSettingsCaretColor('#3f7fbf');` +
              `const el = document.getElementById('settings-caret-field'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-logs') {
          // 开发截图用：滚到「诊断日志」分组（打开日志文件夹按钮 / 日志份数）
          await sleep(700);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-logs-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        } else if (screenshotDialog === 'settings-update') {
          // 开发截图用：滚到「检查更新」，用假网络演示「发现新版本」+ 下载页按钮（不真连 GitHub）
          await sleep(500);
          await win.webContents.executeJavaScript(
            `window.__cwTest.setUpdateMock({ type: 'json', body: { tag_name: 'v0.7.0', name: 'v0.7.0', html_url: 'https://github.com/ANAN1124-OSS/chapter-writer/releases/tag/v0.7.0', published_at: '2026-11-01T00:00:00Z', prerelease: false, draft: false } })`,
            true
          );
          await win.webContents.executeJavaScript('window.__cwTest.checkUpdateNow()', true);
          await waitForRenderer(win, `window.__cwTest.updateStatus().status === 'update'`);
          await win.webContents.executeJavaScript(
            `const el = document.getElementById('settings-update-group'); if (el) el.scrollIntoView({ block: 'start' });`,
            true
          );
        }
        await sleep(500);
      } else if (screenshotDialog === 'bookmenu') {
        await win.webContents.executeJavaScript(
          `const more = document.querySelector('.book-card-more'); if (more) more.click();`,
          true
        );
        await sleep(500);
      } else if (screenshotDialog === 'bookinfo') {
        // 开发截图用：打开第一本书的「书籍信息」并填示例值（只改界面，不保存）
        await win.webContents.executeJavaScript(
          `(() => {
             const book = (window.__cwTest.state.books || []).find((item) => item.status !== 'corrupt');
             if (!book) return false;
             window.__cwTest.openBookInfoForPath(book.path);
             window.__cwTest.setBookInfoField('author', '示例作者');
             window.__cwTest.setBookInfoField('group', '玄幻');
             window.__cwTest.setBookInfoField('tags', '爽文、升级流');
             window.__cwTest.setBookInfoField('brief', '一句话简介：一个关于旧车站与未寄出的信的故事。');
             return true;
           })()`,
          true
        );
        await sleep(500);
      } else if (screenshotDialog === 'exportmenu') {
        // 开发截图用：展开写作页「导出 ▾」菜单，展示 TXT / EPUB / 本书历史入口
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-export').click();`,
          true
        );
        await sleep(500);
      } else if (screenshotDialog === 'export') {
        // 开发截图用：打开「导出 TXT」对话框，展示范围与简繁转换提示（只读，不导出）
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="txt"]').click();`,
          true
        );
        await sleep(900);
      } else if (screenshotDialog === 'export-epub') {
        // 开发截图用：打开「导出 EPUB」范围对话框并选中「按卷导出」，展示 EPUB 也能按卷 / 按范围
        // （只读，不导出、不写盘）
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="epub"]').click();`,
          true
        );
        await sleep(700);
        await win.webContents.executeJavaScript(SCREENSHOT_PICK_VOLUME_JS, true);
        await sleep(900);
      } else if (screenshotDialog === 'export-docx') {
        // 开发截图用：打开「导出 DOCX」范围对话框并选中「按卷导出」（只读，不导出、不写盘）
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="docx"]').click();`,
          true
        );
        await sleep(700);
        await win.webContents.executeJavaScript(SCREENSHOT_PICK_VOLUME_JS, true);
        await sleep(900);
      } else if (screenshotDialog === 'fragment') {
        // 开发截图用：书架「＋ 碎片」弹层 + 示例内容（只是界面演示，不会写盘）
        await win.webContents.executeJavaScript(
          `window.__cwTest.openFragmentDialog(); window.__cwTest.setFragmentText('雨还在下。旧车站的钟停在 3:17，像在等一个不会再回来的人。');`,
          true
        );
        await sleep(400);
      } else if (screenshotDialog === 'fragments') {
        // 开发截图用：写作页「插入碎片…」弹层，等列表读出来再选第一条
        await win.webContents.executeJavaScript(`window.__cwTest.openInsertFragmentDialog();`, true);
        try {
          await waitForRenderer(win, 'window.__cwTest.fragmentRowCount() > 0', 8000);
          await win.webContents.executeJavaScript(`window.__cwTest.clickFragmentRow(0);`, true);
        } catch {
          console.log('[screenshot] 没有可展示的碎片（可在 _碎片 里先放一条）');
        }
        await sleep(600);
      } else if (screenshotDialog === 'splitter') {
        await win.webContents.executeJavaScript(
          `window.__cwTest.setSidebarWidth(420);`,
          true
        );
        await sleep(400);
      } else if (screenshotDialog === 'format') {
        await win.webContents.executeJavaScript(
          `window.__cwTest.openFormatDialog();`,
          true
        );
        await sleep(900);
      } else if (screenshotDialog === 'formatmenu') {
        // v0.8.5 R1：「整理」不再点开菜单，改成悬浮出「选择卡」——截图走真实的 pointerenter
        await win.webContents.executeJavaScript(
          `document.getElementById('format-dropdown').dispatchEvent(new PointerEvent('pointerenter'));`,
          true
        );
        await sleep(400);
      } else if (screenshotDialog === 'displaymenu') {
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-display').click();`,
          true
        );
        await sleep(400);
      } else if (screenshotDialog === 'format-click') {
        // 点「整理」= 直接用记住的规则整理本章（截图要赶在 toast 消失前）
        await win.webContents.executeJavaScript(
          `document.getElementById('btn-format').click();`,
          true
        );
        await sleep(800);
      } else if (screenshotDialog === 'find') {
        await win.webContents.executeJavaScript(
          `window.__cwTest.openFindPanel(); window.__cwTest.setFindFields({ query: '风', scope: 'book' }); window.__cwTest.findRun();`,
          true
        );
        await sleep(900);
      } else if (screenshotDialog === 'find-nav') {
        // 开发截图用：查找面板里的「当前章定位」一行（上一处 / 下一处 + 第 X / N 处）
        await win.webContents.executeJavaScript(
          `(() => {${SCREENSHOT_PICK_CHAR_JS}
             window.__cwTest.openFindPanel();
             window.__cwTest.setFindFields({ query: best || '的', scope: 'current' });
             window.__cwTest.findRun();
           })()`,
          true
        );
        await sleep(900);
      } else if (screenshotDialog === 'find-highlight') {
        // 开发截图用：查找增强（v0.8-11，提案 N11）——当前章全部命中高亮 + 状态栏「查找 1/N」。
        // 先挑本章出现最多的一个汉字当查找词，查完把面板关掉，让正文里的高亮露出来（只读，不写盘）
        await win.webContents.executeJavaScript(
          `(() => {${SCREENSHOT_PICK_CHAR_JS}
             window.__cwTest.openFindPanel();
             window.__cwTest.setFindFields({ query: best || '的', scope: 'current' });
             window.__cwTest.findRun();
             window.__cwTest.closeFindPanel();
           })()`,
          true
        );
        await sleep(900);
      } else if (screenshotDialog === 'find-bookmark') {
        // 开发截图用：查找书签（v0.8-11b，提案 N11b）——当前章查一次并存成书签，
        // 面板里的「书签」区列出这一条，正文命中同时高亮（只写临时 userData 的 config，不碰书库）
        await win.webContents.executeJavaScript(
          `(async () => {${SCREENSHOT_PICK_CHAR_JS}
             window.__cwTest.openFindPanel();
             window.__cwTest.setFindFields({ query: best || '的', scope: 'current' });
             await window.__cwTest.findRun();
             await window.__cwTest.findBookmarkSave();
           })()`,
          true
        );
        await sleep(900);
      } else if (screenshotDialog === 'proofread') {
        // 开发截图用：打开校对面板，等当前章自动检查完，再切整本跑一遍（只读）
        await win.webContents.executeJavaScript(`window.__cwTest.openProofreadPanel();`, true);
        await sleep(800);
        await win.webContents.executeJavaScript(`window.__cwTest.setProofreadScope('book');`, true);
        await sleep(120);
        await win.webContents.executeJavaScript(`window.__cwTest.proofreadRun();`, true);
        await sleep(800);
      } else if (screenshotDialog === 'sensitive') {
        // 开发截图用：打开敏感词预检面板（先等当前章自动预检完），再切整本跑一遍（只读）
        await win.webContents.executeJavaScript(`window.__cwTest.openSensitivePanel();`, true);
        await sleep(900);
        await win.webContents.executeJavaScript(`window.__cwTest.setSensitiveScope('book');`, true);
        await sleep(120);
        await win.webContents.executeJavaScript(`window.__cwTest.sensitiveRun();`, true);
        await sleep(900);
      } else if (screenshotDialog === 'tts') {
        // 开发截图用：假语音引擎 + 朗读小条（真的出声在开发机上也会吵，这里只展示界面状态）
        await win.webContents.executeJavaScript(
          `window.__cwTest.ttsInstallFakeSpeech(); document.getElementById('btn-tts').click();`,
          true
        );
        try {
          await waitForRenderer(
            win,
            'window.__cwTest.ttsBarOpen() && window.__cwTest.ttsChunks().length > 0',
            8000
          );
          await win.webContents.executeJavaScript('window.__cwTest.ttsFakeFinish();', true);
          await sleep(320);
          await win.webContents.executeJavaScript('window.__cwTest.ttsPlay();', true);
        } catch {
          console.log('[screenshot] 朗读条没能准备好');
        }
        await sleep(400);
      } else if (screenshotDialog === 'marks' || screenshotDialog === 'marks-menu') {
        // 开发截图用：编辑器小件——不可见字符 ␣ / 行尾空白 / 超长段落左侧黄线（只读显示层，不写盘）
        await win.webContents.executeJavaScript(
          "window.__cwTest.setMarksToggle('invisibles', true); window.__cwTest.setMarksToggle('longParagraphs', true);",
          true
        );
        await sleep(450);
        if (screenshotDialog === 'marks-menu') {
          await win.webContents.executeJavaScript('window.__cwTest.openFormatMenu();', true);
        } else {
          await win.webContents.executeJavaScript('window.__cwTest.selectRange(0, 42);', true);
        }
        await sleep(500);
      } else if (screenshotDialog === 'marks-caret') {
        // 开发截图用：当前段落高亮（v0.8-10，提案 N10）——打开开关，把光标放进一段较长的正文里
        // （只读显示层，不写盘、不写配置）
        await win.webContents.executeJavaScript(
          "window.__cwTest.setMarksToggle('caretParagraph', true);",
          true
        );
        await sleep(400);
        await win.webContents.executeJavaScript(screenshotCaretLongLineScript(), true);
        await sleep(500);
      } else if (screenshotDialog === 'marks-caret-color') {
        // 开发截图用：当前段落高亮按书开 + 自定义颜色（蓝色）+ 打开「排版 ▾」露出色板。
        // 只写临时 userData 的 config.json（截图环境），不碰书库 / 正文。
        await win.webContents.executeJavaScript(
          "window.__cwTest.setCaretParagraphPersist(true); window.__cwTest.setCaretColor('#3f7fbf');",
          true
        );
        await sleep(600);
        await win.webContents.executeJavaScript(
          screenshotCaretLongLineScript('window.__cwTest.openFormatMenu();'),
          true
        );
        await sleep(600);
      } else if (screenshotDialog === 'focus') {
        // 开发截图用：专注模式 + 打字机模式（隐藏左栏 / 顶栏，只改显示，不写盘、不写配置）
        await win.webContents.executeJavaScript(
          'window.__cwTest.focusToggle(true); window.__cwTest.focusTypewriter(true);',
          true
        );
        await sleep(500);
        await win.webContents.executeJavaScript(
          'const len = window.__cwTest.text().length; window.__cwTest.focusSetCaret(Math.floor(len * 0.6)); window.__cwTest.focusAlign();',
          true
        );
        await sleep(500);
      } else if (screenshotDialog === 'reading') {
        // 开发截图用：整本只读通读（字号 / 行距 / 目录 / 上一章 / 下一章；只读，不写盘）
        await win.webContents.executeJavaScript('window.__cwTest.openReading();', true);
        try {
          await waitForRenderer(win, 'window.__cwTest.readingState().blockCount > 0', 10000);
        } catch {
          console.log('[screenshot] 阅读模式没有读到章节');
        }
        await sleep(500);
        if (argValue('reading-chapter') != null) {
          await win.webContents.executeJavaScript(
            `window.__cwTest.readingJump(${Number(argValue('reading-chapter'))});`,
            true
          );
          await sleep(600);
        }
      } else if (screenshotDialog === 'shelf-search') {
        // 开发截图用：书架搜正文（真实走 userData 里的索引；只读，不碰书库）
        const query = argValue('search-query') || '青柠色';
        await win.webContents.executeJavaScript(
          `window.__cwTest.setShelfQuery(${JSON.stringify(query)});`,
          true
        );
        await sleep(1800);
      } else if (screenshotDialog === 'conflict') {
        const folder = await win.webContents.executeJavaScript(
          'window.__cwTest.firstConflictBookFolder()',
          true
        );
        if (folder) {
          await win.webContents.executeJavaScript(
            `window.__cwTest.openConflictDialogFor(${JSON.stringify(folder)})`,
            true
          );
        }
        await sleep(500);
      } else if (screenshotDialog === 'history') {
        const opened = screenshotBook
          ? await win.webContents.executeJavaScript(
              `window.__cwTest.openHistoryForPath(${JSON.stringify(screenshotBook)})`,
              true
            )
          : await win.webContents.executeJavaScript('window.__cwTest.openHistoryForFirstBook()', true);
        if (!opened) console.log('[screenshot] 没有可打开历史面板的书');
        await sleep(900);
      }
      await sleep(500);
      const image = await win.webContents.capturePage();
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fs.writeFile(screenshotPath, image.toPNG());
      console.log(`[screenshot] ${screenshotPath}`);
    }
    if (isE2E) {
      const scenario = require('./e2e-scenario.js');
      const e2eClipboard = await createE2EClipboard(host.clipboard);
      host.setClipboard(e2eClipboard.clipboard);
      const result = await scenario({
        win,
        app,
        clipboard: e2eClipboard.clipboard,
        config: await getConfig(),
        userData: app.getPath('userData'),
        storage,
        repair,
        exporter,
        sleep,
        exec: (code) => win.webContents.executeJavaScript(code, true),
        // ---------- 多窗口 E2E 辅助 ----------
        openWindow: async (bookPath = null) => {
          const created = await host.createWindow({ bookPath: bookPath || null, cascade: true });
          return created.id;
        },
        closeWindow: (windowId) => {
          const session = host.sessionById(windowId);
          if (!session) return false;
          session.win.close();
          return true;
        },
        destroyWindow: (windowId) => {
          const session = host.sessionById(windowId);
          if (!session) return false;
          session.forceClose = true;
          session.win.destroy();
          return true;
        },
        execIn: (windowId, code) => {
          const session = host.sessionById(windowId);
          if (!session) throw new Error(`窗口不存在：${windowId}`);
          return session.win.webContents.executeJavaScript(code, true);
        },
        focusWindow: (windowId) => host.focusSession(host.sessionById(windowId)),
        windowsInfo: () =>
          host.listSessions().map((session) => ({
            id: session.id,
            bookPath: storage.openBookRegistry.getBook(session.id),
            dirty: session.dirty,
            closePending: session.closePending,
            destroyed: session.win.isDestroyed(),
            focused: !session.win.isDestroyed() && session.win.isFocused()
          })),
        openBookRegistry: () => storage.openBookRegistry.list(),
        registryCounts: () => storage.openBookRegistry.counts(),
        mostRecentWindowId: () => storage.openBookRegistry.mostRecentWindow(),
        windowBounds: (windowId) => {
          const session = host.sessionById(windowId);
          return session ? session.win.getBounds() : null;
        },
        setRealClose: (on) => host.setRealClose(on),
        windowAllClosed: () => host.isWindowAllClosed(),
        getCloseReady: (windowId) => host.getCloseReady(windowId),
        resetCloseReady: (windowId) => host.resetCloseReady(windowId),
        // ---------- Electron 安全开关（v0.9 C-1）自检辅助 ----------
        // securityInfo：真实窗口的 webPreferences / 单实例锁 / 所有 webContents 的类型，
        //   交给 E2E 和 core/security-policy.js 逐项对账（只读）。
        securityInfo: () => {
          const contents =
            win && !win.isDestroyed() ? win.webContents : null;
          const prefs =
            contents && !contents.isDestroyed() ? contents.getLastWebPreferences() || {} : {};
          return {
            webPreferences: prefs,
            singleInstanceLock: app.hasSingleInstanceLock(),
            sessionHandlers: Boolean(permissionHandlers.request && permissionHandlers.check),
            contentTypes: host.getContentTypes()
          };
        },
        // securityProbe：直接调用「真的注册给 Electron 的那两个处理器」，证明它们确实一律拒绝；
        //   顺带带回被拒绝请求的日志字段（真的写进日志的那份，不含本机路径）。
        securityProbe: () => {
          let granted = null;
          let callbackCalled = false;
          if (permissionHandlers.request) {
            permissionHandlers.request(
              {},
              'geolocation',
              (value) => {
                callbackCalled = true;
                granted = value;
              },
              {
                requestingOrigin: 'file:///C:/Users/fake/Desktop/%E7%A7%81%E4%BA%BA%E4%B9%A6%E7%9B%AE/ch1.txt',
                isMainFrame: true
              }
            );
          }
          return {
            request: { callbackCalled, granted },
            check: permissionHandlers.check
              ? permissionHandlers.check({}, 'geolocation', 'file:///C:/Users/fake/Desktop/ch1.txt', {})
              : null,
            lastDenial: host.getLastPermissionDenial()
          };
        }
      });
      console.log(
        `E2E_RESULT ${JSON.stringify({ ...result, clipboardSynthetic: e2eClipboard.synthetic })}`
      );
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

module.exports = {
  run,
  waitForRenderer,
  createE2EClipboard,
  screenshotCaretLongLineScript,
  SCREENSHOT_PICK_CHAR_JS,
  SCREENSHOT_PICK_VOLUME_JS
};
