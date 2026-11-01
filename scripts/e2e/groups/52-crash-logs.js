// E2E 第 52 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-7，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group52CrashLogs(t) {
  const {
    exec,
    check,
    waitFor,
    waitForLog,
    readLogs,
    logDir,
    logNamePattern,
    fileExists,
    userData,
    bookPath,
    appVersion
  } = t;

  // 52. 崩溃与错误日志（提案 7.4）：主进程异常 / 未处理的 Promise / IPC 错误 / 保存失败
  // 写进 userData\logs；日志不含任何正文、写不进去也不影响写作；设置里有「打开日志文件夹」。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  // 读日志 / 等日志的工具在 scripts/e2e/harness.js（v0.9 B-7 拆组时抽走的），
  // 这里直接用 createHarness 交出来的 logDir / logNamePattern / readLogs / waitForLog。

  // 52a. 启动就有一条 app-start：日志目录在 userData\logs，按天命名，只记版本 / 平台 / pid
  const logInfoResult = await exec('window.api.logInfo()');
  check(
    '诊断日志：日志目录是 userData\\logs，文件按天命名（chapter-writer-YYYY-MM-DD.log）',
    logInfoResult.ok === true &&
      logInfoResult.data.dir === logDir &&
      Array.isArray(logInfoResult.data.files) &&
      logInfoResult.data.files.length >= 1 &&
      logNamePattern.test(logInfoResult.data.files[0].name) &&
      logInfoResult.data.limits.maxFiles === 12 &&
      logInfoResult.data.limits.maxFileBytes === 256 * 1024,
    logInfoResult
  );
  const startupLogText = await waitForLog('INFO app-start');
  check(
    '诊断日志：启动记一条 info（版本 / 平台 / pid），不是每次按键都写',
    startupLogText.includes(`app=${appVersion}`) &&
      startupLogText.includes('win32') &&
      startupLogText.includes('pid=') &&
      startupLogText.includes(`启动：v${appVersion}`),
    startupLogText.slice(0, 300)
  );

  // 52b. 设置 → 诊断日志：全局设置里有「打开日志文件夹」，按书设置里不显示
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const logSettingsStatus = await exec('window.__cwTest.logSettingsStatus()');
  check(
    '诊断日志：设置里显示日志份数 / 大小，并说明不含正文',
    typeof logSettingsStatus === 'string' &&
      logSettingsStatus.includes('日志文件') &&
      logSettingsStatus.includes('不含正文'),
    logSettingsStatus
  );
  await exec("document.getElementById('btn-open-logs').click()");
  await waitFor(`window.__cwTest.logSettingsStatus().includes(${JSON.stringify(logDir)})`);
  check(
    '诊断日志：点「打开日志文件夹」回报日志目录（自检环境不弹资源管理器）',
    (await exec('window.__cwTest.logSettingsStatus()')).includes(logDir)
  );
  await exec('window.__cwTest.closeSettings()');
  await exec("window.__cwTest.openBookPath(" + JSON.stringify(bookPath) + ')');
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '诊断日志：按书设置里不显示日志分组（日志是整个应用一份）',
    (await exec('window.__cwTest.logSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');

  // 记录一份「日志操作前」的配置 / 书目 / 正文，稍后逐字节比对（日志不能碰书库与配置）
  const logMetaPath = path.join(bookPath, '书目.json');
  const logChapterMeta = JSON.parse(await fs.readFile(logMetaPath, 'utf8'));
  const logChapter = logChapterMeta.chapters[0];
  const logChapterPath = path.join(bookPath, logChapter.file);
  const logMetaBefore = await fs.readFile(logMetaPath, 'utf8');
  const logConfigBefore = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const logTxtBefore = await fs.readFile(logChapterPath, 'utf8');

  // 52c. IPC 未捕获错误：照常返回失败，同时日志里有一条（频道 + 错误码 + 文件名）
  const ipcFail = await exec(
    `window.api.loadChapter(${JSON.stringify(bookPath)}, '不存在的章节.txt')`
  );
  check(
    '诊断日志：IPC 错误照常返回失败，界面行为不变',
    ipcFail.ok === false && ipcFail.code === 'CHAPTER_MISSING',
    ipcFail
  );
  const ipcLogText = await waitForLog('不存在的章节.txt');
  const ipcLogBlock = ipcLogText.slice(Math.max(0, ipcLogText.indexOf('不存在的章节.txt') - 200));
  check(
    '诊断日志：IPC 未捕获错误记一条（错误码 + IPC 频道 + 出错文件名，含栈）',
    ipcLogBlock.includes('ERROR ipc-error') &&
      ipcLogBlock.includes('code=CHAPTER_MISSING') &&
      ipcLogBlock.includes('不存在的章节.txt') &&
      ipcLogBlock.includes('stack:'),
    ipcLogBlock.slice(0, 500)
  );

  // 52d. 保存失败：把章节文件设成只读让真实写盘失败 → 日志有 save-failed，但绝不含正文
  const saveFailMarker = 'E2E_SAVE_FAIL_MARKER';
  const saveFailBody = '这一段正文绝对不应该出现在日志文件里面';
  await fs.chmod(logChapterPath, 0o444);
  let failedSave;
  try {
    failedSave = await exec(
      `window.api.saveChapter(${JSON.stringify(bookPath)}, ${JSON.stringify(logChapter.id)}, ${JSON.stringify(
        `${saveFailMarker} ${saveFailBody}`
      )})`
    );
  } finally {
    await fs.chmod(logChapterPath, 0o666);
  }
  check(
    '诊断日志：真实写盘失败时保存照常返回错误',
    failedSave.ok === false && ['EPERM', 'EACCES', 'EBUSY'].includes(failedSave.code),
    failedSave
  );
  const saveFailLogText = await waitForLog('save-failed');
  const saveFailBlock = saveFailLogText.slice(Math.max(0, saveFailLogText.indexOf('save-failed') - 200));
  check(
    '诊断日志：保存失败记一条（错误码 + 章节文件路径 + 频道），绝不含正文',
    saveFailBlock.includes('ERROR save-failed') &&
      saveFailBlock.includes(`code=${failedSave.code}`) &&
      saveFailBlock.includes('channel=chapter:save') &&
      saveFailBlock.includes(logChapter.file) &&
      saveFailLogText.includes(saveFailMarker) === false &&
      saveFailLogText.includes(saveFailBody) === false,
    saveFailBlock.slice(0, 500)
  );
  check(
    '诊断日志：保存失败后章节 txt 与 书目.json 一个字节都没变',
    (await fs.readFile(logChapterPath, 'utf8')) === logTxtBefore &&
      (await fs.readFile(logMetaPath, 'utf8')) === logMetaBefore
  );

  // 52e. 主进程未处理的 Promise / 未捕获异常：都记一条，进程不能崩，界面给固定提示
  void Promise.reject(new Error('E2E_UNHANDLED_REJECTION_MARKER'));
  const rejectionLogText = await waitForLog('E2E_UNHANDLED_REJECTION_MARKER');
  check(
    '诊断日志：未处理的 Promise 记一条 unhandledRejection（含错误信息）',
    rejectionLogText.includes('ERROR unhandledRejection'),
    rejectionLogText.slice(-300)
  );
  setTimeout(() => {
    throw new Error('E2E_UNCAUGHT_EXCEPTION_MARKER');
  }, 0);
  const uncaughtLogText = await waitForLog('E2E_UNCAUGHT_EXCEPTION_MARKER');
  check(
    '诊断日志：主进程未捕获异常记一条 uncaughtException（含错误信息与栈），应用没退出',
    uncaughtLogText.includes('ERROR uncaughtException') &&
      uncaughtLogText.includes('stack:') &&
      (await exec('1 + 1')) === 2,
    uncaughtLogText.slice(-400)
  );
  await waitFor("(window.__cwTest.lastInternalError() || {}).kind === 'uncaughtException'");
  const internalError = await exec('window.__cwTest.lastInternalError()');
  check(
    '诊断日志：内部错误只在界面弹一句固定提示（不含错误细节 / 正文），写作页还能用',
    internalError &&
      internalError.kind === 'uncaughtException' &&
      typeof internalError.message === 'string' &&
      internalError.message.includes('日志') &&
      internalError.message.includes('MARKER') === false &&
      (await exec('window.__cwTest.text()')).length > 0,
    internalError
  );

  // 记录错误本身不写配置：日志功能不新增任何配置项，旧 config 照常启动
  const logConfigAfterLogging = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  check(
    '诊断日志：记录错误不写 config.json（没有日志开关，旧配置照常）',
    logConfigAfterLogging === logConfigBefore
  );

  // 52f. 日志写不进去也绝不影响写作：把 logs 目录换成一个同名文件
  const logsBackup = `${logDir}-off`;
  await fs.rm(logsBackup, { recursive: true, force: true });
  await fs.rename(logDir, logsBackup);
  await fs.writeFile(logDir, '占住日志目录位置，模拟日志写不进去');
  const ipcFailWhileBroken = await exec(
    `window.api.loadChapter(${JSON.stringify(bookPath)}, '写日志失败时的错误.txt')`
  );
  check(
    '诊断日志：写日志失败时 IPC 仍照常返回结果（日志失败被吞掉）',
    ipcFailWhileBroken.ok === false && ipcFailWhileBroken.code === 'CHAPTER_MISSING'
  );
  await exec("window.__cwTest.setText('写日志失败时，保存正文也必须成功。')");
  const saveWhileBroken = await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  check(
    '诊断日志：写日志失败时保存正文照常成功（日志绝不影响写作）',
    saveWhileBroken && saveWhileBroken.ok === true && (await exec('window.__cwTest.dirty()')) === false,
    saveWhileBroken
  );
  await fs.unlink(logDir);
  await fs.rename(logsBackup, logDir);
  // 恢复后照常写日志（不会因为失败过一次就永久停写）
  await exec(`window.api.loadChapter(${JSON.stringify(bookPath)}, '恢复后的错误.txt')`);
  const recoveredLogText = await waitForLog('恢复后的错误.txt');
  check(
    '诊断日志：日志目录恢复后继续记录（不会一次失败就永久停写）',
    recoveredLogText.includes('恢复后的错误.txt')
  );

  // 52g. 整份日志都不含正文：拿几段本轮 / 前面几组真的写过的正文去搜
  const allLogs = await readLogs();
  const bodySamples = [
    '风从海面吹来',
    '他沿着堤岸往回走',
    '第40行：',
    saveFailMarker,
    saveFailBody,
    '写日志失败时，保存正文也必须成功'
  ];
  check(
    '诊断日志：所有日志文件里都没有正文（正文只进书库，不进日志）',
    allLogs.names.length >= 1 &&
      allLogs.names.every((name) => logNamePattern.test(name)) &&
      bodySamples.every((sample) => allLogs.text.includes(sample) === false),
    bodySamples.filter((sample) => allLogs.text.includes(sample))
  );
  const bookEntries = await fs.readdir(bookPath);
  check(
    '诊断日志：日志只写 userData\\logs，书文件夹里没有多出日志文件',
    (await fileExists(logDir)) &&
      bookEntries.includes('logs') === false &&
      bookEntries.some((name) => /\.log$/i.test(name)) === false,
    bookEntries
  );
  const finalConfig = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const logConfigKeys = ['logInfo', 'logEnabled', 'logLevel', 'logDir', 'logs', 'diagnosticLog'].filter(
    (key) => key in finalConfig
  );
  check(
    '诊断日志：配置里不新增任何日志字段（日志功能不需要作者手动配置）',
    logConfigKeys.length === 0,
    logConfigKeys
  );
};
