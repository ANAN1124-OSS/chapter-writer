// E2E 第 60 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group60LogRedaction(t) {
  const { exec, check, waitFor, storage, booksRoot, waitForLog, deleteBookWithRetry } = t;

  // 60. 日志与错误脱敏（v0.9 C-4，安全审计 C5）：
  //     主进程把错误回给界面、写进诊断日志时，本机绝对路径只许留最后一节（`…\001-第1章.txt`），
  //     本机用户名 / 临时书库的上级目录一个都不许出现；常见文件系统错误码换成中文；
  //     自研 StorageError 的中文提示一个字都别改（code 仍是界面分支的依据）。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const c4ShelfBefore = (await storage.listBooks(booksRoot)).length;
  await exec(`window.__cwTest.newBook('脱敏演练')`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const c4BookPath = await exec('window.__cwTest.bookPathValue()');
  await exec(`window.__cwTest.setText('脱敏演练的正文。')`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const c4Meta = await storage.readBookMeta(c4BookPath);
  const c4Chapter = c4Meta.chapters[0];
  const c4ChapterPath = path.join(c4BookPath, c4Chapter.file);
  // 「本机路径泄漏」长什么样：临时书库根目录，或任何 `X:\` / `X:/` 盘符路径（http 网址不算）
  const c4LeaksPath = (text) =>
    typeof text === 'string' && (text.includes(booksRoot) || /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(text));

  // 60a. 真实写盘失败（章节文件设成只读）：错误码照旧，文案换成中文、只留文件名
  await fs.chmod(c4ChapterPath, 0o444);
  await exec('window.__cwTest.clearToasts()');
  let c4SaveFail = null;
  try {
    c4SaveFail = JSON.parse(
      await exec(`(async () => {
        window.__cwTest.setText('只读演练：这次保存必须失败。');
        const r = await window.__cwTest.saveVisible();
        return JSON.stringify(r);
      })()`)
    );
  } finally {
    await fs.chmod(c4ChapterPath, 0o666);
  }
  check(
    '错误脱敏：真实写盘失败的文案没有本机绝对路径（中文原因 + 只留最后一节文件名）',
    Boolean(c4SaveFail && c4SaveFail.ok === false) &&
      ['EPERM', 'EACCES', 'EBUSY'].includes(c4SaveFail.code) &&
      !c4LeaksPath(c4SaveFail.message) &&
      /只读|权限|拒绝|占用/.test(c4SaveFail.message) &&
      c4SaveFail.message.includes('…'),
    c4SaveFail
  );
  const c4Toasts = await exec('window.__cwTest.toasts()');
  const c4SaveToast = c4Toasts.find((item) => String(item.message || '').startsWith('保存失败：'));
  check(
    '错误脱敏：界面的保存失败提示同样是中文 + 不带本机路径',
    Boolean(c4SaveToast) && c4SaveToast.kind === 'error' && !c4LeaksPath(c4SaveToast.message) &&
      /只读|权限|拒绝|占用/.test(c4SaveToast.message),
    c4Toasts.slice(-3)
  );
  // 这次失败不能把正文写坏：文件仍是演练时保存的那一版
  check(
    '错误脱敏：失败的保存没有改动章节文件（原子写没留下半成品）',
    (await fs.readFile(c4ChapterPath, 'utf8')) === '脱敏演练的正文。'
  );
  // 复原编辑区内容（文件还是旧正文，编辑器里那句失败内容丢弃）
  await exec(`window.__cwTest.setText('脱敏演练的正文。')`);

  // 60b. 同一次失败写进日志：有错误码 / 频道 / 文件名，但没有本机绝对路径
  const c4LogText = await waitForLog('save-failed');
  const c4SaveFailAt = c4LogText.lastIndexOf('save-failed');
  const c4LogBlock = c4LogText.slice(Math.max(0, c4SaveFailAt - 200), c4SaveFailAt + 400);
  check(
    '错误脱敏：日志记下错误码 / 频道 / 文件名，但不记本机绝对路径',
    c4LogBlock.includes('ERROR save-failed') &&
      c4LogBlock.includes(`code=${c4SaveFail.code}`) &&
      c4LogBlock.includes('channel=chapter:save') &&
      c4LogBlock.includes(path.basename(c4Chapter.file)) &&
      !c4LeaksPath(c4LogBlock) &&
      c4LogText.includes(booksRoot) === false,
    c4LogBlock.slice(0, 500)
  );

  // 60c. 自研错误码的中文提示一个字都不改（只做路径收尾）
  const c4Missing = JSON.parse(
    await exec(
      `window.api.loadChapter(${JSON.stringify(c4BookPath)}, '不存在的章节.txt').then((r) => JSON.stringify(r))`
    )
  );
  check(
    '错误脱敏：自研 StorageError 的中文提示照旧（章节文件不存在 + 文件名）',
    Boolean(c4Missing && c4Missing.ok === false) &&
      c4Missing.code === 'CHAPTER_MISSING' &&
      c4Missing.message === '章节文件不存在：不存在的章节.txt',
    c4Missing
  );

  // 60d. 词表文件被移走：自研提示里的路径也只留最后一节（看得出是哪个文件，没有目录 / 用户名）
  const c4MissingWords = path.join(path.dirname(booksRoot), '脱敏演练-词表.txt');
  const c4ConfigBefore = JSON.parse(await exec('window.api.getConfig().then((r) => JSON.stringify(r))'));
  const c4WordsSet = JSON.parse(
    await exec(`(async () => {
      await window.api.testPickConfigPath(${JSON.stringify(c4MissingWords)}, 'sensitiveWordsPath');
      const r = await window.api.setConfig({ sensitiveWordsPath: ${JSON.stringify(c4MissingWords)} });
      return JSON.stringify(r);
    })()`)
  );
  const c4WordsInfo = JSON.parse(await exec('window.api.sensitiveWordsInfo().then((r) => JSON.stringify(r))'));
  check(
    '错误脱敏：词表文件缺失的自研提示里路径只留最后一节（不带目录）',
    Boolean(c4WordsSet && c4WordsSet.ok === true) &&
      c4WordsSet.data.sensitiveWordsPath === c4MissingWords &&
      Boolean(c4WordsInfo && c4WordsInfo.ok === true) &&
      c4WordsInfo.data.code === 'WORD_LIST_MISSING' &&
      String(c4WordsInfo.data.message).startsWith('词表文件不存在：…\\脱敏演练-词表.txt') &&
      !c4LeaksPath(c4WordsInfo.data.message),
    c4WordsInfo && c4WordsInfo.data
  );
  // 复原词表路径（演练不把坏配置留在 config.json 里）
  const c4WordsRestore = JSON.parse(
    await exec(`(async () => {
      const restore = ${JSON.stringify((c4ConfigBefore && c4ConfigBefore.data && c4ConfigBefore.data.sensitiveWordsPath) || '')};
      if (restore) await window.api.testPickConfigPath(restore, 'sensitiveWordsPath');
      const r = await window.api.setConfig({ sensitiveWordsPath: restore });
      return JSON.stringify(r);
    })()`)
  );
  check(
    '错误脱敏：词表路径已复原成演练前的值（没把坏配置留在 config 里）',
    Boolean(c4WordsRestore && c4WordsRestore.ok === true) &&
      c4WordsRestore.data.sensitiveWordsPath ===
        ((c4ConfigBefore && c4ConfigBefore.data && c4ConfigBefore.data.sensitiveWordsPath) || ''),
    c4WordsRestore && c4WordsRestore.data && c4WordsRestore.data.sensitiveWordsPath
  );

  // 60e. 收尾：删掉演练书（走书架 _trash 兜底），书架数量回到演练前
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const c4Deleted = await deleteBookWithRetry(c4BookPath);
  check(
    '错误脱敏：演练书已移入书架 _trash',
    Boolean(c4Deleted && c4Deleted.ok === true) && c4Deleted.data.method === 'move',
    c4Deleted
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '错误脱敏：演练结束后书架数量回到演练前（没污染后面的多窗口组）',
    (await storage.listBooks(booksRoot)).length === c4ShelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
